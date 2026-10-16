"""Exercise Tidy's calendar snapshot and family-aware daily planning.

Only the selected Tidy origin reaches the network. Every case uses a fresh
browser context, synthetic calendar files and a fixed Dubai school day. These
checks cover real browser controls, storage, file imports and downloads. They
do not request access to an iPhone calendar, contact a calendar provider,
verify native notifications or perform any real booking or purchase.
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
OUT = ROOT / ".qa-results" / "planning"
KEY = "tidy.app.v1"
DAY = "2026-10-15"
FIXED_TIME = datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc)
ICS = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tidy QA//Synthetic//EN",
    "BEGIN:VEVENT", "UID:fixed-meeting@tidy-qa.invalid",
    "DTSTART;TZID=Asia/Dubai:20261015T170000",
    "DTEND;TZID=Asia/Dubai:20261015T180000",
    "SUMMARY:Fixed family meeting", "END:VEVENT",
    "BEGIN:VEVENT", "UID:school-day@tidy-qa.invalid",
    "DTSTART;VALUE=DATE:20261016", "DTEND;VALUE=DATE:20261017",
    "SUMMARY:All-day school trip", "END:VEVENT", "END:VCALENDAR", "",
])
QUOTA_FIXTURE = """(() => {
  window.__rejectTidyWrites = false;
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled calendar planning quota fixture', 'QuotaExceededError');
    return original.call(this, key, value);
  };
})();"""


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def state(tab):
    return tab.evaluate("TidyDemo.getState()")


def saved(tab):
    return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def section(tab, name):
    tab.locator('[data-view="tools"]').click()
    tab.locator(f'#view-tools [data-go="{name}"]').click()
    assert tab.locator("section.view:visible").count() == 1
    assert tab.locator("#view-" + name).is_visible()


def ask(tab, text):
    tab.locator('[data-view="assistant"]').click()
    tab.locator("#capture-text").fill(text)
    tab.locator('#capture-form button[type="submit"]').click()
    tab.wait_for_function("""() => ['done','waiting','error'].includes(
      document.getElementById('assistant-activity').dataset.status)""")


def skip_intro(tab):
    if tab.locator("#calendar-onboarding-dialog").is_visible():
        tab.locator("#calendar-onboarding-later").click()


def configure(tab, **changes):
    section(tab, "planning-settings")
    workdays = changes.pop("workDays", [1, 2, 3, 4, 5])
    schooldays = changes.pop("schoolDays", [1, 2, 3, 4, 5])
    fields = {
        "workStart": "08:00", "workEnd": "17:00", "kidsHome": "15:00",
        "dayStart": "07:00", "dayEnd": "20:30", "taskMinutes": 30,
        "familyMinutes": 45, "bufferMinutes": 15,
    }
    fields.update(changes)
    selectors = {
        "workStart": "work-start", "workEnd": "work-end", "kidsHome": "kids-home",
        "dayStart": "day-start", "dayEnd": "day-end", "taskMinutes": "task-minutes",
        "familyMinutes": "family-minutes", "bufferMinutes": "buffer-minutes",
    }
    tab.locator("#planning-enabled").check()
    for weekday in range(7):
        tab.locator(f'[name="planning-workday"][value="{weekday}"]').set_checked(weekday in workdays)
        tab.locator(f'[name="planning-schoolday"][value="{weekday}"]').set_checked(weekday in schooldays)
    for field, value in fields.items():
        tab.locator("#planning-" + selectors[field]).fill(str(value))
    tab.locator("#planning-settings-save").click()
    tab.wait_for_function("TidyDemo.getState().planningProfile?.enabled===true")
    return fields


def import_calendar(tab, contents=ICS, filename="synthetic-family.ics"):
    section(tab, "calendar")
    tab.locator("#calendar-file").set_input_files({
        "name": filename, "mimeType": "text/calendar", "buffer": contents.encode(),
    })
    tab.wait_for_function("TidyDemo.getState().calendar?.sourceName === 'synthetic-family.ics'")


def add_task(tab, title, category="Home", date="", time="", kind="task", repeat="none"):
    tab.locator('[data-view="family"]').click()
    tab.locator("#family-add").click()
    tab.locator("#task-title").fill(title)
    tab.locator("#task-category").select_option(category)
    tab.locator("#task-type").select_option(kind)
    tab.locator("#task-date").fill(date)
    tab.locator("#task-time").fill(time)
    tab.locator("#task-repeat").select_option(repeat)
    tab.locator("#save-task").click()
    tab.wait_for_function("title=>TidyDemo.getState().tasks.some(task=>task.title===title)", arg=title)
    return next(task for task in state(tab)["tasks"] if task["title"] == title)


def download_backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as downloading:
        tab.locator("#export-backup").click()
    result = json.loads(Path(downloading.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return result


def restore_backup(tab, data):
    tab.locator("#open-settings").click()
    tab.locator("#import-backup").set_input_files({
        "name": "synthetic-family-backup.json", "mimeType": "application/json",
        "buffer": json.dumps(data).encode(),
    })


def minutes(value):
    hour, minute = value.split(":")
    return int(hour) * 60 + int(minute)


def assert_no_overflow(tab, selector):
    bounds = tab.locator(selector).evaluate("""node => ({
      client: node.clientWidth, scroll: node.scrollWidth,
      document: document.documentElement.scrollWidth, viewport: innerWidth
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
    target_origin = origin(args.url)
    if target_origin[0] not in {"http", "https"} or not target_origin[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
              for path in (ROOT / "web").glob("*")
              if path.suffix in {".js", ".html", ".css"}}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def page(context, suffix=""):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: errors.append(str(problem)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(FIXED_TIME)
            tab.goto(args.url + suffix)
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            return tab

        def run(name, check, width=1100):
            if args.case and not any(pattern.casefold() in name.casefold() for pattern in args.case):
                return
            context = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 950})
            context.add_init_script(QUOTA_FIXTURE)

            def guard(route):
                if origin(route.request.url) == target_origin:
                    route.continue_()
                else:
                    external.append(route.request.url)
                    route.abort("blockedbyclient")

            context.route("**/*", guard)
            before = len(errors)
            try:
                evidence = check(context)
                assert len(errors) == before, errors[before:]
                result = {"name": name, "result": "PASS", "evidence": evidence}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
                for index, tab in enumerate(context.pages):
                    try:
                        tab.screenshot(path=str(output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + f"-{index}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        # Scenarios below exercise the public controls rather than calling
        # model APIs, so a successful test includes the actual persistence path.

        def introduction(context):
            tab = page(context)
            dialog = tab.locator("#calendar-onboarding-dialog")
            assert dialog.is_visible()
            text = dialog.inner_text()
            assert re.search(r"cannot read.*phone|can.t read.*phone", text, re.I), text
            assert ".ics" in text or "calendar file" in text.lower()
            tab.locator("#calendar-onboarding-later").click()
            assert not dialog.is_visible()
            assert not state(tab).get("calendar")
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            assert not dialog.is_visible()
            assert tab.evaluate("localStorage.getItem('tidy.calendar-welcome.v1')") is not None
            section(tab, "calendar")
            assert tab.locator("#calendar-file").is_visible()
            return {"transparentFileImportOnly": True, "skipPersists": True, "setUpLaterAvailable": True}

        run("First opening explains calendar-file access honestly and Not now persists", introduction)

        def introduction_accept(context):
            tab = page(context)
            tab.locator("#calendar-onboarding-start").click()
            assert tab.locator("#view-calendar").is_visible()
            assert not tab.locator("#calendar-onboarding-dialog").is_visible()
            assert not state(tab).get("calendar")
            assert re.search(r"no calendar|not imported|choose|import", tab.locator("#calendar-status").inner_text(), re.I)
            assert not re.search(r"connected successfully|phone calendar connected", tab.locator("#view-calendar").inner_text(), re.I)
            return {"opensCalendarImport": True, "doesNotClaimPhoneConnection": True}

        run("Choosing calendar setup opens its own section without pretending to connect a phone", introduction_accept)

        def calendar_import(context):
            tab = page(context)
            skip_intro(tab)
            import_calendar(tab)
            calendar = saved(tab)["calendar"]
            assert len(calendar["events"]) == 2, calendar
            timed = next(event for event in calendar["events"] if not event["allDay"])
            whole_day = next(event for event in calendar["events"] if event["allDay"])
            assert timed["startAt"] == int(datetime(2026, 10, 15, 13, tzinfo=timezone.utc).timestamp() * 1000)
            assert timed["endAt"] - timed["startAt"] == 60 * 60 * 1000
            assert whole_day["endAt"] - whole_day["startAt"] == 24 * 60 * 60 * 1000
            events = tab.locator("#calendar-events").inner_text()
            assert "Fixed family meeting" in events and "All-day school trip" in events
            assert re.search(r"17:00|5:00\s*pm|5\s*pm", events, re.I), events
            assert re.search(r"all.day", events, re.I), events
            tab.reload()
            tab.wait_for_function("TidyDemo.getState().calendar?.events.length===2")
            assert saved(tab)["calendar"] == calendar
            return {"importedEvents": 2, "DubaiTimedInterval": True, "exclusiveAllDayEnd": True, "reloadPreservesSnapshot": True}

        run("Calendar file imports real timed and all-day commitments and preserves them on reload", calendar_import)

        def invalid_calendar(context):
            tab = page(context)
            skip_intro(tab)
            import_calendar(tab)
            before = saved(tab)
            fixtures = [
                ("broken.ics", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261015T130000Z\r\nSUMMARY:Broken event\r\nEND:VCALENDAR\r\n", "mismatch|complete|component"),
                ("backwards.ics", "\r\n".join([
                    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:bad@tidy-qa.invalid",
                    "DTSTART:20261015T140000Z", "DTEND:20261015T130000Z", "SUMMARY:Backwards", "END:VEVENT", "END:VCALENDAR", "",
                ]), "end.*(?:follow|start)|interval"),
                ("unsupported-recurrence.ics", "\r\n".join([
                    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:monthly@tidy-qa.invalid",
                    "DTSTART:20261015T130000Z", "DTEND:20261015T140000Z", "RRULE:FREQ=MONTHLY;COUNT=3",
                    "SUMMARY:Unsupported recurring commitment", "END:VEVENT", "END:VCALENDAR", "",
                ]), "unsupported.*recurrence|daily.*weekly"),
            ]
            for name, contents, expected in fixtures:
                tab.locator("#calendar-file").set_input_files({"name": name, "mimeType": "text/calendar", "buffer": contents.encode()})
                tab.locator("#calendar-error").wait_for(state="visible")
                tab.wait_for_function("pattern=>new RegExp(pattern,'i').test(document.getElementById('calendar-error').textContent)", arg=expected)
                assert saved(tab) == before
                assert state(tab)["calendar"] == before["calendar"]
            return {"rejectedMalformedStructure": True, "rejectedNegativeInterval": True, "rejectedUnsupportedRecurrence": True, "previousCalendarPreserved": True}

        run("Malformed calendar files show an error and leave previously imported commitments untouched", invalid_calendar)

        def confirm_hours(context):
            tab = page(context)
            skip_intro(tab)
            ask(tab, "I have to do work with the kids")
            tasks = saved(tab)["tasks"]
            assert len(tasks) == 1
            task = tasks[0]
            assert not task["dueTime"] and task["remindAt"] is None, task
            assert re.search(r"hours|routine|set.*up|confirm", tab.locator("#assistant-activity-reply").inner_text(), re.I)
            tab.locator("#assistant-activity-open").click()
            assert tab.locator("#view-planning-settings").is_visible()
            assert not tab.locator("#planning-enabled").is_checked()
            tab.locator("#planning-work-start").fill("18:00")
            tab.locator("#planning-work-end").fill("08:00")
            tab.locator("#planning-settings-save").click()
            tab.locator("#planning-settings-error").wait_for(state="visible")
            assert not saved(tab).get("planningProfile", {}).get("enabled")
            fields = configure(tab)
            profile = saved(tab)["planningProfile"]
            assert profile["enabled"] is True
            for key, value in fields.items():
                assert profile[key] == value, (key, profile)
            assert profile["workDays"] == [1, 2, 3, 4, 5]
            assert profile["schoolDays"] == [1, 2, 3, 4, 5]
            return {"requestKeptUntimedUntilHoursConfirmed": True, "invalidHoursRejected": True, "confirmedEditableHoursPersist": True}

        run("Tidy asks for family hours before scheduling and validates the confirmed routine", confirm_hours)

        def kids_auto_plan(context):
            tab = page(context)
            skip_intro(tab)
            import_calendar(tab)
            configure(tab)
            ask(tab, "I have to do work with the kids")
            assert tab.locator("#assistant-activity").get_attribute("data-status") == "done"
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == DAY, task
            assert minutes(task["dueTime"]) >= 18 * 60 + 15, task
            assert minutes(task["dueTime"]) + task["durationMinutes"] <= 20 * 60 + 30, task
            assert task["durationMinutes"] == 45, task
            assert task["remindAt"] is not None
            assert task.get("planningReason"), task
            assert re.search(r"work", task["planningReason"], re.I) and re.search(r"children|kids", task["planningReason"], re.I), task
            reply = tab.locator("#assistant-activity-reply").inner_text()
            hour, minute = map(int, task["dueTime"].split(":"))
            readable = f"{hour % 12 or 12}:{minute:02d} {'pm' if hour >= 12 else 'am'}"
            assert task["dueTime"] in tab.locator("#assistant-activity").inner_text() or readable in reply.lower(), reply
            assert not saved(tab)["actions"]
            assert tab.locator("#view-planning").is_visible()
            assert task["title"] in tab.locator("#planning-items").inner_text()
            return {"date": task["dueDate"], "start": task["dueTime"], "durationMinutes": task["durationMinutes"],
                    "realLocalReminder": True, "avoidsWorkSchoolAndImportedMeeting": True, "externalActions": 0}

        run("Ask Tidy schedules schoolwork after parent and children are home and around imported busy time", kids_auto_plan)

        def different_schooldays(context):
            tab = page(context)
            skip_intro(tab)
            configure(tab, workDays=[], schoolDays=[1, 2, 3, 4, 5])
            ask(tab, "I have to do work with the kids")
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == DAY
            assert 15 * 60 <= minutes(task["dueTime"]) < 17 * 60, task
            assert task["remindAt"] is not None
            profile = saved(tab)["planningProfile"]
            assert profile["workDays"] == [] and profile["schoolDays"] == [1, 2, 3, 4, 5]
            return {"parentDayOff": True, "childrenStillAtSchoolUntil": "15:00", "homeworkStart": task["dueTime"], "separateSchoolDaysHonoured": True}

        run("Children school days stay distinct from a parent day off when choosing family-task time", different_schooldays)

        def organise_day(context):
            tab = page(context)
            skip_intro(tab)
            configure(tab, dayEnd="21:00")
            import_calendar(tab)
            first = add_task(tab, "Homework with the kids", "School")
            second = add_task(tab, "Read with the kids", "School")
            fixed = add_task(tab, "Confirmed dentist", "Health", DAY, "18:30", "appointment")
            fixed_before = next(task for task in saved(tab)["tasks"] if task["id"] == fixed["id"])
            section(tab, "planning")
            tab.locator("#planning-date").fill(DAY)
            tab.locator("#planning-run").click()
            tab.wait_for_function("TidyDemo.getState().tasks.filter(task=>task.type!=='appointment').every(task=>task.dueTime)")
            current = saved(tab)
            assert next(task for task in current["tasks"] if task["id"] == fixed["id"]) == fixed_before
            planned = sorted((task for task in current["tasks"] if task["id"] in {first["id"], second["id"]}), key=lambda item: item["dueTime"])
            assert len(planned) == 2
            intervals = [(minutes(task["dueTime"]), minutes(task["dueTime"]) + task["durationMinutes"]) for task in planned]
            for start, end in intervals:
                assert end <= 18 * 60 + 15 or start >= 19 * 60 + 15, intervals
                assert start >= 18 * 60 + 15 and end <= 21 * 60, intervals
            assert intervals[0][1] + 15 <= intervals[1][0], intervals
            assert all(task["remindAt"] is not None and task.get("planningReason") for task in planned)
            content = tab.locator("#planning-items").inner_text()
            assert all(task["title"] in content for task in current["tasks"])
            assert "Fixed family meeting" in content
            assert tab.locator("#planning-summary").inner_text().strip()
            return {"plannedFlexibleTasks": 2, "fixedAppointmentUnchanged": True, "noOverlapAndBuffer": True, "summaryIncludesCalendarAndTasks": True}

        run("Organise my day places untimed tasks without moving a fixed appointment or overlapping commitments", organise_day)

        def no_room(context):
            tab = page(context)
            skip_intro(tab)
            configure(tab)
            import_calendar(tab)
            task = add_task(tab, "Homework on school-trip day", "School", "2026-10-16")
            before = saved(tab)
            section(tab, "planning")
            tab.locator("#planning-date").fill("2026-10-16")
            tab.locator("#planning-run").click()
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status==='done'")
            after = saved(tab)
            unchanged = next(item for item in after["tasks"] if item["id"] == task["id"])
            assert unchanged == next(item for item in before["tasks"] if item["id"] == task["id"])
            assert not unchanged["dueTime"] and unchanged["remindAt"] is None
            assert task["title"] in tab.locator("#planning-unscheduled").inner_text()
            assert re.search(r"no.*(?:time|room|slot)|not.*fit|all.day|couldn.t", tab.locator("#view-planning").inner_text(), re.I)
            return {"allDayBlocksScheduling": True, "noInventedTimeOrReminder": True, "unscheduledTaskExplained": True}

        run("An all-day commitment produces an honest no-room result and leaves the untimed task unchanged", no_room)

        def backup_export_clear(context):
            tab = page(context)
            skip_intro(tab)
            configure(tab)
            import_calendar(tab)
            ask(tab, "I have to do work with the kids")
            routine = add_task(tab, "Evening family reading", "Home", "2026-10-01", "19:00", repeat="daily")
            backup = download_backup(tab)
            section(tab, "calendar")
            assert re.search(r"next\s+7\s+days|next\s+seven\s+days", tab.locator("#calendar-export-title").locator("..").inner_text(), re.I)
            with tab.expect_download() as downloading:
                tab.locator("#calendar-export").click()
            contents = Path(downloading.value.path()).read_text()
            assert "BEGIN:VCALENDAR" in contents and "BEGIN:VEVENT" in contents
            task = backup["tasks"][0]
            assert task["title"] in contents
            assert "DTSTART" in contents and "DTEND" in contents
            recurring_events = [event for event in contents.split("BEGIN:VEVENT")
                                if "SUMMARY:" + routine["title"] in event]
            assert len(recurring_events) == 7, contents
            starts = [re.search(r"DTSTART:(\d{8}T\d{6}Z)", event).group(1)
                      for event in recurring_events]
            assert starts == [f"202610{day:02d}T150000Z" for day in range(15, 22)], starts
            assert "20261001T150000Z" not in contents, contents
            assert len(set(re.findall(r"^UID:(.+)$", contents, re.M))) == contents.count("BEGIN:VEVENT"), contents
            tab.locator("#calendar-remove").click()
            tab.wait_for_function("!TidyDemo.getState().calendar")
            assert saved(tab)["tasks"] == backup["tasks"]
            restore_backup(tab, backup)
            tab.wait_for_function("TidyDemo.getState().calendar?.events.length===2")
            tab.locator('[data-close="settings-dialog"]').click()
            assert saved(tab)["planningProfile"] == backup["planningProfile"]
            assert saved(tab)["calendar"] == backup["calendar"]
            assert saved(tab)["tasks"] == backup["tasks"]
            rejected = json.loads(json.dumps(backup))
            rejected["planningProfile"]["workEnd"] = "25:99"
            before = saved(tab)
            restore_backup(tab, rejected)
            tab.locator("#backup-error").wait_for(state="visible")
            assert saved(tab) == before
            return {"manualCalendarExportHasLocalTasks": True, "pastAnchoredRoutineExportsSevenUpcomingOccurrences": starts,
                    "exportWindowExplained": True, "uniqueOccurrenceUids": True,
                    "forgetDoesNotDeleteTasks": True, "backupRestoresProfileCalendarAndPlan": True, "invalidProfileBackupPreservesSavedData": True}

        run("Calendar export, forgetting the snapshot and backup recovery retain real planning data", backup_export_clear)

        def profile_concurrency(context):
            a = page(context)
            skip_intro(a)
            configure(a)
            b = page(context)
            skip_intro(b)
            section(a, "planning-settings")
            section(b, "planning-settings")
            a.locator("#planning-work-end").fill("17:30")
            b.locator("#planning-kids-home").fill("15:30")
            a.locator("#planning-settings-save").click()
            b.wait_for_function("TidyDemo.getState().planningProfile.workEnd==='17:30'")
            assert b.locator("#planning-kids-home").input_value() == "15:30"
            b.locator("#planning-settings-save").click()
            b.wait_for_function("TidyDemo.getState().planningProfile.kidsHome==='15:30'")
            assert saved(b)["planningProfile"]["workEnd"] == "17:30"
            a.wait_for_function("TidyDemo.getState().planningProfile.kidsHome==='15:30'")
            a.locator("#planning-work-end").fill("18:00")
            b.locator("#planning-work-end").fill("19:00")
            a.locator("#planning-settings-save").click()
            b.wait_for_function("TidyDemo.getState().planningProfile.workEnd==='18:00'")
            assert b.locator("#planning-work-end").input_value() == "19:00"
            b.locator("#planning-settings-save").click()
            b.locator("#planning-settings-error").wait_for(state="visible")
            assert saved(b)["planningProfile"]["workEnd"] == "18:00"
            assert b.locator("#planning-work-end").input_value() == "19:00"
            return {"differentProfileFieldsMerge": True, "sameFieldConflictDoesNotOverwrite": True, "typedEditRetained": True}

        run("Two tabs merge separate family-hour edits and protect conflicting edits to the same hour", profile_concurrency)

        def quota_recovery(context):
            tab = page(context)
            skip_intro(tab)
            configure(tab)
            before = saved(tab)
            tab.evaluate("__rejectTidyWrites=true")
            import_calendar(tab)
            assert state(tab)["calendar"]["events"]
            assert saved(tab) == before
            assert tab.locator("#storage-warning").is_visible()
            assert re.search(r"not saved|couldn.t save|tab only|this tab", tab.locator("#calendar-status").inner_text(), re.I)
            backup = download_backup(tab)
            assert len(backup["calendar"]["events"]) == 2
            assert backup["planningProfile"]["enabled"] is True
            tab.evaluate("__rejectTidyWrites=false")
            restore_backup(tab, backup)
            tab.wait_for_function("JSON.parse(localStorage.getItem('tidy.app.v1')).calendar?.events.length===2")
            assert saved(tab)["calendar"] == backup["calendar"]
            return {"failedImportWriteNotReportedSaved": True, "unsavedSnapshotInBackup": True, "restorableAfterStorageRecovers": True}

        run("Quota failure keeps the imported calendar recoverable and never reports it saved", quota_recovery)

        def phone_layout(context):
            tab = page(context)
            dialog = tab.locator("#calendar-onboarding-dialog")
            assert dialog.is_visible()
            assert_no_overflow(tab, "#calendar-onboarding-dialog")
            tab.locator("#calendar-onboarding-later").focus()
            tab.keyboard.press("Enter")
            assert not dialog.is_visible()
            configure(tab)
            for name in ["calendar", "planning", "planning-settings"]:
                section(tab, name)
                assert_no_overflow(tab, "#view-" + name)
                heading = tab.locator("#" + name + "-title")
                assert heading.evaluate("node=>document.activeElement===node")
                tab.keyboard.press("Tab")
                assert tab.evaluate("document.activeElement.tagName") != "BODY"
                tab.screenshot(path=str(output / (name + "-320.png")))
            return {"width": 320, "keyboardSkipAndSectionFocus": True, "noHorizontalOverflow": True}

        run("Calendar and planning screens fit 320px and support keyboard navigation", phone_layout, width=320)

        browser.close()

    report = {"url": args.url, "sourceHashes": hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": external,
              "scope": "Synthetic ICS imports and browser-local planning; no live calendar accounts, iPhone permission or native delivery."}
    report_path = output / ("live-report.json" if args.url.startswith("https://") else "local-report.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(item["result"] == "PASS" for item in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(external), "report": str(report_path)}))
    raise SystemExit(1 if not results or passed != len(results) or errors or external else 0)


if __name__ == "__main__":
    main()
