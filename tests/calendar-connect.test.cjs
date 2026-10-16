const test = require('node:test');
const assert = require('node:assert/strict');
const Connect = require('../web/calendar-connect.js');
const NOW = Date.parse('2026-10-16T08:00:00Z');
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const configuration = { googleClientId: '1234-test.apps.googleusercontent.com', microsoftClientId: '12345678-1234-4321-8123-123456789abc', redirectUri: 'https://example.test/tidy/calendar-auth.html' };
const environment = { origin: 'https://example.test', basePath: '/tidy/' };
const googleEvent = (id = 'event-1', values = {}) => ({ id, summary: 'Homework', start: { dateTime: '2026-10-16T17:00:00+04:00' }, end: { dateTime: '2026-10-16T17:30:00+04:00' }, ...values });
const microsoftEvent = (id = 'event-1', values = {}) => ({ id, subject: 'Homework', start: { dateTime: '2026-10-16T13:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-16T13:30:00.0000000', timeZone: 'UTC' }, isAllDay: false, ...values });
function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function fixture(options = {}) {
  const calls = [], sdk = [], loads = { google: 0, microsoft: 0 }; let current = NOW, cleared = 0, googleResponse = options.googleResponse;
  const fetch = async (url, request) => {
    calls.push({ url, request });
    if (options.fetch) return options.fetch(new URL(url), request, calls.length);
    if (url.includes('www.googleapis.com')) return response(url.includes('/events?') ? { items: [googleEvent()] } : { items: [{ id: 'primary', timeZone: 'Asia/Dubai' }] });
    return response(url.includes('/calendarView?') ? { value: [microsoftEvent()] } : { value: [{ id: 'primary', name: 'Calendar' }] });
  };
  const google = { accounts: { oauth2: {
    initTokenClient(config) { sdk.push({ provider: 'google', config }); return { requestAccessToken(request) { sdk.push(request); queueMicrotask(() => options.googleError ? config.error_callback(options.googleError) : config.callback(googleResponse || { access_token: 'synthetic-google-token', expires_in: 3600, scope: SCOPE })); } }; },
    hasGrantedAllScopes(value, scope) { return value.scope?.split(/\s+/).includes(scope); }
  } } };
  class PublicClientApplication {
    constructor(config) { sdk.push({ provider: 'microsoft', config }); }
    async initialize() { sdk.push({ initialized: true }); }
    async loginPopup(request) { sdk.push(request); if (options.microsoftError) throw Error('sensitive provider diagnostic'); return options.microsoftResponse || { accessToken: 'synthetic-microsoft-token', expiresOn: new Date(current + 3600000), scopes: ['Calendars.Read'] }; }
    async clearCache() { cleared++; }
  }
  const connector = Connect.createConnector(options.config || configuration, { ...environment, now: () => current, fetch, timeoutMs: 200, loadGoogle: async () => { loads.google++; return google; }, loadMicrosoft: async () => { loads.microsoft++; return { PublicClientApplication }; } });
  return { connector, calls, sdk, loads, setTime(value) { current = value; }, setGoogleResponse(value) { googleResponse = value; }, get cleared() { return cleared; } };
}

test('public configuration is validated without loading SDKs or requiring both providers', async () => {
  const state = fixture({ config: { googleClientId: '', microsoftClientId: '' } });
  assert.equal(state.connector.status('google').configured, false);
  await assert.rejects(state.connector.connect('google'), /setup is required/);
  await assert.rejects(state.connector.connect('microsoft'), /setup is required/);
  assert.deepEqual(state.loads, { google: 0, microsoft: 0 }); assert.equal(state.calls.length, 0);
  assert.equal(Connect.validateConfig({ googleClientId: configuration.googleClientId }, environment).microsoftClientId, '');
  assert.throws(() => Connect.validateConfig({ googleClientId: 'client-secret' }, environment), /public Google/);
  assert.throws(() => Connect.validateConfig({ microsoftClientId: 'secret' }, environment), /public Microsoft/);
  assert.throws(() => Connect.validateConfig({ redirectUri: 'https://evil.test/calendar-auth.html' }, environment), /match this website/);
  assert.throws(() => Connect.validateConfig({}, { origin: 'http://example.test', basePath: '/' }), /secure website/);
});

test('Google uses official explicit consent, read-only scope, and normalized bounded snapshot', async () => {
  const state = fixture(); assert.equal(state.loads.google, 0);
  const result = await state.connector.connect('google');
  assert.equal(state.loads.google, 1); assert.equal(state.sdk[0].config.scope, SCOPE); assert.equal(state.sdk[0].config.include_granted_scopes, false); assert.equal(state.sdk[1].prompt, 'consent');
  assert.equal(result.sourceType, 'google'); assert.equal(result.events.length, 1); assert.equal(result.events[0].startAt, Date.parse('2026-10-16T13:00:00Z')); assert.equal(result.windowEnd - result.windowStart, 60 * 86400000);
  assert.equal(state.connector.status('google').connected, true);
  const eventRequest = new URL(state.calls[1].url); assert.equal(eventRequest.searchParams.get('singleEvents'), 'true'); assert.equal(eventRequest.searchParams.get('timeZone'), 'UTC');
  for (const { request } of state.calls) { assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error'); assert.equal(request.headers.Authorization, 'Bearer synthetic-google-token'); }
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(state.connector.status('google')), /synthetic-google-token|access_token|accessToken/);
  const returned = state.connector.events('google'); returned.events[0].title = 'Changed outside'; assert.equal(state.connector.events('google').events[0].title, 'Homework');
});

test('Google permission denial, missing scope, popup failure and malformed expiry never fetch calendar data', async () => {
  for (const options of [
    { googleResponse: { error: 'access_denied' } },
    { googleResponse: { access_token: 'synthetic', expires_in: 3600, scope: 'email' } },
    { googleResponse: { access_token: 'synthetic', expires_in: 'nonsense', scope: SCOPE } },
    { googleError: { type: 'popup_failed_to_open' } }
  ]) {
    const state = fixture(options); await assert.rejects(state.connector.connect('google'), /declined|read-only|expired|popup/); assert.equal(state.calls.length, 0); assert.equal(state.connector.status('google').connected, false); assert.equal(state.connector.events('google'), null);
  }
});

test('all Google calendars and pages are read and all-day dates use calendar timezone', async () => {
  const state = fixture({ fetch: url => {
    if (url.pathname.endsWith('/calendarList')) return response(url.searchParams.has('pageToken') ? { items: [{ id: 'school', timeZone: 'Europe/London' }] } : { items: [{ id: 'home', timeZone: 'Asia/Dubai' }], nextPageToken: 'list-next' });
    if (url.pathname.includes('/home/')) return response(url.searchParams.has('pageToken') ? { items: [googleEvent('home-two')] } : { items: [googleEvent('home-one')], nextPageToken: 'events-next' });
    return response({ items: [googleEvent('all-day', { summary: 'School holiday', start: { date: '2026-10-17' }, end: { date: '2026-10-18' } })] });
  } });
  const result = await state.connector.connect('google'); assert.equal(result.events.length, 3); assert.equal(state.calls.length, 5);
  const allDay = result.events.find(item => item.allDay); assert.equal(allDay.startAt, Date.parse('2026-10-16T23:00:00Z')); assert.equal(allDay.endAt, Date.parse('2026-10-17T23:00:00Z'));
});

test('partial calendar failure keeps the last complete snapshot unchanged', async () => {
  let failSecond = false;
  const state = fixture({ fetch: url => {
    if (url.pathname.endsWith('/calendarList')) return response({ items: [{ id: 'one', timeZone: 'Asia/Dubai' }, { id: 'two', timeZone: 'Asia/Dubai' }] });
    if (failSecond && url.pathname.includes('/two/')) return response({ error: 'denied' }, 403);
    return response({ items: [googleEvent(url.pathname.includes('/two/') ? 'two' : 'one')] });
  } });
  const before = await state.connector.connect('google'); failSecond = true;
  await assert.rejects(state.connector.refresh('google'), /every calendar.*403/); assert.deepEqual(state.connector.events('google'), before);
});

test('expired permissions cannot refresh or silently open consent', async () => {
  const state = fixture(); await state.connector.connect('google'); const requests = state.calls.length;
  state.setTime(NOW + 3600000); assert.equal(state.connector.status('google').connected, false);
  await assert.rejects(state.connector.refresh('google'), /expired.*Connect again/); assert.equal(state.calls.length, requests); assert.equal(state.loads.google, 1);
  assert.equal(state.connector.events('google').events.length, 1);
});

test('Microsoft official SDK uses memory cache and calendar consent; Graph times require UTC', async () => {
  const state = fixture(); const result = await state.connector.connect('microsoft');
  assert.equal(state.sdk[0].config.cache.cacheLocation, 'memoryStorage'); assert.equal(state.sdk[0].config.auth.redirectUri, configuration.redirectUri); assert.equal(state.sdk[0].config.auth.authority, 'https://login.microsoftonline.com/common');
  assert.deepEqual(state.sdk.find(item => item.scopes).scopes, ['Calendars.Read']);
  assert.equal(result.events[0].startAt, Date.parse('2026-10-16T13:00:00Z')); assert.equal(result.sourceType, 'microsoft');
  assert.equal(state.calls[1].request.headers.Prefer, 'outlook.timezone="UTC"'); assert.match(state.calls[1].url, /\/me\/calendars\/primary\/calendarView\?/);
  const requests = state.calls.length; await state.connector.refresh('microsoft'); assert.equal(state.sdk.filter(item => item.scopes).length, 1); assert.equal(state.calls.length, requests + 2);
  await state.connector.disconnect('microsoft'); assert.equal(state.cleared, 1); assert.equal(state.connector.status('microsoft').connected, false); assert.equal(state.connector.events('microsoft'), null);
});

test('Microsoft rejects declined, missing-scope and expired consent and clears local SDK memory', async () => {
  for (const options of [
    { microsoftError: true },
    { microsoftResponse: { accessToken: 'synthetic', expiresOn: new Date(NOW + 3600000), scopes: ['User.Read'] } },
    { microsoftResponse: { accessToken: 'synthetic', expiresOn: new Date(NOW), scopes: ['Calendars.Read'] } }
  ]) { const state = fixture(options); await assert.rejects(state.connector.connect('microsoft'), /declined|read-only|expired/); assert.equal(state.cleared, 1); assert.equal(state.calls.length, 0); assert.equal(state.connector.status('microsoft').connected, false); }
});

test('Microsoft next-page links cannot send tokens to another origin or another API path', async () => {
  for (const next of ['https://evil.test/v1.0/me/calendars', 'https://graph.microsoft.com/v1.0/me/messages', 'https://graph.microsoft.com/v1.0/me/calendars#fragment', 'https://name:password@graph.microsoft.com/v1.0/me/calendars']) {
    const state = fixture({ fetch: () => response({ value: [{ id: 'primary' }], '@odata.nextLink': next }) });
    await assert.rejects(state.connector.connect('microsoft'), /unsafe next-page/); assert.equal(state.calls.length, 1); assert.equal(state.connector.events('microsoft'), null);
  }
});

test('Microsoft follows bounded same-path pagination for calendar lists and calendar views', async () => {
  const state = fixture({ fetch: url => {
    if (url.pathname.endsWith('/calendars')) return response(url.searchParams.has('$skiptoken') ? { value: [{ id: 'second' }] } : { value: [{ id: 'first' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next' });
    if (url.pathname.includes('/first/')) return response(url.searchParams.has('$skiptoken') ? { value: [microsoftEvent('first-two')] } : { value: [microsoftEvent('first-one')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/first/calendarView?$skiptoken=next' });
    return response({ value: [microsoftEvent('second-one')] });
  } });
  assert.equal((await state.connector.connect('microsoft')).events.length, 3); assert.equal(state.calls.length, 5);
});

test('repeated pagination and more than 1,000 events abort atomically', async () => {
  const looping = fixture({ fetch: url => response(url.pathname.endsWith('/calendarList') ? { items: [], nextPageToken: 'same-page' } : { items: [] }) });
  await assert.rejects(looping.connector.connect('google'), /pagination/); assert.equal(looping.connector.events('google'), null); assert.ok(looping.calls.length <= 3);
  const crowded = fixture({ fetch: url => response(url.pathname.endsWith('/calendarList') ? { items: [{ id: 'primary', timeZone: 'UTC' }] } : { items: Array.from({ length: 1001 }, (_, index) => googleEvent('event-' + index)) }) });
  await assert.rejects(crowded.connector.connect('google'), /1,000/); assert.equal(crowded.connector.events('google'), null);
});

test('unsafe event dates, offset-free times, unknown zones and duplicate IDs fail the whole snapshot', async () => {
  const bad = [
    googleEvent('x', { start: { dateTime: '2026-10-16T13:00:00' } }),
    googleEvent('x', { start: { dateTime: '2026-02-30T13:00:00Z' } }),
    googleEvent('x', { start: { date: '2026-10-17', timeZone: 'Mars/Example' }, end: { date: '2026-10-18' } }),
    googleEvent('x', { end: { dateTime: '2026-10-16T12:00:00Z' } })
  ];
  for (const item of bad) { const state = fixture({ fetch: url => response(url.pathname.endsWith('/calendarList') ? { items: [{ id: 'primary', timeZone: 'UTC' }] } : { items: [googleEvent('safe'), item] }) }); await assert.rejects(state.connector.connect('google'), /offset|invalid|zone|before/); assert.equal(state.connector.events('google'), null); }
  const duplicates = fixture({ fetch: url => response(url.pathname.endsWith('/calendarList') ? { items: [{ id: 'primary' }] } : { items: [googleEvent(), googleEvent()] }) });
  await assert.rejects(duplicates.connector.connect('google'), /duplicate/);
  const ms = fixture({ fetch: url => response(url.pathname.endsWith('/calendars') ? { value: [{ id: 'primary' }] } : { value: [microsoftEvent('unsafe', { start: { dateTime: '2026-10-16T13:00:00', timeZone: 'Pacific Standard Time' } })] }) });
  await assert.rejects(ms.connector.connect('microsoft'), /UTC/);
});

test('cancelled events are omitted, titles safely truncated, distinct calendars retain distinct IDs', async () => {
  const state = fixture({ fetch: url => response(url.pathname.endsWith('/calendarList') ? { items: [{ id: 'one' }, { id: 'two' }] } : { items: [googleEvent('same-provider-id', { summary: '<img>' + 'x'.repeat(600) }), googleEvent('cancelled', { status: 'cancelled' })] }) });
  const snapshot = await state.connector.connect('google'); assert.equal(snapshot.events.length, 2); assert.equal(snapshot.events[0].title.length, 500); assert.ok(snapshot.warnings.some(note => /shortened/.test(note))); assert.ok(snapshot.warnings.some(note => /busy\/free only/.test(note))); assert.notEqual(snapshot.events[0].id, snapshot.events[1].id);
});

test('disconnect during a request prevents late success and removes all in-memory snapshot access', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const state = fixture({ fetch: async url => { if (url.pathname.endsWith('/calendarList')) { await blocked; return response({ items: [{ id: 'primary' }] }); } return response({ items: [googleEvent()] }); } });
  const work = state.connector.connect('google'); await new Promise(resolve => setImmediate(resolve));
  await state.connector.disconnect('google'); release(); await assert.rejects(work, /cancelled/); assert.equal(state.connector.events('google'), null); assert.equal(state.connector.status('google').connected, false);
});


test('free all-day birthdays do not block the day; busy events remain for either provider', async () => {
  const google = fixture({ fetch: url => response(url.pathname.endsWith('/calendarList') ? { items: [{ id: 'primary', timeZone: 'Asia/Dubai' }] } : { items: [googleEvent('busy'), googleEvent('birthday', { summary: 'Birthday', transparency: 'transparent', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } })] }) });
  const googleSnapshot = await google.connector.connect('google'); assert.equal(googleSnapshot.events.length, 1); assert.equal(googleSnapshot.events[0].title, 'Homework'); assert.ok(googleSnapshot.warnings.some(note => /marked as free/.test(note))); assert.ok(googleSnapshot.warnings.some(note => /busy\/free only/.test(note)));
  const microsoft = fixture({ fetch: url => response(url.pathname.endsWith('/calendars') ? { value: [{ id: 'primary' }] } : { value: [microsoftEvent('busy', { showAs: 'busy' }), microsoftEvent('birthday', { subject: 'Birthday', showAs: 'free', isAllDay: true, start: { dateTime: '2026-10-16T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-17T00:00:00.0000000', timeZone: 'UTC' } })] }) });
  const microsoftSnapshot = await microsoft.connector.connect('microsoft'); assert.equal(microsoftSnapshot.events.length, 1); assert.equal(microsoftSnapshot.events[0].title, 'Homework'); assert.ok(microsoftSnapshot.warnings.some(note => /marked as free/.test(note))); assert.match(new URL(microsoft.calls[1].url).searchParams.get('$select'), /showAs/);
});

test('an existing Google Maps global does not prevent loading the sign-in SDK', async () => {
  const previousGoogle = global.google, previousDocument = global.document, scripts = [];
  global.google = { maps: {} };
  global.document = {
    createElement() { return { remove() {} }; },
    head: { append(script) {
      scripts.push(script.src);
      global.google.accounts = { oauth2: {
        initTokenClient(options) { return { requestAccessToken() { queueMicrotask(() => options.callback({ access_token: 'synthetic-google-token', expires_in: 3600, scope: SCOPE })); } }; },
        hasGrantedAllScopes() { return true; }
      } };
      queueMicrotask(() => script.onload());
    } }
  };
  try {
    const connector = Connect.createConnector(configuration, { ...environment, now: () => NOW, fetch: async () => response({ items: [] }) });
    assert.equal(scripts.length, 0); await connector.connect('google');
    assert.deepEqual(scripts, ['https://accounts.google.com/gsi/client']); assert.equal(connector.status('google').connected, true);
    await connector.disconnect('google');
  } finally { if (previousGoogle === undefined) delete global.google; else global.google = previousGoogle; if (previousDocument === undefined) delete global.document; else global.document = previousDocument; }
});
