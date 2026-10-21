"""Test Tidy's provider viewer with intercepted fixtures, never live retailer sessions.

Pass --url for the selected local or published Tidy site (default: port 8780).
Results and screenshots are written outside web/. These checks establish Tidy's behavior, not compatibility
with an actual retailer's login, security challenge, basket or checkout.
"""
import argparse
import copy
import hashlib
import json
import traceback
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = ROOT / ".qa-results"
OUT.mkdir(exist_ok=True)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://127.0.0.1:8780/")
args = parser.parse_args()
URL = args.url


def origin(url):
    parsed = urlparse(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


SELECTED_ORIGIN = origin(URL)
if SELECTED_ORIGIN[0] not in {"http", "https"} or not SELECTED_ORIGIN[1]:
    parser.error("--url must identify an HTTP(S) site")
STORES = {
    "Amazon UAE": "https://www.amazon.ae/",
    "Kibsons": "https://www.kibsons.com/",
    "Carrefour UAE": "https://www.carrefouruae.com/",
    "Waitrose UAE": "https://www.waitrose.ae/",
}
requests = []
results = []
browser_errors = []
fixture_mode = {urlparse(url).hostname: "normal" for url in STORES.values()}
baseline = None


def run(name, check):
    try:
        check()
        result = {"name": name, "result": "PASS"}
    except Exception as problem:
        result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
    results.append(result)
    print(json.dumps(result), flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True)
    context = browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900})

    def mock_provider(route, request):
        if origin(request.url) == SELECTED_ORIGIN:
            route.continue_()
            return
        host = urlparse(request.url).hostname
        if host not in fixture_mode:
            requests.append({"url": request.url, "scope": "unexpected-external", "mode": "blocked"})
            route.abort("blockedbyclient")
            return
        try:
            scope = "embedded" if request.frame.parent_frame else "direct"
        except Exception:
            # A popup's first navigation can be intercepted before its Frame exists.
            scope = "direct" if request.is_navigation_request() else "asset"
        mode = fixture_mode[host]
        requests.append({"url": request.url, "scope": scope, "mode": mode})
        headers = {"Content-Type": "text/html; charset=utf-8"}
        if mode == "blocked":
            headers["Content-Security-Policy"] = "frame-ancestors 'none'"
            body = "<h1>Test fixture: provider forbids framing</h1>"
        elif mode == "challenge":
            body = """<!doctype html><title>Simulated security check</title>
              <h1>Test fixture: Max challenge attempts exceeded</h1>
              <p>This replay is not a live Amazon security response.</p>
              <script>parent.postMessage({type:'tidy-meals-open-store',store:'Waitrose'},'*');</script>"""
        else:
            body = "<!doctype html><title>Mock retailer</title><h1>Intercepted provider fixture</h1>"
        route.fulfill(status=200, headers=headers, body=body)

    context.route("**/*", mock_provider)
    page = context.new_page()
    page.set_default_timeout(7000)
    page.on("pageerror", lambda error: browser_errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())

    def current():
        return page.evaluate("TidyDemo.getState()")

    def tools():
        page.locator("#open-settings").click()
        page.locator('#settings-dialog [data-go="tools"]').click()

    def section(name):
        tools()
        page.locator(f'#view-tools [data-go="{name}"]').click()
        page.locator(f"#view-{name}").wait_for(state="visible")

    def open_meals():
        section("meals")
        page.locator('[data-meal="dinner"]').click()
        page.locator("#show-meals").click()

    def open_store(name):
        section("stores")
        page.locator("#provider-list").get_by_role("button", name=name, exact=True).click()
        page.locator("#website-dialog").wait_for(state="visible")

    def close_viewer():
        if page.locator("#website-dialog").is_visible():
            page.locator('[data-close="website-dialog"]').click()
        page.wait_for_function("document.getElementById('website-frame').getAttribute('src')==='about:blank'")

    def preserved():
        assert current() == baseline
        stored = json.loads(page.evaluate("localStorage.getItem('tidy.app.v1')"))
        assert stored == baseline

    def count_for(url, scope="embedded"):
        return sum(item["url"] == url and item["scope"] == scope for item in requests)

    def seed_real_saved_data():
        global baseline
        page.goto(URL)
        page.wait_for_function("window.TidyDemo && TidyDemo.getState().mealSnapshot!==null")
        if page.locator("#calendar-onboarding-dialog").is_visible():
            page.locator("#calendar-onboarding-later").click()
        page.locator('[data-view="family"]').click()
        page.locator("#family-add").click()
        page.locator("#task-title").fill("Keep the family responsibility")
        page.locator("#save-task").click()
        page.locator('[data-view="assistant"]').click()
        page.locator("#capture-text").fill("We need milk")
        page.locator("#capture-form button[type=submit]").click()
        open_meals()
        f = page.frame_locator("#meals-frame")
        f.locator("#people").fill("4")
        f.locator("#diet").select_option("mixed")
        f.locator("#no-allergies").check()
        f.locator("#suggest-menu").click()
        f.locator("#approve-menu").click()
        f.locator("#stock-chicken").fill("90")
        f.locator("#pantry-confirm").check()
        f.locator("#review-groceries").click()
        f.locator("#approve-draft").click()
        page.wait_for_function("TidyDemo.getState().mealSnapshot?.state.draftApproved")
        baseline = copy.deepcopy(current())
        assert len(baseline["tasks"]) == 2
        assert len(baseline["mealSummary"]) == 5
        assert baseline["mealSnapshot"]["state"]["pantry"]["chicken"] == 90

    run("Real task and approved meal data are saved before provider tests", seed_real_saved_data)

    def four_destinations():
        tools()
        assert page.locator("#view-tools #provider-list").count() == 0
        assert page.locator("#view-tools #shopping-card").count() == 0
        assert page.locator("#provider-list").is_hidden()
        section("stores")
        assert page.locator("#provider-list button").count() == 4
        assert page.locator("#provider-list button").first.inner_text() == "Waitrose UAE"
        assert page.locator("#shopping-card").is_hidden()
        for name, url in STORES.items():
            before = count_for(url)
            open_store(name)
            if name == "Amazon UAE":
                assert page.locator("#website-choice").is_visible()
                assert page.locator("#website-frame").is_hidden()
                assert page.locator("#website-frame").get_attribute("src") == "about:blank"
                assert count_for(url) == before
                assert len(context.pages) == 1
                page.locator("#website-try-inside").click()
            page.wait_for_function("url=>document.getElementById('website-frame').getAttribute('src')===url", arg=url)
            page.wait_for_timeout(100)
            assert count_for(url) == before + 1
            assert page.locator("#website-title").inner_text() == name
            assert page.locator("#website-open-direct").get_attribute("href") == url
            assert page.locator("#website-open-direct").get_attribute("target") == "_blank"
            assert {"noopener", "noreferrer"}.issubset(set(page.locator("#website-open-direct").get_attribute("rel").split()))
            assert len(context.pages) == 1
            preserved()
            close_viewer()
            assert not page.locator("#website-open-direct").get_attribute("href")

    run("All four stores have correct destinations; Amazon waits for an explicit viewing choice", four_destinations)

    def amazon_browser_choice():
        amazon = STORES["Amazon UAE"]
        before = count_for(amazon)
        direct_before = count_for(amazon, "direct")
        open_store("Amazon UAE")
        assert page.locator("#website-choice").is_visible()
        assert page.locator("#website-open-direct").inner_text() == "Open Amazon in browser"
        assert page.locator("#website-frame").get_attribute("src") == "about:blank"
        page.wait_for_timeout(300)
        assert count_for(amazon) == before
        assert len(context.pages) == 1
        with page.expect_popup() as opened:
            page.locator("#website-open-direct").click()
        popup = opened.value
        popup.wait_for_load_state("domcontentloaded")
        assert popup.url == amazon
        assert popup.evaluate("window.opener===null") is True
        assert count_for(amazon, "direct") == direct_before + 1
        assert page.locator("#website-choice").is_visible()
        assert page.locator("#website-frame").get_attribute("src") == "about:blank"
        popup.close()
        preserved()
        page.keyboard.press("Escape")
        page.wait_for_function("!document.getElementById('website-dialog').open")
        page.wait_for_function("!document.getElementById('website-open-direct').hasAttribute('href')")
        assert not page.locator("#website-open-direct").get_attribute("href")
        assert page.locator("#website-choice").is_hidden()
        assert page.locator("#provider-list").get_by_role("button", name="Amazon UAE", exact=True).evaluate("node=>node===document.activeElement")
        assert count_for(amazon) == before
        preserved()

    run("Amazon browser choice opens only on a click and Escape retains Tidy data and focus", amazon_browser_choice)

    def challenge_recovery():
        amazon = STORES["Amazon UAE"]
        fixture_mode[urlparse(amazon).hostname] = "challenge"
        before = count_for(amazon)
        open_store("Amazon UAE")
        page.locator("#website-try-inside").click()
        page.wait_for_timeout(800)
        assert count_for(amazon) == before + 1
        assert len(context.pages) == 1
        assert page.locator("#website-frame").get_attribute("src") == amazon
        page.locator("#website-report-problem").click()
        page.wait_for_function("document.getElementById('website-frame').getAttribute('src')==='about:blank'")
        assert page.locator("#website-frame").is_hidden()
        assert page.locator("#website-recovery").is_visible()
        assert "cannot complete" in page.locator("#website-recovery").inner_text().lower()
        assert page.locator("#website-report-problem").is_disabled()
        page.wait_for_timeout(400)
        assert count_for(amazon) == before + 1
        assert len(context.pages) == 1
        preserved()

    run("Simulated security challenge never retries or opens a new page automatically; reporting stops the iframe", challenge_recovery)

    def explicit_direct_navigation():
        amazon = STORES["Amazon UAE"]
        before = count_for(amazon, "direct")
        with page.expect_popup() as opened:
            page.locator("#website-open-direct").click()
        popup = opened.value
        popup.wait_for_load_state("domcontentloaded")
        assert popup.url == amazon
        assert popup.evaluate("window.opener===null") is True
        assert count_for(amazon, "direct") == before + 1
        assert page.locator("#website-dialog").is_visible()
        assert page.locator("#website-frame").get_attribute("src") == "about:blank"
        popup.close()
        preserved()

    run("Only clicking the direct link opens a separate no-opener provider page and retains Tidy data", explicit_direct_navigation)

    def explicit_retry_and_close():
        amazon = STORES["Amazon UAE"]
        before = count_for(amazon)
        page.locator("#website-retry").click()
        page.wait_for_function("document.getElementById('website-frame').getAttribute('src')==='https://www.amazon.ae/'")
        page.wait_for_timeout(500)
        assert count_for(amazon) == before + 1
        assert page.locator("#website-frame").is_visible()
        assert page.locator("#website-recovery").is_hidden()
        assert page.locator("#website-report-problem").is_enabled()
        assert len(context.pages) == 1
        close_viewer()
        assert page.locator("#website-frame").is_hidden()
        assert not page.locator("#website-open-direct").get_attribute("href")
        page.wait_for_timeout(250)
        assert count_for(amazon) == before + 1
        preserved()

    run("An explicit retry makes one new attempt; closing blanks the iframe and removes stale direct URLs", explicit_retry_and_close)

    def blocked_embedding():
        waitrose = STORES["Waitrose UAE"]
        fixture_mode[urlparse(waitrose).hostname] = "blocked"
        before = count_for(waitrose)
        open_store("Waitrose UAE")
        page.wait_for_timeout(700)
        assert count_for(waitrose) == before + 1
        assert len(context.pages) == 1
        page.locator("#website-report-problem").click()
        assert page.locator("#website-recovery").is_visible()
        assert page.locator("#website-open-direct").get_attribute("href") == waitrose
        assert page.locator("#website-frame").get_attribute("src") == "about:blank"
        assert page.locator("#website-frame").is_hidden()
        assert "cannot verify" in page.locator(".website-disclaimer").inner_text().lower()
        preserved()
        close_viewer()

    run("A CSP-denied fixture retains honest recovery controls without automatic redirects or retry loops", blocked_embedding)

    def source_and_store_checks():
        before = len(requests)
        assert not page.locator("#website-dialog").is_visible()
        child = next(frame for frame in page.frames if urlparse(frame.url).path.endswith("/meals.html"))
        for bad in ["Amazon", "Unknown shop", "__proto__", "https://example.invalid/"]:
            child.evaluate("store=>parent.postMessage({type:'tidy-meals-open-store',store},'*')", bad)
        page.evaluate("window.postMessage({type:'tidy-meals-open-store',store:'Carrefour'},'*')")
        page.wait_for_timeout(180)
        assert not page.locator("#website-dialog").is_visible()
        assert len(requests) == before
        preserved()

    run("Unknown store keys and messages from the wrong frame cannot open or change a provider URL", source_and_store_checks)

    def reload_preserves():
        page.reload()
        page.wait_for_function("window.TidyDemo && TidyDemo.getState().mealSnapshot?.state.draftApproved")
        open_meals()
        f = page.frame_locator("#meals-frame")
        f.locator("#approval-result").wait_for(state="visible")
        preserved()
        section("shopping")
        assert "milk" in page.locator("#shopping-tasks").inner_text().lower()
        assert "approved" in page.locator("#meal-shopping-status").inner_text().lower()

    run("Tasks, stock and meal grocery approvals survive all provider actions and whole-site reload", reload_preserves)

    def mobile_layout():
        fixture_mode[urlparse(STORES["Amazon UAE"]).hostname] = "challenge"
        for width in [320, 390]:
            page.set_viewport_size({"width": width, "height": 844})
            section("stores")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width
            for name in STORES:
                control = page.locator("#provider-list").get_by_role("button", name=name, exact=True)
                box = control.bounding_box()
                assert box["x"] >= 0 and box["x"] + box["width"] <= width, (width, name, box)
            open_store("Amazon UAE")
            assert page.locator("#website-choice").is_visible()
            page.locator("#website-try-inside").click()
            page.locator("#website-report-problem").click()
            for identity in ["website-open-direct", "website-retry"]:
                control = page.locator("#" + identity)
                control.scroll_into_view_if_needed()
                assert control.is_visible()
                box = control.bounding_box()
                assert box["x"] >= 0 and box["x"] + box["width"] <= width, (width, identity, box)
            assert page.locator("#website-dialog").evaluate("el=>el.scrollWidth <= el.clientWidth"), width
            page.locator("#website-open-direct").scroll_into_view_if_needed()
            page.screenshot(path=OUT / f"website-recovery-{width}.png")
            preserved()
            close_viewer()
        page.set_viewport_size({"width": 1280, "height": 900})

    run("Store selection and recovery/direct controls fit 320px and 390px screens", mobile_layout)
    run("No JavaScript exceptions or unmocked external requests", lambda: (_ for _ in ()).throw(AssertionError({"errors": browser_errors, "external": [item for item in requests if item["scope"] == "unexpected-external"]})) if browser_errors or any(item["scope"] == "unexpected-external" for item in requests) else None)
    browser.close()

report = {"url": URL, "route": "Selected Tidy HTTP(S) origin with intercepted provider fixtures", "compatibility_scope": "Tests Tidy recovery behavior only. No live provider login, challenge, basket or checkout compatibility verified.", "source_sha256": {name: hashlib.sha256((WEB / name).read_bytes()).hexdigest() for name in ["index.html", "app.js", "styles.css", "meals.html"]}, "results": results, "browser_errors": browser_errors, "intercepted_requests": requests}
(OUT / "website-results.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
raise SystemExit(1 if any(item["result"] == "FAIL" for item in results) else 0)
