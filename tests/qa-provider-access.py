"""Check configured clinic access and provider popups with synthetic pages.

Pass --url to select Tidy's local or published site. Only the selected origin
reaches the network; Amazon and clinic responses are intercepted fixtures.
No real sign-in, medical appointment, security challenge or purchase is tested.
"""

import argparse
import json
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".qa-results" / "provider-access"
CLINIC = "https://clinic.example.invalid/"
ALTERNATIVE = "https://second-clinic.example.invalid/"
KEY = "tidy.app.v1"


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9042/")
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) site")
    OUT.mkdir(parents=True, exist_ok=True)
    results, errors, unexpected = [], [], []
    fixture = """<!doctype html><title>Provider test fixture</title>
      <h1>Intercepted provider page</h1>
      <button id="sign-in" onclick="window.open('/sign-in', '_blank')">Open sign-in</button>"""

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True)

        def context(width=1100):
            fresh = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 900})

            def intercept(route):
                url = route.request.url
                if origin(url) == selected:
                    route.continue_()
                elif urlsplit(url).hostname in {"www.amazon.ae", "clinic.example.invalid", "second-clinic.example.invalid"}:
                    route.fulfill(status=200, content_type="text/html", body=fixture)
                else:
                    unexpected.append(url)
                    route.abort("blockedbyclient")

            fresh.route("**/*", intercept)
            return fresh

        def page(fresh):
            tab = fresh.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: errors.append(str(problem)))
            tab.goto(args.url)
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            tab.locator('[data-view="tools"]').click()
            return tab

        def saved(tab):
            return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")

        def configure(tab, url):
            tab.locator("#health-square-url").fill(url)
            tab.locator("#health-square-save").click()

        def run(name, check, width=1100):
            fresh = context(width)
            try:
                check(fresh)
                result = {"name": name, "result": "PASS"}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
            finally:
                fresh.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def clinic_persistence(fresh):
            tab = page(fresh)
            assert tab.locator("#health-square-open").is_disabled()
            configure(tab, CLINIC)
            tab.wait_for_function("TidyDemo.getState().settings.healthSquareUrl === 'https://clinic.example.invalid/'")
            assert saved(tab)["settings"]["healthSquareUrl"] == CLINIC
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            tab.locator('[data-view="tools"]').click()
            assert tab.locator("#health-square-url").input_value() == CLINIC
            tab.locator("#health-square-open").click()
            assert tab.locator("#website-title").inner_text() == "Health Square"
            assert tab.locator("#website-frame").get_attribute("src") == CLINIC
            assert tab.locator("#website-open-direct").get_attribute("href") == CLINIC
            assert tab.frame_locator("#website-frame").locator("h1").inner_text() == "Intercepted provider page"

        run("Clinic setup, local saving, reload and in-app destination", clinic_persistence)

        def invalid_links(fresh):
            tab = page(fresh)
            configure(tab, CLINIC)
            before = saved(tab)
            for bad in ["javascript:alert(1)", "http://clinic.example.invalid/", "https://user:password@clinic.example.invalid/"]:
                configure(tab, bad)
                assert saved(tab) == before
                assert tab.locator("#health-square-error").is_visible()
                assert tab.locator("#health-square-url").input_value() == bad

        run("Unsafe clinic links reject without replacing the saved address", invalid_links)

        def independent_tabs(fresh):
            a = page(fresh)
            b = page(fresh)
            b.locator("#health-square-url").fill(CLINIC)
            a.locator("#open-settings").click()
            a.locator("#alerts-paused").check()
            a.locator('#settings-form button[type="submit"]').click()
            b.wait_for_function("TidyDemo.getState().settings.remindersPaused === true")
            assert b.locator("#health-square-url").input_value() == CLINIC
            b.locator("#health-square-save").click()
            assert saved(b)["settings"]["remindersPaused"] is True
            assert saved(b)["settings"]["healthSquareUrl"] == CLINIC

        run("Remote settings update retains a typed clinic address and merges unrelated changes", independent_tabs)

        def conflicting_tabs(fresh):
            a = page(fresh)
            configure(a, CLINIC)
            b = page(fresh)
            b.locator("#health-square-url").fill(ALTERNATIVE)
            configure(a, "https://clinic.example.invalid/appointments")
            b.wait_for_function("TidyDemo.getState().settings.healthSquareUrl.endsWith('/appointments')")
            before = b.evaluate("localStorage.getItem('tidy.app.v1')")
            b.locator("#health-square-save").click()
            assert b.locator("#health-square-error").is_visible()
            assert b.locator("#health-square-url").input_value() == ALTERNATIVE
            assert b.evaluate("localStorage.getItem('tidy.app.v1')") == before

        run("Conflicting clinic changes keep the entered address and do not overwrite another tab", conflicting_tabs)

        def popup(fresh):
            tab = page(fresh)
            for name in ["Amazon UAE", "Health Square"]:
                if name == "Amazon UAE":
                    tab.locator("#provider-list").get_by_role("button", name=name, exact=True).click()
                    assert tab.locator("#website-choice").is_visible()
                    assert tab.locator("#website-frame").get_attribute("src") == "about:blank"
                    tab.locator("#website-try-inside").click()
                else:
                    configure(tab, CLINIC)
                    tab.locator("#health-square-open").click()
                before = saved(tab)
                with tab.expect_popup() as opened:
                    tab.frame_locator("#website-frame").locator("#sign-in").click()
                child = opened.value
                child.wait_for_load_state()
                assert child.url.endswith("/sign-in")
                assert child.locator("h1").inner_text() == "Intercepted provider page"
                assert tab.locator("#website-dialog").is_visible()
                assert saved(tab) == before
                child.close()
                tab.locator('[data-close="website-dialog"]').click()

        run("Provider user-click popups work without navigating or changing Tidy data", popup)

        def narrow(fresh):
            tab = page(fresh)
            configure(tab, CLINIC)
            assert tab.locator("#view-tools").evaluate("node=>node.scrollWidth<=node.clientWidth")
            tab.locator("#health-square-open").click()
            tab.locator("#website-report-problem").click()
            assert tab.locator("#website-recovery").is_visible()
            assert tab.locator("#website-dialog").evaluate("node=>node.scrollWidth<=node.clientWidth")
            assert tab.locator("#website-open-direct").get_attribute("href") == CLINIC
            tab.locator("#website-retry").click()
            assert tab.locator("#website-frame").get_attribute("src") == CLINIC
            tab.screenshot(path=OUT / "clinic-320.png")

        run("Clinic controls and recovery fit a narrow phone layout", narrow, width=320)
        browser.close()

    results.append({"name": "No JavaScript errors or unexpected external requests", "result": "PASS" if not errors and not unexpected else "FAIL", "errors": errors, "external_requests": unexpected})
    report = {"url": args.url, "scope": "Isolated synthetic provider pages; real login, checkout and clinic compatibility are unverified.", "results": results}
    suffix = "live" if args.url.startswith("https://") else "local"
    (OUT / (suffix + "-report.json")).write_text(json.dumps(report, indent=2))
    raise SystemExit(1 if any(result["result"] == "FAIL" for result in results) else 0)


if __name__ == "__main__":
    main()
