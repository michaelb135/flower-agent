"""Check short meal requests, editable grocery drafts and explicit product memory.

Every case uses a fresh synthetic browser profile. Only the selected Tidy origin
can reach the network: these checks never access retailer accounts or buy food.
HTTPS deployments retain normal browser certificate checks.
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
FIXTURE = """(() => {
  window.__rejectTidyWrites = false;
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled menu QA quota failure', 'QuotaExceededError');
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


def draft(tab):
    return state(tab)["menuHelper"]["draft"]


def items(tab):
    return {item["ingredientId"]: item for item in draft(tab)["items"]}


def navigate(tab, name):
    tab.locator(f'.app-nav [data-view="{name}"]').click()
    assert tab.locator("section.view:visible").get_attribute("id") == "view-" + name


def prepare(tab, request="tomato pasta", people=4, replace=True):
    navigate(tab, "meals")
    tab.locator("#quick-menu-request").fill(request)
    tab.locator("#quick-menu-people").fill(str(people))
    tab.locator("#quick-menu-prepare").click()
    replacement = tab.locator("#quick-menu-replace")
    if replace and replacement.count() and replacement.is_visible():
        replacement.click()


def row(tab, ingredient):
    return tab.locator(f'#quick-menu-items [data-ingredient-id="{ingredient}"]')


def edit(tab, ingredient, field, value):
    target = row(tab, ingredient)
    if field in {"productName", "store", "url"}:
        details = target.locator("details")
        if details.count() and details.get_attribute("open") is None:
            details.locator("summary").click()
    control = target.locator(f'[data-field="{field}"]')
    if field == "store":
        control.select_option(value)
    elif field == "included":
        control.set_checked(value)
    else:
        control.fill(str(value))
        control.dispatch_event("change")


def approve(tab, remember=False):
    tab.locator("#quick-menu-remember").set_checked(remember)
    tab.locator("#quick-menu-approve").click()


def backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as download:
        tab.locator("#export-backup").click()
    data = json.loads(Path(download.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return data


def restore(tab, data):
    tab.locator("#open-settings").click()
    tab.locator("#import-backup").set_input_files({
        "name": "synthetic-menu-backup.json", "mimeType": "application/json",
        "buffer": json.dumps(data).encode(),
    })


def no_overflow(tab, selector):
    dimensions = tab.locator(selector).evaluate("""node => ({
      client:node.clientWidth, scroll:node.scrollWidth,
      viewport:innerWidth, document:document.documentElement.scrollWidth
    })""")
    assert dimensions["scroll"] <= dimensions["client"] + 1, dimensions
    assert dimensions["document"] <= dimensions["viewport"] + 1, dimensions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9051/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--output", type=Path, default=ROOT / ".qa-results" / "quick-menu")
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    args.output.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    source_hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest()
                     for name in ["index.html", "styles.css", "app.js", "core.js", "menu-helper.js", "menu-ui.js"]
                     if (ROOT / "web" / name).exists()}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def page(context):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: errors.append(str(problem)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(datetime(2026, 10, 17, 6, 0, tzinfo=timezone.utc))
            tab.goto(args.url)
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

        def automatic(context):
            tab = page(context)
            before = state(tab)
            prepare(tab)
            data = draft(tab)
            assert data["recipeId"] == "tomato-pasta" and data["people"] == 4
            assert data["status"] == "draft" and data["approvedAt"] is None
            assert {key: (item["amount"], item["unit"]) for key, item in items(tab).items()} == {
                "pasta": (360, "g"), "tinnedTomatoes": (600, "g"), "oliveOil": (20, "ml")}
            assert tab.locator("#quick-menu-items [data-ingredient-id]").count() == 3
            assert tab.locator("#quick-menu-review").is_visible()
            assert not tab.locator("#quick-menu-remember").is_checked()
            assert all(not item["productName"] for item in data["items"])
            assert state(tab)["tasks"] == before["tasks"]
            assert state(tab)["mealSnapshot"] == before["mealSnapshot"]
            assert saved(tab)["menuHelper"]["draft"] == data
            return {"shortRequest": "tomato pasta", "automaticIngredients": 3, "servings": 4,
                    "ingredientsWereNotRequestedFromUser": True, "editableDraftOnly": True,
                    "existingTasksAndWeekdayDinnerPreserved": True}

        run("A short dish produces ingredient quantities immediately without a recipe interview", automatic)

        def conversational(context):
            tab = page(context)
            prepare(tab, "I want to eat some spaghetti to tomato")
            assert draft(tab)["recipeId"] == "tomato-pasta"
            assert items(tab)["pasta"]["name"] == "Spaghetti"
            assert not any(item["productName"] for item in items(tab).values())
            text = tab.locator("#quick-menu-review").inner_text().lower()
            assert "mutti" not in text and "last bought" not in text
            assert state(tab)["menuHelper"]["preferences"] == []
            return {"conversationalRequestRecognized": True, "explicitSpaghettiPreserved": True,
                    "noInventedProductHistory": True}

        run("Conversational spaghetti requests work and no retailer purchase history is invented", conversational)

        def quantities_and_approval(context):
            tab = page(context)
            prepare(tab, people=2)
            assert items(tab)["pasta"]["amount"] == 180
            assert items(tab)["tinnedTomatoes"]["amount"] == 300
            edit(tab, "pasta", "amount", 210)
            edit(tab, "oliveOil", "included", False)
            assert items(tab)["pasta"]["amount"] == 210
            approve(tab)
            assert tab.locator("section.view:visible").get_attribute("id") == "view-shopping"
            assert draft(tab)["status"] == "approved" and draft(tab)["approvedAt"] is not None
            groceries = tab.locator("#quick-menu-shopping-items").inner_text()
            assert "210" in groceries and "300" in groceries
            assert "Olive oil" not in groceries
            assert tab.locator("#quick-menu-shopping-section").is_visible()
            assert not re.search(r"(?:order placed|payment complete|groceries (?:bought|ordered)|basket (?:created|ready))",
                                 tab.locator("#quick-menu-shopping-section").inner_text(), re.I)
            assert state(tab)["tasks"] == []
            with tab.expect_download() as download:
                tab.locator("#download-shopping").click()
            downloaded = Path(download.value.path()).read_text()
            assert "Pasta: 210 g" in downloaded and "Tinned chopped tomatoes: 300 g" in downloaded, downloaded
            return {"servingsScaleAmounts": True, "amountEdited": 210, "pantryItemExcluded": "Olive oil",
                    "approvalShowsGroceries": True, "downloadContainsReadableIngredientLines": True,
                    "noOrderOrBasketClaim": True}

        run("Servings, quantity edits and exclusions reach Groceries only after explicit draft approval", quantities_and_approval)

        def product_memory(context):
            tab = page(context)
            prepare(tab)
            edit(tab, "pasta", "productName", "Waitrose Penne")
            edit(tab, "pasta", "store", "Waitrose")
            approve(tab, remember=False)
            assert state(tab)["menuHelper"]["preferences"] == []
            prepare(tab)
            assert items(tab)["pasta"]["productName"] == ""
            edit(tab, "pasta", "productName", "Waitrose Penne")
            edit(tab, "pasta", "store", "Waitrose")
            edit(tab, "tinnedTomatoes", "productName", "Mutti chopped tomatoes")
            edit(tab, "tinnedTomatoes", "store", "Kibsons")
            approve(tab, remember=True)
            preferences = {item["ingredientId"]: item for item in state(tab)["menuHelper"]["preferences"]}
            assert set(preferences) == {"pasta", "tinnedTomatoes"}
            assert all(item["source"] == "Saved by you in Tidy" for item in preferences.values())
            prepare(tab)
            assert items(tab)["pasta"]["productName"] == "Waitrose Penne"
            assert items(tab)["tinnedTomatoes"]["productName"] == "Mutti chopped tomatoes"
            assert "Saved by you in Tidy" in tab.locator("#quick-menu-review").inner_text()
            prepare(tab, "spaghetti with tomato")
            assert items(tab)["pasta"]["name"] == "Spaghetti"
            assert items(tab)["pasta"]["productName"] == ""
            assert items(tab)["tinnedTomatoes"]["productName"] == "Mutti chopped tomatoes"
            prepare(tab, "fresh tomato pasta")
            assert "freshTomatoes" in items(tab) and "tinnedTomatoes" not in items(tab)
            assert items(tab)["freshTomatoes"]["productName"] == ""
            return {"uncheckedMemoryDoesNotRemember": True, "explicitlySavedProductsReused": 2,
                    "sourceLabel": "Saved by you in Tidy", "explicitPastaShapeWins": True,
                    "freshAndTinnedTomatoesKeptDistinct": True}

        run("Only explicitly remembered compatible products are reused and explicit meal choices take priority", product_memory)

        def unknown(context):
            tab = page(context)
            prepare(tab, "purple moon dumplings")
            assert not state(tab).get("menuHelper", {}).get("draft")
            choices = tab.locator("#quick-menu-choices button")
            choice_count = choices.count()
            assert choice_count >= 2
            assert not tab.locator("#quick-menu-review").is_visible()
            text = tab.locator("#quick-menu-form").inner_text().lower()
            assert "ingredient name" not in text and "name | amount" not in text
            choices.first.click()
            assert draft(tab)["status"] == "draft"
            assert len(items(tab)) >= 2
            prepare(tab, "spaghetti with mushrooms for 2")
            tab.locator("#quick-menu-choices").get_by_role("button", name="Tomato pasta", exact=True).click()
            if tab.locator("#quick-menu-replace").is_visible():
                tab.locator("#quick-menu-replace").click()
            assert draft(tab)["people"] == 2
            assert items(tab)["pasta"]["name"] == "Spaghetti"
            assert items(tab)["pasta"]["amount"] == 180
            return {"unknownDishDoesNotFabricateRecipe": True, "concreteRecipeChoices": choice_count,
                    "suggestionBuildsIngredients": True, "noManualRecipeTranscription": True,
                    "explicitServingsAndSpaghettiRetainedWhenChoosingReplacementRecipe": True}

        run("Unknown dishes offer a small choice of real recipes instead of a blank ingredient form", unknown)

        def edited_approval(context):
            tab = page(context)
            prepare(tab)
            approve(tab)
            tab.locator("#quick-menu-edit").click()
            assert tab.locator("section.view:visible").get_attribute("id") == "view-meals"
            edit(tab, "pasta", "amount", 400)
            assert draft(tab)["status"] == "draft" and draft(tab)["approvedAt"] is None
            navigate(tab, "shopping")
            assert "400" not in tab.locator("#quick-menu-shopping-items").inner_text()
            navigate(tab, "meals")
            approve(tab)
            assert draft(tab)["status"] == "approved"
            assert "400" in tab.locator("#quick-menu-shopping-items").inner_text()
            return {"editRevokesApproval": True, "editedDraftNotShownAsApprovedGroceries": True,
                    "secondApprovalPublishesEditedAmount": 400}

        run("Changing an approved ingredient revokes approval until the edited draft is approved again", edited_approval)

        def replacement(context):
            tab = page(context)
            prepare(tab)
            approve(tab)
            expected = state(tab)["menuHelper"]
            prepare(tab, "chicken and rice", replace=False)
            assert tab.locator("#quick-menu-replacement").is_visible()
            assert state(tab)["menuHelper"] == expected
            tab.locator("#quick-menu-view-current").click()
            assert "Tomato pasta" in tab.locator("#quick-menu-shopping-title").inner_text()
            assert "360" in tab.locator("#quick-menu-shopping-items").inner_text()
            navigate(tab, "meals")
            tab.locator("#quick-menu-keep").click()
            assert state(tab)["menuHelper"] == expected
            prepare(tab, "chicken and rice", replace=False)
            assert state(tab)["menuHelper"] == expected
            tab.locator("#quick-menu-replace").click()
            assert draft(tab)["recipeId"] == "chicken-rice" and draft(tab)["status"] == "draft"
            navigate(tab, "shopping")
            assert not tab.locator("#quick-menu-shopping-items").inner_text().strip()
            return {"existingApprovedGroceriesKeptUntilReplacementConfirmed": True,
                    "currentListCanBeViewedBeforeReplacing": True, "keepButtonPreservesCurrentList": True,
                    "replacementNeedsItsOwnApproval": True}

        run("Preparing another dish asks before replacing existing groceries and preserves the current list when declined", replacement)

        def reload_backup(context):
            tab = page(context)
            prepare(tab)
            edit(tab, "pasta", "productName", "Synthetic family pasta")
            approve(tab, remember=True)
            expected = state(tab)["menuHelper"]
            copy = backup(tab)
            assert copy["menuHelper"] == expected
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            assert state(tab)["menuHelper"] == expected
            prepare(tab, "chicken and rice", 2)
            assert draft(tab)["recipeId"] == "chicken-rice"
            restore(tab, copy)
            tab.wait_for_function("TidyDemo.getState().menuHelper?.draft?.recipeId==='tomato-pasta'")
            assert saved(tab)["menuHelper"] == expected
            tab.locator('[data-close="settings-dialog"]').click()
            navigate(tab, "shopping")
            assert "Synthetic family pasta" in tab.locator("#quick-menu-shopping-items").inner_text()
            bad = json.loads(json.dumps(copy))
            bad["menuHelper"]["draft"]["items"][0]["amount"] = -1
            before = tab.evaluate("localStorage.getItem('tidy.app.v1')")
            restore(tab, bad)
            tab.locator("#backup-error").wait_for(state="visible")
            assert tab.evaluate("localStorage.getItem('tidy.app.v1')") == before
            return {"draftAndPreferencesSurviveReload": True, "wholeAppBackupRestoresApprovedDraft": True,
                    "invalidBackupDoesNotReplaceSavedData": True}

        run("Drafts and saved products survive reload and whole-app backup with invalid data rejected", reload_backup)

        def unsafe_product(context):
            tab = page(context)
            prepare(tab)
            markup = '<img src=x onerror="window.__menuXss=1">'
            edit(tab, "pasta", "productName", markup)
            assert row(tab, "pasta").locator("img").count() == 0
            assert tab.evaluate("window.__menuXss || null") is None
            before = saved(tab)
            edit(tab, "pasta", "url", "javascript:alert(1)")
            assert tab.locator("#quick-menu-error").is_visible()
            assert saved(tab) == before
            assert items(tab)["pasta"]["url"] == ""
            edit(tab, "pasta", "url", "https://user:secret@example.com/item")
            assert tab.locator("#quick-menu-error").is_visible()
            assert saved(tab) == before
            edit(tab, "pasta", "url", "https://www.waitrose.ae/en/product/synthetic-pasta")
            assert not tab.locator("#quick-menu-error").is_visible()
            approve(tab)
            assert tab.locator("#quick-menu-shopping-items img").count() == 0
            assert markup in tab.locator("#quick-menu-shopping-items").inner_text()
            assert tab.evaluate("window.__menuXss || null") is None
            return {"typedMarkupRemainsText": True, "scriptURLsRejected": True,
                    "credentialURLsRejected": True, "httpsProductLinkAccepted": True}

        run("Optional product names remain text and unsafe product links cannot enter the saved grocery draft", unsafe_product)

        def stale_tab(context):
            a = page(context)
            prepare(a)
            b = page(context)
            navigate(b, "meals")
            amount = row(b, "pasta").locator('[data-field="amount"]')
            amount.fill("777")  # An input event keeps this edit local until change/blur.
            prepare(a, "chicken and rice")
            b.wait_for_function("TidyDemo.getState().menuHelper?.draft?.recipeId==='chicken-rice'")
            before = b.evaluate("localStorage.getItem('tidy.app.v1')")
            amount.dispatch_event("change")
            tab_error = b.locator("#quick-menu-error").inner_text()
            assert tab_error
            assert re.search(r"another tab|changed|newer", tab_error, re.I), tab_error
            assert b.evaluate("localStorage.getItem('tidy.app.v1')") == before
            assert saved(b)["menuHelper"]["draft"]["recipeId"] == "chicken-rice"
            assert amount.input_value() == "777"
            return {"staleIngredientEditRetained": "777", "newerDishNotOverwritten": "chicken-rice",
                    "visibleConflictNeedsReview": True}

        run("A stale tab cannot overwrite a newer grocery draft while its typed edit is retained", stale_tab)

        def quota(context):
            tab = page(context)
            before = saved(tab)
            tab.evaluate("__rejectTidyWrites=true")
            prepare(tab)
            assert saved(tab) == before
            assert draft(tab)["recipeId"] == "tomato-pasta"
            assert tab.locator("#storage-warning").is_visible()
            status = tab.locator("#quick-menu-status").inner_text()
            assert re.search(r"not saved|tab only|saving needs attention", status, re.I), status
            copy = backup(tab)
            assert copy["menuHelper"]["draft"]["recipeId"] == "tomato-pasta"
            tab.evaluate("__rejectTidyWrites=false")
            navigate(tab, "meals")
            edit(tab, "pasta", "amount", 420)
            assert saved(tab)["menuHelper"]["draft"]["items"][0]["amount"] == 420
            assert not tab.locator("#storage-warning").is_visible()
            return {"previousSavedCopyUnchanged": True, "unsavedDraftInBackup": True,
                    "storageWarningIsHonest": True, "recoveredEditSaved": 420}

        run("Storage failure retains an exportable draft without claiming it was saved and permits recovery", quota)

        def phone(context):
            tab = page(context)
            prepare(tab)
            edit(tab, "pasta", "productName", "A long but ordinary family favourite pasta product")
            no_overflow(tab, "#view-meals")
            no_overflow(tab, "#quick-menu-review")
            assert tab.locator("#quick-menu-request").evaluate("node=>!!node.labels.length")
            assert tab.locator("#quick-menu-people").evaluate("node=>!!node.labels.length")
            approve(tab)
            no_overflow(tab, "#view-shopping")
            no_overflow(tab, "#quick-menu-shopping-section")
            tab.screenshot(path=str(args.output / f"approved-menu-groceries-{tab.viewport_size['width']}.png"), full_page=True)
            return {"width": tab.viewport_size["width"], "menuAndGroceriesHaveNoHorizontalOverflow": True,
                    "mainInputsLabelled": True, "approvalUsableOnPhone": True}

        run("320px phones can prepare, edit and approve groceries without horizontal scrolling", phone, width=320)
        run("390px phones can prepare, edit and approve groceries without horizontal scrolling", phone, width=390)
        browser.close()

    report = {"url": args.url, "sourceHashes": source_hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": external,
              "scope": "Synthetic browser UI and local data. No retailer history, accounts, baskets, prices or purchases are accessed."}
    report_path = args.output / (("live" if args.url.startswith("https://") else "local") + "-report.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(external), "report": str(report_path)}))
    raise SystemExit(1 if not results or passed != len(results) or errors or external else 0)


if __name__ == "__main__":
    main()
