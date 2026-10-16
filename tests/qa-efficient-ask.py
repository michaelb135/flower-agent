"""Exercise Ask Tidy's shorter capture flow through real browser controls.

Each case uses a fresh synthetic household, a fixed Dubai clock and an origin
allowlist. No live retailer, calendar account, order, booking, message, device
alarm or closed-page notification is exercised. Quota fixtures throw at the
Storage boundary; cross-tab cases use genuine same-origin storage events.
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
DAY = "2026-10-15"
TOMORROW = "2026-10-16"
FIXED_TIME = datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc)
BOUNDARIES = """(() => {
  window.__rejectTidyWrites = false;
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled efficient capture quota failure', 'QuotaExceededError');
    return original.call(this, key, value);
  };
})();"""
ICS = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tidy QA//Synthetic//EN",
    "BEGIN:VEVENT", "UID:efficient-capture-busy@tidy.invalid",
    "DTSTART;TZID=Asia/Dubai:20261015T170000",
    "DTEND;TZID=Asia/Dubai:20261015T180000",
    "SUMMARY:Saved family commitment", "END:VEVENT", "END:VCALENDAR", "",
])


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def state(tab):
    return tab.evaluate("TidyDemo.getState()")


def saved(tab):
    return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def wait_result(tab, status):
    tab.wait_for_function("""expected => {
      const activity = document.getElementById('assistant-activity');
      return activity && !activity.hidden && activity.dataset.status === expected;
    }""", arg=status)


def ask(tab, text, status):
    tab.locator('[data-view="assistant"]').click()
    tab.locator("#capture-text").fill(text)
    tab.locator('#capture-form button[type="submit"]').click()
    wait_result(tab, status)


def reply(tab, text, status="done"):
    tab.locator("#assistant-clarify-answer").fill(text)
    tab.locator("#assistant-clarify-submit").click()
    wait_result(tab, status)


def choose(tab, pattern, status="done"):
    choices = tab.locator("#assistant-clarify-choices")
    selected = choices.get_by_role("button", name=re.compile(pattern, re.I))
    assert selected.count() == 1, choices.inner_text()
    selected.click()
    wait_result(tab, status)


def section(tab, name):
    tab.locator('[data-view="tools"]').click()
    tab.locator(f'#view-tools [data-go="{name}"]').click()


def configure(tab):
    section(tab, "planning-settings")
    tab.locator("#planning-enabled").check()
    tab.locator("#planning-settings-save").click()
    tab.wait_for_function("TidyDemo.getState().planningProfile?.enabled === true")


def import_busy_calendar(tab):
    section(tab, "calendar")
    tab.locator("#calendar-file").set_input_files({
        "name": "synthetic-efficiency.ics", "mimeType": "text/calendar", "buffer": ICS.encode(),
    })
    tab.wait_for_function("TidyDemo.getState().calendar?.sourceName === 'synthetic-efficiency.ics'")


def edit_task(tab, task_id, title=None, notes=None):
    tab.locator('[data-view="family"]').click()
    tab.locator(f'#family-tasks [data-task-id="{task_id}"]').get_by_role("button", name="Edit", exact=True).click()
    if title is not None:
        tab.locator("#task-title").fill(title)
    if notes is not None:
        tab.locator("#task-notes").fill(notes)
    tab.locator("#save-task").click()
    tab.wait_for_function("!document.getElementById('task-dialog').open")


def backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as downloaded:
        tab.locator("#export-backup").click()
    data = json.loads(Path(downloaded.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return data


def assert_compact(tab):
    dialog = tab.locator("#assistant-clarify-dialog")
    assert dialog.is_visible()
    assert not tab.locator("#task-dialog").is_visible()
    assert tab.locator("#assistant-clarify-question").inner_text().strip()
    assert tab.locator("#assistant-clarify-answer").is_visible()
    assert dialog.locator("input:visible, textarea:visible, select:visible").count() == 1
    return tab.locator("#assistant-clarify-question").inner_text()


def assert_no_overflow(tab, selector):
    dimensions = tab.locator(selector).evaluate("""node => ({
      width: node.clientWidth, scroll: node.scrollWidth,
      viewport: innerWidth, document: document.documentElement.scrollWidth
    })""")
    assert dimensions["scroll"] <= dimensions["width"] + 1, dimensions
    assert dimensions["document"] <= dimensions["viewport"] + 1, dimensions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9047/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--output", type=Path, default=ROOT / ".qa-results" / "efficient-ask")
    args = parser.parse_args()
    target_origin = origin(args.url)
    if target_origin[0] not in {"http", "https"} or not target_origin[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    results, javascript_errors, external_requests = [], [], []
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
              for path in (ROOT / "web").glob("*") if path.suffix in {".js", ".html", ".css"}}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def page(context):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: javascript_errors.append(str(problem)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(FIXED_TIME)
            tab.goto(args.url)
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            if tab.locator("#calendar-onboarding-dialog").is_visible():
                tab.locator("#calendar-onboarding-later").click()
            return tab

        def run(name, check, width=1100):
            if args.case and not any(part.casefold() in name.casefold() for part in args.case):
                return
            context = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 950})
            context.add_init_script(BOUNDARIES)

            def guard(route):
                if origin(route.request.url) == target_origin:
                    route.continue_()
                else:
                    external_requests.append(route.request.url)
                    route.abort("blockedbyclient")

            context.route("**/*", guard)
            errors_before = len(javascript_errors)
            try:
                evidence = check(context)
                assert len(javascript_errors) == errors_before, javascript_errors[errors_before:]
                result = {"name": name, "result": "PASS", "evidence": evidence}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
                for index, tab in enumerate(context.pages):
                    try:
                        result.setdefault("state", []).append(state(tab))
                        result.setdefault("activity", []).append(tab.locator("#assistant-activity").inner_text())
                        result.setdefault("clarification", []).append(tab.locator("#assistant-clarify-dialog").inner_text())
                        tab.screenshot(path=str(output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + f"-{index}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def one_choice(context):
            tab = page(context)
            before = saved(tab)
            ask(tab, "Remind me to call Mum at 6 o'clock", "waiting")
            question = assert_compact(tab)
            assert saved(tab) == before and not state(tab)["tasks"]
            assert "call Mum" in tab.locator("#assistant-clarify-context").inner_text()
            choose(tab, r"Tomorrow.*6.*pm")
            task, = saved(tab)["tasks"]
            assert task["title"] == "call Mum" and task["dueDate"] == TOMORROW and task["dueTime"] == "18:00", task
            assert task["remindAt"] == int(datetime(2026, 10, 16, 14, tzinfo=timezone.utc).timestamp() * 1000)
            assert not tab.locator("#assistant-clarify-dialog").is_visible()
            assert not tab.locator("#task-dialog").is_visible()
            assert tab.locator(f'#reminder-tasks [data-task-id="{task["id"]}"]').is_visible()
            return {"oneQuestion": question, "oneTapSavesDateAndTime": True, "extraSaveClicks": 0}

        run("One compact question offers a complete date and am or pm choice that saves immediately", one_choice)

        def typed_context(context):
            tab = page(context)
            ask(tab, "Mum: remind me to prepare school bags tomorrow", "waiting")
            assert_compact(tab)
            assert "prepare school bags" in tab.locator("#assistant-clarify-context").inner_text()
            reply(tab, "6 pm")
            task, = saved(tab)["tasks"]
            assert task["title"] == "prepare school bags" and task["category"] == "School", task
            assert task["assigneeId"] == "mum" and task["dueDate"] == TOMORROW and task["dueTime"] == "18:00", task
            assert task["remindAt"] is not None and not saved(tab)["actions"]
            return {"shortAnswer": "6 pm", "originalTitleCategoryPersonAndDatePreserved": True}

        run("A short typed follow-up preserves the original task person category and known date", typed_context)

        def clock_defaults_undo(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum at 6 pm", "done")
            first, = saved(tab)["tasks"]
            assert first["dueDate"] == DAY and first["dueTime"] == "18:00"
            assert not tab.locator("#assistant-clarify-dialog").is_visible()
            receipt = tab.locator("#assistant-activity").inner_text()
            assert re.search(r"today|15 Oct|next|assum|chose", receipt, re.I), receipt
            tab.locator("#assistant-activity-undo").click()
            assert not saved(tab)["tasks"] and not state(tab)["tasks"]
            ask(tab, "Remind me to call Dad at 6 am", "done")
            second, = saved(tab)["tasks"]
            assert second["dueDate"] == TOMORROW and second["dueTime"] == "06:00"
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            assert saved(tab)["tasks"] == [second]
            return {"futureClockUsesToday": True, "elapsedClockUsesTomorrow": True, "UndoRemovesOnlyCreatedTask": True}

        run("Unambiguous clock uses its next occurrence transparently and Undo removes the saved result", clock_defaults_undo)

        def automatic_routine(context):
            tab = page(context)
            configure(tab)
            import_busy_calendar(tab)
            old_calendar = saved(tab)["calendar"]
            ask(tab, "Remind me to help the kids with homework", "done")
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == DAY and task["dueTime"] == "18:15", task
            assert task["durationMinutes"] == 45 and task["planningReason"] and task["remindAt"] is not None, task
            assert saved(tab)["calendar"] == old_calendar
            assert not tab.locator("#assistant-clarify-dialog").is_visible()
            assert tab.url.endswith("#planning"), tab.url
            return {"usesConfirmedSchoolAndWorkHours": True, "avoidsImportedCommitmentAndBuffer": True,
                    "scheduled": task["dueTime"], "calendarUntouched": True}

        run("An untimed family reminder uses confirmed hours and saved calendar commitments without another question", automatic_routine)

        def unconfirmed_routine(context):
            tab = page(context)
            ask(tab, "Remind me to help the kids with homework", "waiting")
            question = assert_compact(tab)
            assert not saved(tab)["tasks"]
            assert not state(tab).get("planningProfile", {}).get("enabled", False)
            reply(tab, "tomorrow at 6 pm")
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == TOMORROW and task["dueTime"] == "18:00" and task["remindAt"] is not None, task
            assert "homework" in task["title"] and not task.get("planningReason"), task
            return {"essentialQuestion": question, "noUnconfirmedRoutineGuess": True, "singleAnswerSavedReminder": True}

        run("Without confirmed hours an untimed reminder asks one essential question instead of guessing a family routine", unconfirmed_routine)

        def no_free_slot(context):
            tab = page(context)
            configure(tab)
            blocked_day = "\r\n".join([
                "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tidy QA//Synthetic//EN",
                "BEGIN:VEVENT", "UID:fully-booked-day@tidy.invalid",
                "DTSTART;VALUE=DATE:20261015", "DTEND;VALUE=DATE:20261016",
                "SUMMARY:Family unavailable all day", "END:VEVENT", "END:VCALENDAR", "",
            ])
            section(tab, "calendar")
            tab.locator("#calendar-file").set_input_files({
                "name": "fully-booked-day.ics", "mimeType": "text/calendar", "buffer": blocked_day.encode(),
            })
            tab.wait_for_function("TidyDemo.getState().calendar?.sourceName === 'fully-booked-day.ics'")
            before = saved(tab)
            ask(tab, "Remind me to help the kids with homework today", "waiting")
            assert_compact(tab)
            assert re.search(r"could not|couldn.t|free slot|no.*slot|busy|fit", tab.locator("#assistant-clarify-dialog").inner_text(), re.I)
            assert saved(tab) == before and not state(tab)["tasks"]
            reply(tab, "tomorrow at 6 pm")
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == TOMORROW and task["dueTime"] == "18:00" and task["remindAt"] is not None, task
            return {"busyDayNotOverbooked": True, "noUntimedReminderSaved": True, "oneAnswerChoseAlternativeTime": True}

        run("A fully booked planning day asks for another time without silently saving an untimed reminder", no_free_slot)

        def invalid_short_answer(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum tomorrow", "waiting")
            assert_compact(tab)
            before = saved(tab)
            reply(tab, "I do not know yet", "waiting")
            assert_compact(tab)
            assert saved(tab) == before and not state(tab)["tasks"]
            assert "call Mum" in tab.locator("#assistant-clarify-context").inner_text()
            assert tab.locator("#assistant-clarify-error").is_visible()
            reply(tab, "6 pm")
            task, = saved(tab)["tasks"]
            assert task["title"] == "call Mum" and task["dueDate"] == TOMORROW and task["dueTime"] == "18:00"
            return {"UnclearAnswerSavedNothing": True, "originalContextRetained": True, "correctedShortAnswerSavedOnce": True}

        run("An unclear short answer keeps the same question and original details until a valid answer is given", invalid_short_answer)

        def clear_and_duplicate(context):
            tab = page(context)
            ask(tab, "We need milk", "done")
            first, = saved(tab)["tasks"]
            assert first["type"] == "grocery" and first["title"] == "milk" and first["remindAt"] is None
            assert not tab.locator("#assistant-clarify-dialog").is_visible()
            ask(tab, "We need milk", "done")
            assert saved(tab)["tasks"] == [first]
            assert not tab.locator("#assistant-activity-undo").is_visible()
            assert tab.url.endswith("#shopping")
            ask(tab, "We need 2 bottles of milk", "done")
            updated, = saved(tab)["tasks"]
            assert updated["id"] == first["id"] and updated["quantity"] == "2 bottles", updated
            assert not tab.locator("#assistant-clarify-dialog").is_visible() and not tab.locator("#task-dialog").is_visible()
            assert not tab.locator("#assistant-activity-undo").is_visible()
            return {"clearRequestQuestionCount": 0, "duplicateCount": 0, "duplicateDoesNotOfferDestructiveUndo": True,
                    "newQuantityFillsPreviouslyEmptyAmountWithoutQuestion": True}

        run("Clear groceries save without questions and a repeated request cannot offer Undo of an older item", clear_and_duplicate)

        def safety(context):
            tab = page(context)
            ask(tab, "Book a dentist appointment tomorrow at 6 pm", "done")
            action, = saved(tab)["actions"]
            assert action["kind"] == "booking" and action["status"] == "needs_review"
            assert not saved(tab)["tasks"]
            assert re.search(r"nothing.*booked|not.*booked|not.*confirm", tab.locator("#assistant-activity").inner_text(), re.I)
            ask(tab, "Order milk from Waitrose", "done")
            assert len(saved(tab)["actions"]) == 2 and all(action["status"] == "needs_review" for action in saved(tab)["actions"])
            prior = saved(tab)
            ask(tab, "Add an appointment: dentist at 6 pm", "waiting")
            assert saved(tab) == prior
            assert_compact(tab)
            assert re.search(r"day|date|when", tab.locator("#assistant-clarify-question").inner_text(), re.I)
            tab.locator("#assistant-clarify-cancel").click()
            ask(tab, "Read my WhatsApp messages", "waiting")
            assert saved(tab) == prior
            assert not re.search(r"WhatsApp connected|messages read|booked successfully|order placed", tab.locator("#assistant-activity").inner_text(), re.I)
            return {"bookingAndPurchaseStayDrafts": True, "fixedAppointmentDateNotGuessed": True, "otherAppsNotRead": True}

        run("Fewer questions never bypass provider approval invent appointment dates or read another app", safety)

        def unsupported_clock(context):
            tab = page(context)
            configure(tab)
            prior = saved(tab)
            examples = [
                "Remind me to call Mum in 15 minutes",
                "Remind me to call Mum tomorrow morning",
                "Remind me to call Mum after work",
            ]
            for text in examples:
                ask(tab, text, "waiting")
                assert saved(tab) == prior and not state(tab)["tasks"], (text, state(tab)["tasks"])
                assert tab.locator("#assistant-clarify-dialog").is_visible() or tab.locator("#task-dialog").is_visible()
                receipt = tab.locator("#assistant-activity").inner_text()
                assert not re.search(r"saved your reminder|reminder set|I.ve found time", receipt, re.I), receipt
                tab.keyboard.press("Escape")
            tab.clock.set_fixed_time(datetime(2026, 10, 17, 6, 0, tzinfo=timezone.utc))
            ask(tab, "Remind me to call Mum every weekday at 6 pm", "waiting")
            assert saved(tab) == prior and not state(tab)["tasks"]
            assert tab.locator("#assistant-clarify-dialog").is_visible() or tab.locator("#task-dialog").is_visible()
            return {"unsupportedRelativeOrApproximateTimesWaitForClarification": examples,
                    "confirmedRoutineDidNotReplaceRequestedTime": True, "weekdayRepeatNotStartedOnSaturday": True}

        run("Relative or approximate reminder times and weekday recurrence never become silently guessed clock alerts", unsupported_clock)

        def replace_cancel(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum at 6 o'clock", "waiting")
            assert_compact(tab)
            tab.locator("#assistant-clarify-cancel").click()
            assert not saved(tab)["tasks"] and not tab.locator("#assistant-clarify-dialog").is_visible()
            ask(tab, "Remind me to call Dad tomorrow", "waiting")
            assert_compact(tab)
            assert "call Dad" in tab.locator("#assistant-clarify-context").inner_text()
            assert "call Mum" not in tab.locator("#assistant-clarify-context").inner_text()
            reply(tab, "7 pm")
            task, = saved(tab)["tasks"]
            assert task["title"] == "call Dad" and task["dueDate"] == TOMORROW and task["dueTime"] == "19:00", task
            return {"cancelSavedNothing": True, "newRequestReplacedOldContext": True, "savedTasks": 1}

        run("Cancelling and starting a new request discards the old conversational context without duplicate tasks", replace_cancel)

        def updated_item_undo(context):
            tab = page(context)
            ask(tab, "We need milk", "done")
            original, = saved(tab)["tasks"]
            ask(tab, "Get me milk tomorrow at 7 pm", "done")
            updated, = saved(tab)["tasks"]
            assert updated["id"] == original["id"] and updated["remindAt"] is not None
            assert not tab.locator("#assistant-activity-undo").is_visible()
            assert saved(tab)["tasks"] == [updated] and state(tab)["tasks"] == [updated]
            assert tab.locator("#assistant-activity-edit").is_visible()
            return {"updatedSameExistingItem": True, "UndoDoesNotDeleteOlderItem": True, "EditAvailable": True, "duplicateItems": 0}

        run("A changed existing grocery offers Edit and never offers destructive Undo of the older item", updated_item_undo)

        def undo_conflict(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum tomorrow at 6 pm", "done")
            original, = saved(tab)["tasks"]
            other = page(context)
            edit_task(other, original["id"], notes="Family changed this in another tab")
            tab.wait_for_function("TidyDemo.getState().tasks[0]?.notes === 'Family changed this in another tab'")
            changed, = saved(tab)["tasks"]
            undo = tab.locator("#assistant-activity-undo")
            assert undo.is_visible()
            undo.click()
            assert saved(tab)["tasks"] == [changed] and state(tab)["tasks"] == [changed]
            assert re.search(r"changed|another tab|review|cannot|couldn.t", tab.locator("#assistant-activity").inner_text(), re.I)
            return {"genuineSecondTabChangedItem": True, "staleUndoRefused": True, "newerEditRetained": True}

        run("Undo refuses to remove a result changed in another real tab", undo_conflict)

        def quota(context):
            tab = page(context)
            before = saved(tab)
            tab.evaluate("__rejectTidyWrites = true")
            ask(tab, "Remind me to call Mum at 6 pm", "error")
            assert saved(tab) == before
            task, = state(tab)["tasks"]
            assert task["title"] == "call Mum" and task["dueDate"] == DAY and task["dueTime"] == "18:00"
            assert re.search(r"not saved|couldn.t.*save|this tab|backup", tab.locator("#assistant-activity").inner_text(), re.I)
            assert backup(tab)["tasks"] == [task]
            assert tab.locator("#save-status").inner_text() == "Not saved locally"
            return {"savedCopyUntouched": True, "automaticResultRetainedInBackup": True, "noSavedSuccessClaim": True}

        run("Automatic choices still report quota failures and preserve their unsaved result in backup", quota)

        def mobile_advanced(context):
            tab = page(context)
            ask(tab, "Remind me to call Mum at 6 o'clock", "waiting")
            assert_compact(tab)
            assert_no_overflow(tab, "#assistant-clarify-dialog")
            tab.locator("#assistant-clarify-answer").fill("tomorrow at 6 pm")
            tab.locator("#assistant-clarify-answer").focus()
            tab.keyboard.press("Enter")
            wait_result(tab, "done")
            task, = saved(tab)["tasks"]
            assert task["title"] == "call Mum" and task["dueTime"] == "18:00"
            assert_no_overflow(tab, "#assistant-activity")
            tab.locator("#assistant-activity-edit").click()
            assert tab.locator("#task-dialog").is_visible()
            assert tab.locator("#task-title").input_value() == "call Mum"
            assert_no_overflow(tab, "#task-dialog")
            tab.locator("#task-title").fill("call Mum about school")
            tab.locator("#save-task").click()
            updated, = saved(tab)["tasks"]
            assert updated["id"] == task["id"] and updated["title"] == "call Mum about school" and updated["dueTime"] == "18:00"
            tab.screenshot(path=str(output / "efficient-ask-320.png"), full_page=True)
            ask(tab, "Remind me to call Dad tomorrow", "waiting")
            tab.locator("#assistant-clarify-details").click()
            assert not tab.locator("#assistant-clarify-dialog").is_visible()
            assert tab.locator("#task-dialog").is_visible()
            assert tab.locator("#task-title").input_value() == "call Dad"
            tab.keyboard.press("Escape")
            assert saved(tab)["tasks"] == [updated]
            return {"viewportWidth": 320, "keyboardReplySaved": True, "EditChangedSameRecord": True,
                    "MoreDetailsAndEscapePreservedExistingData": True, "horizontalOverflow": False}

        run("320px compact reply supports keyboard submission with Edit and More details available", mobile_advanced, width=320)

        browser.close()

    report = {"url": args.url, "sourceHashes": hashes, "results": results,
              "javascriptErrors": javascript_errors, "blockedExternalRequests": external_requests,
              "limitations": "Synthetic browser and local data only; no real provider, voice hardware, device alarm or closed-page notification."}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": javascript_errors,
                      "blockedExternalRequests": len(external_requests), "report": str(output / "report.json")}))
    if not results or passed != len(results) or javascript_errors or external_requests:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
