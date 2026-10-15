"""Exercise Tidy's focused function pages and separate weekday meal plans.

Pass --url for a locally served web/ directory or its published deployment.
Each case starts with synthetic browser storage. Only that exact Tidy origin
reaches the network. Real retailer compatibility, native phone notifications,
cloud syncing and purchases are outside these browser UI checks.
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
OUT = ROOT / ".qa-results" / "sections"
KEY = "tidy.app.v1"
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
HUB_PAGES = ["meals", "shopping", "stores", "appointments", "routines",
             "household", "requests", "health", "inbox", "upcoming"]
PRIMARY_CONTROLS = {
    "meals": "#meal-tab-breakfast", "shopping": "#shopping-card",
    "stores": "#provider-list", "appointments": "#appointments-add",
    "routines": "#add-routine", "household": "#add-member",
    "requests": "#new-action", "health": "#health-square-form",
    "inbox": "#inbox-tasks", "upcoming": "#upcoming-tasks",
}
FIXTURE = """(() => {
  window.__rejectTidyWrites = false;
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled regression fixture quota failure', 'QuotaExceededError');
    return set.call(this, key, value);
  };
})();"""


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def saved(tab):
    return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def state(tab):
    return tab.evaluate("TidyDemo.getState()")


def section(tab, name):
    tab.locator('[data-view="tools"]').click()
    tab.locator(f'#view-tools [data-go="{name}"]').click()


def destination(tab, name):
    assert tab.locator("section.view:visible").count() == 1
    assert tab.locator("section.view:visible").get_attribute("id") == "view-" + name
    assert tab.url.split("#", 1)[1].split("/", 1)[0] == name, tab.url


def meal(tab, kind):
    section(tab, "meals")
    tab.locator(f'[data-meal="{kind}"]').click()
    assert tab.url.endswith("#meals/" + kind), tab.url
    assert tab.locator(".meal-slide:visible").count() == 1
    assert tab.locator(".meal-slide:visible").get_attribute("id") == "meal-slide-" + kind


def fill_plan(tab, kind, values):
    meal(tab, kind)
    for day, value in values.items():
        tab.locator(f"#{kind}-{day.lower()}").fill(value)


def submit_plan(tab, kind):
    tab.locator(f"#{kind}-save").click()


def download_backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as download:
        tab.locator("#export-backup").click()
    data = json.loads(Path(download.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return data


def import_backup(tab, data):
    tab.locator("#open-settings").click()
    tab.locator("#import-backup").set_input_files({"name": "synthetic-tidy-backup.json", "mimeType": "application/json", "buffer": json.dumps(data).encode()})


def assert_no_overflow(tab, selector):
    bounds = tab.locator(selector).evaluate("""node => ({
      client:node.clientWidth, scroll:node.scrollWidth,
      document:document.documentElement.scrollWidth, viewport:innerWidth
    })""")
    assert bounds["scroll"] <= bounds["client"] + 1, bounds
    assert bounds["document"] <= bounds["viewport"] + 1, bounds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9045/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    OUT.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    source_hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest()
                     for name in ["index.html", "styles.css", "core.js", "app.js", "meals.html"]}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def page(context, suffix=""):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: errors.append(str(problem)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc))
            tab.goto(args.url + suffix)
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            return tab

        def run(name, check, width=1100):
            if args.case and not any(pattern.casefold() in name.casefold() for pattern in args.case):
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
                        tab.screenshot(path=str(OUT / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()) + f"-{index}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def focused_navigation(context):
            tab = page(context)
            assert tab.locator(".app-nav [data-view]").count() == 5
            for view in ["today", "assistant", "family", "reminders", "tools"]:
                tab.locator(f'[data-view="{view}"]').click()
                destination(tab, view)
                assert tab.locator('.app-nav [aria-current="page"]').get_attribute("data-view") == view
            assert sorted(tab.locator("#view-tools [data-go]").evaluate_all("nodes=>nodes.map(node=>node.dataset.go)")) == sorted(HUB_PAGES)
            assert tab.locator("#view-tools form").count() == 0
            for name in HUB_PAGES:
                section(tab, name)
                destination(tab, name)
                assert tab.locator(PRIMARY_CONTROLS[name]).is_visible()
                for other, selector in PRIMARY_CONTROLS.items():
                    if other != name:
                        assert not tab.locator(selector).is_visible(), (name, selector)
                assert tab.locator('.app-nav [aria-current="page"]').get_attribute("data-view") == "tools"
                tab.reload()
                tab.wait_for_function("!!window.TidyDemo")
                destination(tab, name)
                tab.locator(f'#view-{name} .section-back').click()
                destination(tab, "tools")
            return {"mainDestinations": 5, "focusedHubDestinations": len(HUB_PAGES), "deepLinksAndBackButtons": True}

        run("Each navigation button opens one focused page and the section hub contains only destinations", focused_navigation)

        def useful_controls(context):
            tab = page(context)
            tab.locator('[data-view="reminders"]').click()
            tab.locator("#reminders-add").click()
            tab.locator("#task-title").fill("Take a family break")
            tab.locator("#task-date").fill("2026-10-16")
            tab.locator("#task-time").fill("18:00")
            assert tab.locator("#task-reminder").is_checked()
            tab.locator("#save-task").click()
            tab.wait_for_function("TidyDemo.getState().tasks.some(task=>task.title==='Take a family break' && task.remindAt!==null)")
            destination(tab, "reminders")
            section(tab, "appointments")
            tab.locator("#appointments-add").click()
            tab.locator("#task-title").fill("Dentist checkup")
            tab.locator("#task-date").fill("2026-10-17")
            tab.locator("#task-time").fill("10:00")
            tab.locator("#save-task").click()
            tab.wait_for_function("TidyDemo.getState().tasks.some(task=>task.title==='Dentist checkup' && task.type==='appointment')")
            destination(tab, "appointments")
            section(tab, "routines")
            tab.locator("#add-routine").click()
            tab.locator("#task-title").fill("Prepare school bags")
            tab.locator("#save-task").click()
            section(tab, "household")
            tab.locator("#add-member").click()
            tab.locator("#member-name").fill("Grandma")
            tab.locator('#member-form button[type="submit"]').click()
            assert "Grandma" in tab.locator("#member-list").inner_text()
            section(tab, "requests")
            tab.locator("#new-action").click()
            tab.locator("#action-title").fill("Review dinner ingredients")
            tab.locator('#action-form button[type="submit"]').click()
            assert "Review dinner ingredients" in tab.locator("#action-list").inner_text()
            data = saved(tab)
            assert len(data["tasks"]) == 3 and len(data["actions"]) == 1
            assert data["actions"][0]["status"] == "needs_review"
            assert any(task["repeat"] == "weekly" for task in data["tasks"])
            return {"notification": True, "appointmentRecordOnly": True, "weeklyRoutine": True, "householdName": True, "reviewableRequestOnly": True}

        run("Focused notification, appointment, routine, household and request controls perform their local functions", useful_controls)

        def ask_grocery(context):
            tab = page(context)
            tab.locator('[data-view="assistant"]').click()
            tab.locator("#capture-text").fill("We need ketchup")
            tab.locator('#capture-form button[type="submit"]').click()
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status==='done'")
            destination(tab, "shopping")
            task, = saved(tab)["tasks"]
            assert task["type"] == "grocery" and task["title"] == "ketchup"
            assert tab.locator(f'#shopping-tasks [data-task-id="{task["id"]}"]').is_visible()
            tab.locator('#view-shopping [data-go="stores"]').click()
            destination(tab, "stores")
            names = tab.locator("#provider-list button").all_text_contents()
            assert names == ["Waitrose UAE", "Kibsons", "Carrefour UAE", "Amazon UAE"], names
            assert not tab.locator("#shopping-card").is_visible()
            return {"requestShowsSavedShoppingItem": True, "storesSeparate": names}

        run("Ask Tidy opens the shopping list for groceries and shopping websites remain a separate function", ask_grocery)

        def plans_and_reload(context):
            tab = page(context)
            dinner_before = state(tab)["mealSnapshot"]
            breakfast = dict(zip(DAYS, ["Eggs and toast", "Porridge", "Yogurt and fruit", "Cheese toast", "Pancakes"]))
            lunch = dict(zip(DAYS, ["Chicken and rice", "Pasta", "Fish sandwich", "Vegetable soup", "<img src=x onerror=alert(1)>"]))
            for kind, choices in [("breakfast", breakfast), ("lunch", lunch)]:
                fill_plan(tab, kind, choices)
                assert tab.locator(f"#{kind}-monday").get_attribute("maxlength") == "300"
                submit_plan(tab, kind)
                assert saved(tab)["mealPlans"][kind] == choices
                assert "saved" in tab.locator(f"#{kind}-status").inner_text().lower()
                tab.reload()
                tab.wait_for_function("!!window.TidyDemo")
                assert tab.url.endswith("#meals/" + kind)
                assert tab.locator(f"#{kind}-friday").input_value() == choices["Friday"]
            assert saved(tab)["mealSnapshot"] == dinner_before
            assert tab.locator("#meal-slide-lunch img").count() == 0
            meal(tab, "breakfast")
            assert tab.locator("#breakfast-monday").input_value() == breakfast["Monday"]
            return {"independentWeekdayPlans": 2, "reloadAndMealDeepLink": True, "dinnerUnchanged": True, "typedMarkupInert": True}

        run("Breakfast and lunch weekday choices save independently, survive reload and preserve dinner data", plans_and_reload)

        def backup_roundtrip(context):
            tab = page(context)
            for kind, text in [("breakfast", "Toast"), ("lunch", "Chicken rice")]:
                fill_plan(tab, kind, {"Monday": text})
                submit_plan(tab, kind)
            backup = download_backup(tab)
            expected = backup["mealPlans"]
            fill_plan(tab, "breakfast", {"Monday": "Changed breakfast"})
            submit_plan(tab, "breakfast")
            import_backup(tab, backup)
            tab.wait_for_function("TidyDemo.getState().mealPlans?.breakfast?.Monday==='Toast'")
            assert saved(tab)["mealPlans"] == expected
            tab.locator('[data-close="settings-dialog"]').click()
            meal(tab, "breakfast")
            assert tab.locator("#breakfast-monday").input_value() == "Toast"
            bad = json.loads(json.dumps(backup))
            bad["mealPlans"]["lunch"]["Monday"] = "x" * 301
            before = tab.evaluate("localStorage.getItem('tidy.app.v1')")
            import_backup(tab, bad)
            tab.locator("#backup-error").wait_for(state="visible")
            assert tab.evaluate("localStorage.getItem('tidy.app.v1')") == before
            assert state(tab)["mealPlans"] == expected
            return {"bothPlansInBackup": True, "restoreUpdatesForm": True, "invalidPlanRejectedWithoutReplacingData": True}

        run("Whole-app backup restores both meal plans and rejects an oversized meal name without replacing saved data", backup_roundtrip)

        def disjoint_edits(context):
            a, b = page(context), page(context)
            fill_plan(b, "breakfast", {"Tuesday": "Porridge"})
            fill_plan(a, "breakfast", {"Monday": "Eggs"})
            submit_plan(a, "breakfast")
            b.wait_for_function("TidyDemo.getState().mealPlans?.breakfast?.Monday==='Eggs'")
            assert b.locator("#breakfast-tuesday").input_value() == "Porridge"
            submit_plan(b, "breakfast")
            assert saved(b)["mealPlans"]["breakfast"]["Monday"] == "Eggs"
            assert saved(b)["mealPlans"]["breakfast"]["Tuesday"] == "Porridge"
            a.wait_for_function("TidyDemo.getState().mealPlans?.breakfast?.Tuesday==='Porridge'")
            fill_plan(a, "lunch", {"Wednesday": "Pasta"})
            fill_plan(b, "breakfast", {"Friday": "Toast"})
            submit_plan(a, "lunch")
            b.wait_for_function("TidyDemo.getState().mealPlans?.lunch?.Wednesday==='Pasta'")
            assert b.locator("#breakfast-friday").input_value() == "Toast"
            submit_plan(b, "breakfast")
            assert saved(b)["mealPlans"]["lunch"]["Wednesday"] == "Pasta"
            assert saved(b)["mealPlans"]["breakfast"]["Friday"] == "Toast"
            return {"typedFormPreservedAcrossRemoteUpdate": True, "differentDaysMerged": True, "differentMealTypesMerged": True}

        run("Two tabs preserve typed meals and merge edits to different weekdays or meal types", disjoint_edits)

        def conflict(context):
            a = page(context)
            fill_plan(a, "lunch", {"Monday": "Pasta"})
            submit_plan(a, "lunch")
            b = page(context)
            fill_plan(b, "lunch", {"Monday": "Rice"})
            fill_plan(a, "lunch", {"Monday": "Fish"})
            submit_plan(a, "lunch")
            b.wait_for_function("TidyDemo.getState().mealPlans?.lunch?.Monday==='Fish'")
            assert b.locator("#lunch-monday").input_value() == "Rice"
            before = b.evaluate("localStorage.getItem('tidy.app.v1')")
            submit_plan(b, "lunch")
            assert b.locator("#lunch-error").is_visible()
            assert "another tab" in b.locator("#lunch-error").inner_text().lower()
            assert b.locator("#lunch-monday").input_value() == "Rice"
            assert b.evaluate("localStorage.getItem('tidy.app.v1')") == before
            assert saved(b)["mealPlans"]["lunch"]["Monday"] == "Fish"
            return {"conflictVisible": True, "typedChoiceKept": True, "remoteChoiceNotOverwritten": True}

        run("Conflicting edits to the same meal day show an error and retain both the typed form and saved version", conflict)

        def quota(context):
            tab = page(context)
            before = saved(tab)
            fill_plan(tab, "breakfast", {"Monday": "Eggs and toast"})
            tab.evaluate("__rejectTidyWrites=true")
            submit_plan(tab, "breakfast")
            assert saved(tab) == before
            assert tab.locator("#breakfast-monday").input_value() == "Eggs and toast"
            status = tab.locator("#breakfast-status").inner_text().lower()
            assert re.search(r"not saved|saving needs attention|tab only", status), status
            assert tab.locator("#storage-warning").is_visible()
            backup = download_backup(tab)
            assert backup["mealPlans"]["breakfast"]["Monday"] == "Eggs and toast"
            tab.evaluate("__rejectTidyWrites=false")
            tab.locator("#breakfast-monday").fill("Toast")
            submit_plan(tab, "breakfast")
            assert not tab.locator("#breakfast-error").is_visible()
            assert saved(tab)["mealPlans"]["breakfast"]["Monday"] == "Toast"
            assert {key: value for key, value in saved(tab).items() if key != "mealPlans"} == {
                key: value for key, value in before.items() if key != "mealPlans"}
            assert not tab.locator("#storage-warning").is_visible()
            assert tab.locator("#save-status").inner_text() == "Saved on this browser"
            assert "plan saved" in tab.locator("#breakfast-status").inner_text().lower()
            return {"previousSavedCopyUnchanged": True, "unsavedMealRecoverableInBackup": True,
                    "editedRetryAfterStorageRecovery": "Toast", "otherDataPreserved": True,
                    "failureWarningCleared": True}

        run("Storage failure retains the entered meal and exports the unsaved choice without false saved status", quota)

        def phone_slides(context):
            tab = page(context)
            section(tab, "meals")
            assert_no_overflow(tab, "#view-meals")
            assert tab.locator("#meal-previous").is_disabled()
            tab.locator('[data-meal="breakfast"]').focus()
            tab.keyboard.press("ArrowRight")
            assert tab.locator('[data-meal="lunch"]').get_attribute("aria-selected") == "true"
            assert tab.locator('[data-meal="lunch"]').evaluate("node=>node===document.activeElement")
            tab.keyboard.press("End")
            assert tab.locator('[data-meal="dinner"]').get_attribute("aria-selected") == "true"
            assert tab.locator("#meal-next").is_disabled()
            tab.keyboard.press("Home")
            assert tab.locator('[data-meal="breakfast"]').get_attribute("aria-selected") == "true"
            tab.locator("#meal-next").click()
            assert tab.url.endswith("#meals/lunch")
            tab.locator("#meal-previous").click()
            assert tab.url.endswith("#meals/breakfast")
            tab.locator("#breakfast-monday").fill("Eggs and toast")
            submit_plan(tab, "breakfast")
            meal(tab, "dinner")
            tab.locator("#show-meals").click()
            dinner = tab.frame_locator("#meals-frame")
            dinner.locator("#people").fill("4")
            dinner.locator("#diet").select_option("mixed")
            dinner.locator("#no-allergies").check()
            dinner.locator("#suggest-menu").click()
            dinner.locator("#approve-menu").wait_for(state="visible")
            assert_no_overflow(tab, "#view-meals")
            assert_no_overflow(tab, "#meal-slide-dinner")
            dinner.locator("#approve-menu").click()
            tab.wait_for_function("TidyDemo.getState().mealSnapshot?.state.menuApproved===true")
            assert saved(tab)["mealPlans"]["breakfast"]["Monday"] == "Eggs and toast"
            assert len(saved(tab)["mealSummary"]) == 5
            tab.screenshot(path=str(OUT / "meals-320.png"))
            return {"width": 320, "keyboardTabNavigation": True, "previousNext": True, "originalDinnerPlannerWorks": True, "noHorizontalOverflow": True}

        run("320px meal slides support keyboard and previous or next navigation while the dinner planner still works", phone_slides, width=320)
        browser.close()

    report = {"url": args.url, "sourceHashes": source_hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": external,
              "scope": "Isolated browser UI and local data; no retailer transactions, native iPhone alarms or real-device compatibility."}
    suffix = "live" if args.url.startswith("https://") else "local"
    report_path = OUT / (suffix + "-report.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(external), "report": str(report_path)}))
    raise SystemExit(1 if not results or passed != len(results) or errors or external else 0)


if __name__ == "__main__":
    main()
