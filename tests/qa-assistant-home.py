"""Exercise Ask Tidy as the app's starting point and action hub.

Each scenario uses synthetic browser data. Requests outside the selected Tidy
origin are blocked. These tests establish local app behavior, not retailer
connections, real orders, native alarms or a connected AI service.
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
KEY = "tidy.app.v1"
DAY = "2026-10-22"
FIXTURE = """(() => {
  window.__rejectTidyWrites = false;
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled assistant home quota failure', 'QuotaExceededError');
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


def destination(tab, view):
    if view == "calendar" and tab.locator("#calendar-onboarding-dialog").is_visible():
        tab.locator("#calendar-onboarding-later").click()
    assert tab.locator("section.view:visible").count() == 1
    assert tab.locator("section.view:visible").get_attribute("id") == "view-" + view


def home(tab):
    tab.locator(".brand").click()
    destination(tab, "assistant")


def ask(tab, text):
    tab.locator('[data-view="assistant"]').click()
    tab.locator("#capture-text").fill(text)
    tab.locator('#capture-form button[type="submit"]').click()
    tab.wait_for_function("""() => !document.getElementById('capture-form').hasAttribute('aria-busy') &&
      ['done','waiting','error'].includes(document.getElementById('assistant-activity').dataset.status)""")


def menu_draft(tab):
    return state(tab).get("menuHelper", {}).get("draft")


def configure_hours(tab):
    tab.locator("#open-settings").click()
    tab.locator("#settings-usual-hours").click()
    tab.locator("#planning-enabled").check()
    for day in range(7):
        tab.locator(f'[name="planning-workday"][value="{day}"]').set_checked(day in [1, 2, 3, 4, 5])
        tab.locator(f'[name="planning-schoolday"][value="{day}"]').set_checked(day in [1, 2, 3, 4, 5])
    for field, value in {"work-start": "08:00", "work-end": "17:00", "kids-home": "15:00",
                         "day-start": "07:00", "day-end": "20:30", "task-minutes": "30",
                         "family-minutes": "45", "buffer-minutes": "15"}.items():
        tab.locator("#planning-" + field).fill(value)
    tab.locator("#planning-settings-save").click()
    assert state(tab)["planningProfile"]["enabled"] is True


def add_task(tab, title, kind="task", date="", time=""):
    tab.locator('[data-view="family"]').click()
    tab.locator("#family-add").click()
    tab.locator("#task-title").fill(title)
    tab.locator("#task-type").select_option(kind)
    tab.locator("#task-date").fill(date)
    tab.locator("#task-time").fill(time)
    tab.locator("#save-task").click()
    return next(item for item in state(tab)["tasks"] if item["title"] == title)


def no_overflow(tab, selector):
    bounds = tab.locator(selector).evaluate("""node => ({
      client:node.clientWidth,scroll:node.scrollWidth,
      document:document.documentElement.scrollWidth,viewport:innerWidth
    })""")
    assert bounds["scroll"] <= bounds["client"] + 1, bounds
    assert bounds["document"] <= bounds["viewport"] + 1, bounds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9051/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--output", type=Path, default=ROOT / ".qa-results" / "assistant-home")
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    args.output.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    source_hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest()
                     for name in ["index.html", "styles.css", "app.js", "assistant.js", "menu-ui.js"]}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def page(context, fragment=""):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: errors.append(str(problem)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc))
            tab.goto(args.url.split("#", 1)[0] + fragment)
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            if tab.locator("#calendar-onboarding-dialog").is_visible():
                tab.locator("#calendar-onboarding-later").click()
            return tab

        def run(name, check, width=1100):
            if args.case and not any(value.casefold() in name.casefold() for value in args.case):
                return
            context = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 950})
            context.add_init_script(FIXTURE)

            def guard(route):
                if origin(route.request.url) == selected:
                    route.continue_()
                else:
                    external.append(route.request.url)
                    route.abort("blockedbyclient")

            context.route("**/*", guard)
            before_errors = len(errors)
            try:
                evidence = check(context)
                assert len(errors) == before_errors, errors[before_errors:]
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

        def start_and_return(context):
            tab = page(context)
            before = state(tab)
            destination(tab, "assistant")
            assert tab.url.endswith("#assistant"), tab.url
            assert tab.locator("#assistant-title").inner_text() == "Ask Tidy"
            assert tab.locator("#capture-text").is_visible()
            assert not tab.locator("#capture-text").evaluate("node => node === document.activeElement")
            assert tab.locator(".app-nav [data-view]").evaluate_all("nodes => nodes.map(node => node.dataset.view)") == [
                "assistant", "today", "family", "meals", "shopping", "calendar"]
            tab.locator('[data-view="meals"]').click()
            home(tab)
            tab.evaluate("location.hash='not-a-section'")
            tab.wait_for_function("location.hash === '#assistant'")
            destination(tab, "assistant")
            tab.locator('[data-view="calendar"]').click()
            tab.evaluate("location.hash=''")
            tab.wait_for_function("location.hash === '#assistant'")
            destination(tab, "assistant")
            assert state(tab) == before
            return {"askTidyIsStartingPage": True, "sixMainButtons": True,
                    "brandAndUnknownOrEmptyRoutesReturnHome": True, "noAutomaticKeyboardFocus": True,
                    "navigationDoesNotChangeData": True}

        run("Ask Tidy opens first and the brand, empty routes and unknown routes return to it", start_and_return)

        def explicit_links(context):
            tab = page(context, "#calendar")
            destination(tab, "calendar")
            before = state(tab)
            tab.locator('[data-view="today"]').click()
            destination(tab, "today")
            home(tab)
            tab.go_back()
            destination(tab, "today")
            tab.go_back()
            destination(tab, "calendar")
            tab.go_forward()
            destination(tab, "today")
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            destination(tab, "today")
            assert state(tab) == before
            return {"explicitCalendarAndTodayRespected": True, "browserHistoryWorks": True,
                    "reloadKeepsExplicitRoute": True, "dataUnchanged": True}

        run("Explicit section links, reload, Back and Forward retain their intended destinations", explicit_links)

        def contextual_calendar(context):
            tab = page(context)
            destination(tab, "assistant")
            assert not tab.locator("#calendar-onboarding-dialog").is_visible()
            before = state(tab)
            tab.locator('[data-view="calendar"]').click()
            assert tab.locator("#calendar-onboarding-dialog").is_visible()
            tab.locator("#calendar-onboarding-later").click()
            home(tab)
            tab.locator('[data-view="calendar"]').click()
            assert not tab.locator("#calendar-onboarding-dialog").is_visible()
            assert state(tab) == before
            return {"firstScreenIsUnblocked": True, "calendarExplanationAppearsWhenRelevant": True,
                    "notNowPersists": True, "noCalendarConnectionInvented": True}

        run("Calendar setup waits until Calendar is opened and never covers the Ask Tidy starting screen", contextual_calendar)

        def navigation_requests(context):
            tab = page(context)
            before = state(tab)
            for text, view in [("Show my groceries", "shopping"), ("Open my calendar", "calendar"),
                               ("Show my tasks", "family"), ("Show my requests", "requests"),
                               ("Show today", "today")]:
                ask(tab, text)
                destination(tab, view)
                assert tab.locator("#assistant-activity").is_visible()
                assert tab.locator("#assistant-activity-reply").inner_text().strip()
                assert not tab.locator("#assistant-clarify-dialog").is_visible()
                assert state(tab) == before
            return {"fiveExplicitSectionRequestsOpenTheirPages": True, "visibleReplyForEach": True,
                    "navigationDoesNotCreateTasks": True}

        run("Ask Tidy opens the requested section without saving navigation commands as tasks", navigation_requests)

        def meal_request(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "I want to eat tomato pasta for 2")
            destination(tab, "meals")
            meal = menu_draft(tab)
            assert meal["recipeId"] == "tomato-pasta" and meal["people"] == 2
            assert meal["status"] == "draft" and meal["approvedAt"] is None
            assert {item["ingredientId"]: item["amount"] for item in meal["items"]} == {
                "pasta": 180, "tinnedTomatoes": 300, "oliveOil": 10}
            assert tab.locator("#quick-menu-review").is_visible()
            assert tab.locator("#assistant-activity").is_visible()
            assert state(tab)["tasks"] == before["tasks"] and state(tab)["actions"] == before["actions"]
            assert saved(tab)["menuHelper"]["draft"] == meal
            tab.locator("#quick-menu-approve").click()
            destination(tab, "shopping")
            assert menu_draft(tab)["status"] == "approved"
            assert "180" in tab.locator("#quick-menu-shopping-items").inner_text()
            assert not external
            return {"oneRequestPreparesRealEditableIngredients": True, "servingsPreserved": 2,
                    "noTaskOrOrderInvented": True, "groceryApprovalStillExplicit": True}

        run("A meal request in Ask Tidy prepares ingredients in Menu and still waits for grocery approval", meal_request)

        def replacement(context):
            tab = page(context)
            ask(tab, "I want to eat tomato pasta")
            tab.locator("#quick-menu-approve").click()
            original = menu_draft(tab)
            ask(tab, "I want to eat tomato pasta")
            assert menu_draft(tab) == original
            assert menu_draft(tab)["status"] == "approved"
            if tab.locator("#quick-menu-replacement").is_visible():
                tab.locator("#quick-menu-keep").click()
            ask(tab, "I want to eat chicken and rice")
            destination(tab, "meals")
            assert tab.locator("#quick-menu-replacement").is_visible()
            assert menu_draft(tab) == original
            assert saved(tab)["menuHelper"]["draft"] == original
            tab.locator("#quick-menu-keep").click()
            assert menu_draft(tab) == original
            ask(tab, "I want to eat chicken and rice")
            tab.locator("#quick-menu-replace").click()
            assert menu_draft(tab)["recipeId"] == "chicken-rice"
            assert menu_draft(tab)["status"] == "draft"
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status === 'done'")
            reply = tab.locator("#assistant-activity-reply").inner_text().lower()
            assert "chicken and rice" in reply and "still kept" not in reply, reply
            return {"approvedMealNotSilentlyOverwritten": True, "keepRetainsOriginal": True,
                    "replacementNeedsItsOwnApproval": True, "replyUpdatesAfterReplacementChoice": True}

        run("Asking for another meal retains the approved shopping list until replacement is confirmed", replacement)

        def unfinished_meal(context):
            tab = page(context)
            ask(tab, "I want to eat tomato pasta")
            original = menu_draft(tab)
            amount = tab.locator('#quick-menu-items [data-ingredient-id="pasta"] [data-field="amount"]')
            amount.fill("0")
            amount.dispatch_event("change")
            ask(tab, "I want to eat chicken and rice")
            destination(tab, "meals")
            assert menu_draft(tab) == original
            assert amount.input_value() == "0"
            assert re.search(r"unfinished|review|kept", tab.locator("#assistant-activity-reply").inner_text(), re.I)
            tab.locator("#quick-menu-reload").click()
            tab.locator("#quick-menu-request").fill("Spaghetti with tomato for 3")
            ask(tab, "I want to eat chicken and rice")
            assert menu_draft(tab) == original
            assert tab.locator("#quick-menu-request").input_value() == "Spaghetti with tomato for 3"
            return {"invalidPendingIngredientEditKept": True, "unsavedMealTextKept": True,
                    "askingForNewMealDoesNotSilentlyDiscardWork": True}

        run("A new meal request preserves unfinished Menu edits and typed meal choices", unfinished_meal)

        def unknown_meal(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "I want to eat mushroom risotto")
            destination(tab, "meals")
            assert tab.locator("#quick-menu-choices").is_visible()
            assert tab.locator("#quick-menu-choices button").count() > 0
            assert not tab.locator("#task-dialog").is_visible()
            assert menu_draft(tab) is None
            assert state(tab)["tasks"] == before["tasks"]
            assert state(tab)["actions"] == before["actions"]
            tab.locator("#quick-menu-choices button").first.click()
            assert menu_draft(tab) is not None
            assert menu_draft(tab)["status"] == "draft"
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status === 'done'")
            assert menu_draft(tab)["name"].lower() in tab.locator("#assistant-activity-reply").inner_text().lower()
            return {"unknownMealOffersSupportedChoices": True, "noManualIngredientInterview": True,
                    "unknownRequestNotSavedAsTask": True, "replyUpdatesAfterRecipeChoice": True}

        run("An unknown meal opens supported recipe choices instead of becoming a task or demanding a recipe", unknown_meal)

        def initial_planning(context):
            tab = page(context)
            before = state(tab)
            ask(tab, "Organise my day")
            destination(tab, "planning-settings")
            assert not tab.locator("#planning-enabled").is_checked()
            assert state(tab) == before
            assert re.search(r"hours|routine|set.*up|confirm", tab.locator("#assistant-activity-reply").inner_text(), re.I)
            return {"unconfirmedHoursNeedSetup": True, "noScheduleInvented": True,
                    "navigationLeavesSavedDataUnchanged": True}

        run("Plan my day opens confirmed-hours setup when scheduling has not been enabled", initial_planning)

        def confirmed_planning(context):
            tab = page(context)
            configure_hours(tab)
            flexible = add_task(tab, "Check school books")
            fixed = add_task(tab, "Family appointment", kind="appointment", date=DAY, time="18:30")
            before = state(tab)
            ask(tab, "Organise my day")
            destination(tab, "planning")
            planned = next(item for item in state(tab)["tasks"] if item["id"] == flexible["id"])
            assert planned["dueDate"] == DAY and planned["dueTime"] >= "17:00", planned
            assert planned["remindAt"] is not None and planned["durationMinutes"] > 0
            unchanged = next(item for item in state(tab)["tasks"] if item["id"] == fixed["id"])
            assert unchanged == fixed
            assert len(state(tab)["tasks"]) == len(before["tasks"])
            assert saved(tab)["tasks"] == state(tab)["tasks"]
            assert tab.locator("#assistant-activity").is_visible()
            return {"existingFlexibleTaskActuallyScheduled": planned["dueTime"],
                    "fixedAppointmentPreserved": True, "existingPlannerUsedWithoutExtraTasks": True}

        run("Plan my day uses confirmed hours to schedule saved tasks and preserves fixed appointments", confirmed_planning)

        def saved_overview(context):
            tab = page(context)
            ask(tab, "Remind me to check school books today at 6 pm")
            ask(tab, "Remind me to prepare school bags today at 7 pm")
            ask(tab, "We need ketchup")
            ask(tab, "Buy a laptop")
            before = state(tab)
            home(tab)
            summary = tab.locator("#assistant-overview-summary").inner_text().lower()
            assert tab.locator("#assistant-overview-summary").get_attribute("data-due-today") == "2", summary
            assert tab.locator("#assistant-overview-summary").get_attribute("data-groceries") == "1", summary
            assert tab.locator("#assistant-overview-summary").get_attribute("data-requests") == "1", summary
            assert re.search(r"today|due", summary), summary
            assert re.search(r"grocer|shopping", summary), summary
            assert re.search(r"review|request|approval", summary), summary
            listed = tab.locator("#assistant-overview-items").inner_text().lower()
            assert "school books" in listed and "school bags" in listed, listed
            assert tab.locator("#assistant-overview-items > *").count() <= 3
            tab.locator("#assistant-review-requests").click()
            destination(tab, "requests")
            assert len(state(tab)["actions"]) == 1
            home(tab)
            tab.locator("#assistant-view-today").click()
            destination(tab, "today")
            assert state(tab) == before
            return {"overviewUsesActualSavedItems": True, "dueTasksListed": 2,
                    "groceryAndApprovalCountsShown": True, "overviewLinksDoNotChangeData": True}

        run("Ask Tidy summarizes actual saved commitments, grocery needs and requests awaiting review", saved_overview)

        def quota(context):
            tab = page(context)
            before = saved(tab)
            tab.evaluate("window.__rejectTidyWrites=true")
            ask(tab, "I want to eat tomato pasta")
            destination(tab, "meals")
            assert menu_draft(tab) is not None
            assert saved(tab) == before
            assert tab.locator("#storage-warning").is_visible()
            assert re.search(r"not saved|couldn.t save|this tab|backup", tab.locator("#assistant-activity-reply").inner_text(), re.I)
            tab.locator("#open-settings").click()
            with tab.expect_download() as downloading:
                tab.locator("#export-backup").click()
            backup = json.loads(Path(downloading.value.path()).read_text())
            assert backup["menuHelper"]["draft"] == menu_draft(tab)
            return {"failedMealSaveIsReportedHonestly": True, "previousSavedCopyUnchanged": True,
                    "inMemoryDraftRecoverableInBackup": True}

        run("A meal requested through Ask Tidy remains recoverable when browser saving fails", quota)

        def phone(context):
            tab = page(context)
            destination(tab, "assistant")
            assert tab.locator("#capture-text").is_visible()
            assert not tab.locator("#capture-text").evaluate("node=>node===document.activeElement")
            for selector in ["#main-navigation", "#view-assistant", "#capture-form", "#assistant-overview"]:
                no_overflow(tab, selector)
            assert tab.locator("#main-navigation").evaluate("node=>getComputedStyle(node).gridTemplateColumns.split(' ').length") == 3
            tab.screenshot(path=str(args.output / f"assistant-home-{tab.viewport_size['width']}.png"), full_page=True)
            ask(tab, "We need ketchup")
            destination(tab, "shopping")
            assert state(tab)["tasks"][0]["title"].lower() == "ketchup"
            assert tab.locator("#assistant-activity-reply").is_visible()
            home(tab)
            tab.locator('[data-example="I want to eat tomato pasta"]').click()
            assert tab.locator("#capture-text").input_value() == "I want to eat tomato pasta"
            tab.locator('#capture-form button[type="submit"]').click()
            tab.wait_for_function("!document.getElementById('view-meals').hidden && TidyDemo.getState().menuHelper?.draft?.recipeId === 'tomato-pasta' && !document.getElementById('capture-form').hasAttribute('aria-busy')")
            assert menu_draft(tab)["recipeId"] == "tomato-pasta"
            no_overflow(tab, "#view-meals")
            return {"width": tab.viewport_size["width"], "homeHasNoHorizontalOverflow": True,
                    "realGroceryCaptureWorks": True, "mealQuickActionPerformsItsAction": True}

        run("320px phones can start from Ask Tidy, capture groceries and prepare a meal", phone, width=320)
        run("390px phones can start from Ask Tidy, capture groceries and prepare a meal", phone, width=390)

        browser.close()

    report = {"url": args.url, "sourceHashes": source_hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": external,
              "scope": "Synthetic browser UI/local data only; no real accounts, AI service, orders or closed-app reminders."}
    report_name = "live-report.json" if selected[0] == "https" else "local-report.json"
    path = args.output / report_name
    path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(external), "report": str(path)}), flush=True)
    raise SystemExit(0 if results and passed == len(results) and not errors else 1)


if __name__ == "__main__":
    main()
