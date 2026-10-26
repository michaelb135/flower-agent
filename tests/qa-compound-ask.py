"""Exercise related meal, grocery and reminder requests through Ask Tidy.

Every scenario uses isolated synthetic browser data and a fixed Dubai clock.
Requests outside the selected Tidy origin are blocked. These checks do not
establish retailer access, real purchases, native alarms or closed-app alerts.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import traceback
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DAY = "2026-10-26"
TOMORROW = "2026-10-27"
EXAMPLE = "Tomorrow we’re having tomato pasta. Add the ingredients and remind me to cook at 6 pm."
FIXTURE = """(() => {
  window.__rejectTidyWrites = false;
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled compound request quota failure', 'QuotaExceededError');
    return set.call(this, key, value);
  };
})();"""


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def state(tab):
    return tab.evaluate("TidyDemo.getState()")


def saved(tab):
    return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def home(tab):
    tab.locator('.app-nav [data-view="assistant"]').click()


def section(tab, name):
    direct = tab.locator(f'.app-nav [data-view="{name}"]')
    if direct.count():
        direct.click()
    else:
        tab.locator("#open-settings").click()
        tab.locator('#settings-dialog [data-go="tools"]').click()
        tab.locator(f'#view-tools [data-go="{name}"]').click()
    if tab.locator("#calendar-onboarding-dialog").is_visible():
        tab.locator("#calendar-onboarding-later").click()
    assert tab.locator("section.view:visible").get_attribute("id") == "view-" + name


def wait_result(tab):
    tab.wait_for_function("""() => !document.getElementById('capture-form').hasAttribute('aria-busy') &&
      ['done','waiting','error'].includes(document.getElementById('assistant-activity').dataset.status)""")


def ask(tab, text):
    home(tab)
    tab.locator("#capture-text").fill(text)
    tab.locator('#capture-form button[type="submit"]').click()
    wait_result(tab)


def status(tab):
    return tab.locator("#assistant-activity").get_attribute("data-status")


def reply(tab, text):
    tab.locator("#assistant-clarify-answer").fill(text)
    tab.locator("#assistant-clarify-submit").click()
    wait_result(tab)


def reminder(tab):
    tasks = [task for task in state(tab)["tasks"] if task.get("remindAt") is not None and re.search(r"cook", task["title"], re.I)]
    assert len(tasks) == 1, tasks
    return tasks[0]


def assert_reminder(task, date=TOMORROW, clock="18:00"):
    assert task["dueDate"] == date, task
    assert task["dueTime"] == clock, task
    expected = datetime.fromisoformat(date + "T" + clock + ":00+04:00").timestamp() * 1000
    assert task["remindAt"] == expected, task


def draft(tab):
    return state(tab).get("menuHelper", {}).get("draft")


def history(tab):
    return state(tab).get("activityHistory", {}).get("entries", [])


def grocery_rows(tab):
    return tab.locator("#shopping-tasks [data-task-id], #quick-menu-shopping-items > li")


def assert_groceries(tab):
    meal = draft(tab)
    assert meal and meal["items"], meal
    groceries = [task for task in state(tab)["tasks"] if task["type"] == "grocery" and task["status"] == "open"]
    section(tab, "shopping")
    text = tab.locator("#view-shopping").inner_text()
    for ingredient in meal["items"]:
        if ingredient["included"]:
            names = {name.casefold().strip() for name in [ingredient["name"], ingredient.get("productName", "")] if name}
            matches = [task for task in groceries if task["title"].casefold().strip() in names]
            assert len(matches) == 1, (ingredient, groceries)
            assert matches[0]["title"].casefold() in text.casefold(), (ingredient, text)
    return text


def no_overflow(tab, selector):
    size = tab.locator(selector).evaluate("n => ({client:n.clientWidth,scroll:n.scrollWidth,document:document.documentElement.scrollWidth,viewport:innerWidth})")
    assert size["scroll"] <= size["client"] + 1 and size["document"] <= size["viewport"] + 1, size


def backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as download:
        tab.locator("#export-backup").click()
    result = json.loads(Path(download.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return result


def edit_task(tab, task, title=None, quantity=None):
    name, container = ("shopping", "shopping-tasks") if task["type"] == "grocery" else ("family", "family-tasks")
    section(tab, name)
    row = tab.locator(f'#{container} [data-task-id="{task["id"]}"]')
    row.get_by_role("button", name="Edit", exact=True).click()
    if title is not None:
        tab.locator("#task-title").fill(title)
    if quantity is not None:
        tab.locator("#task-quantity").fill(quantity)
    tab.locator("#save-task").click()
    tab.wait_for_function("!document.getElementById('task-dialog').open")


def configure_hours(tab):
    tab.locator("#open-settings").click()
    tab.locator("#settings-usual-hours").click()
    tab.locator("#planning-enabled").check()
    for day in range(7):
        tab.locator(f'[name="planning-workday"][value="{day}"]').set_checked(day in [1, 2, 3, 4, 5])
        tab.locator(f'[name="planning-schoolday"][value="{day}"]').set_checked(day in [1, 2, 3, 4, 5])
    for field, value in {"work-start": "08:00", "work-end": "17:00", "kids-home": "15:00", "day-start": "07:00",
                         "day-end": "20:30", "task-minutes": "30", "family-minutes": "45", "buffer-minutes": "15"}.items():
        tab.locator("#planning-" + field).fill(value)
    tab.locator("#planning-settings-save").click()
    assert state(tab)["planningProfile"]["enabled"] is True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9051/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--output", type=Path, default=ROOT / ".qa-results/compound-ask")
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) Tidy deployment")
    args.output.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest()
              for name in ["index.html", "app.js", "assistant.js", "menu-ui.js", "menu-helper.js"]}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.browser, headless=True)

        def page(context):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda error: errors.append(str(error)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(datetime(2026, 10, 26, 6, 0, tzinfo=timezone.utc))
            tab.goto(args.url.split("#", 1)[0])
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            return tab

        def run(name, check, width=1100):
            if args.case and not any(value.casefold() in name.casefold() for value in args.case):
                return
            context = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 1000})
            context.add_init_script(FIXTURE)

            def guard(route):
                if origin(route.request.url) == selected:
                    route.continue_()
                else:
                    external.append(route.request.url)
                    route.abort("blockedbyclient")

            context.route("**/*", guard)
            before_errors, before_external = len(errors), len(external)
            try:
                evidence = check(context)
                assert len(errors) == before_errors, errors[before_errors:]
                assert len(external) == before_external, external[before_external:]
                result = {"name": name, "result": "PASS", "evidence": evidence}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
                for index, tab in enumerate(context.pages):
                    try:
                        tab.screenshot(path=str(args.output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()) + f"-{index}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def basic(context):
            tab = page(context)
            observed = []
            tab.expose_function("recordCompoundProgress", lambda value: observed.append(value))
            tab.evaluate("""() => new MutationObserver(() => {
              const node=document.getElementById('assistant-activity');
              if(!node.hidden)window.recordCompoundProgress({status:node.dataset.status,text:node.innerText,
                busy:document.getElementById('capture-form').getAttribute('aria-busy')==='true'});
            }).observe(document.getElementById('assistant-activity'),{subtree:true,childList:true,characterData:true,attributes:true})""")
            ask(tab, EXAMPLE)
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            meal = draft(tab)
            assert meal["recipeId"] == "tomato-pasta" and meal["people"] == 4, meal
            assert meal["status"] == "draft" and meal["approvedAt"] is None, meal
            task = reminder(tab)
            assert_reminder(task)
            text = assert_groceries(tab)
            home(tab)
            receipt = tab.locator("#assistant-activity").inner_text()
            assert re.search(r"ingredient|grocer", receipt, re.I) and re.search(r"remind|6:00|18:00", receipt, re.I), receipt
            assert any(item["status"] in {"working", "waiting"} and item["busy"] and re.search(r"prepar|check", item["text"], re.I) for item in observed), observed
            assert any(item["section"] == "Menu" for item in history(tab))
            assert {"Tasks", "Groceries"}.issubset({item["section"] for item in history(tab)})
            assert not state(tab)["actions"], state(tab)["actions"]
            assert not re.search(r"(?:placed|sent|purchased|booked) (?:your|the|an?) (?:order|purchase|booking)", receipt, re.I), receipt
            assert len(tab.locator(".app-nav [data-view]").all()) == 6
            for label, view in [("Open Menu", "meals"), ("Open Groceries", "shopping"), ("Open Reminder", "reminders")]:
                home(tab)
                tab.locator("#assistant-activity-results").get_by_role("button", name=label, exact=True).click()
                assert tab.locator("section.view:visible").get_attribute("id") == "view-" + view
                if view == "reminders":
                    assert tab.locator(f'#reminder-tasks [data-task-id="{task["id"]}"]').is_visible()
            return {"mealPrepared": meal["name"], "people": meal["people"], "reminderDate": task["dueDate"], "reminderTime": task["dueTime"],
                    "ingredientsVisibleInGroceries": True, "visibleProgress": True, "resultButtonsOpenAllThreeSavedSections": True,
                    "newNavigationParts": 0, "providerTransactions": 0}
        run("One request prepares the meal and groceries and sets the correct cooking reminder", basic)

        def servings(context):
            tab = page(context)
            tab.evaluate("""() => {const data=TidyDemo.getState();data.menuHelper=TidyMenuHelper.emptyState();data.menuHelper.people=2;
              localStorage.setItem('tidy.app.v1',TidyCore.backupJSON(data));} """)
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            ask(tab, EXAMPLE)
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            meal = draft(tab)
            assert meal["people"] == 2, meal
            assert next(i for i in meal["items"] if i["ingredientId"] == "pasta")["amount"] == 180
            assert_groceries(tab)
            return {"savedServingsUsed": 2, "pastaAmountGrams": 180}
        run("Compound preparation uses the saved number of people without another question", servings)

        def short_correction(context):
            tab = page(context)
            ask(tab, EXAMPLE)
            original = reminder(tab)
            before = state(tab)
            ask(tab, "Actually, make it 6:30 pm")
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            updated = reminder(tab)
            assert updated["id"] == original["id"]
            assert_reminder(updated, clock="18:30")
            after = state(tab)
            assert after["menuHelper"] == before["menuHelper"]
            assert [task for task in after["tasks"] if task["id"] != original["id"]] == [task for task in before["tasks"] if task["id"] != original["id"]]
            assert len(after["tasks"]) == len(before["tasks"])
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            assert_reminder(reminder(tab), clock="18:30")
            assert saved(tab)["tasks"] == state(tab)["tasks"]
            return {"sameReminderUpdated": True, "newTime": "18:30", "mealAndGroceriesUnchanged": True, "survivesReload": True}
        run("A short follow-up changes the same reminder and preserves groceries and the meal", short_correction)

        def ordinary_correction(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum tomorrow at 6 pm")
            original, = state(tab)["tasks"]
            ask(tab, "Actually, make it 6:30 pm")
            updated, = state(tab)["tasks"]
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            assert updated["id"] == original["id"] and updated["title"] == original["title"]
            assert_reminder(updated, clock="18:30")
            assert not draft(tab)
            return {"ordinaryAskReminderSupportsSameShortCorrection": True, "originalTitleAndIDPreserved": True}
        run("The same short correction also works for an ordinary Ask Tidy reminder", ordinary_correction)

        def clarification(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "Tomorrow we're having tomato pasta. Add the ingredients and remind me to cook at 6 o'clock.")
            assert status(tab) == "waiting", tab.locator("#assistant-activity").inner_text()
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            assert not tab.locator("#task-dialog").is_visible()
            assert state(tab) == before, state(tab)
            reply(tab, "6 pm")
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            assert_reminder(reminder(tab))
            assert_groceries(tab)
            return {"oneEssentialQuestion": True, "noPartialChangesBeforeAnswer": True, "originalMealAndDateRetained": True}
        run("An ambiguous cooking time asks one question before applying the related jobs", clarification)

        def missing_clock_with_planning(context):
            tab = page(context)
            configure_hours(tab)
            before = state(tab)
            ask(tab, "Tomorrow we're having tomato pasta. Add the ingredients and remind me to cook.")
            assert status(tab) == "waiting", tab.locator("#assistant-activity").inner_text()
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            assert not tab.locator("#task-dialog").is_visible()
            assert state(tab) == before
            assert not draft(tab) and not state(tab)["tasks"]
            reply(tab, "7 pm")
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            assert_reminder(reminder(tab), clock="19:00")
            assert_groceries(tab)
            assert state(tab)["planningProfile"] == before["planningProfile"]
            return {"confirmedHoursDoNotInventCookingTime": True, "oneEssentialQuestion": True,
                    "noPartialChangesBeforeAnswer": True, "chosenCookingTime": "19:00"}
        run("Confirmed planning hours still ask for an unspecified cooking time before changing anything", missing_clock_with_planning)

        def correction_question(context):
            tab = page(context)
            ask(tab, EXAMPLE)
            original = reminder(tab)
            before = state(tab)
            ask(tab, "Actually, make it 6 o'clock")
            assert status(tab) == "waiting", tab.locator("#assistant-activity").inner_text()
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            assert state(tab) == before
            reply(tab, "6:30 pm")
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            updated = reminder(tab)
            assert updated["id"] == original["id"]
            assert_reminder(updated, clock="18:30")
            assert len(state(tab)["tasks"]) == len(before["tasks"])
            assert state(tab)["menuHelper"] == before["menuHelper"]
            return {"ambiguousCorrectionAsksOneQuestion": True, "answerUpdatesSameReminderOnly": True}
        run("An ambiguous short correction retains its target while asking one essential question", correction_question)

        def cancel(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "Tomorrow we're having tomato pasta. Add the ingredients and remind me to cook at 6 o'clock.")
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            tab.locator("#assistant-clarify-cancel").click()
            assert not tab.locator("#assistant-clarify-dialog").is_visible()
            assert state(tab) == before
            assert saved(tab)["tasks"] == before["tasks"]
            return {"cancelLeavesMealGroceriesAndReminderUntouched": True}
        run("Cancelling the essential question does not leave a partial meal or reminder", cancel)

        def duplicate_groceries(context):
            tab = page(context)
            section(tab, "shopping")
            tab.locator("#grocery-title").fill("Pasta")
            tab.locator("#grocery-quantity").fill("1 packet")
            tab.locator("#grocery-add").click()
            existing = next(task for task in state(tab)["tasks"] if task["type"] == "grocery" and task["title"] == "Pasta")
            ask(tab, EXAMPLE)
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            assert_groceries(tab)
            after = next(task for task in state(tab)["tasks"] if task["id"] == existing["id"])
            assert after == existing, (existing, after)
            pasta_rows = [text for text in grocery_rows(tab).all_inner_texts() if re.match(r"\s*Pasta\b", text, re.I)]
            assert len(pasta_rows) == 1, grocery_rows(tab).all_inner_texts()
            return {"existingPastaPreserved": True, "existingQuantity": "1 packet", "oneVisiblePastaEntry": True}
        run("Existing grocery amounts are kept and the compound meal does not duplicate them", duplicate_groceries)

        def repeated(context):
            tab = page(context)
            ask(tab, EXAMPLE)
            before = state(tab)
            ask(tab, EXAMPLE)
            if tab.locator("#quick-menu-replacement").is_visible():
                tab.locator("#quick-menu-replace").click()
                tab.wait_for_function("document.getElementById('assistant-activity').dataset.status === 'done'")
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            assert state(tab)["tasks"] == before["tasks"], state(tab)["tasks"]
            assert_groceries(tab)
            section(tab, "meals")
            tab.locator("#quick-menu-approve").click()
            section(tab, "shopping")
            pasta_rows = [text for text in grocery_rows(tab).all_inner_texts() if re.match(r"\s*Pasta\b", text, re.I)]
            assert len(pasta_rows) == 1, grocery_rows(tab).all_inner_texts()
            return {"repeatCreatesNoDuplicateGroceriesOrReminder": True, "ordinaryMenuApprovalDoesNotDuplicateExistingGroceries": True}
        run("Repeating a compound request and confirming its meal does not duplicate saved groceries", repeated)

        def replacement(context):
            tab = page(context)
            ask(tab, "I want to eat chicken and rice")
            before = state(tab)
            assert draft(tab)["recipeId"] == "chicken-rice"
            ask(tab, EXAMPLE)
            assert status(tab) == "waiting", tab.locator("#assistant-activity").inner_text()
            assert tab.locator("#quick-menu-replacement").is_visible()
            assert state(tab) == before
            tab.locator("#quick-menu-keep").click()
            assert state(tab) == before
            assert not [task for task in state(tab)["tasks"] if task.get("remindAt")]
            ask(tab, EXAMPLE)
            tab.locator("#quick-menu-replace").click()
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status === 'done'")
            assert draft(tab)["recipeId"] == "tomato-pasta"
            assert_reminder(reminder(tab))
            assert_groceries(tab)
            return {"existingMealRetainedWhileReviewingReplacement": True, "keepingMealDoesNotCreateUnrelatedReminder": True,
                    "confirmedReplacementCompletesOriginalRelatedJobs": True}
        run("A compound request preserves the existing meal until replacement is chosen", replacement)

        def unfinished(context):
            tab = page(context)
            section(tab, "meals")
            tab.locator("#quick-menu-request").fill("Unfinished family recipe text")
            before = state(tab)
            ask(tab, EXAMPLE)
            assert status(tab) in {"waiting", "error"}, tab.locator("#assistant-activity").inner_text()
            assert state(tab) == before
            assert tab.locator("#quick-menu-request").input_value() == "Unfinished family recipe text"
            return {"unfinishedMealTextRetained": True, "noRelatedGroceryOrReminderSaved": True}
        run("An unfinished Menu entry is protected before a compound request changes anything", unfinished)

        def unknown(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "Tomorrow we're having dragon soup. Add the ingredients and remind me to cook at 6 pm.")
            assert status(tab) == "waiting", tab.locator("#assistant-activity").inner_text()
            assert state(tab) == before
            assert not state(tab)["tasks"]
            assert not draft(tab)
            assert tab.locator("#quick-menu-choices").is_visible()
            assert tab.locator("#quick-menu-choices button").count() >= 1
            tab.locator("#quick-menu-choices button").first.click()
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status === 'done'")
            assert draft(tab)
            assert_reminder(reminder(tab))
            assert_groceries(tab)
            return {"unknownDishDoesNotInventIngredients": True, "noPartialReminder": True, "supportedChoiceCompletesOriginalRelatedJobs": True}
        run("An unknown dish offers supported recipes and does not silently save only the reminder", unknown)

        def pending_choice_correction(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum tomorrow at 6 pm")
            older, = state(tab)["tasks"]
            ask(tab, "Tomorrow we're having dragon soup. Add the ingredients and remind me to cook at 7 pm.")
            assert status(tab) == "waiting" and tab.locator("#quick-menu-choices").is_visible()
            before = state(tab)
            ask(tab, "Actually, make it 6:30 pm")
            assert status(tab) in {"waiting", "error"}, tab.locator("#assistant-activity").inner_text()
            assert state(tab) == before
            assert next(task for task in state(tab)["tasks"] if task["id"] == older["id"]) == older
            assert re.search(r"recipe|replacement|choice|finish.*menu", tab.locator("#assistant-activity").inner_text(), re.I)
            assert tab.locator("#quick-menu-choices").is_visible()
            tab.locator("#quick-menu-choices button").first.click()
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status === 'done'")
            assert_reminder(reminder(tab), clock="19:00")
            assert next(task for task in state(tab)["tasks"] if task["id"] == older["id"]) == older
            assert_groceries(tab)
            return {"pendingMealChoiceDoesNotRedirectCorrectionToOlderReminder": True,
                    "olderReminderUnchanged": True, "pendingMealRequestStillCompletesAfterChoice": True}
        run("A pending new meal choice prevents a short correction from changing an older reminder", pending_choice_correction)

        def quota(context):
            tab = page(context)
            before = saved(tab)
            tab.evaluate("window.__rejectTidyWrites=true")
            ask(tab, EXAMPLE)
            assert status(tab) == "error", tab.locator("#assistant-activity").inner_text()
            assert saved(tab) == before
            assert draft(tab) and reminder(tab)
            text = tab.locator("#assistant-activity").inner_text()
            assert re.search(r"not saved|could(?:n’t| not|n't) save|this tab", text, re.I), text
            recovered = backup(tab)
            assert recovered["menuHelper"] == state(tab)["menuHelper"]
            assert recovered["tasks"] == state(tab)["tasks"]
            assert not recovered["actions"]
            return {"failedWriteReported": True, "previousSavedCopyUntouched": True, "completeInMemoryResultRecoverable": True, "providerTransactions": 0}
        run("A failed compound save is honest and leaves the complete result recoverable", quota)

        def stale_correction(context):
            first = page(context)
            ask(first, EXAMPLE)
            old = reminder(first)
            second = page(context)
            edit_task(second, old, title="Cook a different saved dinner")
            latest = next(task for task in saved(second)["tasks"] if task["id"] == old["id"])
            ask(first, "Actually, make it 6:30 pm")
            assert status(first) in {"waiting", "error"}, first.locator("#assistant-activity").inner_text()
            retained = next(task for task in saved(first)["tasks"] if task["id"] == old["id"])
            assert retained == latest, (latest, retained)
            assert retained["dueTime"] == "18:00"
            return {"otherTabEditNotBlindlyChangedByShortReply": True, "existingReminderRetained": True}
        run("A short correction does not blindly overwrite a reminder changed in another tab", stale_correction)

        def removed_correction(context):
            first = page(context)
            ask(first, EXAMPLE)
            old = reminder(first)
            second = page(context)
            section(second, "family")
            second.locator(f'#family-tasks [data-task-id="{old["id"]}"]').get_by_role("button", name="Remove", exact=True).click()
            before = saved(second)
            ask(first, "Actually, make it 6:30 pm")
            assert status(first) in {"waiting", "error"}, first.locator("#assistant-activity").inner_text()
            assert saved(first) == before
            assert not [task for task in state(first)["tasks"] if task["id"] == old["id"]]
            return {"removedReminderNotRecreatedByShortCorrection": True}
        run("A short correction does not recreate a reminder deleted in another tab", removed_correction)

        def completed_correction(context):
            first = page(context)
            ask(first, EXAMPLE)
            old = reminder(first)
            second = page(context)
            section(second, "family")
            second.locator(f'#family-tasks [data-task-id="{old["id"]}"]').get_by_role("button", name="Complete " + old["title"], exact=True).click()
            before = saved(second)
            ask(first, "Actually, make it 6:30 pm")
            assert status(first) in {"waiting", "error"}, first.locator("#assistant-activity").inner_text()
            assert saved(first) == before
            target = next(task for task in state(first)["tasks"] if task["id"] == old["id"])
            assert target["status"] == "done" and target["dueTime"] == "18:00"
            return {"completedReminderKeptCompletedAndUnchanged": True}
        run("A short correction does not reopen a reminder completed in another tab", completed_correction)

        def no_context(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "Actually, make it 6:30 pm")
            assert status(tab) in {"waiting", "error"}, tab.locator("#assistant-activity").inner_text()
            assert state(tab) == before
            assert not state(tab)["tasks"]
            return {"missingReminderContextDoesNotCreateAnUnrelatedTask": True}
        run("A time correction with no prior reminder asks for context and saves nothing", no_context)

        def selected_after_reload(context):
            tab = page(context)
            ask(tab, EXAMPLE)
            selected = reminder(tab)
            ask(tab, "Remind me to call Mum tomorrow at 8 pm")
            later = next(task for task in state(tab)["tasks"] if task.get("remindAt") is not None and task["id"] != selected["id"])
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            before = state(tab)
            section(tab, "family")
            tab.locator(f'#family-tasks [data-task-id="{selected["id"]}"]').get_by_role("button", name="Edit", exact=True).click()
            tab.locator("#task-dialog").get_by_role("button", name="Cancel", exact=True).click()
            assert state(tab) == before
            ask(tab, "Actually, make it 6:30 pm")
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            updated = next(task for task in state(tab)["tasks"] if task["id"] == selected["id"])
            assert_reminder(updated, clock="18:30")
            assert next(task for task in state(tab)["tasks"] if task["id"] == later["id"]) == later
            assert len(state(tab)["tasks"]) == len(before["tasks"])
            assert state(tab)["menuHelper"] == before["menuHelper"]
            return {"openingExistingReminderSelectsFollowupTargetAfterReload": True,
                    "selectedReminderUpdatedInPlace": True, "otherReminderAndGroceriesUntouched": True}
        run("Selecting a saved reminder after reload allows a short correction to update that item", selected_after_reload)

        def unsupported_extra(context):
            tab = page(context)
            before = state(tab)
            ask(tab, EXAMPLE + " Also read my emails and send a message to the nanny.")
            assert status(tab) in {"waiting", "error"}, tab.locator("#assistant-activity").inner_text()
            assert state(tab) == before
            assert not draft(tab) and not state(tab)["tasks"]
            assert not re.search(r"(?:I’ve|I have) (?:sent|read|accessed)", tab.locator("#assistant-activity").inner_text(), re.I)
            return {"unsupportedExtraActionsNotSilentlyDiscarded": True, "noRelatedJobsPartiallySaved": True, "externalActions": 0}
        run("Extra unsupported email or messaging work is not silently ignored while saving a partial meal", unsupported_extra)

        def phone(context):
            tab = page(context)
            ask(tab, EXAMPLE)
            assert status(tab) == "done", tab.locator("#assistant-activity").inner_text()
            assert_reminder(reminder(tab))
            home(tab)
            no_overflow(tab, "#view-assistant")
            no_overflow(tab, "#assistant-activity")
            no_overflow(tab, "#main-navigation")
            ask(tab, "Actually, make it 6:30 pm")
            assert_reminder(reminder(tab), clock="18:30")
            home(tab)
            assert tab.locator("#assistant-history").is_visible()
            no_overflow(tab, "#assistant-history")
            tab.screenshot(path=str(args.output / "compound-ask-320.png"), full_page=True)
            return {"width": 320, "compoundAndCorrectionWork": True, "noHorizontalOverflow": True, "sameSixMainSections": True}
        run("A small phone can complete and correct the related jobs inside the existing sections", phone, width=320)

        browser.close()
    report = {"url": args.url, "sourceHashes": hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": external,
              "scope": "Synthetic local browser data only; no live retailer connections, purchases, messages, native alarms or closed-app alerts."}
    path = args.output / ("live-report.json" if selected[0] == "https" else "local-report.json")
    path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(item["result"] == "PASS" for item in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(external), "report": str(path)}), flush=True)
    raise SystemExit(0 if results and passed == len(results) and not errors and not external else 1)


if __name__ == "__main__":
    main()
