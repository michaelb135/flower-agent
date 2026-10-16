/* Read-only account calendar snapshots. Official provider SDKs own sign-in;
   API tokens stay in this module's memory and are never exported or persisted. */
(function (root) {
  'use strict';
  const DAY = 86400000, MAX_EVENTS = 1000, MAX_CALENDARS = 25, MAX_PAGES = 20, MAX_REQUESTS = 80, MAX_BYTES = 2 * 1024 * 1024;
  const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
  const PROVIDERS = ['google', 'microsoft'];
  const scriptLoads = new Map();
  const fail = message => { throw new Error(message); };
  function providerName(provider) { if (!PROVIDERS.includes(provider)) fail('Choose Google or Microsoft.'); return provider === 'google' ? 'Google' : 'Microsoft'; }
  function ordinary(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function copy(value) { return value === null ? null : JSON.parse(JSON.stringify(value)); }
  function clock(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 253402214400000) fail('The device clock is invalid. Check its date and time.'); return value; }
  function loadScript(url, ready) {
    if (ready()) return Promise.resolve(ready());
    if (scriptLoads.has(url)) return scriptLoads.get(url);
    const promise = new Promise((resolve, reject) => {
      if (!root.document) { reject(Error('Sign-in needs a browser.')); return; }
      const script = root.document.createElement('script');
      script.src = url; script.async = true; script.referrerPolicy = 'no-referrer';
      const timer = root.setTimeout(() => { script.remove(); reject(Error('The sign-in service did not load. Check your connection and try again.')); }, 20000);
      script.onload = () => { root.clearTimeout(timer); ready() ? resolve(ready()) : reject(Error('The sign-in service did not load correctly. Try again.')); };
      script.onerror = () => { root.clearTimeout(timer); script.remove(); reject(Error('The sign-in service could not load. Check your connection and try again.')); };
      root.document.head.append(script);
    });
    scriptLoads.set(url, promise); promise.catch(() => scriptLoads.delete(url)); return promise;
  }
  function expectedRedirect(origin, basePath) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))) fail('Calendar sign-in needs a secure website.');
    if (typeof basePath !== 'string' || !basePath.startsWith('/') || basePath.startsWith('//') || !basePath.endsWith('/') || /[?#\\]/.test(basePath) || basePath.includes('..')) fail('Invalid calendar website path.');
    const result = new URL(basePath + 'calendar-auth.html', origin);
    if (result.origin !== origin || result.pathname !== basePath + 'calendar-auth.html') fail('Invalid calendar website path.');
    return result.href;
  }
  function validateConfig(config, environment = {}) {
    if (!ordinary(config)) fail('Calendar connection settings are missing.');
    const origin = environment.origin || root.location?.origin;
    const basePath = environment.basePath || (root.location ? new URL('.', root.location.href).pathname : '/');
    const redirectUri = expectedRedirect(origin, basePath);
    if (config.redirectUri !== undefined && config.redirectUri !== redirectUri) fail('Calendar redirect must match this website’s calendar-auth.html address exactly.');
    const googleClientId = config.googleClientId === undefined ? '' : config.googleClientId, microsoftClientId = config.microsoftClientId === undefined ? '' : config.microsoftClientId;
    if (typeof googleClientId !== 'string' || (googleClientId && !/^[A-Za-z0-9_-]{1,220}\.apps\.googleusercontent\.com$/.test(googleClientId))) fail('Enter a valid public Google web client ID.');
    if (typeof microsoftClientId !== 'string' || (microsoftClientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(microsoftClientId))) fail('Enter a valid public Microsoft application client ID.');
    return Object.freeze({ googleClientId, microsoftClientId, redirectUri });
  }
  function dateParts(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
    if (!match) fail('A calendar event has an invalid date. No snapshot was changed.');
    const parts = match.slice(1).map(Number), value = new Date(0); value.setUTCFullYear(parts[0], parts[1] - 1, parts[2]); value.setUTCHours(0, 0, 0, 0);
    if (parts[0] < 1 || value.getUTCFullYear() !== parts[0] || value.getUTCMonth() + 1 !== parts[1] || value.getUTCDate() !== parts[2]) fail('A calendar event has an invalid date. No snapshot was changed.');
    return parts;
  }
  function instant(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(text)) fail('A calendar time needs an explicit UTC offset. No snapshot was changed.');
    dateParts(text.slice(0, 10));
    // Graph commonly returns seven fractional digits; reduce them to the
    // standard millisecond format before parsing (including on iPhone Safari).
    const normalized = text.replace(/\.(\d{1,7})(?=Z|[+-])/, (_, fraction) => '.' + fraction.padEnd(3, '0').slice(0, 3));
    const value = Date.parse(normalized); if (!Number.isFinite(value)) fail('A calendar event has an invalid time. No snapshot was changed.'); return value;
  }
  function allDayInstant(date, zone) {
    const parts = dateParts(date), targetDate = new Date(0); targetDate.setUTCFullYear(parts[0], parts[1] - 1, parts[2]); targetDate.setUTCHours(0, 0, 0, 0); const target = targetDate.getTime();
    let format;
    try { format = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
    catch (_) { fail('An all-day event has an unsupported calendar time zone. No snapshot was changed.'); }
    const wall = epoch => { const item = Object.fromEntries(format.formatToParts(epoch).map(part => [part.type, part.value])); return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(item[key])); };
    const utc = values => { const result = new Date(0); result.setUTCFullYear(values[0], values[1] - 1, values[2]); result.setUTCHours(values[3] || 0, values[4] || 0, values[5] || 0, 0); return result.getTime(); };
    const wanted = [...parts, 0, 0, 0], candidates = new Set();
    for (const hours of [-36, -12, 0, 12, 36]) { const probe = target + hours * 3600000, candidate = target - (utc(wall(probe)) - probe); if (wall(candidate).every((value, i) => value === wanted[i])) candidates.add(candidate); }
    if (candidates.size !== 1) fail('An all-day event has an ambiguous or missing midnight because clocks changed. No snapshot was changed.');
    return [...candidates][0];
  }
  function hash(text) { let first = 2166136261, second = 5381; for (let i = 0; i < text.length; i++) { first = Math.imul(first ^ text.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ text.charCodeAt(i); } return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0'); }
  function event(provider, calendar, raw, warnings) {
    if (!ordinary(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 2000) fail('A calendar returned an invalid event ID. No snapshot was changed.');
    if (provider === 'google' && raw.status === 'cancelled' || provider === 'microsoft' && raw.isCancelled === true) return null;
    if (provider === 'google' && raw.transparency === 'transparent' || provider === 'microsoft' && raw.showAs === 'free') { warnings.add('Events marked as free, including free all-day birthdays, are not treated as busy commitments.'); return null; }
    let startAt, endAt, allDay;
    if (provider === 'google') {
      if (!ordinary(raw.start) || !ordinary(raw.end)) fail('A Google event is missing its start or end. No snapshot was changed.');
      allDay = typeof raw.start.date === 'string';
      if (allDay) {
        if (raw.start.dateTime || raw.end.dateTime || typeof raw.end.date !== 'string') fail('An all-day Google event has inconsistent dates. No snapshot was changed.');
        const zone = raw.start.timeZone || calendar.timeZone;
        if (typeof zone !== 'string' || !zone || zone.length > 100 || raw.end.timeZone && raw.end.timeZone !== zone) fail('An all-day Google event is missing its calendar time zone. No snapshot was changed.');
        startAt = allDayInstant(raw.start.date, zone); endAt = allDayInstant(raw.end.date, zone);
      } else { if (raw.end.date) fail('A Google event has inconsistent dates. No snapshot was changed.'); startAt = instant(raw.start.dateTime); endAt = instant(raw.end.dateTime); }
    } else {
      if (!ordinary(raw.start) || !ordinary(raw.end) || !['UTC', 'Etc/UTC'].includes(raw.start.timeZone) || !['UTC', 'Etc/UTC'].includes(raw.end.timeZone)) fail('Microsoft did not return UTC calendar times. No snapshot was changed.');
      const microsoftTime = value => { if (typeof value !== 'string' || /(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('Microsoft returned an unexpected calendar time. No snapshot was changed.'); return instant(value + 'Z'); };
      startAt = microsoftTime(raw.start.dateTime); endAt = microsoftTime(raw.end.dateTime); allDay = raw.isAllDay === true;
    }
    if (endAt <= startAt) fail('A calendar event ends before it starts. No snapshot was changed.');
    const originalTitle = provider === 'google' ? raw.summary : raw.subject;
    if (originalTitle !== undefined && originalTitle !== null && typeof originalTitle !== 'string') fail('A calendar returned an invalid event title. No snapshot was changed.');
    const title = (originalTitle || 'Untitled calendar event').trim() || 'Untitled calendar event';
    if (title.length > 500) warnings.add('Long event titles were shortened to 500 characters.');
    return { id: provider + '-' + hash(calendar.id + '\n' + raw.id), title: title.slice(0, 500), startAt, endAt, allDay, sourceUid: raw.id.slice(0, 500) };
  }
  function createConnector(input, deps = {}) {
    const config = validateConfig(input, deps), now = deps.now || Date.now, fetcher = deps.fetch || root.fetch?.bind(root);
    const sessions = Object.fromEntries(PROVIDERS.map(provider => [provider, { token: '', expiresAt: 0, snapshot: null, busy: false, generation: 0, error: '', client: null }]));
    const loadGoogle = deps.loadGoogle || (() => loadScript('https://accounts.google.com/gsi/client', () => root.google?.accounts?.oauth2 ? root.google : null));
    const loadMicrosoft = deps.loadMicrosoft || (() => loadScript(new URL('vendor/msal-browser.min.js', config.redirectUri).href, () => root.msal));
    const timeoutMs = deps.timeoutMs === undefined ? 90000 : deps.timeoutMs;
    function configured(provider) { providerName(provider); return !!config[provider + 'ClientId']; }
    function status(provider) {
      const session = sessions[provider]; providerName(provider);
      const connected = !!session.token && session.expiresAt > now();
      return { configured: configured(provider), connected, busy: session.busy, expiresAt: connected ? session.expiresAt : null, count: session.snapshot?.events.length || 0, hasSnapshot: !!session.snapshot, error: session.error };
    }
    function requireToken(provider, generation) {
      const session = sessions[provider];
      if (session.generation !== generation) fail('Calendar connection was cancelled. No snapshot was changed.');
      if (!session.token || session.expiresAt <= now()) { session.token = ''; session.expiresAt = 0; fail(providerName(provider) + ' calendar access expired. Choose Connect again.'); }
      return session.token;
    }
    async function googleToken(session, generation) {
      let google; try { google = await loadGoogle(); } catch (_) { fail('Google sign-in could not load. Check your connection and try Connect again.'); }
      const oauth = google?.accounts?.oauth2;
      if (!oauth?.initTokenClient) fail('Google sign-in is unavailable. Try Connect again.');
      const result = await new Promise((resolve, reject) => {
        let finished = false;
        const complete = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => complete(Error('Google sign-in did not finish. Choose Connect and try again.')), timeoutMs);
        try {
          const client = oauth.initTokenClient({ client_id: config.googleClientId, scope: GOOGLE_SCOPE, include_granted_scopes: false,
            callback: response => {
              if (!response || response.error) return complete(Error(response?.error === 'access_denied' ? 'Google calendar permission was declined. Your saved calendar was kept.' : 'Google sign-in did not finish. Choose Connect and try again.'));
              let granted = false; try { granted = oauth.hasGrantedAllScopes ? oauth.hasGrantedAllScopes(response, GOOGLE_SCOPE) : typeof response.scope === 'string' && response.scope.split(/\s+/).includes(GOOGLE_SCOPE); } catch (_) {}
              if (!granted) return complete(Error('Google did not grant read-only calendar access. Your saved calendar was kept.'));
              complete(null, response);
            }, error_callback: () => complete(Error('Google sign-in could not open or was closed. Allow the sign-in popup, then choose Connect again.')) });
          client.requestAccessToken({ prompt: 'consent' });
        } catch (_) { complete(Error('Google sign-in could not open. Allow the sign-in popup, then choose Connect again.')); }
      });
      if (session.generation !== generation) fail('Calendar connection was cancelled.');
      return { token: result.access_token, expiresAt: clock(now()) + Number(result.expires_in) * 1000 - 30000 };
    }
    async function microsoftToken(session, generation) {
      if (!deps.loadMicrosoft && typeof root.BroadcastChannel !== 'function') fail('Microsoft calendar sign-in needs a browser with BroadcastChannel support. Update your browser and try again.');
      let msal; try { msal = await loadMicrosoft(); } catch (_) { fail('Microsoft sign-in could not load. Check your connection and try Connect again.'); }
      if (!msal?.PublicClientApplication) fail('Microsoft sign-in is unavailable. Try Connect again.');
      if (!session.client) {
        try { session.client = new msal.PublicClientApplication({ auth: { clientId: config.microsoftClientId, authority: 'https://login.microsoftonline.com/common', redirectUri: config.redirectUri }, cache: { cacheLocation: 'memoryStorage' } }); await session.client.initialize(); }
        catch (_) { session.client = null; fail('Microsoft sign-in could not initialise. Check your connection and choose Connect again.'); }
      }
      let result;
      try { result = await session.client.loginPopup({ scopes: ['Calendars.Read'], prompt: 'select_account' }); }
      catch (_) { fail('Microsoft sign-in was declined, closed or blocked. Allow the sign-in popup, then choose Connect again.'); }
      if (session.generation !== generation) { await session.client.clearCache(); fail('Calendar connection was cancelled.'); }
      if (!Array.isArray(result?.scopes) || !result.scopes.some(scope => /^(?:https:\/\/graph\.microsoft\.com\/)?calendars\.read$/i.test(scope))) fail('Microsoft did not grant read-only calendar access. Your saved calendar was kept.');
      return { token: result.accessToken, expiresAt: result.expiresOn instanceof Date ? result.expiresOn.getTime() - 30000 : NaN };
    }
    async function snapshot(provider, generation) {
      if (!fetcher) fail('Calendar requests are unavailable in this browser.');
      const start = clock(now()), end = start + 60 * DAY, warnings = new Set(), output = [], ids = new Set(); let requests = 0;
      if (provider === 'google') warnings.add('Only calendars shared with event-reading permission are included. Calendars shared as busy/free only are not checked.');
      const apiOrigin = provider === 'google' ? 'https://www.googleapis.com' : 'https://graph.microsoft.com';
      async function request(url, expectedPath) {
        let parsed; try { parsed = new URL(url); } catch (_) { fail('A calendar returned an invalid next-page address. No snapshot was changed.'); }
        if (parsed.origin !== apiOrigin || parsed.pathname !== expectedPath || parsed.username || parsed.password || parsed.hash) fail('A calendar returned an unsafe next-page address. No snapshot was changed.');
        if (++requests > MAX_REQUESTS) fail('This account has too many calendar pages to import safely. No snapshot was changed.');
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => controller?.abort(), 20000);
        try {
          let response;
          try { response = await fetcher(parsed.href, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Authorization: 'Bearer ' + requireToken(provider, generation), ...(provider === 'microsoft' ? { Prefer: 'outlook.timezone="UTC"' } : {}) }, ...(controller ? { signal: controller.signal } : {}) }); }
          catch (_) { if (sessionChanged()) fail('Calendar connection was cancelled. No snapshot was changed.'); fail(providerName(provider) + ' calendar could not be read. Check your connection and try Refresh.'); }
          requireToken(provider, generation);
          if (!response?.ok) { if (response?.status === 401) { sessions[provider].token = ''; sessions[provider].expiresAt = 0; fail(providerName(provider) + ' calendar access expired. Choose Connect again.'); } fail(providerName(provider) + ' could not read every calendar (HTTP ' + (Number(response?.status) || 'error') + '). No snapshot was changed.'); }
          if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) fail('A calendar response is too large. No snapshot was changed.');
          let data;
          try { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_BYTES) fail('large'); data = JSON.parse(text); }
          catch (_) { fail('A calendar response is invalid, incomplete or too large. No snapshot was changed.'); }
          requireToken(provider, generation);
          if (!ordinary(data)) fail('A calendar returned invalid data. No snapshot was changed.');
          return data;
        } finally { clearTimeout(timer); }
      }
      function sessionChanged() { return sessions[provider].generation !== generation; }
      async function pages(initial, path, consume) {
        let url = initial, seen = new Set(), count = 0;
        while (url) {
          if (++count > MAX_PAGES || seen.has(url)) fail('Calendar pagination did not finish safely. No snapshot was changed.'); seen.add(url);
          const data = await request(url, path), items = data[provider === 'google' ? 'items' : 'value'];
          if (!Array.isArray(items) && !(provider === 'google' && items === undefined)) fail('A calendar returned an invalid list. No snapshot was changed.');
          for (const item of items || []) consume(item);
          if (provider === 'google') {
            if (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || !data.nextPageToken || data.nextPageToken.length > 4000)) fail('A calendar returned an invalid page token. No snapshot was changed.');
            if (data.nextPageToken) { const next = new URL(initial); next.searchParams.set('pageToken', data.nextPageToken); url = next.href; } else url = null;
          } else {
            if (data['@odata.nextLink'] !== undefined && (typeof data['@odata.nextLink'] !== 'string' || !data['@odata.nextLink'] || data['@odata.nextLink'].length > 10000)) fail('A calendar returned an invalid next-page address. No snapshot was changed.');
            url = data['@odata.nextLink'] || null;
          }
        }
      }
      const calendars = [], calendarIds = new Set(), calendarPath = provider === 'google' ? '/calendar/v3/users/me/calendarList' : '/v1.0/me/calendars';
      const calendarURL = new URL(calendarPath, apiOrigin);
      if (provider === 'google') { calendarURL.searchParams.set('maxResults', '250'); calendarURL.searchParams.set('showHidden', 'true'); calendarURL.searchParams.set('minAccessRole', 'reader'); }
      else { calendarURL.searchParams.set('$top', '100'); calendarURL.searchParams.set('$select', 'id,name'); }
      await pages(calendarURL.href, calendarPath, item => {
        if (!ordinary(item) || typeof item.id !== 'string' || !item.id || item.id.length > 2000 || calendarIds.has(item.id)) fail('A calendar returned invalid or repeated calendar IDs. No snapshot was changed.');
        calendarIds.add(item.id); calendars.push(item); if (calendars.length > MAX_CALENDARS) fail('This account has more than 25 calendars. No snapshot was changed.');
      });
      for (const calendar of calendars) {
        const path = provider === 'google' ? '/calendar/v3/calendars/' + encodeURIComponent(calendar.id) + '/events' : '/v1.0/me/calendars/' + encodeURIComponent(calendar.id) + '/calendarView';
        const url = new URL(path, apiOrigin);
        if (provider === 'google') { for (const [key, value] of Object.entries({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'false', timeZone: 'UTC' })) url.searchParams.set(key, value); }
        else { url.searchParams.set('startDateTime', new Date(start).toISOString()); url.searchParams.set('endDateTime', new Date(end).toISOString()); url.searchParams.set('$top', '250'); url.searchParams.set('$select', 'id,subject,start,end,isAllDay,isCancelled,showAs'); }
        await pages(url.href, path, raw => {
          const normalized = event(provider, calendar, raw, warnings); if (!normalized || normalized.endAt <= start || normalized.startAt >= end) return;
          if (ids.has(normalized.id)) fail('A calendar returned duplicate events. No snapshot was changed.'); ids.add(normalized.id); output.push(normalized);
          if (output.length > MAX_EVENTS) fail('More than 1,000 calendar events were returned. No snapshot was changed.');
        });
      }
      requireToken(provider, generation);
      output.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
      return { sourceName: providerName(provider) + ' Calendar', sourceType: provider, importedAt: clock(now()), windowStart: start, windowEnd: end, events: output, warnings: [...warnings] };
    }
    async function perform(provider, authenticate) {
      providerName(provider); const session = sessions[provider];
      if (!configured(provider)) fail(providerName(provider) + ' calendar setup is required. Add this website’s public client ID before connecting.');
      if (session.busy) fail('A calendar connection is already in progress.');
      session.busy = true; session.error = ''; const generation = ++session.generation;
      try {
        if (authenticate) {
          const credentials = await (provider === 'google' ? googleToken(session, generation) : microsoftToken(session, generation));
          if (typeof credentials.token !== 'string' || !credentials.token || credentials.token.length > 16384 || /[\r\n]/.test(credentials.token) || !Number.isSafeInteger(credentials.expiresAt) || credentials.expiresAt <= now() || credentials.expiresAt > now() + DAY) fail(providerName(provider) + ' returned an invalid or expired calendar permission. Choose Connect again.');
          session.token = credentials.token; session.expiresAt = credentials.expiresAt;
        }
        requireToken(provider, generation); const result = await snapshot(provider, generation); session.snapshot = result; return copy(result);
      } catch (problem) {
        if (authenticate || session.generation !== generation) { session.token = ''; session.expiresAt = 0; if (provider === 'microsoft') await session.client?.clearCache().catch(() => {}); }
        session.error = problem?.message || 'Calendar connection failed. Your saved snapshot was kept.'; throw Error(session.error);
      } finally { session.busy = false; }
    }
    return Object.freeze({ connect: provider => perform(provider, true), refresh: provider => perform(provider, false), async disconnect(provider) { providerName(provider); const session = sessions[provider]; ++session.generation; session.token = ''; session.expiresAt = 0; session.snapshot = null; session.error = ''; if (session.client) await session.client.clearCache(); }, status, events(provider) { providerName(provider); return copy(sessions[provider].snapshot); } });
  }
  const api = Object.freeze({ createConnector, validateConfig }); root.TidyCalendarConnect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
