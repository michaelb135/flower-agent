'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Core = require('../web/core.js');
const MenuHelper = require('../web/menu-helper.js');
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

test('browser core keeps legacy data readable and refuses to discard menu data when its helper is unavailable', () => {
  const sandbox = { URL, TextEncoder, Date, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), sandbox);
  const state = sandbox.TidyCore.defaults();
  assert.equal(Object.hasOwn(sandbox.TidyCore.parseBackup(sandbox.TidyCore.backupJSON(state)), 'menuHelper'), false);
  state.menuHelper = { version: 1, people: 4, preferences: [], draft: null };
  assert.throws(() => sandbox.TidyCore.backupJSON(state), /Menu helper is unavailable/);
});

test('classic browser scripts validate optional menu data with the shared recipe model loaded first', () => {
  const sandbox = { URL, TextEncoder, Date, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/menu-helper.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), sandbox);
  const result = vm.runInNewContext(`
    const menuState = TidyCore.defaults();
    const prepared = TidyMenuHelper.createDraft('tomato pasta', { now: ${NOW}, id: 'browser-menu' });
    menuState.menuHelper = { ...TidyMenuHelper.emptyState(), draft: prepared.draft };
    JSON.stringify(TidyCore.parseBackup(TidyCore.backupJSON(menuState)).menuHelper);
  `, sandbox);
  const restored = JSON.parse(result);
  assert.equal(restored.draft.recipeId, 'tomato-pasta');
  assert.equal(restored.draft.items[0].amount, 360);
  assert.equal(restored.draft.status, 'draft');
});

test('browser core preserves old backups without history and refuses to discard history when its helper is missing', () => {
  const sandbox = { URL, TextEncoder, Date, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), sandbox);
  const state = sandbox.TidyCore.defaults();
  const original = sandbox.TidyCore.backupJSON(state);
  assert.equal(Object.hasOwn(sandbox.TidyCore.parseBackup(original), 'activityHistory'), false);
  assert.equal(sandbox.TidyCore.backupJSON(sandbox.TidyCore.parseBackup(original)), original);
  state.activityHistory = { version: 1, entries: [], olderCount: 0 };
  assert.throws(() => sandbox.TidyCore.backupJSON(state), /Activity history is unavailable/);
  assert.equal(sandbox.TidyCore.backupJSON(sandbox.TidyCore.defaults()), original);
});

test('classic browser scripts validate and restore activity history with the shared history model loaded first', () => {
  const sandbox = { URL, TextEncoder, Date, Math };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/history.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), sandbox);
  const result = vm.runInNewContext(`
    const historyState = TidyCore.defaults();
    historyState.activityHistory = { version: 1, entries: [{ id: 'browser-history', at: ${NOW}, section: 'Tasks', title: 'Added school homework', route: 'family' }], olderCount: 0 };
    JSON.stringify(TidyCore.parseBackup(TidyCore.backupJSON(historyState)).activityHistory);
  `, sandbox);
  assert.deepEqual(JSON.parse(result), { version: 1, entries: [{ id: 'browser-history', at: NOW, section: 'Tasks', title: 'Added school homework', details: '', route: 'family' }], olderCount: 0 });
});

function historyFixture() {
  return {
    version: 1, olderCount: 12,
    entries: [
      { id: 'history-1', at: NOW, section: 'Tasks', title: 'Added school homework', details: 'Assigned to Mum', route: 'family' },
      { id: 'history-2', at: NOW + 1, section: 'Groceries', title: 'Completed ketchup', details: 'Marked completed in Tidy; no purchase verified.', route: 'shopping' },
      { id: 'history-3', at: NOW + 2, section: 'Menu', title: 'Approved meal grocery draft', details: 'No order placed.', route: 'meals' }
    ]
  };
}

test('activity history round-trips with saved responsibilities and is copied independently for backups and persistence', () => {
  const state = Core.defaults();
  task(state, { title: 'School homework', assigneeId: 'mum', notes: 'Keep the actual task notes' });
  state.activityHistory = historyFixture();
  const before = Core.backupJSON(state);
  const restored = Core.parseBackup(before);
  assert.deepEqual(restored.activityHistory, state.activityHistory);
  assert.deepEqual(restored.tasks, state.tasks);
  let saved = null;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  Core.persistIfUnchanged(storage, restored, null);
  assert.equal(saved, before);
  const loaded = Core.load(storage);
  assert.deepEqual(loaded.activityHistory, state.activityHistory);
  loaded.activityHistory.entries[0].title = 'Independent restored title';
  assert.equal(state.activityHistory.entries[0].title, 'Added school homework');
  assert.equal(Core.backupJSON(restored), before);
  assert.equal(Core.parseBackup(saved).activityHistory.olderCount, 12);
});

test('invalid activity history cannot replace valid saved data or silently become an empty log', () => {
  const state = Core.defaults();
  task(state, { title: 'Keep this saved responsibility' });
  state.activityHistory = historyFixture();
  const before = Core.backupJSON(state);
  let saved = before, writes = 0;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; writes++; } };
  const changedHistory = patch => ({ ...historyFixture(), ...patch });
  const changedEntry = patch => changedHistory({ entries: [{ ...historyFixture().entries[0], ...patch }] });
  const invalid = [
    null, [], changedHistory({ version: 2 }), changedHistory({ olderCount: -1 }), changedHistory({ olderCount: 1.5 }),
    changedHistory({ entries: Array.from({ length: 501 }, (_, index) => ({ ...historyFixture().entries[0], id: 'too-many-' + index })) }),
    changedHistory({ entries: [historyFixture().entries[0], historyFixture().entries[0]] }),
    changedEntry({ id: '' }), changedEntry({ at: -1 }), changedEntry({ at: 1.5 }), changedEntry({ at: Number.MAX_SAFE_INTEGER }),
    changedEntry({ section: 'Retailer purchase confirmed' }), changedEntry({ route: 'https://example.invalid/' }),
    changedEntry({ route: 'javascript:alert(1)' }), changedEntry({ route: 'unknown-view' }),
    changedEntry({ title: '' }), changedEntry({ title: 'x'.repeat(361) }), changedEntry({ details: 'x'.repeat(501) })
  ];
  for (const history of invalid) {
    const candidate = { ...state, activityHistory: history };
    assert.throws(() => Core.validateSnapshot(candidate));
    assert.throws(() => Core.parseBackup(JSON.stringify(candidate)));
    assert.throws(() => Core.persistIfUnchanged(storage, candidate, before));
    assert.equal(saved, before);
    assert.equal(writes, 0);
    assert.equal(Core.backupJSON(state), before);
  }
});

function historyBudgetFixture(headroom = 12000) {
  const state = Core.defaults();
  const template = task(state, { id: 'budget-template', title: 'Existing responsibility', notes: 'a'.repeat(8000) });
  state.tasks = Array.from({ length: 119 }, (_, index) => ({ ...template, id: 'budget-' + index }));
  let remaining = 1024 * 1024 - headroom - Buffer.byteLength(Core.backupJSON(state));
  assert.ok(remaining >= 0);
  for (const item of state.tasks) {
    const extra = Math.min(10000 - item.notes.length, remaining);
    item.notes += 'b'.repeat(extra);
    remaining -= extra;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(Core.backupJSON(state)), 1024 * 1024 - headroom);
  state.activityHistory = {
    version: 1, olderCount: 7,
    entries: Array.from({ length: 20 }, (_, index) => ({ id: 'budget-history-' + index, at: NOW + index,
      section: 'Tasks', title: 'An older task change', details: 'c'.repeat(300), route: 'family' }))
  };
  return state;
}

test('business edits reclaim the oldest optional history while preserving all responsibilities and recent events', () => {
  const state = historyBudgetFixture();
  const previous = Core.parseBackup(Core.backupJSON(state));
  const existing = state.tasks[0], existingTasks = state.tasks;
  const created = task(state, { id: 'important-new-task', title: 'New school responsibility', notes: 'd'.repeat(8000) });
  assert.equal(state.tasks.length, 120);
  assert.equal(state.tasks.at(-1), created);
  assert.equal(state.tasks, existingTasks);
  assert.equal(state.tasks[0], existing);
  assert.deepEqual(state.tasks.slice(0, 119), previous.tasks);
  assert.ok(state.activityHistory.entries.length > 0 && state.activityHistory.entries.length < 20);
  const removed = 20 - state.activityHistory.entries.length;
  assert.deepEqual(state.activityHistory.entries, previous.activityHistory.entries.slice(removed));
  assert.equal(state.activityHistory.olderCount, 7 + removed);
  assert.ok(Buffer.byteLength(Core.backupJSON(state)) <= 1024 * 1024);
  const beforeFailure = Core.backupJSON(state);
  assert.throws(() => Core.updateTask(state, existing.id, { dueDate: '2026-02-30', notes: 'e'.repeat(10000) }, NOW));
  assert.equal(Core.backupJSON(state), beforeFailure);
  assert.throws(() => task(state, { id: 'cannot-fit-business', notes: 'f'.repeat(10000) }), /1 MiB/);
  assert.equal(Core.backupJSON(state), beforeFailure);
});

test('working-change history fitting is explicit and never weakens strict backup imports', () => {
  const oversized = historyBudgetFixture(2000);
  const original = JSON.stringify(oversized);
  assert.ok(Buffer.byteLength(original) > 1024 * 1024);
  assert.throws(() => Core.validateSnapshot(oversized), /1 MiB/);
  assert.throws(() => Core.parseBackup(original), /1 MiB/);
  const fitted = Core.validateChangeSnapshot(oversized);
  assert.deepEqual(fitted.tasks, oversized.tasks);
  assert.equal(JSON.stringify(oversized), original);
  assert.ok(fitted.activityHistory.entries.length < oversized.activityHistory.entries.length);
  assert.equal(fitted.activityHistory.olderCount, 7 + 20 - fitted.activityHistory.entries.length);
  const validBackup = Core.backupJSON(fitted);
  assert.ok(Buffer.byteLength(validBackup) <= 1024 * 1024);
  assert.deepEqual(Core.parseBackup(validBackup), fitted);
  const businessOnly = { ...oversized };
  delete businessOnly.activityHistory;
  assert.equal(Object.hasOwn(Core.validateChangeSnapshot(businessOnly), 'activityHistory'), false);
});

test('history metadata that cannot fit has a distinct recoverable failure instead of discarding business data or history', () => {
  const state = historyBudgetFixture(20);
  const original = JSON.stringify(state);
  assert.throws(() => Core.validateChangeSnapshot(state), error => error.code === 'TIDY_HISTORY_FULL');
  assert.equal(JSON.stringify(state), original);
  const business = { ...state };
  delete business.activityHistory;
  const backup = Core.backupJSON(business);
  assert.equal(Buffer.byteLength(backup), 1024 * 1024 - 20);
  assert.equal(Core.backupJSON(Core.validateChangeSnapshot(business)), backup);
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

test('older backups load with no Health Square website configured', () => {
  const legacy = Core.defaults();
  delete legacy.settings.healthSquareUrl;
  task(legacy, { notes: 'Keep this existing responsibility' });
  const restored = Core.parseBackup(JSON.stringify(legacy));
  assert.equal(restored.settings.healthSquareUrl, '');
  assert.deepEqual(restored.tasks, legacy.tasks);
  delete legacy.settings;
  assert.equal(Core.validateSnapshot(legacy).settings.healthSquareUrl, '');
});

test('configured clinic URL normalizes and survives saving and backup restore without changing other preferences', () => {
  const state = Core.defaults();
  state.settings.checkinEnabled = true;
  state.settings.healthSquareUrl = '  https://Clinic.Example.invalid/appointments?visit=first  ';
  const clean = Core.validateSnapshot(state);
  assert.equal(clean.settings.healthSquareUrl, 'https://clinic.example.invalid/appointments?visit=first');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  Core.persist(storage, clean);
  assert.deepEqual(Core.load(storage), clean);
  assert.deepEqual(Core.parseBackup(Core.backupJSON(clean)), clean);
  clean.settings.healthSquareUrl = '';
  const cleared = Core.parseBackup(Core.backupJSON(clean));
  assert.equal(cleared.settings.healthSquareUrl, '');
  assert.equal(cleared.settings.checkinEnabled, true);
});

test('unsafe clinic links reject edits, persistence and backup imports before any stored data is replaced', () => {
  const state = Core.defaults();
  state.settings.healthSquareUrl = 'https://clinic.example.invalid/';
  const before = Core.backupJSON(state);
  let saved = before;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  for (const url of ['http://clinic.example.invalid/', 'javascript:alert(1)', 'data:text/html,bad', 'https://user:password@clinic.example.invalid/', '//clinic.example.invalid/', 'invalid', 'https://clinic.example.invalid/' + 'a'.repeat(2048), null, 123]) {
    const candidate = JSON.parse(before);
    candidate.settings.healthSquareUrl = url;
    assert.throws(() => Core.validateSnapshot(candidate));
    assert.throws(() => Core.parseBackup(JSON.stringify(candidate)));
    assert.throws(() => Core.persistIfUnchanged(storage, candidate, before));
    assert.equal(saved, before);
    assert.equal(Core.backupJSON(state), before);
  }
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

test('legacy backups keep manual meal plans absent, including at the backup size boundary', () => {
  const state = Core.defaults();
  assert.equal(Object.hasOwn(state, 'mealPlans'), false);
  assert.equal(Object.hasOwn(state, 'menuHelper'), false);
  assert.equal(Object.hasOwn(state, 'activityHistory'), false);
  const template = task(state, { id: 'template', notes: 'a'.repeat(8500) });
  state.tasks = Array.from({ length: 119 }, (_, index) => ({ ...template, id: 'near-' + index }));
  // Fill the remaining space with valid notes until the old backup is only
  // twenty bytes below the limit: adding empty meal plans would break it.
  let remaining = 1024 * 1024 - Buffer.byteLength(Core.backupJSON(state)) - 20;
  for (const item of state.tasks) {
    const extra = Math.min(10000 - item.notes.length, remaining);
    item.notes += 'b'.repeat(extra);
    remaining -= extra;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  const backup = Core.backupJSON(state);
  assert.equal(Buffer.byteLength(backup), 1024 * 1024 - 20);
  const restored = Core.parseBackup(backup);
  assert.equal(Object.hasOwn(restored, 'mealPlans'), false);
  assert.equal(Object.hasOwn(restored, 'menuHelper'), false);
  assert.equal(Object.hasOwn(restored, 'activityHistory'), false);
  assert.equal(Core.backupJSON(restored), backup);
  let saved;
  Core.persist({ setItem: (_, text) => { saved = text; } }, restored);
  assert.equal(saved, backup);
  assert.throws(() => Core.persistIfUnchanged({ getItem: () => saved, setItem: (_, text) => { saved = text; } }, { ...restored, activityHistory: { version: 1, entries: [], olderCount: 0 } }, backup), /1 MiB/);
  assert.equal(saved, backup);
  assert.throws(() => Core.persistIfUnchanged({ getItem: () => saved, setItem: (_, text) => { saved = text; } }, { ...restored, menuHelper: MenuHelper.emptyState() }, backup), /1 MiB/);
  assert.equal(saved, backup);
});

function quickMenuFixture() {
  const preferences = [{ ingredientId: 'tinnedTomatoes', productName: 'My saved tomatoes', store: 'Waitrose', url: 'https://www.waitrose.ae/products/tomatoes', source: 'Saved by you in Tidy' }];
  const prepared = MenuHelper.createDraft('tomato pasta', { people: 4, preferences, now: NOW, id: 'menu-backup-test' });
  assert.equal(prepared.ok, true);
  return { version: 1, people: 4, preferences, draft: MenuHelper.approveDraft(prepared.draft, { now: NOW + 1000 }) };
}

test('quick-menu drafts and explicit product choices round-trip with responsibilities and remain independent copies', () => {
  const state = Core.defaults();
  task(state, { title: 'School books', assigneeId: 'mum' });
  state.mealSummary = [{ day: 'Monday', name: 'Existing dinner' }];
  state.menuHelper = quickMenuFixture();
  const text = Core.backupJSON(state);
  const restored = Core.parseBackup(text);
  assert.deepEqual(restored, state);
  assert.equal(restored.menuHelper.draft.status, 'approved');
  assert.equal(restored.menuHelper.draft.items.find(item => item.ingredientId === 'tinnedTomatoes').source, 'Saved by you in Tidy');
  assert.equal(restored.actions.length, 0);
  let stored = null;
  Core.persistIfUnchanged({ getItem: () => stored, setItem: (_, value) => { stored = value; } }, state, null);
  assert.equal(stored, text);
  restored.menuHelper.preferences[0].productName = 'Changed copy';
  restored.menuHelper.draft.items[0].amount = 1;
  assert.equal(Core.backupJSON(state), text);
  assert.equal(state.tasks[0].title, 'School books');
  assert.equal(state.mealSummary[0].name, 'Existing dinner');
});

test('invalid quick-menu imports cannot replace recoverable responsibilities or invent retailer provenance', () => {
  const state = Core.defaults();
  task(state);
  state.menuHelper = quickMenuFixture();
  const before = Core.backupJSON(state);
  let stored = before;
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  const changes = [
    helper => { helper.version = 2; },
    helper => { helper.people = 0; },
    helper => { helper.preferences.push({ ...helper.preferences[0] }); },
    helper => { helper.preferences[0].source = 'Last bought from Waitrose'; },
    helper => { helper.preferences[0].url = 'https://user:password@www.waitrose.ae/'; },
    helper => { helper.draft.items[0].url = 'javascript:alert(1)'; },
    helper => { helper.draft.items[0].amount = -1; },
    helper => { helper.draft.items[0].amount = Infinity; },
    helper => { helper.draft.items[0].source = 'Retailer order history'; },
    helper => { helper.draft.items.push({ ...helper.draft.items[0] }); },
    helper => { helper.draft.status = 'ordered'; },
    helper => { helper.draft.approvedAt = null; },
    helper => { helper.draft.status = 'draft'; },
    helper => { helper.draft.items.forEach(item => { item.included = false; }); }
  ];
  for (const change of changes) {
    const candidate = JSON.parse(before);
    change(candidate.menuHelper);
    assert.throws(() => Core.validateSnapshot(candidate));
    assert.throws(() => Core.parseBackup(JSON.stringify(candidate)));
    assert.throws(() => Core.persistIfUnchanged(storage, candidate, before));
    assert.equal(stored, before);
    assert.equal(Core.backupJSON(state), before);
  }
  assert.throws(() => Core.validateSnapshot({ ...state, menuHelper: null }));
});

test('manual weekday meals trim names, preserve the other plan and round-trip without changing dinner or responsibilities', () => {
  const state = Core.defaults();
  task(state, { notes: 'Keep school books together', assigneeId: 'dad' });
  state.actions.push({ id: 'review-booking', kind: 'booking', title: 'Clinic draft', details: '', provider: '', link: '', status: 'needs_review', createdAt: NOW });
  state.settings.checkinEnabled = true;
  state.mealSnapshot = { version: 4, state: { menu: [{ day: 'Monday', name: 'Roast chicken' }] } };
  state.mealSummary = [{ day: 'Monday', name: 'Roast chicken' }];
  const before = Core.backupJSON(state);
  const breakfast = Core.updateMealPlan(state, 'breakfast', { Monday: '  Eggs and toast  ', Friday: 'Porridge', Saturday: 'Ignore extra day' });
  assert.equal(breakfast, state.mealPlans.breakfast);
  assert.deepEqual(breakfast, { Monday: 'Eggs and toast', Tuesday: '', Wednesday: '', Thursday: '', Friday: 'Porridge' });
  Core.updateMealPlan(state, 'lunch', { Tuesday: 'Chicken sandwich', Wednesday: '寿司 🍱' });
  assert.deepEqual(state.mealPlans.breakfast, breakfast);
  assert.equal(state.mealPlans.lunch.Tuesday, 'Chicken sandwich');
  const restored = Core.parseBackup(Core.backupJSON(state));
  assert.deepEqual(restored, state);
  delete restored.mealPlans;
  assert.equal(Core.backupJSON(restored), before);
  Core.updateMealPlan(state, 'breakfast', {});
  assert.equal(state.mealPlans.breakfast.Monday, '');
  assert.equal(state.mealPlans.lunch.Tuesday, 'Chicken sandwich');
});

test('invalid manual plans and malformed imported plan data leave existing state and storage unchanged', () => {
  const state = Core.defaults();
  Core.updateMealPlan(state, 'lunch', { Monday: 'Soup' });
  const retained = state.mealPlans;
  const before = Core.backupJSON(state);
  let saved = before;
  const storage = { getItem: () => saved, setItem: (_, text) => { saved = text; } };
  for (const type of ['dinner', 'snack', '', null, undefined]) {
    assert.throws(() => Core.updateMealPlan(state, type, { Monday: 'Toast' }), /meal plan type/);
    assert.equal(state.mealPlans, retained);
  }
  for (const values of [null, undefined, [], new Date(), { Monday: 2 }, { Monday: null }, { Monday: [] }, { Friday: 'a'.repeat(301) }]) {
    assert.throws(() => Core.updateMealPlan(state, 'breakfast', values));
    assert.equal(state.mealPlans, retained);
    assert.equal(Core.backupJSON(state), before);
  }
  for (const value of [null, [], new Date(), { breakfast: null }, { lunch: [] }, { breakfast: { Monday: false } }, { lunch: { Tuesday: 'a'.repeat(301) } }]) {
    const candidate = { ...state, mealPlans: value };
    assert.throws(() => Core.validateSnapshot(candidate));
    assert.throws(() => Core.persistIfUnchanged(storage, candidate, before));
    assert.equal(saved, before);
    assert.equal(Core.backupJSON(state), before);
  }
  const cleaned = Core.validateSnapshot({ ...state, mealPlans: { breakfast: { Monday: 'Toast', unexpected: 'ignored' }, unknown: { Monday: 'ignored' } } });
  assert.deepEqual(Object.keys(cleaned.mealPlans), ['breakfast', 'lunch']);
  assert.deepEqual(Object.keys(cleaned.mealPlans.breakfast), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
});

test('a manual plan that exceeds the whole-backup limit rejects before assigning any part of the plan', () => {
  const state = Core.defaults();
  const template = task(state, { id: 'template', notes: 'a'.repeat(8500) });
  state.tasks = Array.from({ length: 119 }, (_, index) => ({ ...template, id: 'near-' + index }));
  let remaining = 1024 * 1024 - Buffer.byteLength(Core.backupJSON(state)) - 20;
  for (const item of state.tasks) {
    const extra = Math.min(10000 - item.notes.length, remaining);
    item.notes += 'b'.repeat(extra);
    remaining -= extra;
    if (!remaining) break;
  }
  const before = Core.backupJSON(state);
  const retainedTasks = state.tasks;
  assert.throws(() => Core.updateMealPlan(state, 'breakfast', { Monday: 'Toast' }), /1 MiB/);
  assert.equal(Object.hasOwn(state, 'mealPlans'), false);
  assert.equal(state.tasks, retainedTasks);
  assert.equal(Core.backupJSON(state), before);
});

function planningFixture() {
  return { enabled: true, workDays: [1, 2, 3, 4, 5], schoolDays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', kidsHome: '15:00', dayStart: '07:00', dayEnd: '20:30', taskMinutes: 30, familyMinutes: 45, bufferMinutes: 15 };
}
function calendarFixture() {
  return { sourceName: 'Family.ics', importedAt: NOW, windowStart: NOW, windowEnd: NOW + 60 * 86400000, events: [{ id: 'school-1', title: 'School meeting', startAt: NOW + 3600000, endAt: NOW + 7200000, allDay: false, sourceUid: 'meeting@family' }], warnings: ['Imported snapshot; refresh by importing again.'] };
}
test('optional calendar, family hours and scheduled task details survive backups without expanding legacy data', () => {
  const legacy = Core.backupJSON(Core.defaults());
  assert.equal(Object.hasOwn(Core.parseBackup(legacy), 'calendar'), false);
  assert.equal(Object.hasOwn(Core.parseBackup(legacy), 'planningProfile'), false);
  const state = Core.defaults();
  state.planningProfile = planningFixture(); state.calendar = calendarFixture();
  task(state, { durationMinutes: 45, planningReason: 'After school and work, avoiding the imported meeting.' });
  assert.deepEqual(Core.parseBackup(Core.backupJSON(state)), state);
  const before = Core.backupJSON(state);
  for (const change of [{ durationMinutes: 0 }, { durationMinutes: 481 }, { durationMinutes: 1.5 }, { planningReason: 'x'.repeat(1001) }]) {
    assert.throws(() => Core.updateTask(state, state.tasks[0].id, change));
    assert.equal(Core.backupJSON(state), before);
  }
});
test('invalid family hours and imported busy events reject before replacing saved responsibilities', () => {
  const state = Core.defaults(); task(state);
  const before = Core.backupJSON(state);
  const profile = planningFixture(), calendar = calendarFixture();
  for (const patch of [{ workDays: [1, 1] }, { workDays: [7] }, { schoolDays: [1, 1] }, { schoolDays: [7] }, { workStart: '18:00' }, { dayEnd: '06:00' }, { familyMinutes: -10 }, { bufferMinutes: 121 }, { enabled: 'yes' }]) {
    assert.throws(() => Core.validateSnapshot({ ...state, planningProfile: { ...profile, ...patch } }));
  }
  for (const patch of [{ windowEnd: calendar.windowStart }, { events: [{ ...calendar.events[0], endAt: calendar.events[0].startAt }] }, { events: [calendar.events[0], calendar.events[0]] }, { events: [{ ...calendar.events[0], allDay: 'true' }] }, { importedAt: Infinity }]) {
    assert.throws(() => Core.validateSnapshot({ ...state, calendar: { ...calendar, ...patch } }));
  }
  assert.equal(Core.backupJSON(state), before);
});
test('manual schedule edits clear an old automatic-planning reason while preserving task duration', () => {
  const state = Core.defaults();
  const item = task(state, { dueTime: '17:00', durationMinutes: 45, planningReason: 'Chosen from family hours.' });
  Core.updateTask(state, item.id, { dueTime: '18:00' });
  assert.equal(item.planningReason, ''); assert.equal(item.durationMinutes, 45);
  Core.updateTask(state, item.id, { dueTime: '19:00', planningReason: 'A fresh reviewed plan.' });
  assert.equal(item.planningReason, 'A fresh reviewed plan.');
});

test('account calendar provenance round-trips while tokens and unsupported connection fields never enter backups', () => {
  for (const sourceType of ['google', 'microsoft', 'file']) {
    const state = Core.defaults();
    state.calendar = { ...calendarFixture(), sourceType, accessToken: 'synthetic-not-a-real-token', refreshToken: 'synthetic-refresh' };
    const backup = Core.backupJSON(state), restored = Core.parseBackup(backup);
    assert.equal(restored.calendar.sourceType, sourceType);
    assert.equal(backup.includes('synthetic-not-a-real-token'), false);
    assert.equal(backup.includes('synthetic-refresh'), false);
    assert.deepEqual(restored.calendar.events, state.calendar.events);
  }
  const state = { ...Core.defaults(), calendar: { ...calendarFixture(), sourceType: 'device-permission-granted' } };
  assert.throws(() => Core.validateSnapshot(state), /calendar source/);
  assert.equal(Object.hasOwn(Core.parseBackup(Core.backupJSON(Core.defaults())), 'calendar'), false);
});
