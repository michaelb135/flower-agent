'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const H = require('../web/history.js');
const Menu = require('../web/menu-helper.js');
const NOW = Date.parse('2026-10-22T03:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
function base() { return { members: [{ id: 'mum', name: 'Mum' }, { id: 'dad', name: 'Dad' }], tasks: [], actions: [], settings: { remindersPaused: false, checkinEnabled: false, checkinTime: '09:00', healthSquareUrl: '', checkinLastDate: '' }, mealSnapshot: null, mealSummary: [] }; }
function task(id = 'task-1', extra = {}) { return { id, title: 'Prepare school bags', category: 'School', assigneeId: 'mum', dueDate: '2026-10-22', dueTime: '17:30', remindAt: null, deliveredReminderAt: null, priority: 'normal', type: 'task', quantity: '', notes: '', link: '', repeat: 'none', status: 'open', createdAt: NOW, completedAt: null, ...extra }; }
function entry(id = 'change-1', extra = {}) { return { id, at: NOW, section: 'Tasks', title: 'Added a task', details: '', route: 'family', ...extra }; }
const diff = (a, b) => H.diff(a, b, { now: NOW });
const append = (a, b, options = {}) => H.append(a, b, { now: NOW, ...options });

test('browser and CommonJS expose the same local history model', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../web/history.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.TidyHistory.diff, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.TidyHistory.emptyHistory())), H.emptyHistory());
});

test('old snapshots and empty iframe bootstrap do not acquire fake history', () => {
  const before = base(), after = clone(before);
  assert.deepEqual(diff(before, after), []);
  assert.equal(append(before, after), undefined);
  after.mealSnapshot = { version: 4, state: { step: 1, prefs: null, menu: [], menuApproved: false, pantry: {}, extras: [], version: 0 }, answers: { people: '', maxTime: '30', gymNights: true, shop: 'Kibsons', checkinDay: 'Sunday', checkinTime: '17:00' }, drafts: { mealRequest: '', extraInput: '', stockInputs: {} } };
  after.mealSummary = [{ day: 'Monday', name: 'Verification-only echo' }];
  assert.deepEqual(diff(before, after), []);
  const baseline = clone(after); after.mealSnapshot.state.step = 2; after.mealSnapshot.state.version = 9;
  assert.deepEqual(diff(baseline, after), []);
});

test('saved weekday dinner preference edits count even before a complete plan is generated', () => {
  const before = base(); before.mealSnapshot = { version: 4, state: { step: 1, prefs: null, menu: [], version: 0 }, answers: { people: '', maxTime: '30', gymNights: true, shop: 'Kibsons', checkinDay: 'Sunday', checkinTime: '17:00' } };
  for (const [key, value] of [['maxTime', '40'], ['gymNights', false], ['shop', 'Waitrose'], ['checkinDay', 'Off'], ['checkinTime', '16:30']]) {
    const after = clone(before); after.mealSnapshot.answers[key] = value;
    assert.match(diff(before, after)[0].title, /Updated weekday dinner planner/);
  }
});

test('task adds, edits, completion, reopening and deletion retain a useful plain-text summary', () => {
  const before = base(), after = clone(before); after.tasks.push(task());
  let change = diff(before, after)[0];
  assert.equal(change.section, 'Tasks'); assert.equal(change.route, 'family'); assert.match(change.title, /Added task.*school bags/); assert.match(change.details, /2026-10-22 at 17:30/);
  const updated = clone(after); Object.assign(updated.tasks[0], { title: 'Pack school bags', quantity: '2 bags', dueTime: '18:00', assigneeId: 'dad', notes: 'SECRET NOTE must not enter log', link: 'https://private.example/token?secret=abc', repeat: 'weekly' });
  change = diff(after, updated)[0];
  assert.match(change.title, /Edited task.*Pack school bags/); assert.match(change.details, /Previously.*Prepare school bags/); assert.match(change.details, /2 bags/); assert.match(change.details, /18:00/); assert.match(change.details, /Dad/); assert.match(change.details, /Notes changed/); assert.match(change.details, /Website link changed/);
  assert.doesNotMatch(JSON.stringify(change), /SECRET NOTE|private\.example|secret=abc/);
  const completed = clone(updated); completed.tasks[0].status = 'done'; completed.tasks[0].completedAt = NOW + 10;
  assert.match(diff(updated, completed)[0].title, /^Completed task/);
  assert.match(diff(completed, updated)[0].title, /^Reopened task/);
  const removed = clone(updated); removed.tasks = [];
  change = diff(updated, removed)[0]; assert.match(change.title, /^Removed task.*Pack school bags/);
  assert.deepEqual(updated.tasks[0].notes, 'SECRET NOTE must not enter log');
});

test('grocery and appointment records use the right screens and never claim provider completion', () => {
  const before = base(), after = clone(before);
  after.tasks = [task('milk', { title: 'Milk', type: 'grocery', quantity: '2 bottles' }), task('dentist', { title: 'Dentist', type: 'appointment' })];
  const changes = diff(before, after);
  assert.deepEqual(changes.map(item => [item.section, item.route]), [['Groceries', 'shopping'], ['Appointments', 'appointments']]);
  assert.match(changes[0].details, /2 bottles/); assert.match(changes[1].details, /Local record; no provider booking confirmed/);
});

test('reminder delivery, bookkeeping timestamps and render-only summaries produce no entries', () => {
  const before = base(); before.tasks = [task()];
  const after = clone(before); after.tasks[0].deliveredReminderAt = NOW; after.tasks[0].createdAt += 99; after.settings.checkinLastDate = '2026-10-22'; after.mealSummary = [{ day: 'Monday', name: 'Tomato pasta' }];
  assert.deepEqual(diff(before, after), []);
  after.tasks[0].remindAt = NOW + 3600000;
  assert.match(diff(before, after)[0].details, /Reminder updated/);
});

test('routine rollover records completion and the actual new occurrence', () => {
  const before = base(); before.tasks = [task('repeat', { repeat: 'daily', seriesId: 'series-1' })];
  const after = clone(before); after.tasks[0].status = 'done'; after.tasks[0].completedAt = NOW; after.tasks.push(task('repeat-next', { repeat: 'daily', seriesId: 'series-1', dueDate: '2026-10-23' }));
  const changes = diff(before, after);
  assert.equal(changes.length, 2); assert.match(changes[0].title, /^Completed/); assert.match(changes[1].title, /^Added/);
});

test('household labels and draft approvals remain honest local records', () => {
  const before = base(), after = clone(before); after.members[0].name = 'Mother'; after.members.push({ id: 'nanny', name: 'Nanny' });
  after.actions = [{ id: 'order', kind: 'purchase', title: 'Order groceries', details: 'SECRET purchase notes', provider: 'Some shop', link: '', status: 'needs_review', createdAt: NOW }];
  let changes = diff(before, after);
  assert.equal(changes.length, 3); assert.match(changes[0].title, /Renamed.*Mother/); assert.match(changes[1].title, /Added.*Nanny/); assert.match(changes[2].title, /Prepared purchase draft/); assert.doesNotMatch(JSON.stringify(changes), /SECRET purchase notes/);
  const approved = clone(after); approved.actions[0].status = 'approved_draft';
  assert.match(diff(after, approved)[0].title, /Approved purchase draft/);
  assert.match(diff(after, approved)[0].details, /has not sent, purchased or booked/);
  const manual = clone(approved); manual.actions[0].status = 'manually_completed';
  assert.match(diff(approved, manual)[0].title, /completed outside Tidy/); assert.match(diff(approved, manual)[0].details, /not verified/);
  const cancelled = clone(approved); cancelled.actions[0].status = 'cancelled'; assert.match(diff(approved, cancelled)[0].title, /Discarded purchase draft/);
});

test('settings, confirmed planning hours and calendar snapshots are summarized without calendar contents', () => {
  const before = base(), after = clone(before);
  after.settings.remindersPaused = true; after.settings.checkinEnabled = true; after.settings.checkinTime = '08:30'; after.settings.healthSquareUrl = 'https://private.clinic.example/secret-token';
  after.planningProfile = { enabled: true, workStart: '08:00', workEnd: '17:00' };
  after.calendar = { importedAt: NOW, events: [{ id: 'event', title: 'CONFIDENTIAL MEDICAL EVENT', location: 'PRIVATE CLINIC' }] };
  const changes = diff(before, after);
  assert.equal(changes.length, 6); assert.ok(changes.some(item => /Reminders paused/.test(item.details))); assert.ok(changes.some(item => /08:30/.test(item.details))); assert.ok(changes.some(item => item.section === 'Planning')); assert.ok(changes.some(item => /1 saved events/.test(item.details)));
  assert.doesNotMatch(JSON.stringify(changes), /CONFIDENTIAL|PRIVATE CLINIC|secret-token/);
  assert.match(diff(after, { ...after, calendar: undefined }).at(-1).title, /Removed saved calendar/);
});

test('weekday meal choices record individual changes and clears', () => {
  const before = base(), after = clone(before); after.mealPlans = { breakfast: { Monday: 'Toast', Tuesday: 'Eggs' } };
  const changes = diff(before, after);
  assert.equal(changes.length, 2); assert.match(changes[0].title, /Saved Monday breakfast/); assert.match(changes[0].details, /Toast/);
  const cleared = clone(after); cleared.mealPlans.breakfast.Monday = '';
  assert.match(diff(after, cleared)[0].title, /Cleared Monday breakfast/);
});

test('meal preparation, ingredient changes, approval and saved product preferences are distinct local changes', () => {
  const before = base(), prepared = clone(before);
  const draft = Menu.createDraft('tomato pasta', { people: 4, now: NOW, id: 'meal-1' }).draft;
  prepared.menuHelper = { ...Menu.emptyState(), draft };
  assert.match(diff(before, prepared)[0].title, /Prepared meal ingredients.*Tomato pasta/);
  const edited = clone(prepared); edited.menuHelper.draft = Menu.updateDraft(draft, { items: draft.items.map(item => ({ ...item, amount: item.amount + 1 })) });
  assert.match(diff(prepared, edited)[0].details, /Ingredients, amounts/);
  const approved = clone(edited); approved.menuHelper.draft = Menu.approveDraft(edited.menuHelper.draft, { now: NOW + 10 });
  assert.match(diff(edited, approved)[0].title, /Confirmed meal grocery draft/); assert.match(diff(edited, approved)[0].details, /no order placed/);
  const dirty = clone(approved); dirty.menuHelper.draft = Menu.updateDraft(approved.menuHelper.draft, { people: 2 }); assert.match(diff(approved, dirty)[0].details, /Previous approval removed/);
  const saved = clone(approved); saved.menuHelper.preferences = [{ ingredientId: 'pasta', productName: 'Usual pasta', store: 'Kibsons', url: '', source: 'Saved by you in Tidy' }];
  assert.match(diff(approved, saved)[0].title, /Saved usual product choices/);
  const provenance = clone(saved); provenance.menuHelper.draft.items[0].source = 'Saved by you in Tidy'; assert.deepEqual(diff(saved, provenance), []);
});

test('legacy dinner edits and approvals are recorded while internal step counters are ignored', () => {
  const before = base(), after = clone(before); after.mealSnapshot = { version: 4, state: { menu: [{ name: 'Dinner' }], menuApproved: false, draftApproved: false }, answers: { people: '4' } };
  assert.match(diff(before, after)[0].title, /Updated weekday dinner planner/);
  const approved = clone(after); approved.mealSnapshot.state.menuApproved = true;
  assert.match(diff(after, approved)[0].title, /Approved weekday dinner menu/);
  const groceries = clone(approved); groceries.mealSnapshot.state.draftApproved = true;
  assert.match(diff(approved, groceries)[0].title, /Confirmed weekday meal grocery draft/);
  const removed = clone(groceries); removed.mealSnapshot = null; assert.match(diff(groceries, removed)[0].title, /Removed weekday dinner plan/);
});

test('pending-save retries reuse IDs and successful later cycles still record the same change again', () => {
  const before = base(), after = clone(before); after.tasks.push(task());
  const history = append(before, after); after.activityHistory = history;
  assert.deepEqual(H.append(before, after, { now: NOW + 20 }), history);
  const removed = clone(after); removed.tasks = []; removed.activityHistory = append(after, removed);
  const addedAgain = clone(removed); addedAgain.tasks = [task()]; addedAgain.activityHistory = append(removed, addedAgain);
  assert.equal(addedAgain.activityHistory.entries.length, 3);
  assert.notEqual(history.entries[0].id, addedAgain.activityHistory.entries[2].id);
});

test('restore history unions current and imported entries without duplicate IDs or losing local summaries', () => {
  const before = base(), after = clone(before);
  before.activityHistory = { version: 1, entries: [entry('local', { at: NOW + 20 }), entry('shared')], olderCount: 3 };
  after.activityHistory = { version: 1, entries: [entry('imported', { at: NOW - 10 }), entry('shared', { title: 'Tampered duplicate' })], olderCount: 5 };
  const merged = append(before, after, { mergeHistories: true });
  assert.deepEqual(merged.entries.map(item => item.id), ['imported', 'shared', 'local']);
  assert.equal(merged.entries.find(item => item.id === 'shared').title, 'Added a task');
  assert.equal(merged.olderCount, 5);
});

test('ordinary writes respect previously pruned history and do not count old entries twice', () => {
  const before = base(); before.tasks = [task()];
  before.activityHistory = { version: 1, entries: [entry('old-1'), entry('old-2'), entry('old-3')], olderCount: 4 };
  const after = clone(before); after.activityHistory = H.trim(before.activityHistory, 1); after.tasks[0].quantity = '2 bags';
  const result = append(before, after);
  assert.equal(result.entries.length, 3); assert.equal(result.olderCount, 5);
  assert.equal(result.entries.some(item => item.id === 'old-1'), false);
  after.activityHistory = result;
  assert.deepEqual(append(before, after), result);
});

test('large batches retain the latest 500 summaries and expose how many were removed', () => {
  const before = base(), after = clone(before);
  after.tasks = Array.from({ length: 600 }, (_, index) => task('task-' + index, { title: 'Responsibility ' + index }));
  assert.equal(diff(before, after).length, 600);
  const history = append(before, after);
  assert.equal(history.entries.length, 500); assert.equal(history.olderCount, 100); assert.match(history.entries[0].title, /Responsibility 100/); assert.match(history.entries.at(-1).title, /Responsibility 599/);
  const trimmed = H.trim(history, 499); assert.equal(trimmed.entries.length, 1); assert.equal(trimmed.olderCount, 599); assert.equal(history.entries.length, 500);
});

test('validation rejects unsafe destinations, false sections, duplicates, malformed epochs and accessor objects', () => {
  const valid = { version: 1, entries: [entry()], olderCount: 0 };
  for (const patch of [{ route: 'https://attacker.example' }, { route: 'javascript:alert(1)' }, { section: 'Retailer purchase confirmed' }, { at: -1 }, { at: Infinity }, { at: 253402300800000 }, { id: '' }, { title: '' }, { details: 'a'.repeat(501) }]) assert.throws(() => H.validateHistory({ ...valid, entries: [entry('bad', patch)] }));
  assert.throws(() => H.validateHistory({ ...valid, entries: [entry(), entry()] }), /Duplicate/);
  assert.throws(() => H.validateHistory({ ...valid, olderCount: -1 })); assert.throws(() => H.validateHistory({ ...valid, olderCount: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => H.validateHistory({ ...valid, entries: Array.from({ length: 501 }, (_, i) => entry('entry-' + i)) }));
  let touched = false; const accessor = { ...entry() }; Object.defineProperty(accessor, 'title', { enumerable: true, get() { touched = true; return 'Unsafe'; } });
  assert.throws(() => H.validateHistory({ ...valid, entries: [accessor] }), /data fields/); assert.equal(touched, false);
  const getterState = base(); Object.defineProperty(getterState, 'tasks', { enumerable: true, get() { touched = true; return []; } }); assert.throws(() => diff(getterState, base()), /data fields/); assert.equal(touched, false);
  const getterList = [entry()]; Object.defineProperty(getterList, '0', { enumerable: true, get() { touched = true; return entry(); } });
  assert.throws(() => H.validateHistory({ ...valid, entries: getterList }), /data fields/); assert.equal(touched, false);
  const sparse = Array(1); assert.throws(() => H.validateHistory({ ...valid, entries: sparse }), /missing items/);
  const custom = Object.create({ inherited: true }); custom.version = 1; custom.entries = []; assert.throws(() => H.validateHistory(custom), /plain data/);
});

test('history is detached, input remains untouched and markup stays literal text', () => {
  const before = base(), after = clone(before); after.tasks = [task('html', { title: '<img src=x onerror=alert(1)>', notes: 'private notes' })];
  const original = clone(after); const history = append(before, after);
  assert.deepEqual(after, original); assert.equal(before.activityHistory, undefined);
  assert.match(history.entries[0].title, /<img src=x onerror=alert\(1\)>/);
  const copied = H.validateHistory(history); copied.entries[0].title = 'Changed copy'; assert.notEqual(history.entries[0].title, copied.entries[0].title);
  assert.throws(() => H.trim({ version: 1, entries: [entry()], olderCount: Number.MAX_SAFE_INTEGER }, 1), /too large/);
  assert.throws(() => H.diff(before, after, { now: NOW, idFactory: () => '' }));
});
