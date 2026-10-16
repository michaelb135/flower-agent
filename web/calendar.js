/* Local .ics files only: no calendar accounts, network access, or device permissions. */
(function (root) {
  'use strict';
  const DAY = 86400000, LIMIT = 1024 * 1024, MAX_EVENTS = 1000;
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const formatters = new Map();
  const fail = message => { throw new Error(message); };
  const bytes = text => new TextEncoder().encode(text).length;
  function integer(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('Invalid ' + label + '.');
    return value;
  }
  function epoch(value, label) {
    integer(value, -8640000000000000, 8640000000000000, label);
    const year = new Date(value).getUTCFullYear();
    if (year < 1 || year > 9999) fail('Invalid ' + label + '; use years 0001 to 9999.');
    return value;
  }
  function utc(parts) {
    const result = new Date(0);
    result.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
    result.setUTCHours(parts[3] || 0, parts[4] || 0, parts[5] || 0, 0);
    const actual = [result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate(), result.getUTCHours(), result.getUTCMinutes(), result.getUTCSeconds()];
    if (parts[0] < 1 || parts[0] > 9999 || actual.some((value, i) => value !== (parts[i] || 0))) fail('Invalid calendar date or time.');
    return result.getTime();
  }
  function formatter(zone) {
    if (typeof zone !== 'string' || zone.length > 100) fail('Unsupported calendar time zone.');
    if (!formatters.has(zone)) {
      if (formatters.size > 64) formatters.clear();
      try { formatters.set(zone, new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })); }
      catch (_) { fail('Unsupported calendar time zone: ' + zone + '. Export the calendar in UTC or a standard named time zone.'); }
    }
    return formatters.get(zone);
  }
  function wallParts(value, zone) {
    const parts = Object.fromEntries(formatter(zone).formatToParts(value).map(part => [part.type, part.value]));
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(parts[key]));
  }
  function wallEpoch(parts, zone) {
    const target = utc(parts);
    if (zone === 'UTC' || zone === 'Etc/UTC') return target;
    const candidates = new Set();
    // Probe both sides of a possible daylight-saving transition. A gap or an
    // ambiguous repeated hour needs an explicit UTC export, never a guess.
    for (const delta of [-36, -12, 0, 12, 36]) {
      const probe = target + delta * 3600000;
      const offset = utc(wallParts(probe, zone)) - probe;
      const candidate = target - offset;
      if (wallParts(candidate, zone).every((part, i) => part === parts[i])) candidates.add(candidate);
    }
    if (!candidates.size) fail('A calendar time does not exist because of a daylight-saving change. Export that event in UTC.');
    if (candidates.size > 1) fail('A calendar time is ambiguous because of a daylight-saving change. Export that event in UTC.');
    return [...candidates][0];
  }
  function addDays(parts, amount) {
    const value = new Date(utc(parts) + amount * DAY);
    const result = [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), ...parts.slice(3)];
    utc(result);
    return result;
  }
  function splitOutside(text, separator) {
    const result = []; let quoted = false, start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted;
      else if (text[i] === separator && !quoted) { result.push(text.slice(start, i)); start = i + 1; }
    }
    if (quoted) fail('Malformed quoted calendar parameter.');
    result.push(text.slice(start));
    return result;
  }
  function property(line) {
    let quoted = false, colon = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      if (line[i] === ':' && !quoted) { colon = i; break; }
    }
    if (colon < 1) fail('Malformed calendar property.');
    const fields = splitOutside(line.slice(0, colon), ';'), name = fields.shift().toUpperCase(), params = {};
    if (!/^[A-Z0-9-]+$/.test(name)) fail('Malformed calendar property name.');
    for (const field of fields) {
      const equal = field.indexOf('='), key = field.slice(0, equal).toUpperCase();
      if (equal < 1 || !/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params, key)) fail('Malformed calendar parameter.');
      let value = field.slice(equal + 1);
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!value || /[\r\n"]/.test(value)) fail('Malformed calendar parameter.');
      params[key] = value;
    }
    return { name, params, value: line.slice(colon + 1) };
  }
  function text(value) {
    if (value.length > 10000) fail('Calendar text is too long.');
    let result = '';
    for (let index = 0; index < value.length; index++) {
      let char = value[index];
      if (char === '\\') {
        char = value[++index];
        if (char === 'n' || char === 'N') char = '\n';
        else if (!char || !'\\,;'.includes(char)) fail('Unsupported calendar text escape.');
      }
      result += char;
    }
    return result;
  }
  function dateValue(prop, defaultZone, warnings) {
    for (const key of Object.keys(prop.params)) if (!['TZID', 'VALUE'].includes(key)) fail('Unsupported calendar date parameter: ' + key + '.');
    const valueType = prop.params.VALUE && prop.params.VALUE.toUpperCase();
    const dateOnly = valueType === 'DATE';
    if (valueType && !['DATE', 'DATE-TIME'].includes(valueType)) fail('Unsupported calendar date type.');
    const match = (dateOnly ? /^(\d{4})(\d{2})(\d{2})$/ : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/).exec(prop.value);
    if (!match) fail('Invalid calendar date or time.');
    if ((dateOnly || match[7]) && prop.params.TZID) fail('A UTC or all-day date cannot also have a time-zone parameter.');
    const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)];
    const zone = match[7] ? 'UTC' : prop.params.TZID || defaultZone;
    formatter(zone);
    if (!dateOnly && !match[7] && !prop.params.TZID) warnings.add('Times without a named time zone are interpreted in ' + defaultZone + '.');
    return { parts, epoch: wallEpoch(parts, zone), dateOnly, zone };
  }
  function tree(input) {
    if (typeof input !== 'string' || bytes(input) > LIMIT) fail('Choose a calendar file smaller than 1 MiB.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) fail('Invalid control character in calendar file.');
    input = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (input.includes('\r')) fail('Malformed calendar line endings.');
    const lines = [];
    for (const line of input.split('\n')) {
      if (/^[ \t]/.test(line)) {
        if (!lines.length) fail('Malformed folded calendar line.');
        lines[lines.length - 1] += line.slice(1);
      } else if (line) lines.push(line);
      if (lines.length > 20000 || (lines.length && lines[lines.length - 1].length > 20000)) fail('Calendar file has too many or oversized lines.');
    }
    const stack = [], roots = [];
    for (const line of lines) {
      const prop = property(line);
      if (prop.name === 'BEGIN') {
        if (Object.keys(prop.params).length) fail('Malformed calendar component.');
        const name = prop.value.toUpperCase(), parent = stack.at(-1);
        const allowed = !parent ? ['VCALENDAR'] : parent.name === 'VCALENDAR' ? ['VEVENT', 'VTIMEZONE'] : parent.name === 'VEVENT' ? ['VALARM'] : parent.name === 'VTIMEZONE' ? ['STANDARD', 'DAYLIGHT'] : [];
        if (!allowed.includes(name)) fail('Unsupported calendar component: ' + name + '. No events have been imported.');
        const node = { name, props: [], children: [] };
        (parent ? parent.children : roots).push(node); stack.push(node);
      } else if (prop.name === 'END') {
        if (Object.keys(prop.params).length || !stack.length || stack.pop().name !== prop.value.toUpperCase()) fail('Mismatched calendar component.');
      } else {
        if (!stack.length) fail('Calendar properties must be inside VCALENDAR.');
        stack.at(-1).props.push(prop);
      }
    }
    if (stack.length || roots.length !== 1) fail('Choose one complete VCALENDAR file.');
    return roots[0];
  }
  function one(node, name, required) {
    const values = node.props.filter(prop => prop.name === name);
    if (values.length > 1 || (required && values.length !== 1)) fail('Calendar event needs exactly one ' + name + '.');
    return values[0];
  }
  function rule(prop, start, warnings) {
    if (!prop) return null;
    if (Object.keys(prop.params).length) fail('Unsupported recurrence parameters.');
    const values = {};
    for (const field of prop.value.toUpperCase().split(';')) {
      const [key, value, extra] = field.split('=');
      if (!key || !value || extra !== undefined || Object.hasOwn(values, key) || !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(key)) fail('Unsupported recurrence rule. Only daily and weekly rules with INTERVAL, COUNT, UNTIL and weekly BYDAY are supported.');
      values[key] = value;
    }
    if (!['DAILY', 'WEEKLY'].includes(values.FREQ) || (values.WKST && values.WKST !== 'MO')) fail('Unsupported recurrence rule. Use daily or weekly recurrence with Monday as the week start.');
    const positive = (value, fallback, name) => value === undefined ? fallback : /^\d+$/.test(value) ? integer(Number(value), 1, 1000000, 'recurrence ' + name) : fail('Invalid recurrence ' + name + '.');
    const result = { freq: values.FREQ, interval: positive(values.INTERVAL, 1, 'interval'), count: positive(values.COUNT, Infinity, 'count'), until: Infinity };
    if (values.COUNT && values.UNTIL) fail('A recurrence cannot combine COUNT and UNTIL.');
    if (values.UNTIL) {
      if (!start.dateOnly && !values.UNTIL.endsWith('Z')) fail('Timed recurrence UNTIL must be in UTC.');
      const until = dateValue({ params: start.dateOnly ? { VALUE: 'DATE' } : {}, value: values.UNTIL }, start.zone, warnings);
      if (until.dateOnly !== start.dateOnly) fail('Recurrence UNTIL must match the start date type.');
      result.until = until.epoch;
      if (result.until < start.epoch) fail('Recurrence ends before it starts.');
    }
    if (values.BYDAY && result.freq !== 'WEEKLY') fail('BYDAY is supported for weekly recurrence only.');
    result.days = values.BYDAY ? values.BYDAY.split(',').map(day => {
      if (!DAYS.includes(day)) fail('Unsupported recurrence BYDAY. Use weekday names without positions.');
      return (DAYS.indexOf(day) + 6) % 7;
    }) : [(new Date(utc(start.parts)).getUTCDay() + 6) % 7];
    if (new Set(result.days).size !== result.days.length) fail('Duplicate recurrence weekdays.');
    result.days.sort((a, b) => a - b);
    const startDay = (new Date(utc(start.parts)).getUTCDay() + 6) % 7;
    if (!result.days.includes(startDay)) fail('The recurrence start must match its BYDAY weekdays.');
    return result;
  }
  function hash(value) {
    let a = 2166136261, b = 5381;
    for (const char of value) { a = Math.imul(a ^ char.codePointAt(0), 16777619); b = Math.imul(b, 33) ^ char.codePointAt(0); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function parseICS(input, options = {}) {
    const now = options.now === undefined ? Date.now() : epoch(options.now, 'import time');
    const horizonDays = options.horizonDays === undefined ? 60 : integer(options.horizonDays, 1, 366, 'calendar horizon');
    const defaultZone = options.timeZone || 'Asia/Dubai'; formatter(defaultZone);
    const windowEnd = epoch(now + horizonDays * DAY, 'calendar window end');
    const calendar = tree(input), warnings = new Set(), events = [], seen = new Map(), ids = new Set();
    const version = one(calendar, 'VERSION', true);
    if (version.value !== '2.0') fail('Only iCalendar version 2.0 is supported.');
    const method = one(calendar, 'METHOD');
    if (method && !['PUBLISH', 'REQUEST'].includes(method.value.toUpperCase())) fail('This calendar method is not a complete event import. Export the calendar as a .ics file.');
    for (const zone of calendar.children.filter(node => node.name === 'VTIMEZONE')) {
      const tzid = one(zone, 'TZID', true); formatter(tzid.value);
      warnings.add('Named time zones use the standard time-zone rules available on this device.');
    }
    const nodes = calendar.children.filter(node => node.name === 'VEVENT');
    if (nodes.length > 5000) fail('Calendar file has too many events. Export a smaller date range.');
    let excluded = 0, outside = 0;
    for (const node of nodes) {
      for (const name of ['RECURRENCE-ID', 'RDATE', 'EXRULE']) if (one(node, name)) fail('This calendar uses ' + name + ', which Tidy cannot safely expand. Export individual events instead; no events have been imported.');
      if (node.children.length) warnings.add('Calendar alarms are not imported. Tidy reminders are managed separately.');
      const uid = text(one(node, 'UID', true).value);
      if (!uid.trim() || uid.length > 500) fail('Invalid calendar event UID.');
      const signature = JSON.stringify(node);
      if (seen.has(uid)) {
        if (seen.get(uid) !== signature) fail('Conflicting copies of the same calendar event were found. Export the latest calendar instead.');
        warnings.add('Identical duplicate events were imported once.'); continue;
      }
      seen.set(uid, signature);
      const status = one(node, 'STATUS');
      if (status && status.value.toUpperCase() === 'CANCELLED') { excluded++; continue; }
      const start = dateValue(one(node, 'DTSTART', true), defaultZone, warnings);
      const endProp = one(node, 'DTEND'), durationProp = one(node, 'DURATION');
      if (endProp && durationProp) fail('A calendar event cannot have both DTEND and DURATION.');
      let duration, days = 0;
      if (endProp) {
        const end = dateValue(endProp, defaultZone, warnings);
        if (end.dateOnly !== start.dateOnly || end.epoch <= start.epoch) fail('Calendar event end must follow its start and use the same date type.');
        duration = end.epoch - start.epoch;
        if (start.dateOnly) days = (utc(end.parts) - utc(start.parts)) / DAY;
      } else if (durationProp) {
        if (Object.keys(durationProp.params).length) fail('Unsupported calendar duration parameters.');
        const match = (start.dateOnly ? /^P(\d+)D$/ : /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/).exec(durationProp.value);
        if (!match) fail('Unsupported calendar duration. Use a positive number of days for all-day events, or hours/minutes/seconds for timed events.');
        if (start.dateOnly) { days = Number(match[1]); duration = days * DAY; }
        else duration = ((Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60 + Number(match[3] || 0)) * 1000;
        if (!Number.isSafeInteger(duration) || duration <= 0) fail('Invalid calendar duration.');
      } else {
        days = start.dateOnly ? 1 : 0; duration = start.dateOnly ? DAY : 30 * 60000;
        if (!start.dateOnly) warnings.add('Timed events without an end time are reserved for 30 minutes.');
      }
      if (duration > 366 * DAY || !Number.isInteger(days)) fail('Calendar event duration is too long or invalid.');
      const summary = one(node, 'SUMMARY');
      const title = summary ? text(summary.value).trim() : 'Busy';
      if (!title || title.length > 500) fail('Calendar event title must be 1 to 500 characters.');
      const recurrence = rule(one(node, 'RRULE'), start, warnings), exceptions = new Set();
      for (const prop of node.props.filter(value => value.name === 'EXDATE')) for (const value of prop.value.split(',')) {
        const exclusion = dateValue({ ...prop, value }, defaultZone, warnings);
        if (exclusion.dateOnly !== start.dateOnly) fail('Excluded dates must match the event date type.');
        exceptions.add(exclusion.epoch);
      }
      const add = parts => {
        const startAt = wallEpoch(parts, start.zone), endAt = start.dateOnly ? wallEpoch(addDays(parts, days), start.zone) : startAt + duration;
        epoch(endAt, 'calendar event end');
        if (exceptions.has(startAt)) { excluded++; return; }
        if (endAt <= now || startAt >= windowEnd) { outside++; return; }
        const id = 'calendar-' + hash(uid) + '-' + startAt.toString(36);
        if (ids.has(id)) fail('Calendar event identifiers collided. No events have been imported.');
        ids.add(id);
        if (events.length >= MAX_EVENTS) fail('Calendar expands to more than 1,000 events. Export a smaller date range.');
        events.push({ id, title, startAt, endAt, allDay: start.dateOnly, sourceUid: uid });
      };
      if (!recurrence) { add(start.parts); continue; }
      warnings.add('Recurring events are expanded only within this import window. Import again to refresh later dates.');
      const startWall = utc(start.parts), lowerWall = utc(wallParts(now - duration - 2 * DAY, start.zone));
      if (recurrence.freq === 'DAILY') {
        const first = Math.max(0, Math.floor((lowerWall - startWall) / DAY / recurrence.interval));
        for (let index = first; index < recurrence.count; index++) {
          if (startWall + index * recurrence.interval * DAY > windowEnd + 2 * DAY) break;
          const parts = addDays(start.parts, index * recurrence.interval), instant = wallEpoch(parts, start.zone);
          if (instant > recurrence.until || instant >= windowEnd) break;
          add(parts);
        }
      } else {
        const weekday = (new Date(startWall).getUTCDay() + 6) % 7, anchor = addDays(start.parts, -weekday);
        const initialDays = recurrence.days.filter(day => day >= weekday);
        let week = Math.max(0, Math.floor((lowerWall - utc(anchor)) / (7 * DAY * recurrence.interval)));
        let finished = false;
        for (; !finished; week++) {
          const selected = week === 0 ? initialDays : recurrence.days;
          const previous = week === 0 ? 0 : initialDays.length + (week - 1) * recurrence.days.length;
          for (let index = 0; index < selected.length; index++) {
            if (previous + index >= recurrence.count) { finished = true; break; }
            if (utc(anchor) + (week * 7 * recurrence.interval + selected[index]) * DAY > windowEnd + 2 * DAY) { finished = true; break; }
            const parts = addDays(anchor, week * 7 * recurrence.interval + selected[index]), instant = wallEpoch(parts, start.zone);
            if (instant > recurrence.until || instant >= windowEnd) { finished = true; break; }
            add(parts);
          }
        }
      }
    }
    if (excluded) warnings.add(excluded + ' cancelled or excluded occurrence(s) were omitted.');
    if (outside) warnings.add('Events outside the import window are not shown.');
    events.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
    return { events, importedAt: now, windowStart: now, windowEnd, warnings: [...warnings] };
  }
  function escapeText(value) {
    if (typeof value !== 'string' || value.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('Invalid calendar export text.');
    return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  }
  function stamp(value) { return new Date(epoch(value, 'calendar export time')).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  function fold(line) {
    let result = '', current = '', length = 0;
    for (const char of line) {
      const size = bytes(char);
      if (length + size > 75) { result += current + '\r\n'; current = ' '; length = 1; }
      current += char; length += size;
    }
    return result + current;
  }
  function exportICS(items, options = {}) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_EVENTS) fail('Select 1 to 1,000 scheduled items to export.');
    const now = options.now === undefined ? Date.now() : epoch(options.now, 'export time');
    const zone = options.timeZone || 'Asia/Dubai'; formatter(zone);
    const duration = options.durationMinutes === undefined ? 30 : integer(options.durationMinutes, 1, 24 * 60, 'export duration');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tidy//Local calendar export//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    const ids = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || item.id.length > 500 || ids.has(item.id)) fail('Export items need unique IDs.');
      ids.add(item.id);
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500) fail('Export items need a title of at most 500 characters.');
      let startAt, endAt, allDay = item.allDay === true;
      if (item.startAt !== undefined) {
        startAt = epoch(item.startAt, 'event start'); endAt = epoch(item.endAt, 'event end');
      } else {
        if (typeof item.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) fail('Select only tasks with a scheduled date.');
        const date = item.dueDate.replace(/-/g, '');
        if (item.dueTime) {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.dueTime)) fail('Invalid scheduled task time.');
          startAt = dateValue({ value: date + 'T' + item.dueTime.replace(':', '') + '00', params: { TZID: zone } }, zone, new Set()).epoch;
          const minutes = item.durationMinutes === undefined ? duration : integer(item.durationMinutes, 1, 24 * 60, 'task duration');
          endAt = startAt + minutes * 60000;
        } else {
          const start = dateValue({ value: date, params: { VALUE: 'DATE' } }, zone, new Set());
          startAt = start.epoch; endAt = wallEpoch(addDays(start.parts, 1), zone); allDay = true;
        }
      }
      if (endAt <= startAt) fail('Export event end must follow its start.');
      lines.push('BEGIN:VEVENT', 'UID:' + escapeText(item.id) + '@tidy.local', 'DTSTAMP:' + stamp(now));
      if (allDay) {
        const start = wallParts(startAt, zone), end = wallParts(endAt, zone);
        if (start.slice(3).some(Boolean) || end.slice(3).some(Boolean)) fail('All-day exports must start and end at midnight in the selected time zone.');
        const date = parts => parts.slice(0, 3).map((value, index) => String(value).padStart(index ? 2 : 4, '0')).join('');
        lines.push('DTSTART;VALUE=DATE:' + date(start), 'DTEND;VALUE=DATE:' + date(end));
      } else lines.push('DTSTART:' + stamp(startAt), 'DTEND:' + stamp(endAt));
      lines.push('SUMMARY:' + escapeText(item.title.trim()), 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const result = lines.map(fold).join('\r\n') + '\r\n';
    if (bytes(result) > LIMIT) fail('Calendar export exceeds 1 MiB. Select fewer items.');
    return result;
  }
  const api = Object.freeze({ parseICS, exportICS });
  root.TidyCalendar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
