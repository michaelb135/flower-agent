'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Core = require('../web/core.js');
const NOW = Date.parse('2026-10-12T12:00:00Z');

function task(state, overrides = {}) {
  return Core.createTask(state, { title: 'Call clinic', dueDate: '2026-10-12', ...overrides }, NOW);
}

test('classic browser script provides TidyCore without module support', () => {
  const sandbox = { URL, TextEncoder, Date, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.TidyCore.createTask, 'function');
  assert.equal(sandbox.TidyCore.defaults().settings.timezone, 'Asia/Dubai');
});

test('Dubai dates change at UTC 20:00 and due times use UTC+4', () => {
  assert.equal(Core.today(Date.parse('2026-10-11T19:59:59Z')), '2026-10-11');
  assert.equal(Core.today(Date.parse('2026-10-11T20:00:00Z')), '2026-10-12');
  assert.equal(Core.dueEpoch('2026-10-12', '09:00'), Date.parse('2026-10-12T05:00:00Z'));
  assert.equal(Core.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(Core.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(Core.addDays('2026-01-01', -1), '2025-12-31');
});

test('calendar dates, clock times and member assignments are validated before mutation', () => {
  const state = Core.defaults();
  for (const overrides of [
    { dueDate: '2026-02-30' }, { dueDate: '2025-02-29' }, { dueDate: '2026-13-01' },
    { dueTime: '24:00' }, { dueDate: '', dueTime: '09:00' },
    { repeat: 'weekly', dueDate: '' }, { assigneeId: 'stranger' }, { title: '   ' },
    { remindAt: NaN }, { quantity: 'x'.repeat(121) }, { category: 'Unknown' }
  ]) {
    assert.throws(() => task(state, overrides));
    assert.equal(state.tasks.length, 0);
  }
  const result = task(state, { title: '  Buy ketchup  ', type: 'grocery', category: 'Shopping', assigneeId: 'nanny', quantity: '1 bottle' });
  assert.equal(result.title, 'Buy ketchup');
  assert.equal(result.assigneeId, 'nanny');
  assert.equal(result.status, 'open');
});

test('new household names reject trimmed case-insensitive duplicates while legacy duplicate names stay readable', () => {
  const state = Core.defaults();
  const before = Core.backupJSON(state);
  for (const name of ['Mum', ' mum ', 'MUM']) {
    assert.throws(() => Core.createMember(state, { name }, NOW), /household name already exists/);
    assert.equal(Core.backupJSON(state), before);
  }
  const member = Core.createMember(state, { name: '  Grandma  ' }, NOW);
  assert.equal(member.name, 'Grandma');
  assert.equal(state.members.at(-1), member);
  const valid = Core.backupJSON(state);
  assert.throws(() => Core.createMember(state, { id: member.id, name: 'Uncle' }, NOW), /Duplicate member ID/);
  assert.equal(Core.backupJSON(state), valid);
  const legacy = { ...state, members: [...state.members, { id: 'legacy-mum', name: 'mUm' }] };
  const restored = Core.parseBackup(JSON.stringify(legacy));
  assert.equal(restored.members.filter(item => item.name.toLowerCase() === 'mum').length, 2);
  assert.equal(Core.backupJSON(restored), JSON.stringify(restored));
});

test('unrenderable reminder timestamps reject imports and edits before replacing recoverable data', () => {
  const state = Core.defaults();
  const item = task(state, { remindAt: 0, deliveredReminderAt: 0 });
  const before = Core.backupJSON(state);
  const minimum = Core.dueEpoch('0001-01-01', '00:00');
  const maximum = Core.dueEpoch('9999-12-31', '23:59') + 59999;
  for (const remindAt of [8640000000000000, -8640000000000000, minimum - 1, maximum + 1]) {
    assert.throws(() => Core.updateTask(state, item.id, { remindAt }, NOW), /Invalid reminder time/);
    assert.throws(() => task(state, { remindAt }), /Invalid reminder time/);
    const imported = JSON.parse(before);
    imported.tasks[0].remindAt = remindAt;
    assert.throws(() => Core.parseBackup(JSON.stringify(imported)), /Invalid reminder time/);
    assert.equal(Core.backupJSON(state), before);
  }
  assert.throws(() => Core.updateTask(state, item.id, { deliveredReminderAt: 8640000000000000 }, NOW), /Invalid delivered reminder time/);
  Core.updateTask(state, item.id, { remindAt: minimum }, NOW);
  assert.equal(item.remindAt, minimum);
  Core.updateTask(state, item.id, { remindAt: maximum }, NOW);
  assert.equal(item.remindAt, maximum);
});

test('links preserve HTTPS verification and exclude embedded credentials and executable schemes', () => {
  const state = Core.defaults();
  for (const value of ['http://example.com', 'javascript:alert(1)', 'data:text/html,bad', 'https://username:password@example.com', '//example.com']) {
    assert.throws(() => task(state, { link: value }));
  }
  assert.equal(task(state, { link: 'https://example.com/clinic' }).link, 'https://example.com/clinic');
});

test('edits clear obsolete reminders, can set a replacement, and leave existing data intact on failure', () => {
  const state = Core.defaults();
  const initial = task(state, { remindAt: NOW });
  Core.updateTask(state, initial.id, { title: 'Call a clinic', notes: 'Ask for available slots' }, NOW);
  assert.equal(initial.remindAt, NOW);
  Core.updateTask(state, initial.id, { dueDate: '2026-10-13' }, NOW);
  assert.equal(initial.remindAt, null);
  Core.updateTask(state, initial.id, { dueTime: '10:00', remindAt: NOW + 1000 }, NOW);
  assert.equal(initial.remindAt, NOW + 1000);
  const before = JSON.stringify(state);
  assert.throws(() => Core.updateTask(state, initial.id, { dueDate: '2026-02-30' }, NOW));
  assert.throws(() => Core.updateTask(state, initial.id, { status: 'done' }, NOW));
  assert.throws(() => Core.updateTask(state, initial.id, { id: 'replacement' }, NOW));
  assert.equal(JSON.stringify(state), before);
});

test('ordinary completion and reopening keep one task and reminders exclude completed tasks', () => {
  const state = Core.defaults();
  const item = task(state, { remindAt: NOW });
  Core.completeTask(state, item.id, NOW);
  assert.equal(item.completedAt, NOW);
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(Core.dueReminders(state, NOW), []);
  Core.reopenTask(state, item.id, NOW + 1);
  assert.equal(item.completedAt, null);
  assert.equal(Core.dueReminders(state, NOW + 1).length, 1);
});

test('daily recurrence advances overdue tasks beyond today and preserves reminder offsets', () => {
  const state = Core.defaults();
  const original = task(state, { dueDate: '2026-10-08', dueTime: '17:00', repeat: 'daily', remindAt: Core.dueEpoch('2026-10-08', '16:30') });
  Core.completeTask(state, original.id, NOW);
  const next = state.tasks.find(item => item.status === 'open');
  assert.equal(next.dueDate, '2026-10-13');
  assert.equal(next.remindAt, Core.dueEpoch('2026-10-13', '16:30'));
  assert.equal(next.seriesId, original.id);
  assert.equal(next.assigneeId, original.assigneeId);
  Core.completeTask(state, original.id, NOW);
  assert.equal(state.tasks.length, 2);
});

test('weekly recurrence advances from a future due date, weekdays skip Saturday and Sunday', () => {
  const weeklyState = Core.defaults();
  const weekly = task(weeklyState, { dueDate: '2026-10-20', repeat: 'weekly' });
  Core.completeTask(weeklyState, weekly.id, NOW);
  assert.equal(weeklyState.tasks[1].dueDate, '2026-10-27');
  const weekdayState = Core.defaults();
  const weekdays = task(weekdayState, { dueDate: '2026-10-16', repeat: 'weekdays' });
  Core.completeTask(weekdayState, weekdays.id, Date.parse('2026-10-16T12:00:00Z'));
  assert.equal(weekdayState.tasks[1].dueDate, '2026-10-19');
});

test('late weekly completion preserves the original weekday and skips missed occurrences', () => {
  const state = Core.defaults();
  const weekly = task(state, { dueDate: '2026-10-12', repeat: 'weekly' });
  Core.completeTask(state, weekly.id, Date.parse('2026-10-14T12:00:00Z'));
  assert.equal(state.tasks[1].dueDate, '2026-10-19');
  const older = task(state, { dueDate: '2026-09-28', repeat: 'weekly' });
  Core.completeTask(state, older.id, Date.parse('2026-10-26T12:00:00Z'));
  assert.equal(state.tasks[3].dueDate, '2026-11-02');
});

test('reopening and completing a recurring task does not duplicate its future occurrence', () => {
  const state = Core.defaults();
  const item = task(state, { repeat: 'daily' });
  Core.completeTask(state, item.id, NOW);
  Core.reopenTask(state, item.id, NOW);
  Core.completeTask(state, item.id, NOW);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks.filter(item => item.status === 'open').length, 1);
});

test('reopening an older recurring task on a later date reuses its existing open successor', () => {
  const state = Core.defaults();
  const item = task(state, { repeat: 'daily' });
  Core.completeTask(state, item.id, NOW);
  Core.reopenTask(state, item.id, NOW + 86400000);
  Core.completeTask(state, item.id, NOW + 86400000);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[1].dueDate, '2026-10-13');
  Core.completeTask(state, state.tasks[1].id, NOW + 86400000);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[2].dueDate, '2026-10-14');
});

test('stopping a routine preserves its history and prevents historical reopening from restarting it', () => {
  const state = Core.defaults();
  const original = task(state, { repeat: 'daily' });
  const unrelated = task(state, { title: 'Other routine', repeat: 'weekly' });
  Core.completeTask(state, original.id, NOW);
  const upcoming = state.tasks.find(item => item.seriesId === original.id && item.status === 'open');
  const dates = state.tasks.map(item => item.dueDate);
  Core.stopRepeating(state, upcoming.id);
  assert.equal(original.repeat, 'none');
  assert.equal(original.status, 'done');
  assert.equal(upcoming.repeat, 'none');
  assert.equal(upcoming.status, 'open');
  assert.equal(unrelated.repeat, 'weekly');
  assert.deepEqual(state.tasks.map(item => item.dueDate), dates);
  Core.completeTask(state, upcoming.id, NOW + 86400000);
  const restored = Core.parseBackup(Core.backupJSON(state));
  Core.reopenTask(restored, original.id, NOW + 2 * 86400000);
  Core.completeTask(restored, original.id, NOW + 2 * 86400000);
  assert.equal(restored.tasks.length, 3);
  assert.equal(restored.tasks.filter(item => item.seriesId === original.id && item.status === 'open').length, 0);
  assert.throws(() => Core.stopRepeating(restored, 'missing'), /Task not found/);
});

test('due reminders are ordered, exclude future tasks and support pausing', () => {
  const state = Core.defaults();
  const second = task(state, { remindAt: NOW - 1 });
  const first = task(state, { remindAt: NOW - 100 });
  task(state, { remindAt: NOW + 1 });
  task(state);
  assert.deepEqual(Core.dueReminders(state, NOW).map(item => item.id), [first.id, second.id]);
  state.settings.remindersPaused = true;
  assert.deepEqual(Core.dueReminders(state, NOW), []);
  assert.equal(state.tasks.length, 4);
});

test('delivered reminders stay suppressed after reload and reminder edits reset delivery', () => {
  const state = Core.defaults();
  const item = task(state, { remindAt: NOW - 1 });
  Core.updateTask(state, item.id, { deliveredReminderAt: item.remindAt }, NOW);
  assert.deepEqual(Core.dueReminders(state, NOW), []);
  const restored = Core.parseBackup(Core.backupJSON(state));
  assert.deepEqual(Core.dueReminders(restored, NOW), []);
  Core.updateTask(state, item.id, { remindAt: NOW }, NOW);
  assert.equal(item.deliveredReminderAt, null);
  assert.equal(Core.dueReminders(state, NOW).length, 1);
  Core.updateTask(state, item.id, { deliveredReminderAt: NOW }, NOW);
  Core.updateTask(state, item.id, { dueDate: '2026-10-13' }, NOW);
  assert.equal(item.remindAt, null);
  assert.equal(item.deliveredReminderAt, null);
});

test('next recurring occurrence starts with an undelivered reminder', () => {
  const state = Core.defaults();
  const item = task(state, { repeat: 'daily', remindAt: NOW - 1, deliveredReminderAt: NOW - 1 });
  Core.completeTask(state, item.id, NOW);
  assert.equal(state.tasks[1].deliveredReminderAt, null);
});

test('backup roundtrip preserves tasks, assignments, settings, bounded meal data and local action status', () => {
  const state = Core.defaults();
  task(state, { assigneeId: 'dad', notes: 'Check opening hours', remindAt: NOW + 1000 });
  state.settings.checkinEnabled = true;
  state.settings.checkinTime = '18:00';
  state.settings.checkinLastDate = '2026-10-12';
  state.mealSnapshot = { preferences: { avoid: ['beans'] }, menu: ['Chicken and rice', 'Chicken pasta'] };
  state.mealSummary = [{ day: 'Monday', name: 'Chicken and rice' }];
  state.actions.push({ id: 'draft-1', kind: 'purchase', title: 'Review groceries', details: 'One bottle of ketchup; review price and delivery first.', provider: 'Carrefour', link: 'https://www.carrefouruae.com/', status: 'approved_draft', createdAt: NOW });
  const result = Core.parseBackup(Core.backupJSON(state));
  assert.deepEqual(result, state);
  assert.notEqual(result, state);
  result.mealSnapshot.menu[0] = 'Different';
  assert.equal(state.mealSnapshot.menu[0], 'Chicken and rice');
  assert.equal(result.actions[0].status, 'approved_draft');
});

test('imports reject invalid records atomically, duplicated IDs and unsupported versions', () => {
  const existing = Core.defaults();
  task(existing);
  const before = Core.backupJSON(existing);
  const bad = JSON.parse(before);
  bad.tasks.push({ ...bad.tasks[0], id: 'bad', dueDate: '2026-02-30' });
  assert.throws(() => Core.parseBackup(JSON.stringify(bad)));
  assert.equal(Core.backupJSON(existing), before);
  bad.tasks = [{ ...existing.tasks[0] }, { ...existing.tasks[0] }];
  assert.throws(() => Core.validateSnapshot(bad), /Duplicate/);
  bad.tasks = [];
  bad.schemaVersion = 2;
  assert.throws(() => Core.validateSnapshot(bad), /version/);
  assert.throws(() => Core.parseBackup('{bad json'));
});

test('imports sanitize unknown fields and reject misleading external action success', () => {
  const state = Core.defaults();
  task(state);
  state.tasks[0].credential = 'do not retain';
  state.secret = 'do not retain';
  const cleaned = Core.validateSnapshot(state);
  assert.equal('secret' in cleaned, false);
  assert.equal('credential' in cleaned.tasks[0], false);
  state.actions.push({ id: 'order-1', kind: 'purchase', title: 'Groceries', status: 'ordered', createdAt: NOW });
  assert.throws(() => Core.validateSnapshot(state), /action status/);
});

test('oversized or unsafe meal data and backups are rejected', () => {
  assert.throws(() => Core.parseBackup(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
  const state = Core.defaults();
  state.mealSnapshot = { data: 'a'.repeat(256 * 1024 + 1) };
  assert.throws(() => Core.validateSnapshot(state), /Meal/);
  state.mealSnapshot = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => Core.validateSnapshot(state), /key/);
  assert.equal({}.polluted, undefined);
  const cyclic = {};
  cyclic.self = cyclic;
  state.mealSnapshot = cyclic;
  assert.throws(() => Core.validateSnapshot(state), /cycles/);
  state.mealSnapshot = null;
  state.mealSummary = Array.from({ length: 6 }, () => ({ day: 'Monday', name: 'Chicken' }));
  assert.throws(() => Core.validateSnapshot(state), /5 items/);
});

test('persistence survives a reload and surfaces quota, access and corrupt-data failures', () => {
  const values = new Map();
  const storage = { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value) };
  assert.equal(Core.load(storage), null);
  const state = Core.defaults();
  task(state, { assigneeId: 'mum' });
  assert.equal(Core.persist(storage, state), true);
  assert.deepEqual(Core.load(storage), state);
  const before = values.get('tidy.app.v1');
  assert.throws(() => Core.persist({ setItem() { throw Error('QuotaExceededError'); } }, state), /could not save/);
  assert.equal(values.get('tidy.app.v1'), before);
  assert.throws(() => Core.load({ getItem() { throw Error('Access denied'); } }), /could not read/);
  values.set('tidy.app.v1', '{broken');
  assert.throws(() => Core.load(storage), /not valid JSON/);
  assert.throws(() => Core.persist(null, state), /unavailable/);
});

test('a valid near-limit imported backup can be saved and exported without formatting expansion', () => {
  const state = Core.defaults();
  for (let index = 0; index < 117; index++) task(state, { id: 'large-' + index, notes: 'a'.repeat(8500) });
  const backup = Core.backupJSON(state);
  assert.ok(Buffer.byteLength(backup) < 1024 * 1024);
  const imported = Core.parseBackup(backup);
  let saved;
  Core.persist({ setItem(key, text) { saved = text; } }, imported);
  assert.equal(saved, backup);
  assert.equal(Core.backupJSON(imported), backup);
});

test('oversized additions, edits and recurring successors reject before mutating recoverable data', () => {
  const state = Core.defaults();
  for (let index = 0; index < 119; index++) task(state, {
    id: 'near-limit-' + index, title: 'Saved responsibility ' + index, notes: 'a'.repeat(8500),
    dueDate: index === 0 ? '2026-10-12' : '', repeat: index === 0 ? 'daily' : 'none'
  });
  const before = Core.backupJSON(state);
  const retained = state.tasks[0];
  const retainedArray = state.tasks;
  assert.throws(() => task(state, { title: 'New responsibility', notes: 'b'.repeat(10000) }), /1 MiB/);
  assert.equal(Core.backupJSON(state), before);
  assert.throws(() => Core.updateTask(state, retained.id, { notes: 'b'.repeat(10000) }, NOW), /1 MiB/);
  assert.equal(Core.backupJSON(state), before);
  assert.throws(() => Core.completeTask(state, retained.id, NOW), /1 MiB/);
  assert.equal(Core.backupJSON(state), before);
  assert.equal(retained.status, 'open');
  assert.equal(retained.seriesId, undefined);
  assert.equal(state.tasks[0], retained);
  assert.equal(state.tasks, retainedArray);
  // This state remains small enough to export or save after all rejected edits.
  const storage = new Map();
  Core.persist({ setItem(key, text) { storage.set(key, text); } }, state);
  assert.equal(storage.get('tidy.app.v1'), before);
});

test('deleting a task removes only that task', () => {
  const state = Core.defaults();
  const first = task(state);
  const second = task(state);
  Core.deleteTask(state, first.id);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, second.id);
  assert.throws(() => Core.deleteTask(state, first.id), /not found/);
});

test('conditional persistence rejects a changed stored snapshot without overwriting either version', () => {
  const local = Core.defaults();
  const remote = Core.defaults();
  Core.createTask(local, { title: 'Local responsibility' });
  Core.createTask(remote, { title: 'Other tab responsibility' });
  const original = Core.backupJSON(Core.defaults());
  let stored = original;
  let writes = 0;
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; writes++; } };
  stored = Core.backupJSON(remote);
  assert.throws(() => Core.persistIfUnchanged(storage, local, original), error => error.code === 'TIDY_STORAGE_CONFLICT');
  assert.equal(writes, 0);
  assert.equal(Core.parseBackup(stored).tasks[0].title, 'Other tab responsibility');
  assert.equal(local.tasks[0].title, 'Local responsibility');
  const written = Core.persistIfUnchanged(storage, local, stored);
  assert.equal(writes, 1);
  assert.equal(written, stored);
  assert.equal(Core.parseBackup(stored).tasks[0].title, 'Local responsibility');
});
