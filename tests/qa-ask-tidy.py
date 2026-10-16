"""Exercise Ask Tidy's conversational replies, progress and real local results.

Serve web/ over HTTP and pass --url for that site or the published deployment.
Each case uses a fresh browser context with synthetic data. Only the selected
Tidy origin can reach the network. Clock and quota fixtures exercise the actual
UI, save boundary and reminder interval; no retailer, provider, native iPhone
alarm, closed-page notification, sign-in, voice hardware or booking is tested.
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
OUT = ROOT / ".qa-results" / "ask-tidy"
KEY = "tidy.app.v1"
FIXED_TIME = datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc)
TOMORROW = "2026-10-16"

BOUNDARY_FIXTURES = """
(() => {
  window.__rejectTidyWrites = false;
  window.__activityHistory = [];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (window === window.top && window.__rejectTidyWrites && key === 'tidy.app.v1')
      throw new DOMException('Controlled regression fixture quota failure', 'QuotaExceededError');
    return setItem.call(this, key, value);
  };
  let previous = '';
  new MutationObserver(() => {
    if (window !== window.top) return;
    const panel = document.getElementById('assistant-activity');
    if (!panel || panel.hidden) return;
    const status = panel.dataset.status || '';
    const title = document.getElementById('assistant-activity-title')?.textContent || '';
    const steps = document.getElementById('assistant-activity-steps')?.textContent || '';
    const message = document.getElementById('assistant-activity-message')?.textContent || '';
    const replyNode = document.getElementById('assistant-activity-reply');
    const reply = replyNode?.textContent || '';
    const replyVisible = !!replyNode && !replyNode.hidden && replyNode.getClientRects().length > 0;
    const replyBounds = replyNode?.getBoundingClientRect();
    const replyInViewport = replyVisible && replyBounds.top >= 0 && replyBounds.bottom <= innerHeight &&
      replyBounds.left >= 0 && replyBounds.right <= innerWidth;
    const signature = JSON.stringify([status, title, steps, message, reply, replyVisible]);
    if (signature === previous) return;
    previous = signature;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('tidy.app.v1')); } catch (_) {}
    window.__activityHistory.push({status, title, steps, message, reply, replyVisible, replyInViewport,
      savedTasks: saved?.tasks?.length || 0, savedActions: saved?.actions?.length || 0});
  }).observe(document, {subtree:true, childList:true, characterData:true, attributes:true,
    attributeFilter:['data-status','hidden']});
})();
"""


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def state(page):
    return page.evaluate("TidyDemo.getState()")


def saved(page):
    return page.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def skip_calendar_onboarding(page):
    dialog = page.locator("#calendar-onboarding-dialog")
    if dialog.is_visible():
        page.locator("#calendar-onboarding-later").click()


def record(page, task_id, container):
    return page.locator(f"#{container} [data-task-id='{task_id}']")


def wait_result(page, status=None):
    page.wait_for_function("""expected => {
      const panel = document.getElementById('assistant-activity');
      return panel && !panel.hidden &&
        (expected ? panel.dataset.status === expected :
         ['done','waiting','error'].includes(panel.dataset.status));
    }""", arg=status)


def ask(page, text, status=None):
    page.locator('[data-view="assistant"]').click()
    page.locator("#capture-text").fill(text)
    page.locator('#capture-form button[type="submit"]').click()
    wait_result(page, status)


def assert_progress(page, terminal="done", before_tasks=0, before_actions=0):
    history = page.evaluate("__activityHistory")
    assert any(item["status"] == "working" for item in history), history
    working = next(item for item in history if item["status"] == "working")
    assert working["savedTasks"] == before_tasks, history
    assert working["savedActions"] == before_actions, history
    assert working["replyVisible"] and working["reply"].strip(), history
    assert working["replyInViewport"], working
    assert re.search(r"\bI\b|\bme\b|\blet(?:'|’)s\b", working["reply"], re.I), working
    assert page.locator("#assistant-activity").get_attribute("data-status") == terminal
    assert page.locator("#assistant-activity-steps li").count() >= 2
    return [{"status": item["status"], "title": item["title"], "reply": item["reply"]} for item in history]


def conversational_reply(page):
    reply = page.locator("#assistant-activity-reply")
    assert reply.is_visible()
    text = reply.inner_text().strip()
    assert text and re.search(r"\bI\b|\bI(?:'|’)ve\b|\byou(?:r)?\b|\blet(?:'|’)s\b", text, re.I), text
    return text


def assert_destination(page, destination):
    assert page.url.endswith("#" + destination), page.url
    assert page.locator("#view-" + destination).is_visible()
    visible = page.locator("section.view:visible")
    assert visible.count() == 1
    assert visible.get_attribute("id") == "view-" + destination


def assert_no_overflow(page, selector):
    measures = page.locator(selector).evaluate("""node => ({
      client:node.clientWidth, scroll:node.scrollWidth,
      document:document.documentElement.scrollWidth, viewport:innerWidth
    })""")
    assert measures["scroll"] <= measures["client"] + 1, measures
    assert measures["document"] <= measures["viewport"] + 1, measures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9044/")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--case", action="append", default=[], help="Run only case names containing this text; repeat for more cases")
    parser.add_argument("--output", type=Path, default=OUT, help="Directory for this run's report and failure screenshots")
    args = parser.parse_args()
    selected_origin = origin(args.url)
    if selected_origin[0] not in {"http", "https"} or not selected_origin[1]:
        parser.error("--url must identify an HTTP(S) deployment")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    results, errors, blocked_requests = [], [], []
    hashes = {name: hashlib.sha256((ROOT / "web" / name).read_bytes()).hexdigest()
              for name in ["index.html", "styles.css", "app.js", "assistant.js", "core.js"]}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def run(name, check, width=1100, reminder_clock=False):
            if args.case and not any(pattern.casefold() in name.casefold() for pattern in args.case):
                return
            fresh = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 950})
            fresh.add_init_script(BOUNDARY_FIXTURES)
            case_errors = []

            def guard(route):
                if origin(route.request.url) == selected_origin:
                    route.continue_()
                else:
                    blocked_requests.append(route.request.url)
                    route.abort("blockedbyclient")

            fresh.route("**/*", guard)
            tab = fresh.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: case_errors.append(str(problem)))
            if reminder_clock:
                tab.clock.install(time=datetime(2026, 10, 15, 13, 59, tzinfo=timezone.utc))
            else:
                tab.clock.set_fixed_time(FIXED_TIME)
            try:
                tab.goto(args.url)
                tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
                skip_calendar_onboarding(tab)
                evidence = check(tab)
                assert not case_errors, case_errors
                result = {"name": name, "result": "PASS", "evidence": evidence}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc()}
                try:
                    result["activity"] = tab.locator("#assistant-activity").inner_text()
                    result["state"] = state(tab)
                    tab.screenshot(path=str(output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + ".png")), full_page=True)
                except Exception:
                    pass
            finally:
                errors.extend(case_errors)
                fresh.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def reminder(tab):
            ask(tab, "Set a notification to call Mum tomorrow at 6 pm", "done")
            history = assert_progress(tab)
            assert_destination(tab, "reminders")
            assert not tab.locator("#task-dialog").is_visible()
            task, = saved(tab)["tasks"]
            assert task["title"] == "call Mum"
            assert task["dueDate"] == TOMORROW and task["dueTime"] == "18:00"
            assert task["remindAt"] == int(datetime(2026, 10, 16, 14, tzinfo=timezone.utc).timestamp() * 1000)
            assert task["deliveredReminderAt"] is None
            row = record(tab, task["id"], "reminder-tasks")
            assert row.is_visible() and "18:00" in row.inner_text() and "Alert set" in row.inner_text()
            assert "not iPhone Clock alarms" in tab.locator("#view-reminders").inner_text()
            assert not tab.locator("#alert-banner").is_visible()
            reply = conversational_reply(tab)
            assert "call Mum" in reply and re.search(r"remind|reminder", reply, re.I), reply
            assert re.search(r"6:00|6\s*pm|18:00", reply, re.I), reply
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            skip_calendar_onboarding(tab)
            assert_destination(tab, "reminders")
            assert saved(tab)["tasks"] == [task]
            assert record(tab, task["id"], "reminder-tasks").is_visible()
            return {"progress": history, "replyOnDestination": reply, "dueDate": task["dueDate"], "dueTime": task["dueTime"], "persistedAfterReload": True}

        run("Complete notification request shows progress, saves correct Dubai reminder and opens its record", reminder)

        def clarification(tab):
            before = saved(tab)
            ask(tab, "Put me a notification at 6 o’clock", "waiting")
            assert_destination(tab, "assistant")
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            assert not tab.locator("#task-dialog").is_visible()
            assert saved(tab) == before and not state(tab)["tasks"]
            reply = conversational_reply(tab)
            assert re.search(r"date|day|time|am|pm|detail", reply, re.I), reply
            choices = tab.locator("#assistant-clarify-choices")
            assert choices.is_visible()
            choices.get_by_role("button", name=re.compile(r"Tomorrow.*6.*pm", re.I)).click()
            wait_result(tab, "done")
            assert_destination(tab, "reminders")
            task, = saved(tab)["tasks"]
            assert task["title"] == "Reminder" and task["dueTime"] == "18:00" and task["dueDate"] == TOMORROW
            assert record(tab, task["id"], "reminder-tasks").is_visible()
            return {"notSavedUntilClarified": True, "choiceDate": task["dueDate"], "choiceTime": task["dueTime"]}

        run("Ambiguous six o'clock asks date and am or pm, then saves the chosen reminder", clarification)

        def appointment(tab):
            ask(tab, "Do an appointment: dentist tomorrow at 6 pm", "done")
            assert_progress(tab)
            assert_destination(tab, "appointments")
            task, = saved(tab)["tasks"]
            assert task["type"] == "appointment" and task["title"] == "dentist"
            assert task["dueDate"] == TOMORROW and task["dueTime"] == "18:00"
            assert not saved(tab)["actions"] and "confirmed" not in task
            row = record(tab, task["id"], "appointment-tasks")
            assert row.is_visible() and "Entered appointment" in row.inner_text() and "18:00" in row.inner_text()
            assert "does not check availability" in tab.locator("#view-appointments").inner_text()
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            skip_calendar_onboarding(tab)
            assert_destination(tab, "appointments")
            assert record(tab, task["id"], "appointment-tasks").is_visible()
            return {"type": task["type"], "savedRecordOnly": True, "dueTime": task["dueTime"]}

        run("Natural appointment request opens and saves an appointment record with no provider confirmation", appointment)

        def booking(tab):
            ask(tab, "Book an appointment with dentist tomorrow at 6 pm", "done")
            assert_progress(tab)
            assert_destination(tab, "appointments")
            assert not saved(tab)["tasks"]
            action, = saved(tab)["actions"]
            assert action["kind"] == "booking" and action["status"] == "needs_review"
            assert tab.locator(f'#appointment-requests [data-action-id="{action["id"]}"]').is_visible()
            receipt = tab.locator("#assistant-activity").inner_text()
            assert re.search(r"review", receipt, re.I), receipt
            assert re.search(r"nothing(?: has been)? booked|not booked|no .*booking|no appointment.*confirmed", receipt, re.I), receipt
            assert "Needs your review" in tab.locator("#appointment-requests").inner_text()
            reply = conversational_reply(tab)
            assert re.search(r"draft|review", reply, re.I), reply
            assert re.search(r"nothing.*booked|not.*booked|haven(?:'|’)t.*booked|no.*confirm", reply, re.I), reply
            return {"draftStatus": action["status"], "appointmentRecords": 0, "reply": reply, "noExternalRequests": True}

        run("Booking request opens reviewable draft and explicitly leaves provider booking undone", booking)

        def groceries(tab):
            ask(tab, "We need milk", "done")
            assert_progress(tab)
            assert_destination(tab, "shopping")
            task, = saved(tab)["tasks"]
            assert task["type"] == "grocery" and task["title"] == "milk"
            row = record(tab, task["id"], "shopping-tasks")
            assert row.is_visible()
            reply = conversational_reply(tab)
            assert "milk" in reply and re.search(r"list|shopping", reply, re.I), reply
            ask(tab, "We need milk")
            assert_destination(tab, "shopping")
            assert saved(tab)["tasks"] == [task]
            assert record(tab, task["id"], "shopping-tasks").is_visible()
            assert re.search(r"already|existing", tab.locator("#assistant-activity").inner_text(), re.I)
            return {"firstSaved": True, "duplicateTasks": 0}

        run("Grocery request opens actual saved shopping item and repeated request does not duplicate it", groceries)

        def timed_grocery_reply(tab):
            ask(tab, "Get me milk tomorrow at 7 pm", "done")
            history = assert_progress(tab)
            assert_destination(tab, "shopping")
            task, = saved(tab)["tasks"]
            assert task["type"] == "grocery" and task["title"] == "milk", task
            assert task["dueDate"] == TOMORROW and task["dueTime"] == "19:00", task
            assert task["remindAt"] == int(datetime(2026, 10, 16, 15, tzinfo=timezone.utc).timestamp() * 1000), task
            assert not saved(tab)["actions"]
            assert record(tab, task["id"], "shopping-tasks").is_visible()
            reply = conversational_reply(tab)
            assert "milk" in reply and re.search(r"7:00|7\s*pm|19:00", reply, re.I), reply
            assert re.search(r"list|shopping", reply, re.I), reply
            assert not re.search(r"(?:I|we)(?:'ve| have| will)?\s+(?:ordered|bought|purchased|deliver(?:ed)?)\s+(?:you\s+)?milk", reply, re.I), reply
            assert_no_overflow(tab, "#assistant-activity")
            screenshot = output / "friendly-grocery-reply-390.png"
            tab.screenshot(path=str(screenshot), full_page=True)
            return {"progress": history, "replyOnShoppingPage": reply, "dueTime": task["dueTime"], "reminderSet": True,
                    "orders": 0, "viewportWidth": 390, "screenshot": str(screenshot)}

        run("Friendly grocery reply accompanies the real seven pm shopping reminder without claiming a purchase", timed_grocery_reply, width=390)

        def existing_grocery_reminder(tab):
            ask(tab, "We need milk", "done")
            original, = saved(tab)["tasks"]
            assert original["remindAt"] is None
            ask(tab, "Get me milk tomorrow at 7 pm", "done")
            assert_destination(tab, "shopping")
            updated, = saved(tab)["tasks"]
            assert updated["id"] == original["id"] and updated["title"] == "milk"
            assert updated["dueDate"] == TOMORROW and updated["dueTime"] == "19:00", updated
            assert updated["remindAt"] == int(datetime(2026, 10, 16, 15, tzinfo=timezone.utc).timestamp() * 1000), updated
            assert record(tab, updated["id"], "shopping-tasks").is_visible()
            reply = conversational_reply(tab)
            assert "milk" in reply and re.search(r"7:00|7\s*pm|19:00", reply, re.I), reply
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            skip_calendar_onboarding(tab)
            assert saved(tab)["tasks"] == [updated]
            return {"sameItemId": True, "reminderPersistedAfterReload": True, "duplicateItems": 0, "reply": reply}

        run("Existing grocery gains the requested reminder on the same item instead of silently ignoring it", existing_grocery_reminder)

        def quantity_review_preserves_reminder(tab):
            ask(tab, "We need 1 bottle of milk", "done")
            original, = saved(tab)["tasks"]
            assert original["title"] == "milk" and original["quantity"] == "1 bottle", original
            ask(tab, "Get me 2 bottles of milk tomorrow at 7 pm", "waiting")
            assert_destination(tab, "shopping")
            assert saved(tab)["tasks"] == [original]
            reply = conversational_reply(tab)
            assert re.search(r"review|quantity|amount", reply, re.I), reply
            tab.locator("#assistant-activity-open").click()
            assert tab.locator("#task-dialog").is_visible()
            assert tab.locator("#task-quantity").input_value() == "2 bottles"
            assert tab.locator("#task-date").input_value() == TOMORROW
            assert tab.locator("#task-time").input_value() == "19:00"
            assert tab.locator("#task-reminder").is_checked()
            assert tab.locator("#task-reminder-at").input_value() == TOMORROW + "T19:00"
            assert saved(tab)["tasks"] == [original]
            tab.locator("#save-task").click()
            wait_result(tab, "done")
            updated, = saved(tab)["tasks"]
            assert updated["id"] == original["id"] and updated["quantity"] == "2 bottles", updated
            assert updated["dueTime"] == "19:00" and updated["remindAt"] is not None, updated
            assert_destination(tab, "shopping")
            return {"reviewBeforeQuantityOrTimeChanged": True, "requestedTimeRetained": True, "sameItemId": True, "duplicateItems": 0}

        run("Different grocery quantity waits for review while retaining the requested reminder in its editor", quantity_review_preserves_reminder)

        def ambiguous_grocery_reply(tab):
            before = saved(tab)
            ask(tab, "Get me a grocery at 7 o'clock", "waiting")
            assert_progress(tab, "waiting")
            assert_destination(tab, "assistant")
            assert saved(tab) == before and not state(tab)["tasks"]
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            assert not tab.locator("#task-dialog").is_visible()
            reply = conversational_reply(tab)
            assert re.search(r"date|day|time|am|pm|detail", reply, re.I), reply
            tab.locator("#assistant-clarify-choices").get_by_role("button", name=re.compile(r"Tomorrow.*7.*pm", re.I)).click()
            wait_result(tab, "done")
            task, = saved(tab)["tasks"]
            assert task["category"] == "Shopping" and task["type"] == "task", task
            assert task["dueDate"] == TOMORROW and task["dueTime"] == "19:00", task
            assert task["remindAt"] is not None and not saved(tab)["actions"]
            assert record(tab, task["id"], "reminder-tasks").is_visible()
            reply = conversational_reply(tab)
            assert re.search(r"groc|shopping", reply, re.I), reply
            assert re.search(r"7:00|7\s*pm|19:00", reply, re.I), reply
            return {"clarifiedBeforeSaving": True, "replyOnReminderPage": reply, "chosenTime": task["dueTime"], "orders": 0}

        run("Ambiguous get me a grocery at seven replies with a question and saves only the chosen date and time", ambiguous_grocery_reply)

        def purchase_reply(tab):
            ask(tab, "Order milk from Waitrose tomorrow at 7 pm", "done")
            assert_progress(tab)
            assert_destination(tab, "requests")
            assert not saved(tab)["tasks"]
            action, = saved(tab)["actions"]
            assert action["kind"] == "purchase" and action["status"] == "needs_review"
            assert tab.locator(f'#action-list [data-action-id="{action["id"]}"]').is_visible()
            reply = conversational_reply(tab)
            assert re.search(r"draft|review", reply, re.I), reply
            assert re.search(r"nothing.*(?:purchased|ordered)|not.*(?:purchased|ordered)|haven(?:'|’)t.*(?:purchased|ordered)", reply, re.I), reply
            return {"draftStatus": action["status"], "replyOnRequestsPage": reply, "externalOrders": 0}

        run("Purchase request gets a friendly review reply and remains a draft without retailer contact", purchase_reply)

        def unsupported(tab):
            before = saved(tab)
            ask(tab, "Read my WhatsApp messages", "waiting")
            assert saved(tab) == before and not state(tab)["tasks"] and not state(tab)["actions"]
            receipt = tab.locator("#assistant-activity").inner_text()
            assert not re.search(r"messages read|WhatsApp connected|completed successfully", receipt, re.I), receipt
            assert re.search(r"not sure|cannot|not connected|missing|check|clarif|detail", receipt, re.I), receipt
            return {"savedChanges": 0, "status": "waiting"}

        run("Unsupported access to another app stays a clarification and carries out no fake action", unsupported)

        def failed_save(tab):
            before = saved(tab)
            tab.evaluate("__rejectTidyWrites = true")
            ask(tab, "Set a notification to call Mum tomorrow at 6 pm", "error")
            assert saved(tab) == before
            task, = state(tab)["tasks"]
            assert task["title"] == "call Mum"
            assert tab.locator("#storage-warning").is_visible()
            assert re.search(r"not saved|tab only|this tab|backup", tab.locator("#assistant-activity").inner_text(), re.I)
            assert tab.locator("#save-status").inner_text() == "Not saved locally"
            reply = conversational_reply(tab)
            assert re.search(r"not saved|couldn(?:'|’)t.*sav|cannot.*sav|unable.*sav|tab only|this tab|backup", reply, re.I), reply
            assert not re.search(r"(?:I(?:'|’)ve|I have)\s+(?:saved|set)\b", reply, re.I), reply
            tab.locator("#open-settings").click()
            with tab.expect_download() as downloaded:
                tab.locator("#export-backup").click()
            backup = json.loads(Path(downloaded.value.path()).read_text())
            assert backup["tasks"] == [task]
            return {"previousSavedCopyUntouched": True, "unsavedTaskBackedUp": True, "status": "error"}

        run("Quota failure reports error instead of saved success and keeps unsaved reminder in backup", failed_save)

        def double_submit(tab):
            tab.locator('[data-view="assistant"]').click()
            tab.locator("#capture-text").fill("Set a notification to call Mum tomorrow at 6 pm")
            tab.locator("#capture-form").evaluate("form => { form.requestSubmit(); form.requestSubmit(); }")
            wait_result(tab, "done")
            assert_progress(tab)
            task, = saved(tab)["tasks"]
            assert task["title"] == "call Mum" and len(state(tab)["tasks"]) == 1
            return {"submitEvents": 2, "savedTasks": 1}

        run("Repeated form submission during visible work creates only one reminder", double_submit)

        def reminder_delivery(tab):
            ask(tab, "Remind me to call Mum today at 6 pm", "done")
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == "2026-10-15" and task["dueTime"] == "18:00"
            assert task["deliveredReminderAt"] is None and not tab.locator("#alert-banner").is_visible()
            tab.clock.run_for(70000)
            assert tab.locator("#alert-banner").is_visible()
            assert "call Mum" in tab.locator("#alert-content").inner_text()
            delivered, = saved(tab)["tasks"]
            assert delivered["deliveredReminderAt"] == delivered["remindAt"]
            assert "Alert shown" in record(tab, task["id"], "reminder-tasks").inner_text()
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            skip_calendar_onboarding(tab)
            assert saved(tab)["tasks"] == [delivered]
            assert not tab.locator("#alert-banner").is_visible()
            return {"actualIntervalFired": True, "deliveryRecorded": True, "noRepeatAfterReload": True}

        run("Saved reminder fires through the browser timer while open and keeps its delivery record on reload", reminder_delivery, reminder_clock=True)

        def mobile_keyboard(tab):
            tab.locator('[data-view="assistant"]').click()
            tab.locator("#capture-text").focus()
            tab.locator("#capture-text").fill("Set a notification to call Mum tomorrow at 6 pm")
            tab.keyboard.press("Tab")
            tab.keyboard.press("Tab")
            assert tab.locator('#capture-form button[type="submit"]').evaluate("node => node === document.activeElement")
            tab.keyboard.press("Enter")
            wait_result(tab, "done")
            assert_destination(tab, "reminders")
            assert_no_overflow(tab, "#assistant-activity")
            assert_no_overflow(tab, "#view-reminders")
            task, = saved(tab)["tasks"]
            row = record(tab, task["id"], "reminder-tasks")
            row.get_by_role("button", name="Edit", exact=True).click()
            assert tab.locator("#task-dialog").is_visible()
            assert tab.locator("#task-title").evaluate("node => node === document.activeElement")
            assert_no_overflow(tab, "#task-dialog")
            assert tab.locator("#task-time").input_value() == "18:00"
            tab.keyboard.press("Escape")
            assert not tab.locator("#task-dialog").is_visible()
            assert saved(tab)["tasks"] == [task]
            return {"viewportWidth": 320, "keyboardSubmit": True, "editAndEscape": True, "noHorizontalOverflow": True}

        run("320px layout supports keyboard request, visible receipt and edit dialog without overflow", mobile_keyboard, width=320)

        def receipt_navigation(tab):
            ask(tab, "Set a notification to call Mum tomorrow at 6 pm", "done")
            task, = saved(tab)["tasks"]
            tab.locator('[data-view="today"]').click()
            tab.locator("#assistant-activity-open").click()
            assert_destination(tab, "reminders")
            assert record(tab, task["id"], "reminder-tasks").is_visible()
            tab.locator("#assistant-activity-dismiss").click()
            assert not tab.locator("#assistant-activity").is_visible()
            tab.locator('[data-view="today"]').click()
            tab.locator("#today-appointments").click()
            assert_destination(tab, "appointments")
            tab.locator('[data-view="today"]').click()
            tab.locator("#today-reminders").click()
            assert_destination(tab, "reminders")
            assert saved(tab)["tasks"] == [task]
            return {"receiptReopensSavedRecord": True, "todayShortcuts": True, "dismissPreservesTask": True}

        run("Receipt show-me button and Today shortcuts reopen real reminder or appointment pages", receipt_navigation)

        def past_reminder(tab):
            before = saved(tab)
            ask(tab, "Remind me to call Mum today at 6 am", "waiting")
            assert saved(tab) == before and not state(tab)["tasks"]
            assert_destination(tab, "assistant")
            assert tab.locator("#assistant-clarify-dialog").is_visible()
            assert re.search(r"passed|past|new time|future", tab.locator("#assistant-clarify-dialog").inner_text(), re.I)
            assert not tab.locator("#alert-banner").is_visible()
            return {"noPastReminderSaved": True, "editableClarification": True}

        run("Past reminder request asks for a new time instead of showing a successful alarm", past_reminder)

        def task_and_today(tab):
            ask(tab, "Add task: Prepare school bags today", "done")
            assert_destination(tab, "family")
            task, = saved(tab)["tasks"]
            assert task["title"] == "Prepare school bags" and task["dueDate"] == "2026-10-15"
            assert record(tab, task["id"], "family-tasks").is_visible()
            before = saved(tab)
            ask(tab, "What do I need to do today?", "done")
            assert_destination(tab, "today")
            assert saved(tab) == before
            assert task["title"] in tab.locator("#assistant-activity-message").inner_text()
            assert record(tab, task["id"], "today-tasks").is_visible()
            return {"taskSavedInFamily": True, "todayAnswerUsesStoredData": True, "readOnlyAnswerDoesNotWrite": True}

        run("Task request opens responsibilities and a day question shows the saved task without a new write", task_and_today)

        def example_buttons(tab):
            tab.locator('[data-view="assistant"]').click()
            tab.get_by_role("button", name="Remind me at 6 pm", exact=True).click()
            assert tab.locator("#capture-text").input_value()
            tab.locator('#capture-form button[type="submit"]').click()
            wait_result(tab, "done")
            assert_destination(tab, "reminders")
            reminder_task, = saved(tab)["tasks"]
            assert reminder_task["remindAt"] is not None and reminder_task["dueTime"] == "18:00"
            tab.locator('[data-view="assistant"]').click()
            tab.get_by_role("button", name="Add an appointment", exact=True).click()
            tab.locator('#capture-form button[type="submit"]').click()
            wait_result(tab, "done")
            assert_destination(tab, "appointments")
            appointment_tasks = [task for task in saved(tab)["tasks"] if task["type"] == "appointment"]
            appointment_task, = appointment_tasks
            assert appointment_task["title"] == "dentist" and appointment_task["dueTime"] == "18:00"
            assert not saved(tab)["actions"]
            return {"reminderExampleSavesReminder": True, "appointmentExampleSavesRecord": True}

        run("Displayed reminder and appointment example buttons execute their advertised local actions", example_buttons)

        browser.close()

    report = {"url": args.url, "sourceHashes": hashes, "results": results,
              "javascriptErrors": errors, "blockedExternalRequests": blocked_requests,
              "limitations": "Browser UI and local state only; no real provider, voice hardware, native Clock alarm or closed-page notification."}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedExternalRequests": len(blocked_requests), "report": str(output / "report.json")}))
    if not results or passed != len(results) or errors or blocked_requests:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
