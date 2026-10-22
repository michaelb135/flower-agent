"""Exercise Tidy's prominent Ask button and saved change history.

Uses isolated synthetic browser data and blocks requests outside the selected
Tidy origin. No retailer account, real message, purchase or booking is accessed.
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
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled history quota failure', 'QuotaExceededError');
    return original.call(this, key, value);
  };
})();"""


def origin(url):
    u = urlsplit(url)
    return u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80)


def state(tab):
    return tab.evaluate("TidyDemo.getState()")


def saved(tab):
    return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def entries(tab):
    return state(tab).get("activityHistory", {}).get("entries", [])


def record_text(tab):
    return json.dumps(entries(tab), ensure_ascii=False)


def home(tab):
    tab.locator('.app-nav [data-view="assistant"]').click()


def section(tab, name):
    primary = tab.locator(f'.app-nav [data-view="{name}"]')
    if primary.count():
        primary.click()
    else:
        tab.locator("#open-settings").click()
        tab.locator('#settings-dialog [data-go="tools"]').click()
        tab.locator(f'#view-tools [data-go="{name}"]').click()
    if tab.locator("#calendar-onboarding-dialog").is_visible():
        tab.locator("#calendar-onboarding-later").click()
    assert tab.locator("section.view:visible").get_attribute("id") == "view-" + name


def add_task(tab, title, kind="task", date="", time=""):
    section(tab, "family")
    tab.locator("#family-add").click()
    tab.locator("#task-title").fill(title)
    tab.locator("#task-type").select_option(kind)
    tab.locator("#task-date").fill(date)
    tab.locator("#task-time").fill(time)
    tab.locator("#save-task").click()
    return next(t for t in state(tab)["tasks"] if t["title"] == title)


def task_row(tab, task, container="family-tasks"):
    return tab.locator(f'#{container} [data-task-id="{task["id"]}"]')


def add_grocery(tab, title, amount=""):
    section(tab, "shopping")
    tab.locator("#grocery-title").fill(title)
    tab.locator("#grocery-quantity").fill(amount)
    tab.locator("#grocery-add").click()
    return next(t for t in state(tab)["tasks"] if t["title"] == title)


def ask(tab, text):
    home(tab)
    tab.locator("#capture-text").fill(text)
    tab.locator('#capture-form button[type="submit"]').click()
    tab.wait_for_function("""() => !document.getElementById('capture-form').hasAttribute('aria-busy') &&
      ['done','waiting','error'].includes(document.getElementById('assistant-activity').dataset.status)""")


def backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as download:
        tab.locator("#export-backup").click()
    data = json.loads(Path(download.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return data


def restore(tab, data):
    tab.locator("#open-settings").click()
    tab.locator("#import-backup").set_input_files({"name": "synthetic-history.json", "mimeType": "application/json", "buffer": json.dumps(data).encode()})
    tab.wait_for_function("() => !document.getElementById('import-backup').value")


def no_overflow(tab, selector):
    b = tab.locator(selector).evaluate("n => ({client:n.clientWidth,scroll:n.scrollWidth,document:document.documentElement.scrollWidth,viewport:innerWidth})")
    assert b["scroll"] <= b["client"] + 1 and b["document"] <= b["viewport"] + 1, b


def largest_ask(tab):
    rows = tab.locator('#main-navigation [data-view]').evaluate_all("""nodes => nodes.map(n => {
      const b=n.getBoundingClientRect();return {name:n.dataset.view,width:b.width,height:b.height,
      font:parseFloat(getComputedStyle(n).fontSize),left:b.left,right:b.right};})""")
    assert len(rows) == 6
    main = next(r for r in rows if r["name"] == "assistant")
    other = [r for r in rows if r["name"] != "assistant"]
    assert main["width"] * main["height"] > max(r["width"] * r["height"] for r in other) * 2, rows
    assert main["font"] > max(r["font"] for r in other) * 1.3, rows
    assert main["height"] > max(r["height"] for r in other), rows
    assert all(r["width"] >= 44 and r["height"] >= 44 for r in rows), rows
    no_overflow(tab, "#main-navigation")
    return {"buttons": 6, "askArea": main["width"] * main["height"], "askFont": main["font"], "askIsLargest": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9051/")
    parser.add_argument("--output", type=Path, default=ROOT / ".qa-results/history")
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--browser", default="/usr/bin/chromium")
    args = parser.parse_args()
    selected = origin(args.url)
    if selected[0] not in {"http", "https"} or not selected[1]:
        parser.error("--url must identify an HTTP(S) Tidy deployment")
    args.output.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    hashes = {n: hashlib.sha256((ROOT / "web" / n).read_bytes()).hexdigest() for n in ["index.html", "styles.css", "app.js", "core.js", "history.js"] if (ROOT / "web" / n).exists()}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.browser, headless=True)

        def page(context):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda e: errors.append(str(e)))
            tab.on("dialog", lambda d: d.accept())
            tab.clock.set_fixed_time(datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc))
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
            start_errors = len(errors)
            try:
                evidence = check(context)
                assert len(errors) == start_errors, errors[start_errors:]
                result = {"name": name, "result": "PASS", "evidence": evidence}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
                for i, tab in enumerate(context.pages):
                    try:
                        tab.screenshot(path=str(args.output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()) + f"-{i}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def initial(context):
            tab = page(context)
            assert not entries(tab), entries(tab)
            before = state(tab)
            geometry = largest_ask(tab)
            for view in ["today", "family", "meals", "shopping", "calendar", "assistant"]:
                section(tab, view)
                largest_ask(tab)
            assert state(tab) == before
            assert not entries(tab)
            assert tab.locator("#assistant-history").is_visible()
            assert re.search(r"(?:changes|activity|history).*(?:here|from|appear)|no.*(?:changes|activity)", tab.locator("#assistant-history").inner_text(), re.I | re.S)
            # A browser upgrading an older saved app has no historical event log.
            # Loading its existing records must not pretend they were just added.
            add_task(tab, "Legacy task present before activity history")
            legacy = saved(tab)
            legacy.pop("activityHistory", None)
            tab.evaluate("data => localStorage.setItem('tidy.app.v1', JSON.stringify(data))", legacy)
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            assert state(tab)["tasks"][0]["title"] == "Legacy task present before activity history"
            assert not entries(tab)
            return {**geometry, "bootstrapAndNavigationDoNotInventChanges": True, "existingRecordsNotBackfilledAsNewChanges": True, "historyStartsWithNewChanges": True}
        run("Ask Tidy is largest across sections and navigation does not invent change records", initial)

        def task_lifecycle(context):
            tab = page(context)
            task = add_task(tab, "School folder history check")
            assert "School folder history check" in record_text(tab)
            before = len(entries(tab))
            task_row(tab, task).get_by_role("button", name="Edit", exact=True).click()
            tab.locator("#task-title").fill('School folder <img src=x onerror="window.__historyXss=1">')
            tab.locator("#task-notes").fill("PRIVATE_DOCTOR_NOTES_SHOULD_NOT_ENTER_ACTIVITY")
            tab.locator("#save-task").click()
            assert len(entries(tab)) > before
            assert "PRIVATE_DOCTOR_NOTES_SHOULD_NOT_ENTER_ACTIVITY" not in record_text(tab)
            task = next(t for t in state(tab)["tasks"] if t["id"] == task["id"])
            task_row(tab, task).get_by_role("button", name="Complete " + task["title"], exact=True).click()
            section(tab, "family")
            tab.locator("#status-filter").select_option("all")
            task_row(tab, task).get_by_role("button", name="Reopen " + task["title"], exact=True).click()
            task_row(tab, task).get_by_role("button", name="Remove", exact=True).click()
            assert not state(tab)["tasks"]
            home(tab)
            text = tab.locator("#assistant-history-list").inner_text()
            assert re.search(r"add|creat", text, re.I) and re.search(r"complet|done", text, re.I) and re.search(r"reopen", text, re.I) and re.search(r"remov|delet", text, re.I), text
            assert "School folder" in text
            assert tab.locator("#assistant-history-list img").count() == 0
            assert not tab.evaluate("window.__historyXss || false")
            assert len({e["id"] for e in entries(tab)}) == len(entries(tab))
            tab.locator("#assistant-history-list").get_by_role("button", name="Open Tasks", exact=True).first.click()
            assert tab.locator("#view-family").is_visible()
            assert not state(tab)["tasks"]
            return {"addEditCompleteReopenDeleteRecorded": True, "deletedTitleStillVisible": True, "notesNotCopiedToHistory": True, "markupRemainsText": True}
        run("Task edits, completion, reopening and deletion remain recorded in Ask Tidy", task_lifecycle)

        def groceries_and_appointments(context):
            tab = page(context)
            grocery = add_grocery(tab, "History milk", "1 bottle")
            add_grocery(tab, "History milk", "1 bottle")
            assert len(entries(tab)) == 1, entries(tab)
            task_row(tab, grocery, "shopping-tasks").get_by_role("button", name="Edit", exact=True).click()
            tab.locator("#task-quantity").fill("2 bottles")
            tab.locator("#save-task").click()
            task_row(tab, grocery, "shopping-tasks").get_by_role("button", name="Complete History milk", exact=True).click()
            appointment = add_task(tab, "History dentist", "appointment", "2026-10-23", "18:00")
            assert appointment["type"] == "appointment"
            home(tab)
            text = tab.locator("#assistant-history-list").inner_text()
            assert "History milk" in text and "History dentist" in text
            assert re.search(r"quantit|amount|2 bottles|updated|changed", text, re.I), text
            assert len(entries(tab)) >= 4
            return {"groceryQuantityAndCompletionRecorded": True, "duplicateSubmissionNotRecordedAgain": True, "appointmentRecorded": True}
        run("Groceries and appointment changes made outside Ask Tidy appear in its history", groceries_and_appointments)

        def meals(context):
            tab = page(context)
            section(tab, "meals")
            tab.locator("#quick-menu-request").fill("tomato pasta")
            tab.locator("#quick-menu-prepare").click()
            assert state(tab)["menuHelper"]["draft"]["status"] == "draft"
            tab.locator("#quick-menu-approve").click()
            assert state(tab)["menuHelper"]["draft"]["status"] == "approved"
            section(tab, "meals")
            tab.locator("#breakfast-monday").fill("Cheese toast")
            tab.locator("#breakfast-save").click()
            home(tab)
            text = tab.locator("#assistant-history-list").inner_text()
            assert re.search(r"tomato pasta", text, re.I) and re.search(r"approv|confirm", text, re.I), text
            assert re.search(r"breakfast|Cheese toast", text, re.I), text
            assert "no order placed" in text.lower(), text
            affirmative = re.sub(r"\bno order placed\b", "", text, flags=re.I)
            assert not re.search(r"order placed|payment completed|groceries bought|purchase completed", affirmative, re.I), text
            return {"mealDraftAndApprovalRecorded": True, "manualWeekdayChoiceRecorded": True, "approvalNotClaimedAsPurchase": True}
        run("Menu preparation, grocery approval and typed weekday meals are recorded accurately", meals)

        def household_settings_requests(context):
            tab = page(context)
            section(tab, "household")
            tab.locator("#add-member").click()
            tab.locator("#member-name").fill("History grandma")
            tab.locator('#member-form button[type="submit"]').click()
            section(tab, "health")
            tab.locator("#health-square-url").fill("https://clinic.example/history")
            tab.locator("#health-square-save").click()
            tab.locator("#open-settings").click()
            tab.locator("#checkin-enabled").check()
            tab.locator('#settings-form button[type="submit"]').click()
            tab.locator('[data-close="settings-dialog"]').click()
            ask(tab, "Buy a new school backpack")
            action, = state(tab)["actions"]
            section(tab, "requests")
            tab.locator(f'[data-action-id="{action["id"]}"]').get_by_role("button", name="Approve draft", exact=True).click()
            assert state(tab)["actions"][0]["status"] == "approved_draft"
            home(tab)
            text = tab.locator("#assistant-history-list").inner_text()
            assert "History grandma" in text
            assert re.search(r"clinic|Health Square|website", text, re.I)
            assert re.search(r"check.in|setting|reminder", text, re.I)
            assert re.search(r"backpack", text, re.I) and re.search(r"draft|review", text, re.I)
            assert not re.search(r"purchase completed|order placed", text, re.I)
            return {"householdAndSettingsChangesRecorded": True, "purchaseDraftAndApprovalRecorded": True, "noProviderTransactionClaim": True}
        run("Household names, settings and request approvals are visible in the same history", household_settings_requests)

        def calendar(context):
            tab = page(context)
            section(tab, "calendar")
            ics = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tidy QA//Synthetic//EN", "BEGIN:VEVENT", "UID:history-meeting@tidy.invalid", "DTSTART;TZID=Asia/Dubai:20261022T170000", "DTEND;TZID=Asia/Dubai:20261022T180000", "SUMMARY:Private meeting title must not enter history", "END:VEVENT", "END:VCALENDAR", ""])
            tab.locator("#calendar-file").set_input_files({"name": "history.ics", "mimeType": "text/calendar", "buffer": ics.encode()})
            tab.wait_for_function("!!TidyDemo.getState().calendar")
            assert entries(tab)
            tab.locator("#calendar-remove").click()
            assert not state(tab).get("calendar")
            home(tab)
            text = tab.locator("#assistant-history-list").inner_text()
            assert re.search(r"calendar", text, re.I) and re.search(r"remov|forget|clear", text, re.I), text
            assert "Private meeting title must not enter history" not in record_text(tab)
            return {"calendarImportAndRemovalRecorded": True, "privateEventContentNotCopiedToHistory": True}
        run("Calendar import and removal are recorded without copying private event contents", calendar)

        def reload_and_backup(context):
            tab = page(context)
            add_task(tab, "History backup task")
            add_grocery(tab, "History backup apples", "4")
            exported = backup(tab)
            ids = {e["id"] for e in entries(tab)}
            assert exported["activityHistory"]["entries"] == entries(tab)
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            assert {e["id"] for e in entries(tab)} == ids
            add_task(tab, "Post backup temporary task")
            ids_before_restore = {e["id"] for e in entries(tab)}
            restore(tab, exported)
            tab.wait_for_function("!TidyDemo.getState().tasks.some(t=>t.title==='Post backup temporary task')")
            assert ids_before_restore <= {e["id"] for e in entries(tab)}
            assert len({e["id"] for e in entries(tab)}) == len(entries(tab))
            tab.locator('[data-close="settings-dialog"]').click()
            home(tab)
            assert re.search(r"backup|restor", tab.locator("#assistant-history-list").inner_text(), re.I)
            before = saved(tab)
            invalid = json.loads(json.dumps(exported))
            invalid["activityHistory"]["entries"][0]["at"] = -1
            restore(tab, invalid)
            assert tab.locator("#backup-error").is_visible()
            assert saved(tab) == before
            return {"historySurvivesReloadAndBackupRestore": True, "postBackupChangesRemainRecordedAfterRestore": True, "restoreRecorded": True, "invalidHistoryRejectedWithoutWrites": True}
        run("History survives reload and backup restore while invalid imported entries are rejected", reload_and_backup)

        def quota(context):
            tab = page(context)
            before = saved(tab)
            tab.evaluate("window.__rejectTidyWrites=true")
            add_grocery(tab, "Unsaved history pears", "3")
            assert "Unsaved history pears" in record_text(tab)
            assert saved(tab) == before
            home(tab)
            assert re.search(r"not saved|this tab|backup", tab.locator("#assistant-history-status").inner_text(), re.I)
            with tab.expect_download() as download:
                tab.locator("#assistant-history-download").click()
            history_export = json.loads(Path(download.value.path()).read_text())
            assert history_export["entries"] == entries(tab)
            recoverable = backup(tab)
            assert "Unsaved history pears" in json.dumps(recoverable["activityHistory"])
            count = len(entries(tab))
            tab.evaluate("window.__rejectTidyWrites=false")
            add_grocery(tab, "Unsaved history pears", "3")
            assert len(entries(tab)) == count
            assert saved(tab)["activityHistory"]["entries"] == entries(tab)
            home(tab)
            assert not re.search(r"not saved|this tab only", tab.locator("#assistant-history-status").inner_text(), re.I)
            return {"unsavedChangeAndHistoryRecoverableInBackup": True, "historyOnlyExportIncludesPendingChanges": True, "failureLabelHonest": True, "retryDoesNotDuplicateEvent": True}
        run("Failed local saving retains history for backup and retry saves each change once", quota)

        def failed_undo(context):
            tab = page(context)
            ask(tab, "Remind me to call doctor tomorrow at 6 pm")
            task, = state(tab)["tasks"]
            before = entries(tab)
            persisted = saved(tab)
            assert len(before) == 1
            assert tab.locator("#assistant-activity-undo").is_visible()
            tab.evaluate("window.__rejectTidyWrites=true")
            tab.locator("#assistant-activity-undo").click()
            assert state(tab)["tasks"] == [task]
            assert saved(tab) == persisted
            assert entries(tab) == before
            assert re.search(r"could not be saved.*item is kept", tab.locator("#assistant-activity").inner_text(), re.I | re.S)
            tab.evaluate("window.__rejectTidyWrites=false")
            section(tab, "family")
            task_row(tab, task).get_by_role("button", name="Edit", exact=True).click()
            tab.locator("#task-title").fill(task["title"] + " reviewed")
            tab.locator("#save-task").click()
            after = entries(tab)
            assert len(after) == len(before) + 1, after
            assert after[:len(before)] == before
            assert re.search(r"edit|updat|chang", after[-1]["title"], re.I), after
            assert not any(re.search(r"remov|delet", event["title"], re.I) for event in after)
            assert saved(tab)["activityHistory"]["entries"] == after
            home(tab)
            assert len(tab.locator("#assistant-history-list [data-history-id]").all()) == len(after)
            return {"failedUndoRetainsSavedTask": True, "rolledBackDeletionNotRecorded": True,
                    "nextEditRecordedOnceWithoutReAddingTask": True}
        run("An unsaved Ask Tidy Undo keeps its task and does not invent a deletion or duplicate addition", failed_undo)

        def full_backup_boundary(context):
            tab = page(context)
            fixture = tab.evaluate("""() => {
              const core=TidyCore, data=TidyDemo.getState(), target=1024*1024-20;
              delete data.activityHistory;data.tasks=[];
              core.createTask(data,{title:'Boundary milk',type:'grocery',category:'Shopping',quantity:'1'});
              for(let i=0;i<118;i++)core.createTask(data,{title:'Boundary responsibility '+i});
              let remaining=target-new TextEncoder().encode(core.backupJSON(data)).length;
              if(remaining<0)throw Error('Boundary fixture metadata unexpectedly too large');
              for(const task of data.tasks){const count=Math.min(remaining,10000);task.notes='x'.repeat(count);remaining-=count;}
              if(remaining)throw Error('Boundary fixture has insufficient note capacity');
              const raw=core.backupJSON(data);core.parseBackup(raw);
              const bytes=new TextEncoder().encode(raw).length;
              if(bytes!==target)throw Error('Boundary fixture has wrong byte size');
              localStorage.setItem('tidy.app.v1',raw);
              return {bytes,groceryId:data.tasks[0].id,removableId:data.tasks[1].id};
            }""")
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            assert not entries(tab)
            grocery = {"id": fixture["groceryId"]}

            def quantity(amount):
                section(tab, "shopping")
                task_row(tab, grocery, "shopping-tasks").get_by_role("button", name="Edit", exact=True).click()
                tab.locator("#task-quantity").fill(amount)
                tab.locator("#save-task").click()
                assert tab.evaluate("id => JSON.parse(localStorage.getItem('tidy.app.v1')).tasks.find(t=>t.id===id).quantity", grocery["id"]) == amount

            for i, amount in enumerate(["2", "3", "2", "3"], 1):
                quantity(amount)
                home(tab)
                assert tab.locator("#assistant-history-list [data-history-id]").count() == i
                assert re.search(r"full.*history.*tab|history.*tab only", tab.locator("#assistant-history-status").inner_text(), re.I | re.S)
                assert not saved(tab).get("activityHistory")
            with tab.expect_download() as download:
                tab.locator("#assistant-history-download").click()
            pending = json.loads(Path(download.value.path()).read_text())
            ids = [event["id"] for event in pending["entries"]]
            assert len(ids) == len(set(ids)) == 4
            assert [event["details"] for event in pending["entries"]] == ["Quantity: " + amount for amount in ["2", "3", "2", "3"]]
            assert pending["olderCount"] == 0
            quantity("3")
            home(tab)
            assert [row.get_attribute("data-history-id") for row in tab.locator("#assistant-history-list [data-history-id]").all()] == ids[::-1]
            section(tab, "family")
            task_row(tab, {"id": fixture["removableId"]}).get_by_role("button", name="Remove", exact=True).click()
            persisted = saved(tab)["activityHistory"]
            assert [event["id"] for event in persisted["entries"][:4]] == ids
            assert len(persisted["entries"]) == 5 and persisted["olderCount"] == 0
            assert re.search(r"remov|delet", persisted["entries"][-1]["title"], re.I)
            home(tab)
            assert not re.search(r"not saved|tab only|saved data is full", tab.locator("#assistant-history-status").inner_text(), re.I)
            return {"legacySnapshotBytes": fixture["bytes"], "businessEditsSaveWith20BytesAvailable": True,
                    "repeatedQuantityEditsHaveDistinctHistoryIDs": True, "pendingHistoryExportHasAllFourEdits": True,
                    "noOpRetryDoesNotDuplicate": True, "freeingSpacePersistsPendingHistory": True}
        run("A nearly full old backup keeps repeated edits in history until freeing space saves the complete log", full_backup_boundary)

        def reminder_noise(context):
            tab = page(context)
            ask(tab, "Remind me to call doctor today at 10:05 am")
            task, = state(tab)["tasks"]
            assert task["remindAt"] is not None
            before = entries(tab)
            tab.clock.set_fixed_time(datetime(2026, 10, 22, 6, 6, tzinfo=timezone.utc))
            tab.evaluate("TidyDemo.checkReminders()")
            delivered, = state(tab)["tasks"]
            assert delivered["deliveredReminderAt"] == task["remindAt"]
            assert entries(tab) == before
            home(tab)
            assert len(tab.locator("#assistant-history-list [data-history-id]").all()) == len(before)
            return {"actualReminderDeliveryUpdatesMetadata": True, "deliveryTimestampDoesNotInventUserEdit": True}
        run("Reminder delivery metadata does not fill history with duplicate task edits", reminder_noise)

        def shared_tabs(context):
            first = page(context)
            second = page(context)
            add_task(first, "First tab history task")
            second.wait_for_function("TidyDemo.getState().tasks.some(t=>t.title==='First tab history task')")
            add_grocery(second, "Second tab history oranges", "6")
            first.wait_for_function("TidyDemo.getState().tasks.some(t=>t.title==='Second tab history oranges')")
            assert entries(first) == entries(second)
            text = record_text(first)
            assert "First tab history task" in text and "Second tab history oranges" in text
            assert len({e["id"] for e in entries(first)}) == len(entries(first))
            home(first)
            assert "Second tab history oranges" in first.locator("#assistant-history-list").inner_text()
            return {"bothTabsAppendWithoutClobberingEarlierEvents": True, "historyPropagatesThroughStorageEvents": True, "noDuplicateIDs": True}
        run("Two tabs retain each other's changes and update the common Ask Tidy history", shared_tabs)

        def pagination(context):
            tab = page(context)
            data = state(tab)
            data["activityHistory"] = {"version": 1, "olderCount": 7, "entries": [
                {"id": "history-page-" + str(i), "at": 1792648760000 + i,
                 "section": "Tasks", "title": "Earlier saved change " + str(i),
                 "details": "Synthetic retained history", "route": "family"}
                for i in range(35)]}
            restore(tab, data)
            assert not tab.locator("#backup-error").is_visible()
            tab.locator('[data-close="settings-dialog"]').click()
            home(tab)
            rows = tab.locator("#assistant-history-list [data-history-id]")
            first = rows.count()
            assert first == 20, first
            assert tab.locator("#assistant-history-more").is_visible()
            tab.locator("#assistant-history-more").click()
            assert rows.count() > first
            assert "Earlier saved change 0" in tab.locator("#assistant-history-list").inner_text()
            assert not tab.locator("#assistant-history-more").is_visible()
            text = tab.locator("#assistant-history-status").inner_text()
            assert "7" in text and re.search(r"older|earlier", text, re.I), text
            assert saved(tab)["activityHistory"]["olderCount"] >= 7
            return {"firstPageHas20Changes": True, "showMoreRevealsEarlierRetainedEvents": True,
                    "trimmedHistoryCountDisclosed": True}
        run("Earlier retained changes remain readable and the history limit is disclosed", pagination)

        def phone(context):
            tab = page(context)
            add_grocery(tab, "Phone history bread", "1 loaf")
            home(tab)
            largest = largest_ask(tab)
            assert "Phone history bread" in tab.locator("#assistant-history-list").inner_text()
            assert tab.locator("#assistant-history-list time").count() >= 1
            no_overflow(tab, "#assistant-history")
            tab.screenshot(path=str(args.output / f'ask-history-{tab.viewport_size["width"]}.png'), full_page=True)
            section(tab, "today")
            largest_ask(tab)
            return {**largest, "historyReadableWithoutHorizontalScrolling": True, "largestEvenWhenAnotherSectionActive": True}
        run("320px phones show the largest Ask Tidy button and readable saved history", phone, width=320)
        run("390px phones show the largest Ask Tidy button and readable saved history", phone, width=390)
        browser.close()
    report = {"url": args.url, "sourceHashes": hashes, "results": results, "javascriptErrors": errors,
              "blockedExternalRequests": external, "scope": "Synthetic browser state and provider-free UI only; no real purchases, bookings or account access."}
    path = args.output / ("live-report.json" if selected[0] == "https" else "local-report.json")
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": sum(r["result"] == "PASS" for r in results), "total": len(results), "javascriptErrors": errors, "blockedExternalRequests": len(external), "report": str(path)}))
    if not results or any(r["result"] != "PASS" for r in results) or errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
