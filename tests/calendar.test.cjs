const test = require('node:test');
const assert = require('node:assert/strict');
const Calendar = require('../web/calendar.js');

const NOW = Date.parse('2026-10-15T00:00:00Z');
const options = { now: NOW, horizonDays: 60 };
const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
const event = (extra = [], uid = 'event-1') => ['BEGIN:VEVENT', 'UID:' + uid, 'DTSTART:20261016T130000Z', 'DTEND:20261016T140000Z', 'SUMMARY:Homework', ...extra, 'END:VEVENT'].join('\r\n');
const parse = value => Calendar.parseICS(value, options);

test('imports an overlapping or future event with plain text, provenance and exact UTC timing', () => {
  const source = calendar(event(['LOCATION:School']));
  const result = parse(source);
  assert.equal(result.importedAt, NOW);
  assert.equal(result.windowStart, NOW);
  assert.equal(result.windowEnd, NOW + 60 * 86400000);
  assert.deepEqual(result.events.map(({ title, startAt, endAt, allDay, sourceUid }) => ({ title, startAt, endAt, allDay, sourceUid })), [{ title: 'Homework', startAt: Date.parse('2026-10-16T13:00:00Z'), endAt: Date.parse('2026-10-16T14:00:00Z'), allDay: false, sourceUid: 'event-1' }]);
  assert.deepEqual(parse(source), result);
  const overlapping = calendar(event().replace('20261016T130000Z', '20261014T230000Z').replace('20261016T140000Z', '20261015T010000Z'));
  assert.equal(parse(overlapping).events.length, 1);
});

test('unfolds text and decodes escapes without treating titles as HTML', () => {
  const source = calendar(event().replace('SUMMARY:Homework', 'SUMMARY:<img src=x>\\, homework\\nLine two\r\n  and folded\\; title'));
  assert.equal(parse(source).events[0].title, '<img src=x>, homework\nLine two and folded; title');
  assert.throws(() => parse(calendar(event().replace('SUMMARY:Homework', 'SUMMARY:broken\\'))), /escape/);
});

test('all-day DTEND is exclusive and absent DTEND means one local day', () => {
  const source = calendar(event().replace('DTSTART:20261016T130000Z', 'DTSTART;VALUE=DATE:20261016').replace('DTEND:20261016T140000Z', 'DTEND;VALUE=DATE:20261018'));
  const [item] = parse(source).events;
  assert.equal(item.startAt, Date.parse('2026-10-15T20:00:00Z'));
  assert.equal(item.endAt, Date.parse('2026-10-17T20:00:00Z'));
  assert.equal(item.allDay, true);
  const noEnd = source.replace('DTEND;VALUE=DATE:20261018\r\n', '');
  assert.equal(parse(noEnd).events[0].endAt - item.startAt, 86400000);
});

test('uses named time zones and explicit default-zone warning for floating times', () => {
  const source = calendar(event().replace('DTSTART:20261016T130000Z', 'DTSTART;TZID="Asia/Dubai":20261016T170000').replace('DTEND:20261016T140000Z', 'DTEND;TZID=Asia/Dubai:20261016T180000'));
  assert.equal(parse(source).events[0].startAt, Date.parse('2026-10-16T13:00:00Z'));
  const floating = source.replaceAll(';TZID="Asia/Dubai"', '').replaceAll(';TZID=Asia/Dubai', '');
  assert.equal(parse(floating).events[0].startAt, Date.parse('2026-10-16T13:00:00Z'));
  assert.match(parse(floating).warnings.join(' '), /interpreted in Asia\/Dubai/);
});

test('rejects nonexistent and ambiguous DST wall times instead of guessing', () => {
  const source = date => calendar(event().replace('DTSTART:20261016T130000Z', 'DTSTART;TZID=America/New_York:' + date).replace('DTEND:20261016T140000Z', 'DURATION:PT30M'));
  assert.throws(() => Calendar.parseICS(source('20260308T023000'), { now: Date.parse('2026-03-01T00:00:00Z') }), /does not exist.*daylight-saving/);
  assert.throws(() => parse(source('20261101T013000')), /ambiguous.*daylight-saving/);
});

test('weekly recurrence keeps local wall time across DST and applies COUNT and EXDATE', () => {
  const source = calendar(event(['RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE', 'EXDATE;TZID=America/New_York:20261102T090000']).replace('DTSTART:20261016T130000Z', 'DTSTART;TZID=America/New_York:20261028T090000').replace('DTEND:20261016T140000Z', 'DURATION:PT1H'));
  const items = parse(source).events;
  assert.deepEqual(items.map(item => new Date(item.startAt).toISOString()), ['2026-10-28T13:00:00.000Z', '2026-11-04T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
  assert.match(parse(source).warnings.join(' '), /Recurring events.*import window/);
});

test('daily and interval recurrence are bounded and UNTIL is inclusive', () => {
  const source = calendar(event(['RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261020T130000Z']));
  assert.deepEqual(parse(source).events.map(item => new Date(item.startAt).toISOString().slice(0, 10)), ['2026-10-16', '2026-10-18', '2026-10-20']);
  assert.equal(parse(calendar(event(['RRULE:FREQ=DAILY']))).events.length, 59);
  assert.equal(parse(calendar(event(['RRULE:FREQ=WEEKLY;INTERVAL=1000000']))).events.length, 1);
  const old = calendar(event(['RRULE:FREQ=DAILY;COUNT=2']).replaceAll('20261016', '20001016'));
  assert.equal(parse(old).events.length, 0);
});

test('weekly recurrence skips historical occurrences without resetting COUNT or interval', () => {
  const source = calendar(event(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10']).replaceAll('20261016T130000Z', '20260928T130000Z').replaceAll('20261016T140000Z', '20260928T140000Z'));
  assert.deepEqual(parse(source).events.map(item => new Date(item.startAt).toISOString().slice(0, 10)), ['2026-10-26', '2026-10-28', '2026-11-09', '2026-11-11', '2026-11-23', '2026-11-25']);
});

test('all-day recurrence preserves exclusive calendar-day ends across DST', () => {
  const source = calendar(event(['RRULE:FREQ=DAILY;COUNT=3']).replace('DTSTART:20261016T130000Z', 'DTSTART;VALUE=DATE:20261031').replace('DTEND:20261016T140000Z', 'DURATION:P1D'));
  const result = Calendar.parseICS(source, { ...options, timeZone: 'America/New_York' });
  assert.deepEqual(result.events.map(item => (item.endAt - item.startAt) / 3600000), [24, 25, 24]);
});

test('rejects unsupported recurrence, overrides, date formats, components and time zones atomically', () => {
  for (const extra of ['RRULE:FREQ=MONTHLY', 'RRULE:FREQ=WEEKLY;BYDAY=1MO', 'RRULE:FREQ=DAILY;BYHOUR=9', 'RRULE:FREQ=DAILY;COUNT=3;UNTIL=20261020T130000Z', 'RRULE:FREQ=DAILY;COUNT=0', 'RDATE:20261017T130000Z', 'RECURRENCE-ID:20261016T130000Z', 'EXRULE:FREQ=WEEKLY']) assert.throws(() => parse(calendar(event(), event([extra], 'unsupported'))), /recurrence|RDATE|RECURRENCE-ID|EXRULE/i);
  assert.throws(() => parse(calendar('BEGIN:VTODO\r\nUID:todo\r\nEND:VTODO')), /Unsupported calendar component/);
  assert.throws(() => parse(calendar(event().replace('DTSTART:20261016T130000Z', 'DTSTART;TZID=Not/AZone:20261016T130000'))), /Unsupported calendar time zone/);
  for (const invalid of ['20260230T130000Z', '20261016T250000Z', '20261016T130060Z', '00001016T130000Z', '2026-10-16T13:00:00Z']) assert.throws(() => parse(calendar(event().replace('20261016T130000Z', invalid))), /date|time/i);
});

test('recognizes standard zone metadata and makes separate alarm handling explicit', () => {
  const timezone = 'BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE';
  const source = calendar(timezone, event(['BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM']));
  const result = parse(source);
  assert.equal(result.events.length, 1);
  assert.match(result.warnings.join(' '), /standard time-zone rules/);
  assert.match(result.warnings.join(' '), /alarms are not imported/);
});

test('duplicate copies are deduplicated and conflicting UIDs reject the whole file', () => {
  assert.equal(parse(calendar(event(), event())).events.length, 1);
  assert.match(parse(calendar(event(), event())).warnings.join(' '), /duplicate/);
  assert.throws(() => parse(calendar(event(), event().replace('SUMMARY:Homework', 'SUMMARY:Another appointment'))), /Conflicting copies/);
  assert.throws(() => parse(calendar(event(['DTSTART:20261017T130000Z']))), /exactly one DTSTART/);
});

test('cancelled and past events are reported and input/output bounds are enforced', () => {
  const result = parse(calendar(event(['STATUS:CANCELLED']), event([], 'old').replaceAll('20261016', '20261001')));
  assert.equal(result.events.length, 0);
  assert.match(result.warnings.join(' '), /cancelled/);
  assert.match(result.warnings.join(' '), /outside/);
  assert.throws(() => parse('é'.repeat(524289)), /smaller than 1 MiB/);
  assert.throws(() => Calendar.parseICS(calendar(...Array.from({ length: 1001 }, (_, i) => event([], String(i)))), options), /more than 1,000/);
  assert.throws(() => Calendar.parseICS(calendar(event()), { ...options, horizonDays: 367 }), /horizon/);
});

test('malformed structure, parameters, zero/negative duration and reversed intervals reject', () => {
  for (const source of [calendar(event()).replace('END:VEVENT', 'END:VTIMEZONE'), calendar(event()).replace('VERSION:2.0', 'VERSION:1.0'), calendar(event()).replace('DTEND:20261016T140000Z', 'DTEND:20261016T120000Z'), calendar(event()).replace('DTEND:20261016T140000Z', 'DURATION:PT0M'), calendar(event()).replace('DTEND:20261016T140000Z', 'DURATION:-PT30M'), calendar(event()).replace('DTSTART:', 'DTSTART;VALUE=DATE;TZID=UTC:'), calendar(event()).replace('SUMMARY:Homework', 'SUMMARY:bad\u0000text')]) assert.throws(() => parse(source));
});

test('exports selected real task timing in UTC and round-trips safely without mutating tasks', () => {
  const tasks = [{ id: 'school', title: 'Homework, maths; reading\\books\nAt home', dueDate: '2026-10-16', dueTime: '17:00', type: 'task' }];
  const original = structuredClone(tasks);
  const result = Calendar.exportICS(tasks, { now: NOW });
  assert.match(result, /DTSTART:20261016T130000Z\r\nDTEND:20261016T133000Z/);
  assert.equal(result.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(parse(result).events[0].title, tasks[0].title);
  assert.deepEqual(tasks, original);
});

test('exports date-only tasks as exclusive all-day events and honors explicit duration', () => {
  const tasks = [{ id: 'all-day', title: 'School holiday', dueDate: '2026-10-16', dueTime: '' }, { id: 'timed', title: 'Study', dueDate: '2026-10-16', dueTime: '17:00', durationMinutes: 90 }];
  const result = Calendar.exportICS(tasks, { now: NOW });
  assert.match(result, /DTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261017/);
  assert.equal(parse(result).events.find(item => item.title === 'Study').endAt, Date.parse('2026-10-16T14:30:00Z'));
});

test('export escapes line injection and folds UTF-8 without breaking characters', () => {
  const title = '🥐'.repeat(60) + '\r\nBEGIN:VEVENT\r\nSUMMARY:injection';
  const result = Calendar.exportICS([{ id: 'safe\r\nBEGIN:VEVENT', title, dueDate: '2026-10-16', dueTime: '17:00' }], { now: NOW });
  assert.equal(result.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.ok(result.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.equal(parse(result).events.length, 1);
  assert.equal(parse(result).events[0].title, title.replaceAll('\r\n', '\n'));
});

test('export rejects unscheduled selections, invalid times, duplicate IDs and excessive duration', () => {
  const item = { id: 'a', title: 'Task', dueDate: '2026-10-16', dueTime: '17:00' };
  for (const selection of [[], [{ ...item, dueDate: '' }], [{ ...item, dueTime: '25:00' }], [item, item], [{ ...item, durationMinutes: -1 }], [{ ...item, startAt: NOW, endAt: NOW - 1 }]]) assert.throws(() => Calendar.exportICS(selection, { now: NOW }));
});
