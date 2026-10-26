'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../web/core.js');
const Menu = require('../web/menu-helper.js');
const Workflow = require('../web/assistant-workflow.js');
const NOW = Date.parse('2026-10-26T06:00:00Z');
const TOMORROW = '2026-10-27';
function prepare(request = 'tomato pasta', options = {}) {
  const result = Menu.createDraft(request, { now: NOW, id: 'meal-workflow', ...options });
  assert.equal(result.ok, true);
  return result.draft;
}
function reminder(overrides = {}) {
  return { title: 'Cook tomato pasta', type: 'task', dueDate: TOMORROW, dueTime: '18:00', remindAt: Core.dueEpoch(TOMORROW, '18:00'), repeat: 'none', ...overrides };
}
function changes(state, overrides = {}) {
  return Workflow.prepareMealChanges(state, { draft: prepare(), addGroceries: true, reminderDraft: reminder(), ...overrides }, { now: NOW });
}
function freezeTree(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}

test('a meal, its groceries and cooking reminder become one independent valid local candidate', () => {
  const state = freezeTree(Core.defaults()), input = freezeTree({ draft: prepare(), addGroceries: true, reminderDraft: reminder() });
  const before = Core.backupJSON(state);
  const result = Workflow.prepareMealChanges(state, input, { now: NOW });
  const groceries = result.state.tasks.filter(task => task.type === 'grocery');
  assert.equal(groceries.length, 3);
  assert.deepEqual(groceries.map(task => [task.title, task.quantity]), [['Pasta', '360 g'], ['Tinned chopped tomatoes', '600 g'], ['Olive oil', '20 ml']]);
  assert.equal(result.summary.addedGroceryIds.length, 3);
  assert.deepEqual(result.summary.keptGroceryIds, []);
  const savedReminder = result.state.tasks.find(task => task.id === result.summary.reminderId);
  assert.equal(savedReminder.remindAt, Core.dueEpoch(TOMORROW, '18:00'));
  assert.equal(savedReminder.type, 'task');
  assert.equal(result.state.menuHelper.draft.status, 'draft');
  assert.equal(result.state.menuHelper.draft.approvedAt, null);
  assert.deepEqual(result.state.actions, []);
  assert.equal(Core.backupJSON(state), before);
  assert.deepEqual(Core.parseBackup(Core.backupJSON(result.state)), result.state);
  assert.equal(Object.hasOwn(result.state, 'activityHistory'), false);
});

test('saved people and product choices remain local preferences rather than claimed retailer history', () => {
  const state = Core.defaults();
  const preferences = [{ ingredientId: 'tinnedTomatoes', productName: 'Mutti chopped tomatoes', store: 'Waitrose', url: 'https://www.waitrose.ae/products/my-tomatoes', source: 'Saved by you in Tidy' }];
  state.menuHelper = { ...Menu.emptyState(), people: 2, preferences };
  const draft = prepare('tomato pasta', { people: state.menuHelper.people, preferences });
  const { state: result } = changes(state, { draft });
  assert.equal(result.menuHelper.people, 2);
  assert.deepEqual(result.menuHelper.preferences, preferences);
  const tomatoes = result.tasks.find(task => task.title === 'Tinned chopped tomatoes');
  assert.equal(tomatoes.quantity, '300 g');
  assert.equal(tomatoes.link, preferences[0].url);
  assert.match(tomatoes.notes, /Mutti chopped tomatoes/);
  assert.match(tomatoes.notes, /Waitrose/);
  assert.match(tomatoes.notes, /Saved by you in Tidy/);
  assert.doesNotMatch(tomatoes.notes, /last bought|purchase history|order placed|connected/i);
});

test('an existing normalized open grocery keeps its quantity, assignee, notes and reminder for review', () => {
  const state = Core.defaults();
  const existing = Core.createTask(state, { title: '  ＰＡＳＴＡ  ', type: 'grocery', category: 'Shopping', quantity: '1 bag', assigneeId: 'dad', notes: 'Buy our usual size', dueDate: TOMORROW, dueTime: '11:00', remindAt: Core.dueEpoch(TOMORROW, '11:00') }, NOW);
  const preserved = structuredClone(existing);
  const result = changes(state);
  assert.deepEqual(result.state.tasks.find(task => task.id === existing.id), preserved);
  assert.equal(result.state.tasks.filter(task => Workflow.groceryKey(task.title) === 'pasta').length, 1);
  assert.deepEqual(result.summary.keptGroceryIds, [existing.id]);
  assert.equal(result.summary.addedGroceryIds.length, 2);
  assert.deepEqual(result.summary.quantityDifferences, [{ id: existing.id, title: existing.title, existingQuantity: '1 bag', suggestedQuantity: '360 g' }]);
});

test('an existing grocery with no quantity gains only the suggested amount', () => {
  const state = Core.defaults();
  const existing = Core.createTask(state, { title: 'Pasta', type: 'grocery', quantity: '', assigneeId: 'nanny', notes: 'Keep this note', link: 'https://www.kibsons.com/' }, NOW - 1000);
  const expected = { ...existing, quantity: '360 g' };
  const result = changes(state);
  assert.deepEqual(result.state.tasks.find(task => task.id === existing.id), expected);
  assert.deepEqual(result.summary.quantityDifferences, []);
  assert.equal(existing.quantity, '');
});

test('explicit saved product names match while fresh and tinned tomatoes remain separate', () => {
  const state = Core.defaults();
  const existing = Core.createTask(state, { title: 'Mutti Chopped Tomatoes', type: 'grocery', quantity: '600 g' }, NOW);
  Core.createTask(state, { title: 'Fresh tomatoes', type: 'grocery', quantity: '2' }, NOW);
  const preferences = [{ ingredientId: 'tinnedTomatoes', productName: 'Mutti chopped tomatoes', store: 'Waitrose', url: '', source: 'Saved by you in Tidy' }];
  const draft = prepare('tomato pasta', { preferences });
  const result = changes(state, { draft });
  assert.ok(result.summary.keptGroceryIds.includes(existing.id));
  assert.equal(result.state.tasks.some(task => task.title === 'Tinned chopped tomatoes'), false);
  assert.equal(result.state.tasks.find(task => task.title === 'Fresh tomatoes').quantity, '2');
  const freshState = Core.defaults();
  Core.createTask(freshState, { title: 'Tinned chopped tomatoes', type: 'grocery', quantity: '1 tin' }, NOW);
  const fresh = changes(freshState, { draft: prepare('tomato pasta with fresh tomatoes'), reminderDraft: null });
  assert.ok(fresh.state.tasks.some(task => task.title === 'Fresh tomatoes' && task.quantity === '600 g'));
  assert.equal(fresh.state.tasks.find(task => task.title === 'Tinned chopped tomatoes').quantity, '1 tin');
});

test('finished groceries remain finished while the requested meal receives a new open item', () => {
  const state = Core.defaults();
  const existing = Core.createTask(state, { title: 'Pasta', type: 'grocery', quantity: '360 g' }, NOW - 2000);
  Core.completeTask(state, existing.id, NOW - 1000);
  const result = changes(state);
  assert.equal(result.state.tasks.find(task => task.id === existing.id).status, 'done');
  assert.equal(result.state.tasks.filter(task => task.type === 'grocery' && task.title === 'Pasta' && task.status === 'open').length, 1);
  assert.equal(result.summary.addedGroceryIds.length, 3);
});

test('a repeated meal request reuses open ingredients and an identical cooking reminder', () => {
  const first = changes(Core.defaults());
  const second = changes(first.state);
  assert.deepEqual(second.summary.addedGroceryIds, []);
  assert.equal(second.summary.keptGroceryIds.length, 3);
  assert.equal(second.summary.reminderExisting, true);
  assert.equal(second.summary.reminderId, first.summary.reminderId);
  assert.deepEqual(second.state, first.state);
});

test('groceries and reminder are independently optional and incoming approval is not reused', () => {
  const draft = Menu.approveDraft(prepare(), { now: NOW });
  const onlyMeal = changes(Core.defaults(), { draft, addGroceries: false, reminderDraft: null });
  assert.deepEqual(onlyMeal.state.tasks, []);
  assert.equal(onlyMeal.state.menuHelper.draft.status, 'draft');
  assert.equal(onlyMeal.state.menuHelper.draft.approvedAt, null);
  assert.equal(onlyMeal.summary.reminderId, null);
  const mealAndReminder = changes(Core.defaults(), { addGroceries: false });
  assert.equal(mealAndReminder.state.tasks.length, 1);
  assert.equal(mealAndReminder.state.tasks[0].type, 'task');
});

test('an invalid reminder rejects the entire candidate after grocery preparation without changing saved input', () => {
  const state = Core.defaults();
  Core.createTask(state, { title: 'Unrelated school task', assigneeId: 'mum' }, NOW);
  const before = Core.backupJSON(state);
  for (const invalid of [reminder({ remindAt: NOW - 1 }), reminder({ dueTime: '19:00' }), reminder({ dueDate: '' }), reminder({ repeat: 'daily' }), reminder({ type: 'appointment' }), reminder({ assigneeId: 'unknown' }), reminder({ link: 'javascript:alert(1)' }), reminder({ title: '' })]) {
    assert.throws(() => changes(state, { reminderDraft: invalid }));
    assert.equal(Core.backupJSON(state), before);
  }
});

test('an invalid recipe or request never alters existing meal approval or responsibilities', () => {
  const state = Core.defaults();
  state.menuHelper = { ...Menu.emptyState(), draft: Menu.approveDraft(prepare(), { now: NOW }) };
  const before = Core.backupJSON(state);
  assert.throws(() => changes(state, { draft: { ...prepare(), recipeId: 'unverified-recipe' } }), /Unknown recipe/);
  assert.throws(() => changes(state, { addGroceries: 'yes' }), /whether/);
  assert.throws(() => changes(state, { draft: null }), /meal/);
  const getterRequest = { addGroceries: true };
  Object.defineProperty(getterRequest, 'draft', { get() { throw Error('Getter should not run'); } });
  assert.throws(() => Workflow.prepareMealChanges(state, getterRequest, { now: NOW }), /data fields/);
  assert.equal(Core.backupJSON(state), before);
});

test('a full backup rejects the complete change and preserves its original export byte for byte', () => {
  const state = Core.defaults();
  for (let index = 0; index < 119; index++) Core.createTask(state, { id: 'boundary-' + index, title: 'Responsibility ' + index, notes: 'a'.repeat(8500) }, NOW);
  let remaining = 1024 * 1024 - Buffer.byteLength(Core.backupJSON(state)) - 20;
  for (const task of state.tasks) { const extra = Math.min(10000 - task.notes.length, remaining); task.notes += 'b'.repeat(extra); remaining -= extra; if (!remaining) break; }
  assert.equal(remaining, 0);
  const before = Core.backupJSON(state);
  assert.throws(() => changes(state), /1 MiB/);
  assert.equal(Core.backupJSON(state), before);
  assert.equal(Object.hasOwn(state, 'menuHelper'), false);
});

test('a new meal can reclaim old history budget without dropping responsibilities or mutating its working input', () => {
  const state = Core.defaults();
  const template = Core.createTask(state, { id: 'template', title: 'Responsibility', notes: 'a'.repeat(8000) }, NOW);
  state.tasks = Array.from({ length: 110 }, (_, index) => ({ ...template, id: 'history-budget-' + index }));
  state.activityHistory = { version: 1, olderCount: 4, entries: Array.from({ length: 100 }, (_, index) => ({ id: 'retained-' + index, at: NOW - 100 + index, section: 'Tasks', route: 'family', title: 'Earlier task ' + index + 'x'.repeat(100), details: 'Old detail '.repeat(10) })) };
  let remaining = 1024 * 1024 - Buffer.byteLength(Core.backupJSON(state)) - 20;
  for (const task of state.tasks) { const extra = Math.min(10000 - task.notes.length, remaining); task.notes += 'b'.repeat(extra); remaining -= extra; if (!remaining) break; }
  assert.equal(remaining, 0);
  Core.validateSnapshot(state);
  state.menuHelper = { ...Menu.emptyState(), draft: prepare() };
  // The menu UI has staged its new draft, while working validation must reclaim
  // optional history before the complete candidate can be exported again.
  assert.throws(() => Core.validateSnapshot(state), /1 MiB/);
  const before = JSON.stringify(state);
  const result = changes(state);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(result.state.tasks.slice(0, 110), state.tasks);
  assert.ok(result.state.activityHistory.entries.length < 100);
  assert.equal(result.state.activityHistory.entries.at(-1).id, 'retained-99');
  assert.equal(result.state.activityHistory.olderCount, 4 + 100 - result.state.activityHistory.entries.length);
  Core.validateSnapshot(result.state);
});

test('approved meal rows already represented by open groceries are hidden without hiding distinct ingredients', () => {
  const state = Core.defaults(), draft = Menu.approveDraft(prepare(), { now: NOW });
  state.menuHelper = { ...Menu.emptyState(), draft };
  Core.createTask(state, { title: 'pasta', type: 'grocery', quantity: '360 g' }, NOW);
  Core.createTask(state, { title: 'Fresh tomatoes', type: 'grocery' }, NOW);
  const rows = Workflow.visibleMealItems(state, draft.items);
  assert.deepEqual(rows.map(item => item.name), ['Tinned chopped tomatoes', 'Olive oil']);
  assert.notEqual(rows[0], draft.items[1]);
  const completed = state.tasks.find(task => task.title === 'pasta');
  Core.completeTask(state, completed.id, NOW);
  assert.equal(Workflow.visibleMealItems(state, draft.items).length, 3);
  state.menuHelper.draft = Menu.updateDraft(draft, {});
  assert.deepEqual(Workflow.visibleMealItems(state, draft.items), []);
});

test('classic browser scripts expose the same workflow without Node or a network service', () => {
  const sandbox = { URL, TextEncoder, Date, Math };
  for (const file of ['menu-helper.js', 'core.js', 'assistant-workflow.js']) vm.runInNewContext(fs.readFileSync(require.resolve('../web/' + file), 'utf8'), sandbox);
  const result = vm.runInNewContext(`JSON.stringify(TidyAssistantWorkflow.prepareMealChanges(TidyCore.defaults(), {draft:TidyMenuHelper.createDraft('tomato pasta',{now:${NOW},id:'browser-meal'}).draft,addGroceries:true,reminderDraft:null},{now:${NOW}}))`, sandbox);
  const parsed = JSON.parse(result);
  assert.equal(parsed.state.tasks.length, 3);
  assert.equal(parsed.state.menuHelper.draft.status, 'draft');
  assert.equal(typeof sandbox.TidyAssistantWorkflow.groceryKey, 'function');
  assert.equal(typeof sandbox.TidyAssistantWorkflow.visibleMealItems, 'function');
});
