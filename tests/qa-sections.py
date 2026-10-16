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
HUB_PAGES = ["meals", "shopping", "family", "reminders", "stores", "appointments", "routines",
             "household", "requests", "health", "inbox", "upcoming",
             "calendar", "planning", "planning-settings"]
NAV_PAGES = ["today", "assistant", "family", "meals", "shopping", "reminders",
             "appointments", "calendar", "planning", "routines", "stores",
             "household", "requests", "health", "inbox", "upcoming",
             "planning-settings", "tools"]
PRIMARY_CONTROLS = {
    "meals": "#meal-tab-breakfast", "shopping": "#grocery-form",
    "family": "#family-add", "reminders": "#reminders-add",
    "stores": "#provider-list", "appointments": "#appointments-add",
    "routines": "#add-routine", "household": "#add-member",
    "requests": "#new-action", "health": "#health-square-form",
    "inbox": "#inbox-tasks", "upcoming": "#upcoming-tasks",
    "calendar": "#calendar-file", "planning": "#planning-run",
    "planning-settings": "#planning-settings-save",
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
    assert tab.locator('.app-nav [aria-current="page"]').count() == 1
    assert tab.locator('.app-nav [aria-current="page"]').get_attribute("data-view") == name


def navigation_item_visible(tab, name):
    item = tab.locator(f'.app-nav [data-view="{name}"]')
    tab.wait_for_function("""name => {
      const nav = document.getElementById('main-navigation');
      const item = [...nav.querySelectorAll('[data-view]')].find(node=>node.dataset.view===name);
      const n = nav.getBoundingClientRect(), b = item.getBoundingClientRect();
      return b.left >= n.left - 1 && b.right <= n.right + 1;
    }""", arg=name)
    return item


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


def grocery(tab, title, quantity=""):
    tab.locator("#grocery-title").fill(title)
    tab.locator("#grocery-quantity").fill(quantity)
    tab.locator("#grocery-add").click()


def full_task_editor(tab):
    if tab.locator("#assistant-clarify-dialog").is_visible():
        tab.locator("#assistant-clarify-details").click()
    tab.locator("#task-dialog").wait_for(state="visible")


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
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    args.output.mkdir(parents=True, exist_ok=True)
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
            if tab.locator("#calendar-onboarding-dialog").is_visible():
                tab.locator("#calendar-onboarding-later").click()
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
                        tab.screenshot(path=str(args.output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()) + f"-{index}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def focused_navigation(context):
            tab = page(context)
            before = state(tab)
            destination(tab, "today")
            assert tab.locator(".app-nav [data-view]").count() == len(NAV_PAGES)
            assert tab.locator(".app-nav [data-view]").evaluate_all("nodes=>nodes.map(node=>node.dataset.view)") == NAV_PAGES
            assert tab.locator(".app-nav").get_attribute("aria-label") == "Main navigation"
            assert tab.locator('.app-nav [data-view="meals"]').inner_text().strip().endswith("Menu")
            assert tab.locator('.app-nav [data-view="shopping"]').inner_text().strip().endswith("Groceries")
            for view in NAV_PAGES:
                tab.locator(f'.app-nav [data-view="{view}"]').click()
                destination(tab, view)
                assert tab.locator(f"#view-{view} h1").evaluate("node=>node===document.activeElement")
                navigation_item_visible(tab, view)
            assert state(tab) == before
            assert sorted(tab.locator("#view-tools [data-go]").evaluate_all("nodes=>nodes.map(node=>node.dataset.go)")) == sorted(HUB_PAGES)
            assert tab.locator("#view-tools form").count() == 0
            for name in HUB_PAGES:
                section(tab, name)
                destination(tab, name)
                assert tab.locator(PRIMARY_CONTROLS[name]).is_visible()
                for other, selector in PRIMARY_CONTROLS.items():
                    if other != name:
                        assert not tab.locator(selector).is_visible(), (name, selector)
                tab.reload()
                tab.wait_for_function("!!window.TidyDemo")
                destination(tab, name)
                navigation_item_visible(tab, name)
                tab.locator(f'#view-{name} .section-back').click()
                destination(tab, "tools")
            assert state(tab) == before
            return {"mainDestinations": len(NAV_PAGES), "oneVisibleFunctionAtATime": True,
                    "everyMainButtonFocusesItsHeading": True, "navigationDoesNotModifyData": True,
                    "focusedHubDestinations": len(HUB_PAGES), "deepLinksAndBackButtons": True}

        run("All 18 main navigation buttons open one focused page directly and preserve saved data", focused_navigation)

        def phone_navigation(context):
            tab = page(context)
            before = state(tab)
            destination(tab, "today")
            nav = tab.locator("#main-navigation")
            assert nav.get_attribute("aria-describedby") == "navigation-hint"
            assert tab.locator("#navigation-hint").is_visible()
            dimensions = nav.evaluate("""node=>({client:node.clientWidth,scroll:node.scrollWidth,
              document:document.documentElement.scrollWidth,viewport:innerWidth,
              rows:[...new Set([...node.querySelectorAll('[data-view]')].map(item=>Math.round(item.getBoundingClientRect().top)))]})""")
            assert dimensions["scroll"] > dimensions["client"], dimensions
            assert dimensions["document"] <= dimensions["viewport"] + 1, dimensions
            assert len(dimensions["rows"]) == 1, dimensions
            assert tab.locator(".navigation-shell").evaluate("node=>getComputedStyle(node).position") == "fixed"
            assert tab.locator("#navigation-previous").is_disabled()
            assert not tab.locator("#navigation-next").is_disabled()
            start_scroll = nav.evaluate("node=>node.scrollLeft")
            tab.locator("#navigation-next").click()
            tab.wait_for_function("previous=>document.getElementById('main-navigation').scrollLeft>previous+20", arg=start_scroll)
            destination(tab, "today")
            assert not tab.locator("#navigation-previous").is_disabled()
            tab.locator("#navigation-previous").click()
            tab.wait_for_function("document.getElementById('main-navigation').scrollLeft<=1")
            destination(tab, "today")

            # This is navigation, rather than an ARIA tablist: arrow keys move
            # focus to a section name and Enter activates that actual page.
            tab.locator('.app-nav [data-view="today"]').focus()
            tab.keyboard.press("ArrowRight")
            assert tab.locator('.app-nav [data-view="assistant"]').evaluate("node=>node===document.activeElement")
            destination(tab, "today")
            tab.keyboard.press("End")
            assert tab.locator('.app-nav [data-view="tools"]').evaluate("node=>node===document.activeElement")
            navigation_item_visible(tab, "tools")
            destination(tab, "today")
            tab.keyboard.press("Enter")
            destination(tab, "tools")
            assert tab.locator("#tools-title").evaluate("node=>node===document.activeElement")
            tab.locator('.app-nav [data-view="tools"]').focus()
            tab.keyboard.press("Home")
            assert tab.locator('.app-nav [data-view="today"]').evaluate("node=>node===document.activeElement")
            destination(tab, "tools")
            tab.keyboard.press("Enter")
            destination(tab, "today")

            tab.locator('.app-nav [data-view="meals"]').click()
            destination(tab, "meals")
            navigation_item_visible(tab, "meals")
            assert tab.locator('.app-nav [data-view="meals"]').evaluate("node=>node.nextElementSibling.dataset.view") == "shopping"
            tab.locator('.app-nav [data-view="shopping"]').click()
            destination(tab, "shopping")
            navigation_item_visible(tab, "shopping")
            tab.evaluate("location.hash='planning-settings'")
            tab.wait_for_function("!document.getElementById('view-planning-settings').hidden")
            destination(tab, "planning-settings")
            navigation_item_visible(tab, "planning-settings")
            assert_no_overflow(tab, "#view-planning-settings")
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            destination(tab, "planning-settings")
            navigation_item_visible(tab, "planning-settings")
            assert state(tab) == before
            width = tab.viewport_size["width"]
            tab.screenshot(path=str(args.output / f"direct-navigation-{width}.png"))
            return {"width": width, "allFunctionsAreMainNavigationPeers": len(NAV_PAGES),
                    "menuAndGroceriesAdjacent": True, "singleScrollableNavigationRow": True,
                    "documentHasNoHorizontalOverflow": True, "scrollArrowsDoNotChangeSection": True,
                    "arrowKeyFocusAndEnterActivation": True, "activeDeepLinkRevealedAfterReload": True,
                    "savedDataUnchanged": True}

        run("320px direct main navigation scrolls, supports keyboard and reveals the active section", phone_navigation, width=320)
        run("390px direct main navigation scrolls, supports keyboard and reveals the active section", phone_navigation, width=390)

        def useful_controls(context):
            tab = page(context)
            tab.locator('[data-view="reminders"]').click()
            tab.locator("#reminders-add").click()
            full_task_editor(tab)
            tab.locator("#task-title").fill("Take a family break")
            tab.locator("#task-date").fill("2026-10-16")
            tab.locator("#task-time").fill("18:00")
            assert tab.locator("#task-reminder").is_checked()
            tab.locator("#save-task").click()
            tab.wait_for_function("TidyDemo.getState().tasks.some(task=>task.title==='Take a family break' && task.remindAt!==null)")
            destination(tab, "reminders")
            section(tab, "appointments")
            tab.locator("#appointments-add").click()
            full_task_editor(tab)
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

        def home_directory(context):
            tab = page(context)
            before = state(tab)
            destination(tab, "today")
            tab.locator('.app-nav [data-view="tools"]').click()
            destination(tab, "tools")
            assert tab.locator("#tools-title").inner_text() == "Home"
            groups = tab.locator("#view-tools .section-group")
            assert groups.count() == 4
            assert groups.first.locator("[data-go]").evaluate_all("nodes=>nodes.map(node=>node.dataset.go)") == ["meals", "shopping", "family", "reminders", "appointments", "calendar"]
            assert tab.locator("#view-tools [data-go=meals] strong").inner_text() == "Menu"
            assert tab.locator("#view-tools [data-go=shopping] strong").inner_text() == "Groceries"
            for name, heading in [("meals", "Menu"), ("shopping", "Groceries")]:
                section(tab, name)
                assert tab.locator(f"#view-{name} h1").inner_text() == heading
                tab.locator(".brand").click()
                destination(tab, "today")
            tab.locator('[data-view="today"]').click()
            assert tab.locator(".today-shortcuts button").count() == 2
            assert tab.locator("#today-meals").count() == 0
            assert tab.locator("#today-reminders").count() == 0
            assert tab.locator("#today-appointments").count() == 0
            assert state(tab) == before
            return {"todayFirst": True, "optionalHomeDirectory": True, "groupedDestinations": 15, "primarySections": 6,
                    "menuAndGroceriesDistinct": True, "navigationDoesNotModifyData": True,
                    "todayShortcuts": 2}

        run("Optional Home directory groups sections while Today remains the starting page", home_directory)

        def direct_groceries(context):
            tab = page(context)
            section(tab, "shopping")
            assert tab.locator("#grocery-title").get_attribute("maxlength") == "300"
            assert tab.locator("#grocery-quantity").get_attribute("maxlength") == "120"
            before = state(tab)
            grocery(tab, "   ")
            assert state(tab) == before
            assert tab.locator("#grocery-error").is_visible()
            grocery(tab, "Milk", "2 bottles")
            task, = saved(tab)["tasks"]
            assert task["type"] == "grocery" and task["category"] == "Shopping"
            assert task["title"] == "Milk" and task["quantity"] == "2 bottles"
            assert re.search(r"added|saved", tab.locator("#grocery-status").inner_text().lower())
            assert tab.locator("#grocery-title").input_value() == ""
            assert tab.locator("#grocery-quantity").input_value() == ""
            assert tab.locator("#grocery-title").evaluate("node=>node===document.activeElement")
            grocery(tab, "mILk", "2 bottles")
            assert len(saved(tab)["tasks"]) == 1
            assert saved(tab)["tasks"][0]["id"] == task["id"]
            grocery(tab, "MILK", "3 bottles")
            assert tab.locator("#grocery-error").is_visible()
            assert tab.locator("#grocery-title").input_value() == "MILK"
            assert tab.locator("#grocery-quantity").input_value() == "3 bottles"
            assert saved(tab)["tasks"] == [task]
            grocery(tab, "<img src=x onerror=alert(1)>", "1")
            assert len(saved(tab)["tasks"]) == 2
            assert tab.locator("#shopping-tasks img").count() == 0
            assert "<img src=x onerror=alert(1)>" in tab.locator("#shopping-tasks").inner_text()
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            destination(tab, "shopping")
            assert len(saved(tab)["tasks"]) == 2
            assert saved(tab)["actions"] == []
            return {"directListEntry": True, "caseInsensitiveDuplicate": True,
                    "conflictingQuantityNeedsReview": True, "typedMarkupInert": True,
                    "reloadAndNoProviderAction": True}

        run("Groceries adds directly, avoids duplicates and preserves quantities that need review", direct_groceries)

        def missing_quantity_and_tabs(context):
            a = page(context)
            section(a, "shopping")
            grocery(a, "Apples")
            original, = saved(a)["tasks"]
            b = page(context, "#shopping")
            grocery(b, "APPLES", "6")
            updated, = saved(b)["tasks"]
            assert updated["id"] == original["id"] and updated["quantity"] == "6"
            a.wait_for_function("TidyDemo.getState().tasks[0].quantity==='6'")
            a.locator("#grocery-title").fill("Eggs")
            a.locator("#grocery-quantity").fill("12")
            grocery(b, "Eggs", "12")
            a.wait_for_function("TidyDemo.getState().tasks.length===2")
            assert a.locator("#grocery-title").input_value() == "Eggs"
            assert a.locator("#grocery-quantity").input_value() == "12"
            a.locator("#grocery-add").click()
            assert len(saved(a)["tasks"]) == 2
            assert len({task["id"] for task in saved(a)["tasks"]}) == 2
            grocery(a, "Apples", "7")
            assert a.locator("#grocery-error").is_visible()
            assert next(task for task in saved(a)["tasks"] if task["id"] == original["id"])["quantity"] == "6"
            return {"missingQuantityUpdatedOnSameRecord": True, "typedEntrySurvivesRemoteUpdate": True,
                    "duplicateAddedInOtherTabNotRepeated": True, "latestQuantityKept": True}

        run("Grocery quantity updates and two-tab entry preserve identity and the latest list", missing_quantity_and_tabs)

        def checked_grocery_reopen(context):
            tab = page(context)
            section(tab, "family")
            tab.locator("#family-add").click()
            tab.locator("#task-title").fill("Tidy the desk")
            tab.locator("#save-task").click()
            ordinary, = saved(tab)["tasks"]
            tab.locator(f'#family-tasks [data-task-id="{ordinary["id"]}"]').get_by_role("button", name="Complete Tidy the desk", exact=True).click()
            section(tab, "shopping")
            assert not tab.locator("#grocery-completed-section").is_visible()
            grocery(tab, "Bananas", "4")
            original = next(task for task in saved(tab)["tasks"] if task["type"] == "grocery")
            tab.locator(f'#shopping-tasks [data-task-id="{original["id"]}"]').get_by_role("button", name="Complete Bananas", exact=True).click()
            assert tab.locator(f'#shopping-tasks [data-task-id="{original["id"]}"]').count() == 0
            checked = tab.locator("#grocery-completed-section")
            assert checked.is_visible()
            assert not checked.evaluate("node=>node.open")
            assert "1" in tab.locator("#grocery-completed-count").inner_text()
            checked.locator("summary").click()
            reopened_card = tab.locator(f'#grocery-completed-tasks [data-task-id="{original["id"]}"]')
            assert reopened_card.is_visible()
            assert tab.locator("#grocery-completed-tasks [data-task-id]").count() == 1
            assert "Tidy the desk" not in checked.inner_text()
            completed = next(task for task in saved(tab)["tasks"] if task["id"] == original["id"])
            assert completed["status"] == "done" and completed["quantity"] == "4"
            reopened_card.get_by_role("button", name="Reopen Bananas", exact=True).click()
            assert tab.locator(f'#shopping-tasks [data-task-id="{original["id"]}"]').is_visible()
            assert not checked.is_visible()
            restored = next(task for task in saved(tab)["tasks"] if task["id"] == original["id"])
            assert restored["status"] == "open" and restored["quantity"] == "4"
            assert restored["createdAt"] == original["createdAt"]
            assert len(saved(tab)["tasks"]) == 2
            assert next(task for task in saved(tab)["tasks"] if task["id"] == ordinary["id"])["status"] == "done"
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            assert tab.locator(f'#shopping-tasks [data-task-id="{original["id"]}"]').is_visible()
            assert not tab.locator("#grocery-completed-section").is_visible()
            return {"checkedItemAccessibleInGroceries": True, "collapsedUntilOpened": True,
                    "ordinaryTasksExcluded": True, "reopenKeepsIdentityAndQuantity": True,
                    "reloadPreservesReopenedItem": True}

        run("Checked groceries stay accessible and can be reopened without mixing in completed tasks", checked_grocery_reopen)

        def separated_lists(context):
            tab = page(context)
            section(tab, "shopping")
            grocery(tab, "Milk", "1 bottle")
            milk, = saved(tab)["tasks"]
            tab.locator(f'#shopping-tasks [data-task-id="{milk["id"]}"]').get_by_role("button", name="Edit", exact=True).click()
            tab.locator("#task-date").fill("2026-10-15")
            tab.locator("#save-task").click()
            section(tab, "family")
            tab.locator("#family-add").click()
            tab.locator("#task-title").fill("Check homework")
            tab.locator("#task-date").fill("2026-10-15")
            tab.locator("#task-time").fill("18:00")
            tab.locator("#task-reminder").check()
            tab.locator("#save-task").click()
            section(tab, "appointments")
            tab.locator("#appointments-add").click()
            full_task_editor(tab)
            tab.locator("#task-title").fill("Dentist")
            tab.locator("#task-date").fill("2026-10-15")
            tab.locator("#task-time").fill("19:00")
            tab.locator("#save-task").click()
            tasks = saved(tab)["tasks"]
            homework = next(task for task in tasks if task["title"] == "Check homework")
            dentist = next(task for task in tasks if task["title"] == "Dentist")
            section(tab, "family")
            assert tab.locator("#family-tasks [data-task-id]").evaluate_all("nodes=>nodes.map(node=>node.dataset.taskId)") == [homework["id"]]
            tab.locator("#task-search").fill("Milk")
            assert tab.locator("#family-tasks [data-task-id]").count() == 0
            tab.locator("#task-search").fill("")
            section(tab, "shopping")
            assert tab.locator("#shopping-tasks [data-task-id]").evaluate_all("nodes=>nodes.map(node=>node.dataset.taskId)") == [milk["id"]]
            section(tab, "appointments")
            assert tab.locator("#appointment-tasks [data-task-id]").evaluate_all("nodes=>nodes.map(node=>node.dataset.taskId)") == [dentist["id"]]
            section(tab, "reminders")
            assert tab.locator(f'#reminder-tasks [data-task-id="{homework["id"]}"]').is_visible()
            tab.locator('[data-view="today"]').click()
            assert sorted(tab.locator("#today-tasks [data-task-id]").evaluate_all("nodes=>nodes.map(node=>node.dataset.taskId)")) == sorted(task["id"] for task in tasks)
            assert len(saved(tab)["tasks"]) == 3
            return {"tasksExcludeGroceriesAndAppointments": True, "eachListHasItsOwnType": True,
                    "remindersReferenceSameTask": True, "todayShowsDatedOverview": True}

        run("Tasks, groceries and appointments stay separate while Today gives one dated overview", separated_lists)

        def navigation_history(context):
            tab = page(context)
            before = state(tab)
            section(tab, "meals")
            tab.locator('[data-meal="lunch"]').click()
            lunch_url = tab.url
            tab.locator('#view-meals [data-go="shopping"]').click()
            destination(tab, "shopping")
            tab.locator('#view-shopping [data-go="stores"]').click()
            destination(tab, "stores")
            tab.go_back()
            destination(tab, "shopping")
            tab.go_back()
            destination(tab, "meals")
            assert tab.url == lunch_url
            assert tab.locator("#meal-slide-lunch").is_visible()
            tab.go_forward()
            destination(tab, "shopping")
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            destination(tab, "shopping")
            tab.evaluate("location.hash='appointments'")
            tab.wait_for_function("!document.getElementById('view-appointments').hidden")
            destination(tab, "appointments")
            tab.evaluate("location.hash='unrecognised-section'")
            tab.wait_for_function("!document.getElementById('view-tools').hidden")
            destination(tab, "tools")
            assert state(tab) == before
            return {"browserBackAndForward": True, "mealSlideRestored": True,
                    "reloadAndHashChange": True, "unknownSectionReturnsHome": True,
                    "savedDataUnchanged": True}

        run("Browser navigation and deep links restore the correct section without editing saved data", navigation_history)

        def phone_organisation(context):
            tab = page(context)
            destination(tab, "today")
            tab.locator('.app-nav [data-view="tools"]').click()
            destination(tab, "tools")
            assert_no_overflow(tab, "#view-tools")
            menu_button = tab.locator('#view-tools [data-go="meals"]')
            menu_button.focus()
            tab.keyboard.press("Enter")
            destination(tab, "meals")
            tab.locator("#breakfast-monday").fill("Toast and eggs")
            tab.locator('#view-meals [data-go="shopping"]').click()
            destination(tab, "shopping")
            assert_no_overflow(tab, "#view-shopping")
            tab.locator("#grocery-title").fill("Bread")
            tab.locator("#grocery-quantity").fill("1 loaf")
            tab.locator("#grocery-add").focus()
            tab.keyboard.press("Enter")
            assert saved(tab)["tasks"][0]["title"] == "Bread"
            assert tab.locator("#grocery-title").evaluate("node=>node===document.activeElement")
            tab.locator('#view-shopping [data-go="meals"]').click()
            assert tab.locator("#breakfast-monday").input_value() == "Toast and eggs"
            submit_plan(tab, "breakfast")
            assert saved(tab)["mealPlans"]["breakfast"]["Monday"] == "Toast and eggs"
            tab.locator(".brand").click()
            destination(tab, "today")
            for name in HUB_PAGES:
                section(tab, name)
                assert_no_overflow(tab, "#view-" + name)
                assert tab.locator(f"#view-{name} h1").evaluate("node=>node===document.activeElement")
            tab.screenshot(path=str(args.output / "organisation-320.png"), full_page=True)
            return {"width": 320, "keyboardActivationAndFocus": True,
                    "typedMenuSurvivesRelatedNavigation": True, "allSectionsFitViewport": True}

        run("320px Home and focused sections support keyboard use and retain a typed menu", phone_organisation, width=320)

        def grocery_quota(context):
            tab = page(context)
            section(tab, "shopping")
            before = saved(tab)
            tab.evaluate("__rejectTidyWrites=true")
            grocery(tab, "Oranges", "6")
            assert saved(tab) == before
            assert tab.locator("#grocery-title").input_value() == "Oranges"
            assert tab.locator("#grocery-quantity").input_value() == "6"
            status = tab.locator("#grocery-status").inner_text().lower()
            assert re.search(r"not saved|tab only|this tab|saving needs attention", status), status
            assert tab.locator("#storage-warning").is_visible()
            backup = download_backup(tab)
            item, = backup["tasks"]
            assert item["title"] == "Oranges" and item["quantity"] == "6"
            tab.evaluate("__rejectTidyWrites=false")
            tab.locator("#grocery-add").click()
            assert len(saved(tab)["tasks"]) == 1
            assert saved(tab)["tasks"][0]["id"] == item["id"]
            assert saved(tab)["tasks"][0]["quantity"] == "6"
            assert not tab.locator("#storage-warning").is_visible()
            assert tab.locator("#grocery-title").input_value() == ""
            assert saved(tab)["actions"] == []
            return {"failedWriteNotReportedSaved": True, "typedFieldsRetained": True,
                    "unsavedItemRecoverableInBackup": True, "retryDoesNotDuplicate": True}

        run("Grocery storage failure keeps the form and backup, and a recovered retry saves once", grocery_quota)

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
            tab.screenshot(path=str(args.output / "meals-320.png"))
            return {"width": 320, "keyboardTabNavigation": True, "previousNext": True, "originalDinnerPlannerWorks": True, "noHorizontalOverflow": True}

        run("320px meal slides support keyboard and previous or next navigation while the dinner planner still works", phone_slides, width=320)
        browser.close()

    report = {"url": args.url, "sourceHashes": source_hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": external,
              "scope": "Isolated browser UI and local data; no retailer transactions, native iPhone alarms or real-device compatibility."}
    suffix = "live" if args.url.startswith("https://") else "local"
    report_path = args.output / (suffix + "-report.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(external), "report": str(report_path)}))
    raise SystemExit(1 if not results or passed != len(results) or errors or external else 0)


if __name__ == "__main__":
    main()
