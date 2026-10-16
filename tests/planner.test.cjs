'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/planner.js');
const at = text => Date.parse(text + '+04:00');
const monday = at('2026-10-12T12:00:00');
const profile = () => ({ ...P.defaults(), enabled: true });
const family = (extra = {}) => ({ title: 'Do work with the kids', category: 'School', type: 'task', dueDate: '', dueTime: '', remindAt: null, ...extra });
const event = (start, end, extra = {}) => ({ startAt: at(start), endAt: at(end), ...extra });
const plan = (draft = family(), extra = {}) => P.proposeTask(draft, { now: monday, profile: profile(), tasks: [], events: [], ...extra });

test('example routine is unconfirmed until enabled and module does not share default arrays', () => {
  assert.equal(plan(family(), { profile: P.defaults() }).code, 'routine_not_confirmed');
  const first = P.defaults(); first.workDays.push(0);
  assert.deepEqual(P.defaults().workDays, [1, 2, 3, 4, 5]);
  first.schoolDays.push(6);
  assert.deepEqual(P.defaults().schoolDays, [1, 2, 3, 4, 5]);
  assert.equal(plan(family(), { profile: { ...profile(), workEnd: '7' } }).code, 'invalid_profile');
  assert.equal(plan(family(), { profile: { ...profile(), dayEnd: '06:30' } }).code, 'invalid_profile');
});

test('weekday kids work gets a concrete slot after both work and school', () => {
  const result = plan();
  assert.equal(result.ok, true);
  assert.deepEqual([result.date, result.time, result.endTime, result.durationMinutes], ['2026-10-12', '17:00', '17:45', 45]);
  assert.match(result.reason, /work finishes.*children are home/);
  assert.equal(plan(family(), { profile: { ...profile(), kidsHome: '18:00' } }).time, '18:00');
  assert.equal(plan({ title: 'Help the children study', category: 'Home' }).time, '17:00');
  assert.equal(P.isFamilyTask({ title: 'Prepare work report', category: 'Work' }), false);
});

test('school availability uses separately confirmed schooldays and workdays', () => {
  const saturday = plan(family(), { now: at('2026-10-17T08:00:00') });
  assert.deepEqual([saturday.date, saturday.time], ['2026-10-17', '08:00']);
  const sunday = plan(family(), { now: at('2026-10-18T08:00:00'), profile: { ...profile(), workDays: [0, 1, 2, 3, 4] } });
  assert.equal(sunday.time, '17:00');
  assert.match(sunday.reason, /work finishes.*without school/);
  assert.match(saturday.reason, /day off from work and school/);
});

test('parent day off still waits for children on schooldays while a working weekend waits for work', () => {
  const friday = plan(family({ dueDate: '2026-10-16' }), {
    now: at('2026-10-16T08:00:00'),
    profile: { ...profile(), workDays: [1, 2, 3, 4], schoolDays: [1, 2, 3, 4, 5] }
  });
  assert.equal(friday.time, '15:00');
  assert.match(friday.reason, /children are home from school.*day off work/);
  const workingSaturday = plan(family({ dueDate: '2026-10-17' }), {
    now: at('2026-10-17T08:00:00'),
    profile: { ...profile(), workDays: [1, 2, 3, 4, 6], schoolDays: [1, 2, 3, 4, 5], kidsHome: '19:00' }
  });
  assert.equal(workingSaturday.time, '17:00', 'school return does not apply on a non-school Saturday');
  assert.match(workingSaturday.reason, /work finishes.*without school/);
  const bothOff = plan(family({ dueDate: '2026-10-18' }), { now: at('2026-10-18T06:00:00') });
  assert.equal(bothOff.time, '07:00');
});

test('legacy omitted schooldays follow confirmed workdays and invalid school lists are rejected', () => {
  const legacy = { ...profile(), workDays: [0, 1, 2, 3, 4], kidsHome: '18:00' };
  delete legacy.schoolDays;
  const sunday = plan(family(), { now: at('2026-10-18T08:00:00'), profile: legacy });
  assert.equal(sunday.time, '18:00');
  assert.equal(plan(family(), { profile: { ...profile(), schoolDays: [1, 1] } }).code, 'invalid_profile');
  assert.equal(plan(family(), { profile: { ...profile(), schoolDays: [7] } }).code, 'invalid_profile');
  assert.equal(plan(family(), { profile: { ...profile(), schoolDays: 'weekdays' } }).code, 'invalid_profile');
});

test('work tasks stay within work hours while household tasks avoid them', () => {
  const work = plan({ title: 'Prepare report', category: 'Work' });
  const home = plan({ title: 'Wash clothes', category: 'Home' });
  assert.equal(work.time, '12:00');
  assert.equal(home.time, '17:00');
  assert.equal(plan({ title: 'Prepare report', category: 'Work', dueDate: '2026-10-17' }).code, 'no_fit');
  const nextWorkday = plan({ title: 'Prepare report', category: 'Work' }, { now: at('2026-10-17T12:00:00') });
  assert.deepEqual([nextWorkday.date, nextWorkday.time], ['2026-10-19', '08:00']);
});

test('gym and calendar commitments on Tuesday and Thursday receive full duration and buffer checks', () => {
  for (const date of ['2026-10-13', '2026-10-15']) {
    const result = plan(family({ dueDate: date }), {
      now: at(date + 'T16:00:00'),
      events: [event(date + 'T17:00:00', date + 'T18:00:00')]
    });
    assert.deepEqual([result.date, result.time, result.endTime], [date, '18:15', '19:00']);
  }
  const overlapBeforeEvent = plan(family(), { events: [event('2026-10-12T17:30:00', '2026-10-12T18:30:00')] });
  assert.equal(overlapBeforeEvent.time, '18:45', 'a 17:00 start would overlap the middle of an event');
});

test('busy intervals may touch exactly at their configured buffer boundary', () => {
  const before = plan(family(), { events: [event('2026-10-12T18:00:00', '2026-10-12T19:00:00')] });
  assert.equal(before.time, '17:00');
  const after = plan(family(), { events: [event('2026-10-12T16:30:00', '2026-10-12T17:00:00')] });
  assert.equal(after.time, '17:15');
  const noBuffer = plan(family(), { profile: { ...profile(), bufferMinutes: 0 }, events: [event('2026-10-12T16:30:00', '2026-10-12T17:00:00')] });
  assert.equal(noBuffer.time, '17:00');
});

test('overnight repeating commitments from yesterday block morning tasks and preserve fixed conflicts', () => {
  const context = { now: at('2026-10-13T00:30:00'), profile: { ...profile(), workDays: [0,1,2,3,4,5,6], schoolDays: [], workStart: '00:00', workEnd: '08:00', dayStart: '00:00', dayEnd: '08:00' }, tasks: [{ id: 'night', title: 'Overnight work', dueDate: '2026-10-12', dueTime: '22:00', durationMinutes: 480, repeat: 'daily', status: 'open' }] };
  const result = plan({ title: 'Prepare report', category: 'Work', dueDate: '2026-10-13' }, context);
  assert.equal(result.time, '06:15');
  assert.equal(plan({ title: 'Fixed report', category: 'Work', dueDate: '2026-10-13', dueTime: '00:30' }, context).code, 'fixed_conflict');
});

test('tomorrow recurring commitments reserve their buffer before midnight on the selected day', () => {
  const result = plan({ title: 'Prepare report', category: 'Work', dueDate: '2026-10-12' }, { now: at('2026-10-12T23:00:00'), profile: { ...profile(), workDays: [0,1,2,3,4,5,6], workStart: '00:00', workEnd: '23:59', dayStart: '00:00', dayEnd: '23:59', bufferMinutes: 60 }, tasks: [{ id: 'early', title: 'Early work', dueDate: '2026-10-13', dueTime: '00:15', repeat: 'daily', status: 'open' }] });
  assert.equal(result.code, 'no_fit');
});

test('repeated calls reserve newly saved task duration and recurring responsibilities', () => {
  const first = plan();
  const task = { id: 'homework', status: 'open', dueDate: first.date, dueTime: first.time, durationMinutes: first.durationMinutes };
  const second = plan(family(), { tasks: [task] });
  assert.equal(second.time, '18:00');
  const recurring = plan(family({ dueDate: '2026-10-14' }), { tasks: [{ ...task, dueDate: '2026-10-05', repeat: 'weekdays' }] });
  assert.equal(recurring.time, '18:00');
  assert.equal(plan(family(), { tasks: [{ ...task, status: 'done' }] }).time, '17:00');
  assert.equal(plan(family({ id: task.id }), { tasks: [task] }).time, '17:00', 'editing the same task does not conflict with itself');
});

test('all-day imported ranges block a whole day with an exclusive end', () => {
  const result = plan(family(), { events: [{ allDay: true, startDate: '2026-10-12', endDate: '2026-10-14' }] });
  assert.deepEqual([result.date, result.time], ['2026-10-14', '17:00']);
  const absolute = plan(family(), { events: [event('2026-10-12T00:00:00', '2026-10-13T00:00:00', { allDay: true })] });
  assert.equal(absolute.date, '2026-10-13');
  assert.equal(plan(family({ dueDate: '2026-10-12' }), { events: [{ allDay: true, startDate: '2026-10-12', endDate: '2026-10-13' }] }).code, 'no_fit');
});

test('fully busy seven days reports no fit and never invents an eighth-day slot', () => {
  const result = plan(family(), { events: [event('2026-10-12T00:00:00', '2026-10-19T00:00:00')] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_fit');
  assert.equal(result.conflict, true);
  assert.match(result.reason, /next seven days/);
  assert.equal(result.date, undefined);
});

test('dated tasks stay on that date and outside-horizon or past dates require review', () => {
  assert.equal(plan(family({ dueDate: '2026-10-13' })).date, '2026-10-13');
  assert.equal(plan(family({ dueDate: '2026-10-19' })).code, 'outside_horizon');
  assert.equal(plan(family({ dueDate: '2026-10-11' })).code, 'past_date');
  assert.equal(plan(family({ dueDate: '2026-02-30' })).code, 'needs_date');
  assert.equal(plan(family({ dueDate: '2026-10-12', durationMinutes: 240 }), { now: at('2026-10-12T19:00:00') }).code, 'no_fit');
});

test('explicit appointment and reminder times are never guessed or moved', () => {
  assert.equal(plan(family({ dueTime: '18:00' })).code, 'needs_date');
  assert.equal(plan(family({ dueTime: '6', dueDate: '2026-10-12' })).code, 'needs_time');
  assert.equal(plan(family({ type: 'appointment' })).code, 'needs_time');
  assert.equal(plan(family({ remindAt: at('2026-10-12T18:00:00') })).code, 'needs_time');
  const chosen = family({ dueDate: '2026-10-12', dueTime: '14:00', type: 'appointment' });
  assert.equal(plan(chosen).time, '14:00', 'the user may explicitly choose a time outside routine hours');
  const conflicting = plan(chosen, { events: [event('2026-10-12T14:15:00', '2026-10-12T15:00:00')] });
  assert.equal(conflicting.code, 'fixed_conflict');
  assert.equal(chosen.dueTime, '14:00');
  assert.equal(plan(family({ dueDate: '2026-10-12', dueTime: '11:00' })).code, 'past_time');
});

test('Dubai date rollover, minute rounding and day end prevent past or overnight suggestions', () => {
  const afterDubaiMidnight = plan(family(), { now: Date.parse('2026-10-16T21:02:04Z') });
  assert.deepEqual([afterDubaiMidnight.date, afterDubaiMidnight.time], ['2026-10-17', '07:00']);
  const rounded = plan(family(), { now: at('2026-10-12T17:03:47') });
  assert.equal(rounded.time, '17:05');
  const late = plan(family({ dueDate: '2026-10-12' }), { now: at('2026-10-12T20:00:00') });
  assert.equal(late.code, 'no_fit');
  assert.equal(plan(family({ dueDate: '2026-10-12', dueTime: '23:45' })).code, 'day_boundary');
});

test('malformed busy data blocks unsafe suggestions while cancelled and transparent events do not', () => {
  for (const events of [null, [{}], [{ startAt: 1, endAt: 0 }], [{ startAt: '2026-02-30T17:00:00+04:00', endAt: '2026-03-01T17:00:00+04:00' }]]) {
    assert.equal(plan(family(), { events }).code, 'invalid_busy_data');
  }
  assert.equal(plan(family(), { tasks: [{ status: 'open', dueDate: '2026-10-12', dueTime: 'wrong' }] }).code, 'invalid_busy_data');
  assert.equal(plan(family(), { events: [event('2026-10-12T17:00:00', '2026-10-12T18:00:00', { cancelled: true })] }).time, '17:00');
  assert.equal(plan(family(), { events: [event('2026-10-12T17:00:00', '2026-10-12T18:00:00', { transparent: true })] }).time, '17:00');
  assert.equal(plan(family(), { tasks: [{ status: 'open', remindAt: at('2026-10-12T17:00:00') }] }).time, '17:45');
});

test('planning is deterministic, does not mutate frozen inputs, and rejects hostile objects', () => {
  const draft = Object.freeze(family());
  const routine = Object.freeze({ ...profile(), workDays: Object.freeze([1, 2, 3, 4, 5]) });
  const events = Object.freeze([Object.freeze(event('2026-10-12T17:00:00', '2026-10-12T18:00:00'))]);
  const context = Object.freeze({ now: monday, profile: routine, tasks: Object.freeze([]), events });
  assert.deepEqual(P.proposeTask(draft, context), P.proposeTask(draft, context));
  assert.equal(events[0].endAt, at('2026-10-12T18:00:00'));
  let reads = 0;
  const hostile = { get title() { reads++; throw new Error('do not execute'); } };
  assert.equal(P.proposeTask(hostile, context).code, 'invalid_input');
  assert.equal(reads, 0);
  assert.equal(P.proposeTask(Object.create({ title: 'prototype data' }), context).code, 'invalid_input');
  assert.equal(plan(family({ durationMinutes: 481 })).code, 'invalid_duration');
});
