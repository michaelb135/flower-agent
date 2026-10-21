"""Exercise calendar-account UI using isolated, synthetic provider fixtures.

Only the chosen Tidy origin reaches the network. Google GIS and Microsoft's
MSAL SDK are replaced with explicit fixture facades, and account event requests
receive synthetic responses. No real authorization, account, permission grant,
calendar write, appointment, purchase or iPhone calendar access is tested here.
Actual OAuth still requires registered public application IDs and a real user.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import traceback
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".qa-results" / "calendar-connect"
KEY = "tidy.app.v1"
GOOGLE_ID = "123456789012-syntheticcalendarfixture.apps.googleusercontent.com"
MICROSOFT_ID = "12345678-1234-4234-8234-123456789abc"
TOKEN = "tidy-synthetic-calendar-fixture-token-DO-NOT-PERSIST"
DAY = "2026-10-15"
FIXED_TIME = datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc)
ICS = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tidy QA//Synthetic//EN",
    "BEGIN:VEVENT", "UID:existing-qa@tidy.invalid",
    "DTSTART:20261015T140000Z", "DTEND:20261015T143000Z",
    "SUMMARY:Previously imported commitment", "END:VEVENT", "END:VCALENDAR", "",
])
INIT_FIXTURE = """(() => {
  window.__calendarFixture = {denied:false, partialScope:false, expires:3600, calls:[], accounts:[]};
  window.__rejectTidyWrites = false;
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window === window.top && key === 'tidy.app.v1' && window.__rejectTidyWrites)
      throw new DOMException('Controlled calendar connection quota fixture', 'QuotaExceededError');
    return original.call(this, key, value);
  };
})();"""
GOOGLE_SDK = """(() => {
  const f=window.__calendarFixture;
  window.google={accounts:{oauth2:{
    initTokenClient(config) {
      f.calls.push({kind:'google-init',clientId:config.client_id,scope:config.scope});
      return {requestAccessToken(options) {
        f.calls.push({kind:'google-request',options});
        setTimeout(() => {
          if(f.denied) return config.callback({error:'access_denied',error_description:'Synthetic permission refusal'});
          config.callback({access_token:'__TOKEN__',token_type:'Bearer',expires_in:f.expires,
            scope:f.partialScope?'openid':config.scope});
        },0);
      }};
    },
    hasGrantedAllScopes(response,...scopes) {return scopes.every(scope=>(response.scope||'').split(' ').includes(scope));},
    revoke(token,callback) {f.calls.push({kind:'google-revoke'});if(callback)callback({});}
  }}};
})();""".replace("__TOKEN__", TOKEN)
MICROSOFT_SDK = """(() => {
  const f=window.__calendarFixture;
  const account={homeAccountId:'synthetic-home-account',localAccountId:'synthetic-local-account',
    tenantId:'synthetic-tenant',username:'synthetic-user@tidy.invalid',name:'Synthetic calendar user'};
  const result=scopes=>({accessToken:'__TOKEN__',scopes:f.partialScope?['openid']:scopes,
    expiresOn:new Date(Date.now()+f.expires*1000),account});
  class PublicClientApplication {
    constructor(config){this.config=config;f.calls.push({kind:'microsoft-init',config});}
    async initialize(){f.calls.push({kind:'microsoft-initialize'});}
    async loginPopup(options){
      f.calls.push({kind:'microsoft-login',options});
      if(f.denied)throw Object.assign(new Error('Synthetic cancellation'),{errorCode:'user_cancelled'});
      f.accounts=[account];return result(options.scopes);
    }
    async acquireTokenPopup(options){
      f.calls.push({kind:'microsoft-token',options});
      if(f.denied)throw Object.assign(new Error('Synthetic cancellation'),{errorCode:'user_cancelled'});
      f.accounts=[account];return result(options.scopes);
    }
    async acquireTokenSilent(options){
      f.calls.push({kind:'microsoft-silent',options});
      if(f.denied)throw Object.assign(new Error('Synthetic interaction required'),{errorCode:'interaction_required'});
      return result(options.scopes);
    }
    getAllAccounts(){return f.accounts;}
    getActiveAccount(){return f.accounts[0]||null;}
    setActiveAccount(value){f.accounts=value?[value]:[];}
    async clearCache(){f.calls.push({kind:'microsoft-clear'});f.accounts=[];}
    async logoutPopup(){f.calls.push({kind:'microsoft-logout'});f.accounts=[];}
  }
  window.msal={PublicClientApplication,BrowserCacheLocation:{MemoryStorage:'memoryStorage'},
    InteractionRequiredAuthError:class extends Error{}};
})();""".replace("__TOKEN__", TOKEN)


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme.lower(), parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def state(tab):
    return tab.evaluate("TidyDemo.getState()")


def saved(tab):
    return tab.evaluate("JSON.parse(localStorage.getItem('tidy.app.v1'))")


def section(tab, name):
    tab.locator("#open-settings").click()
    tab.locator('#settings-dialog [data-go="tools"]').click()
    tab.locator(f'#view-tools [data-go="{name}"]').click()
    assert tab.locator("section.view:visible").count() == 1
    assert tab.locator("#view-" + name).is_visible()


def skip_intro(tab):
    if tab.locator("#calendar-onboarding-dialog").is_visible():
        tab.locator("#calendar-onboarding-later").click()


def configure_connection(tab, google=GOOGLE_ID, microsoft=MICROSOFT_ID):
    section(tab, "calendar")
    details = tab.locator("#calendar-connection-setup")
    if not details.evaluate("node=>node.open"):
        details.locator("summary").click()
    tab.locator("#calendar-google-client-id").fill(google)
    tab.locator("#calendar-microsoft-client-id").fill(microsoft)
    tab.locator("#calendar-connection-config-save").click()
    assert not tab.locator("#calendar-config-error").is_visible(), tab.locator("#calendar-config-error").inner_text()


def import_existing(tab):
    section(tab, "calendar")
    tab.locator("#calendar-file").set_input_files({"name": "previous.ics", "mimeType": "text/calendar", "buffer": ICS.encode()})
    tab.wait_for_function("TidyDemo.getState().calendar?.sourceName==='previous.ics'")


def download_backup(tab):
    tab.locator("#open-settings").click()
    with tab.expect_download() as downloading:
        tab.locator("#export-backup").click()
    data = json.loads(Path(downloading.value.path()).read_text())
    tab.locator('[data-close="settings-dialog"]').click()
    return data


def connect(tab, provider="google"):
    tab.locator("#calendar-connect-" + provider).click()
    tab.wait_for_function("provider=>TidyDemo.getState().calendar?.sourceType===provider", arg=provider)


def error_text(tab):
    tab.locator("#calendar-connection-error").wait_for(state="visible")
    return tab.locator("#calendar-connection-error").inner_text()


def no_overflow(tab, selector):
    bounds = tab.locator(selector).evaluate("""node=>({client:node.clientWidth,scroll:node.scrollWidth,
      document:document.documentElement.scrollWidth,viewport:innerWidth})""")
    assert bounds["scroll"] <= bounds["client"] + 1, bounds
    assert bounds["document"] <= bounds["viewport"] + 1, bounds


class ProviderFixture:
    """Explicit SDK/API allowlist; unrelated external traffic is an error."""

    def __init__(self, context, target_origin):
        self.origin = target_origin
        self.requests = []
        self.external = []
        self.mode = "normal"
        self.hold_next = False
        self.held = []
        context.route("**/*", self.route)

    @staticmethod
    def google_event(identifier, title, start="2026-10-15T13:00:00Z", end="2026-10-15T14:00:00Z"):
        return {"id": identifier, "status": "confirmed", "summary": title,
                "start": {"dateTime": start}, "end": {"dateTime": end}}

    @staticmethod
    def microsoft_event(identifier, title, start="2026-10-15T13:00:00", end="2026-10-15T14:00:00"):
        return {"id": identifier, "subject": title, "isCancelled": False, "isAllDay": False,
                "showAs": "busy", "start": {"dateTime": start, "timeZone": "UTC"},
                "end": {"dateTime": end, "timeZone": "UTC"}}

    def reply(self, route, data, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(data),
                      headers={"Access-Control-Allow-Origin": "*"})

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if parsed.hostname == "accounts.google.com" and parsed.path == "/gsi/client":
            self.requests.append({"kind": "google-sdk", "path": parsed.path})
            route.fulfill(status=200, content_type="application/javascript", body=GOOGLE_SDK)
            return
        if origin(request.url) == self.origin:
            if parsed.path.endswith("/vendor/msal-browser.min.js"):
                self.requests.append({"kind": "microsoft-sdk", "path": parsed.path})
                route.fulfill(status=200, content_type="application/javascript", body=MICROSOFT_SDK)
            else:
                route.continue_()
            return
        if parsed.hostname in {"www.googleapis.com", "graph.microsoft.com"}:
            if request.method == "OPTIONS":
                self.requests.append({"kind": "cors-preflight", "host": parsed.hostname, "path": parsed.path})
                route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET",
                                                  "Access-Control-Allow-Headers": "authorization,prefer"})
                return
            self.requests.append({"kind": "api", "host": parsed.hostname, "method": request.method,
                                  "path": parsed.path, "query": parse_qs(parsed.query)})
            assert request.method == "GET", "Calendar connection must not write to a provider"
            assert request.headers.get("authorization") == "Bearer " + TOKEN
            if self.hold_next:
                self.hold_next = False
                self.held.append(route)
                return
            if self.mode == "unauthorized":
                self.reply(route, {"error": {"code": "InvalidAuthenticationToken", "message": "Synthetic token expiry"}}, 401)
                return
            if parsed.hostname == "www.googleapis.com":
                self.google(route, parsed)
            else:
                self.microsoft(route, parsed)
            return
        self.external.append(request.url)
        route.abort("blockedbyclient")

    def google(self, route, parsed):
        query = parse_qs(parsed.query)
        if parsed.path == "/calendar/v3/users/me/calendarList":
            if query.get("pageToken") == ["calendars-second"]:
                self.reply(route, {"items": [{"id": "family@tidy.invalid", "summary": "Synthetic family", "accessRole": "reader", "selected": True, "timeZone": "Asia/Dubai"}]})
            else:
                self.reply(route, {"items": [{"id": "primary@tidy.invalid", "summary": "Synthetic main", "accessRole": "owner", "primary": True, "selected": True, "timeZone": "Asia/Dubai"}], "nextPageToken": "calendars-second"})
            return
        match = re.fullmatch(r"/calendar/v3/calendars/([^/]+)/events", parsed.path)
        if match:
            identifier = unquote(match.group(1))
            assert query.get("singleEvents") == ["true"], query
            assert query.get("timeMin") and query.get("timeMax"), query
            if identifier == "primary@tidy.invalid":
                if query.get("pageToken") == ["events-second"]:
                    if self.mode == "invalid":
                        self.reply(route, {"items": [self.google_event("bad", "Invalid backwards commitment", "2026-10-15T14:00:00Z", "2026-10-15T13:00:00Z")]})
                    else:
                        self.reply(route, {"items": [self.google_event("admin", "Synthetic admin appointment", "2026-10-15T06:00:00Z", "2026-10-15T07:00:00Z")]})
                else:
                    free = {"id": "birthday", "status": "confirmed", "summary": "Synthetic free birthday reminder",
                            "transparency": "transparent", "start": {"date": "2026-10-15"}, "end": {"date": "2026-10-16"}}
                    self.reply(route, {"items": [self.google_event("meeting", "Synthetic family meeting"), free], "nextPageToken": "events-second"})
            elif identifier == "family@tidy.invalid":
                self.reply(route, {"items": [{"id": "trip", "status": "confirmed", "summary": "Synthetic school trip", "start": {"date": "2026-10-16"}, "end": {"date": "2026-10-17"}}]})
            else:
                raise AssertionError("Unexpected Google calendar fixture identifier: " + identifier)
            return
        raise AssertionError("Unexpected Google API fixture endpoint: " + parsed.path)

    def microsoft(self, route, parsed):
        if parsed.path == "/v1.0/me/calendars":
            self.reply(route, {"value": [{"id": "primary-calendar", "name": "Synthetic main", "canEdit": True, "isDefaultCalendar": True}]})
            return
        if parsed.path in {"/v1.0/me/calendarView", "/v1.0/me/calendars/primary-calendar/calendarView"}:
            query = parse_qs(parsed.query)
            if query.get("$skiptoken") == ["events-second"]:
                self.reply(route, {"value": [self.microsoft_event("admin", "Synthetic Outlook admin appointment", "2026-10-15T06:00:00", "2026-10-15T07:00:00")]})
            else:
                next_url = "https://graph.microsoft.com" + parsed.path + "?startDateTime=2026-10-15T00:00:00Z&endDateTime=2026-12-14T00:00:00Z&$skiptoken=events-second"
                free = self.microsoft_event("free-reminder", "Synthetic Outlook free reminder")
                free["showAs"] = "free"
                self.reply(route, {"value": [self.microsoft_event("meeting", "Synthetic Outlook family meeting"), free], "@odata.nextLink": next_url})
            return
        raise AssertionError("Unexpected Microsoft API fixture endpoint: " + parsed.path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:9047/")
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
    hashes = {path.relative_to(ROOT / "web").as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in (ROOT / "web").rglob("*") if path.is_file() and path.suffix in {".js", ".html", ".css"}}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True)

        def page(context):
            tab = context.new_page()
            tab.set_default_timeout(8000)
            tab.on("pageerror", lambda problem: errors.append(str(problem)))
            tab.on("dialog", lambda dialog: dialog.accept())
            tab.clock.set_fixed_time(FIXED_TIME)
            tab.goto(args.url)
            tab.wait_for_function("!!window.TidyDemo && TidyDemo.getState().mealSnapshot !== null")
            skip_intro(tab)
            section(tab, "calendar")
            return tab

        def run(name, check, width=1100):
            if args.case and not any(pattern.casefold() in name.casefold() for pattern in args.case):
                return
            context = browser.new_context(accept_downloads=True, viewport={"width": width, "height": 950})
            context.add_init_script(INIT_FIXTURE)
            fixture = ProviderFixture(context, target_origin)
            before = len(errors)
            try:
                evidence = check(context, fixture)
                assert len(errors) == before, errors[before:]
                assert not fixture.external, fixture.external
                result = {"name": name, "result": "PASS", "evidence": evidence,
                          "fixtureRequests": fixture.requests}
            except Exception as problem:
                result = {"name": name, "result": "FAIL", "detail": str(problem), "traceback": traceback.format_exc(),
                          "fixtureRequests": fixture.requests}
                for index, tab in enumerate(context.pages):
                    try:
                        tab.screenshot(path=str(output / ("failure-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + f"-{index}.png")), full_page=True)
                    except Exception:
                        pass
            finally:
                external.extend(fixture.external)
                context.close()
            results.append(result)
            print(json.dumps(result), flush=True)

        def unconfigured(context, fixture):
            tab = page(context)
            before = state(tab)
            assert tab.locator("#calendar-account-refresh").is_disabled()
            for provider in ["google", "microsoft"]:
                tab.locator("#calendar-connect-" + provider).click()
                text = tab.locator("#calendar-connection-status").inner_text() + " " + tab.locator("#calendar-connection-error").inner_text()
                assert re.search(r"setup|set.up|register|client|application|configure", text, re.I), text
                assert not state(tab).get("calendar")
            assert state(tab) == before
            assert not fixture.requests, fixture.requests
            assert tab.locator("#calendar-connection-setup").evaluate("node=>node.open")
            return {"setupExplained": True, "noSdkOrProviderRequests": True, "notPretendingConnected": True}

        run("Missing registrations show setup without loading an SDK or claiming calendar access", unconfigured)

        def configuration(context, fixture):
            tab = page(context)
            configure_connection(tab)
            assert not fixture.requests
            assert tab.locator("#calendar-config-origin").input_value() == urlsplit(args.url).scheme + "://" + urlsplit(args.url).netloc
            assert tab.locator("#calendar-config-redirect").input_value().endswith("/calendar-auth.html")
            tab.reload()
            tab.wait_for_function("!!window.TidyDemo")
            section(tab, "calendar")
            details = tab.locator("#calendar-connection-setup")
            if not details.evaluate("node=>node.open"):
                details.locator("summary").click()
            assert tab.locator("#calendar-google-client-id").input_value() == GOOGLE_ID
            assert tab.locator("#calendar-microsoft-client-id").input_value() == MICROSOFT_ID
            assert not state(tab).get("calendar")
            assert not fixture.requests
            tab.locator("#calendar-google-client-id").fill("do-not-enter-a-secret")
            tab.locator("#calendar-connection-config-save").click()
            tab.locator("#calendar-config-error").wait_for(state="visible")
            assert re.search(r"client|public|Google|invalid", tab.locator("#calendar-config-error").inner_text(), re.I)
            assert not state(tab).get("calendar")
            return {"publicIdsPersist": True, "exactOriginAndRedirectShown": True, "invalidPublicIdRejected": True, "savingConfigDoesNotConnect": True}

        run("Public connection IDs persist separately and malformed setup is rejected", configuration)

        def google_connection(context, fixture):
            tab = page(context)
            configure_connection(tab)
            assert not fixture.requests
            connect(tab)
            calendar = saved(tab)["calendar"]
            assert calendar["sourceType"] == "google"
            assert len(calendar["events"]) == 3, calendar
            assert {event["title"] for event in calendar["events"]} == {"Synthetic family meeting", "Synthetic admin appointment", "Synthetic school trip"}
            calls = tab.evaluate("__calendarFixture.calls")
            initial = next(call for call in calls if call["kind"] == "google-init")
            assert initial["clientId"] == GOOGLE_ID
            scopes = initial["scope"].split()
            assert scopes and all(scope.endswith(".readonly") for scope in scopes), scopes
            assert not tab.locator("#calendar-account-refresh").is_disabled()
            assert not tab.locator("#calendar-account-disconnect").is_disabled()
            assert "Synthetic family meeting" in tab.locator("#calendar-events").inner_text()
            assert "Synthetic free birthday reminder" not in tab.locator("#calendar-events").inner_text()
            assert re.search(r"free|transparent", " ".join(calendar["warnings"]), re.I), calendar["warnings"]
            api = [request for request in fixture.requests if request["kind"] == "api"]
            assert len(api) >= 5, api
            tab.reload()
            tab.wait_for_function("TidyDemo.getState().calendar?.sourceType==='google'")
            assert saved(tab)["calendar"] == calendar
            assert tab.locator("#calendar-account-refresh").is_disabled()
            section(tab, "calendar")
            text = tab.locator("#calendar-connection-status").inner_text()
            assert re.search(r"connect|sign.in|snapshot|session", text, re.I), text
            return {"readOnlyGoogleScopes": scopes, "allCalendarAndEventPagesRead": True, "threeCommitmentsSaved": True,
                    "reloadRetainsSnapshotWithoutPretendingSession": True}

        run("Google connection reads all calendar and event pages using read-only scopes", google_connection)

        def microsoft_connection(context, fixture):
            tab = page(context)
            configure_connection(tab)
            connect(tab, "microsoft")
            calendar = saved(tab)["calendar"]
            assert calendar["sourceType"] == "microsoft" and len(calendar["events"]) == 2, calendar
            calls = tab.evaluate("__calendarFixture.calls")
            initial = next(call for call in calls if call["kind"] == "microsoft-init")
            assert initial["config"]["auth"]["clientId"] == MICROSOFT_ID
            assert initial["config"]["cache"]["cacheLocation"] == "memoryStorage", initial
            authorizations = [call for call in calls if call["kind"] in {"microsoft-login", "microsoft-token"}]
            assert authorizations
            for call in authorizations:
                scopes = call["options"]["scopes"]
                assert any("Calendars.Read" in scope for scope in scopes), scopes
                assert not any("ReadWrite" in scope for scope in scopes), scopes
            assert "Synthetic Outlook family meeting" in tab.locator("#calendar-events").inner_text()
            assert "Synthetic Outlook free reminder" not in tab.locator("#calendar-events").inner_text()
            assert re.search(r"free", " ".join(calendar["warnings"]), re.I), calendar["warnings"]
            return {"readOnlyOutlookPermission": True, "officialMsalFacadeUsesMemoryCache": True, "paginatedEventsSaved": True}

        run("Outlook connection uses read-only permissions, memory cache and paginated events", microsoft_connection)

        def connected_planner(context, fixture):
            tab = page(context)
            configure_connection(tab)
            connect(tab)
            section(tab, "planning-settings")
            tab.locator("#planning-enabled").check()
            for weekday in range(7):
                tab.locator(f'[name="planning-workday"][value="{weekday}"]').set_checked(weekday in [1, 2, 3, 4, 5])
                tab.locator(f'[name="planning-schoolday"][value="{weekday}"]').set_checked(weekday in [1, 2, 3, 4, 5])
            for field, value in {"work-start": "08:00", "work-end": "17:00", "kids-home": "15:00", "day-start": "07:00",
                                 "day-end": "20:30", "task-minutes": "30", "family-minutes": "45", "buffer-minutes": "15"}.items():
                tab.locator("#planning-" + field).fill(value)
            tab.locator("#planning-settings-save").click()
            tab.wait_for_function("TidyDemo.getState().planningProfile?.enabled===true")
            tab.locator('[data-view="assistant"]').click()
            tab.locator("#capture-text").fill("I have to do work with the kids")
            tab.locator('#capture-form button[type="submit"]').click()
            tab.wait_for_function("document.getElementById('assistant-activity').dataset.status==='done'")
            task, = saved(tab)["tasks"]
            assert task["dueDate"] == DAY, task
            hours, minute = map(int, task["dueTime"].split(":"))
            assert hours * 60 + minute >= 18 * 60 + 15, task
            assert task["remindAt"] is not None and task["durationMinutes"] == 45, task
            assert tab.locator("#view-planning").is_visible()
            assert task["title"] in tab.locator("#planning-items").inner_text()
            assert "Synthetic family meeting" in tab.locator("#planning-items").inner_text()
            assert not saved(tab)["actions"]
            return {"accountEventsFeedRealPlanner": True, "schoolworkAfterWorkSchoolAndGoogleMeeting": task["dueTime"],
                    "localReminderCreated": True, "externalBookingOrWrite": False}

        run("Connected calendar commitments feed family-aware scheduling and a real local reminder", connected_planner)

        def denial(context, fixture):
            tab = page(context)
            import_existing(tab)
            configure_connection(tab)
            before = saved(tab)
            tab.evaluate("__calendarFixture.denied=true")
            tab.locator("#calendar-connect-google").click()
            text = error_text(tab)
            assert re.search(r"permission|declin|deni|cancel|connect|allow", text, re.I), text
            assert saved(tab) == before and state(tab)["calendar"] == before["calendar"]
            assert not [request for request in fixture.requests if request["kind"] == "api"]
            tab.evaluate("__calendarFixture.denied=false;__calendarFixture.partialScope=true")
            tab.locator("#calendar-connect-google").click()
            tab.wait_for_function("document.getElementById('calendar-connection-error').textContent.length>0")
            assert saved(tab) == before and state(tab)["calendar"] == before["calendar"]
            assert not [request for request in fixture.requests if request["kind"] == "api"]
            return {"declinedPermissionPreservesSnapshot": True, "missingReadOnlyScopesRejectedBeforeApi": True}

        run("Declined or incomplete permission never replaces the existing calendar", denial)

        def malformed_page(context, fixture):
            tab = page(context)
            import_existing(tab)
            configure_connection(tab)
            before = saved(tab)
            fixture.mode = "invalid"
            tab.locator("#calendar-connect-google").click()
            text = error_text(tab)
            assert re.search(r"invalid|end|interval|time|event|calendar", text, re.I), text
            assert saved(tab) == before and state(tab)["calendar"] == before["calendar"]
            assert any(request.get("query", {}).get("pageToken") == ["events-second"] for request in fixture.requests)
            return {"lateMalformedPageRejectedAtomically": True, "priorSnapshotAndTasksKept": True}

        run("A malformed later provider page keeps the previous complete calendar unchanged", malformed_page)

        def refresh_expiry(context, fixture):
            tab = page(context)
            configure_connection(tab)
            connect(tab)
            before = saved(tab)
            fixture.mode = "unauthorized"
            tab.locator("#calendar-account-refresh").click()
            text = error_text(tab)
            assert re.search(r"connect|expired|sign.in|permission|authorization", text, re.I), text
            assert saved(tab) == before and state(tab)["calendar"] == before["calendar"]
            assert tab.locator("#calendar-account-refresh").is_disabled()
            return {"expiryIsNotReportedAsSuccess": True, "completeSnapshotPreserved": True, "reconnectRequired": True}

        run("Expired account access asks for reconnection and keeps the last saved snapshot", refresh_expiry)

        def disconnect(context, fixture):
            tab = page(context)
            configure_connection(tab)
            connect(tab)
            before = saved(tab)
            count = len(fixture.requests)
            tab.locator("#calendar-account-disconnect").click()
            assert tab.locator("#calendar-account-refresh").is_disabled()
            assert tab.locator("#calendar-account-disconnect").is_disabled()
            assert saved(tab) == before and state(tab)["calendar"] == before["calendar"]
            text = tab.locator("#calendar-connection-status").inner_text()
            assert re.search(r"disconnected|session|snapshot|connect", text, re.I), text
            assert not re.search(r"permission.*revoked|access.*revoked", text, re.I), text
            assert len(fixture.requests) == count
            return {"inMemoryAccessForgotten": True, "snapshotRetained": True, "noFalseRevocationClaim": True}

        run("Disconnect forgets this session while retaining commitments and avoids claiming revocation", disconnect)

        def quota(context, fixture):
            tab = page(context)
            configure_connection(tab)
            before = saved(tab)
            tab.evaluate("__rejectTidyWrites=true")
            connect(tab)
            assert saved(tab) == before
            text = tab.locator("#calendar-connection-status").inner_text() + " " + tab.locator("#calendar-status").inner_text()
            assert re.search(r"not saved|this tab|tab only|couldn.t save", text, re.I), text
            assert tab.locator("#storage-warning").is_visible()
            backup = download_backup(tab)
            assert backup["calendar"]["sourceType"] == "google" and len(backup["calendar"]["events"]) == 3
            assert TOKEN not in json.dumps(backup)
            return {"unsavedConnectionNotReportedSaved": True, "completeSnapshotRecoverableInBackup": True, "tokenAbsentFromBackup": True}

        run("Storage quota failure keeps account commitments recoverable without claiming saved", quota)

        def concurrent_calendar(context, fixture):
            a = page(context)
            import_existing(a)
            configure_connection(a)
            before = saved(a)
            b = page(context)
            fixture.hold_next = True
            a.locator("#calendar-connect-google").click()
            a.wait_for_function("__calendarFixture.calls.some(call=>call.kind==='google-request')")
            for _ in range(20):
                if fixture.held:
                    break
                a.wait_for_timeout(20)
            assert len(fixture.held) == 1
            different = ICS.replace("Previously imported commitment", "Newer other-tab commitment")
            b.locator("#calendar-file").set_input_files({"name": "newer.ics", "mimeType": "text/calendar", "buffer": different.encode()})
            b.wait_for_function("TidyDemo.getState().calendar?.sourceName==='newer.ics'")
            latest = saved(b)
            held = fixture.held.pop()
            fixture.google(held, urlsplit(held.request.url))
            text = error_text(a)
            assert re.search(r"another tab|changed|newer|conflict", text, re.I), text
            assert saved(a) == latest and saved(a) != before
            assert state(a)["calendar"] == latest["calendar"]
            return {"accountFetchDoesNotOverwriteNewerOtherTabImport": True, "newerCalendarPreserved": True}

        run("An account fetch cannot overwrite a calendar changed in another tab", concurrent_calendar)

        def private_session(context, fixture):
            tab = page(context)
            configure_connection(tab)
            connect(tab)
            backup = download_backup(tab)
            raw = json.dumps(backup)
            assert TOKEN not in raw and GOOGLE_ID not in raw and MICROSOFT_ID not in raw
            assert "synthetic-user@tidy.invalid" not in raw
            storage = tab.evaluate("({local:{...localStorage},session:{...sessionStorage}})")
            assert TOKEN not in json.dumps(storage), storage
            assert any(GOOGLE_ID in value for value in storage["local"].values())
            assert all(GOOGLE_ID not in value for key, value in storage["local"].items() if key == KEY)
            assert all(request["method"] == "GET" for request in fixture.requests if request["kind"] == "api")
            return {"credentialsNotInStorageOrBackups": True, "publicIdsSeparateFromTaskBackup": True, "noProviderWrites": True}

        run("Access tokens and account identifiers never enter browser storage or task backups", private_session)

        def phone_keyboard(context, fixture):
            tab = page(context)
            assert tab.locator("#calendar-title").evaluate("node=>node===document.activeElement")
            no_overflow(tab, "#view-calendar")
            tab.locator("#calendar-connect-google").focus()
            tab.keyboard.press("Enter")
            assert tab.locator("#calendar-connection-setup").evaluate("node=>node.open")
            no_overflow(tab, "#calendar-connection-setup")
            configure_connection(tab)
            no_overflow(tab, "#view-calendar")
            tab.locator("#calendar-connect-google").focus()
            tab.keyboard.press("Enter")
            tab.wait_for_function("TidyDemo.getState().calendar?.sourceType==='google'")
            no_overflow(tab, "#view-calendar")
            tab.screenshot(path=str(output / "calendar-connected-320.png"), full_page=True)
            return {"width": 320, "keyboardConnectAndSetup": True, "noHorizontalOverflow": True}

        run("Calendar setup and account controls work by keyboard at 320px", phone_keyboard, width=320)

        browser.close()

    report = {"url": args.url, "sourceHashes": hashes, "results": results,
              "javascriptErrors": errors, "blockedUnexpectedExternalRequests": external,
              "scope": "Synthetic Google GIS/MSAL SDK and calendar API fixtures; no real OAuth accounts or device calendar permission tested."}
    report_path = output / ("live-report.json" if args.url.startswith("https://") else "local-report.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    passed = sum(result["result"] == "PASS" for result in results)
    print(json.dumps({"passed": passed, "total": len(results), "javascriptErrors": errors,
                      "blockedUnexpectedExternalRequests": len(external), "report": str(report_path)}))
    raise SystemExit(1 if not results or passed != len(results) or errors or external else 0)


if __name__ == "__main__":
    main()
