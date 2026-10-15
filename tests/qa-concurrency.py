"""Exercise Tidy's same-browser concurrency and unsaved-data recovery.

Start an internal HTTP server for web/ on port 8821, then run this script.
Use --url to select another HTTP(S) deployment. Only that exact origin is
allowed through the browser request guard. Each scenario uses a fresh browser
context and synthetic household data. These are real same-origin tabs and real
browser storage events; selected scenarios delay the application's registered
listener until both relevant UI operations finish, without synthesizing
StorageEvents. The quota fixture throws at the
Storage API boundary in one tab instead of filling a user's browser storage.
No retailer, account, purchase, appointment or messaging integration is tested.
"""

import argparse
import hashlib
import json
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
KEY = "tidy.app.v1"
OUT = ROOT / ".qa-results" / "concurrency"
OUT.mkdir(parents=True, exist_ok=True)

# A real event reaches the browser listener normally. Only the subsequent call
# to Tidy's handler is delayed, modelling a busy/background tab. No events are
# constructed, dispatched, copied or replayed; held original callbacks run once.
STORAGE_BOUNDARIES = """
(() => {
  window.__holdStorageHandlers = false;
  window.__pendingStorageHandlers = [];
  window.__genuineStorageEvents = [];
  window.__storageHandlerInvocations = 0;
  window.__rejectTidyWrites = false;
  window.__tidyWriteAttempts = 0;
  window.__tidyWritesAtHandlerCounts = [];
  window.__mealMessagesReceived = [];
  const add = window.addEventListener;
  add.call(window, 'message', event => {
    if (event.source === document.getElementById('meals-frame')?.contentWindow &&
        typeof event.data?.type === 'string' && event.data.type.startsWith('tidy-meals-'))
      window.__mealMessagesReceived.push(event.data.type);
  });
  window.__releaseStorageHandlers = () => {
    window.__holdStorageHandlers = false;
    const callbacks = window.__pendingStorageHandlers.splice(0);
    for (const deliver of callbacks) deliver();
  };
  window.addEventListener = function(type, handler, options) {
    if (type !== 'storage' || typeof handler !== 'function')
      return add.call(this, type, handler, options);
    const target = this;
    return add.call(this, type, event => {
      if (event.key === 'tidy.app.v1')
        window.__genuineStorageEvents.push({at:performance.now(), held:window.__holdStorageHandlers, newValue:event.newValue});
      const deliver = () => {
        if (event.key === 'tidy.app.v1') window.__storageHandlerInvocations++;
        handler.call(target, event);
      };
      if (window.__holdStorageHandlers) window.__pendingStorageHandlers.push(deliver);
      else deliver();
    }, options);
  };
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1') {
      window.__tidyWriteAttempts++;
      window.__tidyWritesAtHandlerCounts.push(window.__storageHandlerInvocations);
    }
    if (window === window.top && window.__rejectTidyWrites && key === 'tidy.app.v1')
      throw new DOMException('Controlled quota failure in regression fixture', 'QuotaExceededError');
    return set.call(this, key, value);
  };
})();
"""


def state(page):
    return page.evaluate("TidyDemo.getState()")


def persisted(page):
    return page.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def titles(snapshot):
    return sorted(task["title"] for task in snapshot["tasks"])


def task_dialog(page, title=None, notes=None, task_id=None):
    page.locator('[data-view="family"]').click()
    if task_id:
        page.locator(f'[data-task-id="{task_id}"]').get_by_role("button", name="Edit", exact=True).click()
    else:
        page.locator("#family-add").click()
    if title is not None:
        page.locator("#task-title").fill(title)
    if notes is not None:
        page.locator("#task-notes").fill(notes)


def save_task(page):
    page.locator("#save-task").click()


def action_dialog(page, action_id=None):
    page.locator('[data-view="tools"]').click()
    page.locator('#view-tools [data-go="requests"]').click()
    if action_id:
        page.locator(f'[data-action-id="{action_id}"]').get_by_role("button", name="Edit draft", exact=True).click()
    else:
        page.locator("#new-action").click()


def save_action(page):
    page.locator("#action-form button[type=submit]").click()


def member_dialog(page, name):
    page.locator('[data-view="tools"]').click()
    page.locator('#view-tools [data-go="household"]').click()
    page.locator("#member-list").get_by_role("button", name=f"{name} · 0 open", exact=True).click()


def settings_dialog(page):
    page.locator("#open-settings").click()


def save_settings(page):
    page.locator("#settings-form button[type=submit]").click()


def meals(page):
    page.locator('[data-view="tools"]').click()
    page.locator('#view-tools [data-go="meals"]').click()
    page.locator('[data-meal="dinner"]').click()
    page.locator("#show-meals").click()
    return page.frame_locator("#meals-frame")


def wait_tasks(page, expected):
    page.wait_for_function(
        "expected => JSON.stringify(TidyDemo.getState().tasks.map(t=>t.title).sort()) === JSON.stringify(expected)",
        arg=sorted(expected),
    )


def wait_field(page, collection, identity, field, value):
    page.wait_for_function(
        "q => TidyDemo.getState()[q.collection].find(item=>item.id===q.id)?.[q.field] === q.value",
        arg={"collection": collection, "id": identity, "field": field, "value": value},
    )


def download_json(page, button):
    with page.expect_download() as downloaded:
        page.locator(button).click()
    return json.loads(Path(downloaded.value.path()).read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8821/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    args = parser.parse_args()
    def origin(url):
        parsed = urlsplit(url)
        return (parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    selected_origin = origin(args.url)
    if selected_origin[0] not in {"http", "https"} or not selected_origin[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    results, errors, external_requests = [], [], []
    source_hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest()
                     for name in ["app.js", "core.js", "meals.html", "index.html"]}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def context():
            fresh = browser.new_context(accept_downloads=True, viewport={"width": 1100, "height": 950})
            fresh.add_init_script(STORAGE_BOUNDARIES)

            def allow_selected_origin(route):
                if origin(route.request.url) == selected_origin:
                    route.continue_()
                else:
                    external_requests.append(route.request.url)
                    route.abort("blockedbyclient")

            fresh.route("**/*", allow_selected_origin)
            return fresh

        def page(fresh, wait_meal=True):
            tab = fresh.new_page()
            tab.set_default_timeout(7000)
            tab.on("pageerror", lambda error: errors.append(str(error)))
            tab.goto(args.url)
            tab.wait_for_function("!!window.TidyDemo")
            if wait_meal:
                tab.wait_for_function("TidyDemo.getState().mealSnapshot !== null")
            return tab

        def run(name, scenario):
            fresh = context()
            try:
                evidence = scenario(fresh)
                result = {"name": name, "result": "PASS", "evidence": evidence}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
            finally:
                fresh.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def delayed_additions(fresh):
            a, b = page(fresh), page(fresh)
            task_dialog(a, "First delayed-event addition")
            task_dialog(b, "Second delayed-event addition")
            for tab in (a, b):
                tab.evaluate("__holdStorageHandlers=true; __genuineStorageEvents=[]; __storageHandlerInvocations=0; __tidyWritesAtHandlerCounts=[]")
            save_task(a)
            b.wait_for_function("__genuineStorageEvents.length > 0")
            assert b.evaluate("__storageHandlerInvocations") == 0
            save_task(b)
            assert b.evaluate("__storageHandlerInvocations") == 0
            assert b.evaluate("__tidyWritesAtHandlerCounts.length > 0 && __tidyWritesAtHandlerCounts.every(n=>n===0)")
            a.wait_for_function("__genuineStorageEvents.length > 0")
            for tab in (a, b):
                tab.evaluate("__releaseStorageHandlers()")
            expected = ["First delayed-event addition", "Second delayed-event addition"]
            wait_tasks(a, expected)
            wait_tasks(b, expected)
            a.wait_for_timeout(200)
            assert titles(persisted(a)) == sorted(expected)
            assert titles(state(a)) == titles(state(b)) == sorted(expected)
            actual_events = [a.evaluate("__genuineStorageEvents.length"), b.evaluate("__genuineStorageEvents.length")]
            assert all(actual_events), actual_events
            a.reload()
            a.wait_for_function("!!window.TidyDemo")
            assert titles(state(a)) == sorted(expected)
            return {"titles_after_reload": titles(state(a)), "genuine_event_counts": actual_events, "handlers_held_until_both_saves": True}

        run("Delayed genuine storage-event handling preserves separate task additions and reload", delayed_additions)

        def task_merge(fresh):
            a = page(fresh)
            task_dialog(a, "School pickup", "Original notes")
            save_task(a)
            identity = state(a)["tasks"][0]["id"]
            b = page(fresh)
            task_dialog(a, task_id=identity)
            task_dialog(b, task_id=identity)
            a.locator("#task-notes").fill("Dad collects at the school gate")
            save_task(a)
            wait_field(b, "tasks", identity, "notes", "Dad collects at the school gate")
            assert b.locator("#task-notes").input_value() == "Original notes"
            b.locator("#task-title").fill("Collect children at school")
            save_task(b)
            b.locator("#task-dialog").wait_for(state="hidden")
            saved = persisted(b)["tasks"][0]
            assert saved["title"] == "Collect children at school"
            assert saved["notes"] == "Dad collects at the school gate"
            b.reload()
            b.wait_for_function("!!window.TidyDemo")
            assert state(b)["tasks"][0] == saved
            return {"title": saved["title"], "notes": saved["notes"]}

        run("Stale task editor merges different fields and survives reload", task_merge)

        def task_conflict(fresh):
            a = page(fresh)
            task_dialog(a, "Original responsibility")
            save_task(a)
            identity = state(a)["tasks"][0]["id"]
            b = page(fresh)
            task_dialog(a, task_id=identity)
            task_dialog(b, task_id=identity)
            a.locator("#task-title").fill("Remote changed responsibility")
            save_task(a)
            wait_field(b, "tasks", identity, "title", "Remote changed responsibility")
            before = persisted(b)
            writes_before = b.evaluate("__tidyWriteAttempts")
            b.locator("#task-title").fill("Local conflicting responsibility")
            save_task(b)
            assert b.locator("#task-dialog").is_visible()
            assert b.locator("#task-title").input_value() == "Local conflicting responsibility"
            assert b.locator("#task-error").is_visible()
            assert b.locator("#task-error").inner_text().strip()
            assert persisted(b) == before
            assert b.evaluate("__tidyWriteAttempts") == writes_before
            assert state(b) == before
            return {"form_title": b.locator("#task-title").input_value(), "persisted_title": before["tasks"][0]["title"], "error": b.locator("#task-error").inner_text()}

        run("Same-field task conflict retains entered form and makes no storage write", task_conflict)

        def action_merge_and_conflict(fresh):
            a = page(fresh)
            action_dialog(a)
            a.locator("#action-title").fill("Prepare a clinic request")
            a.locator("#action-details").fill("Original details")
            save_action(a)
            identity = state(a)["actions"][0]["id"]
            b = page(fresh)
            for tab in (a, b):
                action_dialog(tab, identity)
            a.locator("#action-details").fill("Ask for availability next week")
            save_action(a)
            wait_field(b, "actions", identity, "details", "Ask for availability next week")
            assert b.locator("#action-details").input_value() == "Original details"
            b.locator("#action-title").fill("Prepare appointment enquiry")
            save_action(b)
            b.locator("#action-dialog").wait_for(state="hidden")
            saved = persisted(b)["actions"][0]
            assert saved["title"] == "Prepare appointment enquiry"
            assert saved["details"] == "Ask for availability next week"
            wait_field(a, "actions", identity, "title", saved["title"])
            for tab in (a, b):
                action_dialog(tab, identity)
            a.locator("#action-title").fill("Remote appointment title")
            save_action(a)
            wait_field(b, "actions", identity, "title", "Remote appointment title")
            before = persisted(b)
            writes_before = b.evaluate("__tidyWriteAttempts")
            b.locator("#action-title").fill("Local appointment title")
            save_action(b)
            assert b.locator("#action-dialog").is_visible()
            assert b.locator("#action-title").input_value() == "Local appointment title"
            assert b.locator("#action-error").is_visible()
            assert persisted(b) == before
            assert b.evaluate("__tidyWriteAttempts") == writes_before
            assert state(b) == before
            return {"merged_details": saved["details"], "conflict_error": b.locator("#action-error").inner_text(), "external_action_taken": False}

        run("Request drafts merge different fields and keep same-field conflicts for review", action_merge_and_conflict)

        def member_conflict(fresh):
            a, b = page(fresh), page(fresh)
            for tab in (a, b):
                member_dialog(tab, "Dad")
            a.locator("#member-name").fill("Papa")
            a.locator("#member-form button[type=submit]").click()
            wait_field(b, "members", "dad", "name", "Papa")
            before = persisted(b)
            writes_before = b.evaluate("__tidyWriteAttempts")
            b.locator("#member-name").fill("Father")
            b.locator("#member-form button[type=submit]").click()
            assert b.locator("#member-dialog").is_visible()
            assert b.locator("#member-name").input_value() == "Father"
            assert b.locator("#member-error").is_visible()
            assert persisted(b) == before
            assert b.evaluate("__tidyWriteAttempts") == writes_before
            assert state(b) == before
            return {"form_name": "Father", "persisted_name": "Papa", "error": b.locator("#member-error").inner_text()}

        run("Conflicting household-name edits keep the user's form and persisted remote name", member_conflict)

        def settings_merge_and_conflict(fresh):
            a, b = page(fresh), page(fresh)
            for tab in (a, b):
                settings_dialog(tab)
            a.locator("#alerts-paused").check()
            save_settings(a)
            b.wait_for_function("TidyDemo.getState().settings.remindersPaused === true")
            assert not b.locator("#alerts-paused").is_checked()
            b.locator("#checkin-time").fill("22:00")
            save_settings(b)
            saved = persisted(b)["settings"]
            assert saved["remindersPaused"] and saved["checkinTime"] == "22:00"
            a.locator('[data-close="settings-dialog"]').click()
            b.locator('[data-close="settings-dialog"]').click()
            a.wait_for_function("TidyDemo.getState().settings.checkinTime === '22:00'")
            for tab in (a, b):
                settings_dialog(tab)
            a.locator("#checkin-time").fill("21:00")
            save_settings(a)
            b.wait_for_function("TidyDemo.getState().settings.checkinTime === '21:00'")
            before = persisted(b)
            writes_before = b.evaluate("__tidyWriteAttempts")
            previous_toast = b.locator("#toast").inner_text()
            b.locator("#checkin-time").fill("20:00")
            save_settings(b)
            assert b.locator("#settings-dialog").is_visible()
            assert b.locator("#checkin-time").input_value() == "20:00"
            assert persisted(b) == before
            assert b.evaluate("__tidyWriteAttempts") == writes_before
            assert state(b) == before
            visible_messages = " ".join(b.locator(selector).inner_text() for selector in ["#toast", "#storage-warning"] if b.locator(selector).is_visible()).lower()
            assert "changed in another tab" in visible_messages or "conflict" in visible_messages, visible_messages
            assert b.locator("#toast").inner_text() != previous_toast
            return {"disjoint_fields": saved, "persisted_conflicting_time": before["settings"]["checkinTime"], "retained_form_time": "20:00"}

        run("Settings merge disjoint changes and reject conflicting time edits without data loss", settings_merge_and_conflict)

        def quota_recovery(fresh):
            a, b = page(fresh), page(fresh)
            a.evaluate("__rejectTidyWrites=true")
            task_dialog(a, "Unsaved responsibility during quota failure")
            save_task(a)
            assert titles(state(a)) == ["Unsaved responsibility during quota failure"]
            assert a.locator("#storage-warning").is_visible()
            task_dialog(b, "Saved responsibility from another tab")
            save_task(b)
            a.wait_for_function("__genuineStorageEvents.length > 0")
            a.wait_for_timeout(200)
            assert titles(state(a)) == ["Unsaved responsibility during quota failure"]
            assert a.locator("#storage-warning").is_visible()
            assert "not saved" in a.locator("#save-status").inner_text().lower()
            assert titles(persisted(a)) == ["Saved responsibility from another tab"]
            settings_dialog(a)
            backup = download_json(a, "#export-backup")
            assert titles(backup) == ["Unsaved responsibility during quota failure"]
            a.locator('[data-close="settings-dialog"]').click()
            a.evaluate("__rejectTidyWrites=false")
            task_dialog(a, "Attempted save after quota fixture released")
            save_task(a)
            assert "Unsaved responsibility during quota failure" in titles(state(a))
            assert titles(persisted(a)) == ["Saved responsibility from another tab"]
            assert a.locator("#storage-warning").is_visible()
            assert "not saved" in a.locator("#save-status").inner_text().lower()
            assert "another tab" in a.locator("#storage-warning").inner_text().lower()
            return {"recoverable_backup_titles": titles(backup), "persisted_remote_titles_after_retry": titles(persisted(a)), "quota_scope": "controlled Storage.setItem failure in one tab", "retry_did_not_overwrite_remote_version": True}

        run("Quota-failed edits survive remote events and export; later retry cannot overwrite remote data", quota_recovery)

        def corrupt_recovery(fresh):
            b = page(fresh)
            valid = persisted(b)
            corrupt = '{"schemaVersion":1,"tasks": BROKEN synthetic recovery bytes'
            b.evaluate("raw => localStorage.setItem('tidy.app.v1', raw)", corrupt)
            a = page(fresh, wait_meal=False)
            assert a.locator("#storage-warning").is_visible()
            task_dialog(a, "Keep unsaved recovery responsibility")
            save_task(a)
            assert titles(state(a)) == ["Keep unsaved recovery responsibility"]
            # A genuine write in tab B causes a genuine browser event in A.
            # This intentionally repairs bytes at the persistence boundary;
            # it does not dispatch a synthetic event or call Tidy internals.
            b.evaluate("snapshot => localStorage.setItem('tidy.app.v1', JSON.stringify(snapshot))", valid)
            a.wait_for_function("__genuineStorageEvents.length > 0")
            a.wait_for_timeout(200)
            assert titles(state(a)) == ["Keep unsaved recovery responsibility"]
            assert a.locator("#storage-warning").is_visible()
            settings_dialog(a)
            assert a.locator("#export-recovery").is_visible()
            with a.expect_download() as recovery:
                a.locator("#export-recovery").click()
            raw = Path(recovery.value.path()).read_text()
            assert raw == corrupt
            backup = download_json(a, "#export-backup")
            assert titles(backup) == ["Keep unsaved recovery responsibility"]
            assert persisted(a) == valid
            return {"recovery_bytes_preserved": True, "unsaved_backup_titles": titles(backup), "remote_valid_data_not_overwritten": True}

        run("Corrupt-storage lock keeps original recovery bytes and unsaved edits after a valid remote write", corrupt_recovery)

        def empty_corrupt_recovery(fresh):
            seed = page(fresh)
            seed.evaluate("localStorage.setItem('tidy.app.v1', '')")
            a = page(fresh, wait_meal=False)
            assert a.locator("#storage-warning").is_visible()
            task_dialog(a, "Keep a new task alongside unreadable empty bytes")
            save_task(a)
            assert titles(state(a)) == ["Keep a new task alongside unreadable empty bytes"]
            assert a.evaluate("localStorage.getItem('tidy.app.v1')") == ""
            settings_dialog(a)
            assert a.locator("#export-recovery").is_visible()
            with a.expect_download() as recovery:
                a.locator("#export-recovery").click()
            assert Path(recovery.value.path()).read_bytes() == b""
            backup = download_json(a, "#export-backup")
            assert titles(backup) == ["Keep a new task alongside unreadable empty bytes"]
            return {"empty_saved_bytes_not_overwritten": True, "empty_recovery_copy_available": True, "new_task_exported": True}

        run("Present unreadable empty storage remains locked and both recovery copies can be downloaded", empty_corrupt_recovery)

        def meal_echo(fresh):
            a, b = page(fresh), page(fresh)
            for tab in (a, b):
                tab.evaluate("__mealMessagesReceived=[]")
            task_dialog(a, "Task before remote meal restore echo")
            save_task(a)
            wait_tasks(b, ["Task before remote meal restore echo"])
            # Task-only reconciliation need not restore unchanged meal data.
            # The real planner-opening control requests an actual restore,
            # whose genuine acknowledgement/echo must preserve those tasks.
            meals(b)
            b.wait_for_function("__mealMessagesReceived.includes('tidy-meals-restored')")
            b.wait_for_timeout(250)
            task_dialog(b, "Task after remote meal restore echo")
            save_task(b)
            expected = ["Task before remote meal restore echo", "Task after remote meal restore echo"]
            wait_tasks(a, expected)
            meals(a)
            a.wait_for_function("__mealMessagesReceived.includes('tidy-meals-restored')")
            a.wait_for_timeout(650)
            assert titles(state(a)) == titles(state(b)) == titles(persisted(a)) == sorted(expected)
            assert state(a)["mealSnapshot"] is not None and state(b)["mealSnapshot"] is not None
            return {"retained_tasks": sorted(expected), "genuine_event_counts": [a.evaluate("__genuineStorageEvents.length"), b.evaluate("__genuineStorageEvents.length")], "real_meal_restore_acknowledgements_observed": True}

        run("Meal restore acknowledgements cannot roll back another tab's saved tasks", meal_echo)

        def restored_meal_summary(fresh):
            a = page(fresh)
            fa = meals(a)
            fa.locator("#people").fill("2")
            fa.locator("#diet").select_option("mixed")
            fa.locator("#no-allergies").check()
            fa.locator("#suggest-menu").click()
            fa.locator("#approve-menu").click()
            a.wait_for_function("JSON.parse(localStorage.getItem('tidy.app.v1')).mealSummary.length === 5")
            expected = persisted(a)["mealSummary"]
            stored = persisted(a)
            stored["mealSummary"] = []
            # A valid saved/imported backup may omit this derived display
            # cache; the child must restore it from its approved meal draft.
            a.evaluate("s => localStorage.setItem('tidy.app.v1', JSON.stringify(s))", stored)
            b = page(fresh)
            b.wait_for_function("JSON.parse(localStorage.getItem('tidy.app.v1')).mealSummary.length === 5")
            assert persisted(b)["mealSummary"] == expected
            task_dialog(b, "Task after restored dinner summary")
            save_task(b)
            wait_tasks(a, ["Task after restored dinner summary"])
            assert state(a)["mealSummary"] == expected
            b.reload()
            b.wait_for_function("TidyDemo.getState().mealSummary.length === 5")
            assert state(b)["mealSummary"] == expected
            return {"five_approved_dinners_recovered_and_persisted": True, "summary_survives_task_reconciliation_and_reload": True}

        run("Restored approved meal data repairs a missing saved dinner summary across tabs and reload", restored_meal_summary)

        def meal_conflict(fresh):
            a, b = page(fresh), page(fresh)
            fa, fb = meals(a), meals(b)
            a.wait_for_timeout(200)
            b.evaluate("__holdStorageHandlers=true; __genuineStorageEvents=[]; __storageHandlerInvocations=0")
            fa.locator("#people").fill("4")
            a.wait_for_function("JSON.parse(localStorage.getItem('tidy.app.v1')).mealSnapshot?.answers.people === '4'")
            b.wait_for_function("__genuineStorageEvents.length > 0")
            assert b.evaluate("__storageHandlerInvocations") == 0
            fb.locator("#people").fill("5")
            b.wait_for_function("TidyDemo.getState().mealSnapshot?.answers.people === '5'")
            assert persisted(b)["mealSnapshot"]["answers"]["people"] == "4"
            assert b.evaluate("__storageHandlerInvocations") == 0
            b.evaluate("__releaseStorageHandlers()")
            b.wait_for_timeout(200)
            assert b.evaluate("__genuineStorageEvents.length") > 0
            assert fb.locator("#people").input_value() == "5"
            assert state(b)["mealSnapshot"]["answers"]["people"] == "5"
            assert persisted(b)["mealSnapshot"]["answers"]["people"] == "4"
            assert fa.locator("#people").input_value() == "4"
            assert b.locator("#storage-warning").is_visible()
            assert fb.locator("#save-status").get_attribute("data-error") == "true"
            settings_dialog(b)
            backup = download_json(b, "#export-backup")
            assert backup["mealSnapshot"]["answers"]["people"] == "5"
            return {"persisted_people": "4", "unsaved_visible_and_exported_people": "5", "warning": b.locator("#storage-warning").inner_text(), "handler_held_until_local_edit": True}

        run("Conflicting meal drafts keep local fields and backup visible without overwriting remote draft", meal_conflict)
        browser.close()

    end_hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest() for name in source_hashes}
    final_checks = {"name": "Stable source, no JavaScript exceptions or attempted external integrations", "result": "PASS" if not errors and not external_requests and end_hashes == source_hashes else "FAIL", "errors": errors, "external_requests": external_requests, "source_unchanged_during_run": end_hashes == source_hashes}
    results.append(final_checks)
    print(json.dumps(final_checks), flush=True)
    report = {
        "url": args.url,
        "scope": "Selected HTTP(S) origin only, isolated contexts, synthetic data, same-origin real tabs and genuine storage events. TLS verification remains enabled. Selected handlers are delayed; quota failure is simulated at Storage.setItem. No real-device, cloud-family-sharing or retailer behavior is established.",
        "source_sha256": source_hashes,
        "results": results,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    raise SystemExit(1 if any(item["result"] == "FAIL" for item in results) else 0)


if __name__ == "__main__":
    main()
