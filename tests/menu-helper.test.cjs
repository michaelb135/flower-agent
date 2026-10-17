'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const menu = require('../web/menu-helper.js');
const now = Date.parse('2026-10-17T08:00:00Z');
const options = extra => ({ now, id: 'menu-test', ...extra });
const make = (text = 'tomato pasta', extra = {}) => {
  const result = menu.createDraft(text, options(extra));
  assert.equal(result.ok, true, result.reason);
  return result;
};
const penne = { ingredientId: 'pasta', productName: 'Waitrose Penne', store: 'Waitrose', url: 'https://www.waitrose.ae/en/products/penne', source: 'Saved by you in Tidy' };
const tomatoes = { ingredientId: 'tinnedTomatoes', productName: 'Mutti chopped tomatoes', store: 'Kibsons', url: '', source: 'Saved by you in Tidy' };

test('a new menu has no fabricated product preferences or purchase history', () => {
  assert.deepEqual(menu.emptyState(), { version: 1, people: 4, preferences: [], draft: null });
  const first = menu.emptyState();
  first.preferences.push(penne);
  assert.deepEqual(menu.emptyState().preferences, []);
  assert.equal(menu.recipes().length >= 20, true);
  assert.equal(menu.recipes().every(recipe => !/beans?/i.test(recipe.name)), true);
});

test('a short dish creates a complete editable grocery draft with visible serving assumption', () => {
  const result = make();
  assert.equal(result.draft.name, 'Tomato pasta');
  assert.equal(result.draft.status, 'draft');
  assert.equal(result.draft.approvedAt, null);
  assert.equal(result.draft.people, 4);
  assert.match(result.assumptions.join(' '), /4 people/);
  assert.deepEqual(result.draft.items.map(item => [item.ingredientId, item.amount, item.unit]), [
    ['pasta', 360, 'g'], ['tinnedTomatoes', 600, 'g'], ['oliveOil', 20, 'ml']
  ]);
  assert.equal(result.draft.items.every(item => item.productName === '' && item.store === '' && item.source === ''), true);
});

test('the spoken spaghetti example requires no ingredient transcription', () => {
  const result = make('I want to eat some spaghetti to tomato');
  assert.equal(result.draft.recipeId, 'tomato-pasta');
  assert.equal(result.draft.items[0].name, 'Spaghetti');
  assert.equal(result.draft.items.length, 3);
  assert.equal(result.draft.items[0].productName, '');
  assert.equal(make('tomatoes and pasta').draft.recipeId, 'tomato-pasta');
  assert.equal(make('penne pasta with tomato').draft.items[0].name, 'Penne');
  assert.equal(make('spaghetti pasta with tomato').draft.items[0].name, 'Spaghetti');
});

test('generic pasta reuses only compatible products explicitly saved in Tidy', () => {
  const prefs = [penne, tomatoes];
  const snapshot = JSON.stringify(prefs);
  const result = make('tomato pasta', { preferences: prefs });
  assert.equal(result.draft.items[0].productName, 'Waitrose Penne');
  assert.equal(result.draft.items[0].source, 'Saved by you in Tidy');
  assert.equal(result.draft.items[1].productName, 'Mutti chopped tomatoes');
  assert.equal(result.draft.items[2].productName, '');
  assert.equal(JSON.stringify(prefs), snapshot);
});

test('explicit spaghetti is never silently changed to remembered penne', () => {
  const result = make('I want to eat some spaghetti to tomato', { preferences: [penne] });
  const pasta = result.draft.items.find(item => item.ingredientId === 'pasta');
  assert.equal(pasta.name, 'Spaghetti');
  assert.equal(pasta.productName, '');
  assert.equal(pasta.store, '');
  assert.equal(pasta.url, '');
  assert.match(result.assumptions.join(' '), /saved pasta product was not substituted/);
  const exact = make('tomato spaghetti', { preferences: [{ ...penne, productName: 'Waitrose Spaghetti' }] });
  assert.equal(exact.draft.items[0].productName, 'Waitrose Spaghetti');
  const explicitPenne = make('tomato penne', { preferences: [{ ...penne, productName: 'Waitrose Spaghetti' }] });
  assert.equal(explicitPenne.draft.items[0].name, 'Penne');
  assert.equal(explicitPenne.draft.items[0].productName, '');
});

test('fresh tomatoes do not reuse a saved tinned tomato product', () => {
  const result = make('fresh tomato pasta', { preferences: [tomatoes] });
  const tomato = result.draft.items.find(item => item.ingredientId === 'freshTomatoes');
  assert.equal(tomato.name, 'Fresh tomatoes');
  assert.equal(tomato.productName, '');
  assert.equal(result.draft.items.some(item => item.ingredientId === 'tinnedTomatoes'), false);
});

test('explicit serving counts scale ingredients without another question', () => {
  const result = make('tomato pasta for two people', { people: 4 });
  assert.equal(result.draft.people, 2);
  assert.equal(result.draft.items[0].amount, 180);
  assert.equal(make('tomato pasta', { people: 6 }).draft.items[0].amount, 540);
  assert.throws(() => make('tomato pasta for 21 people'), /1 to 20/);
  assert.throws(() => make('tomato pasta', { people: 0 }), /1 to 20/);
});

test('simple breakfast, lunch and dinner recipes fill their own ingredients', () => {
  for (const name of ['scrambled eggs on toast', 'pancakes', 'avocado toast', 'tuna sandwiches', 'chicken wraps', 'egg fried rice', 'fish and rice', 'chicken and potatoes', 'pizza', 'chicken pasta with tomato']) {
    const result = make(name);
    assert.equal(result.draft.items.length >= 2, true, name);
    assert.equal(result.draft.items.every(item => !/beans?/i.test(item.name)), true, name);
  }
});

test('unknown dishes offer concrete choices instead of blank ingredient entry', () => {
  for (const text of ['beef stroganoff', 'chicken', 'surprise me']) {
    const result = menu.createDraft(text, options());
    assert.equal(result.ok, false, text);
    assert.equal(result.draft, undefined);
    assert.equal(result.choices.length >= 1 && result.choices.length <= 3, true);
    assert.equal(result.choices.every(item => item.id && item.name && item.meal), true);
    assert.match(result.reason, /Choose/);
  }
  const choice = menu.createDraft('beef stroganoff', options({ recipeId: 'chicken-rice' }));
  assert.equal(choice.ok, true);
  assert.equal(choice.draft.name, 'Chicken and rice');
});

test('unsupported additions and restrictions cannot silently disappear from a dish', () => {
  for (const text of ['tomato pasta with prawns', 'pizza with pineapple', 'tomato pasta without tomato', 'tomato pasta no cheese', 'tomato pasta gluten free', 'tomato pasta with a nut allergy']) {
    const result = menu.createDraft(text, options());
    assert.equal(result.ok, false, text);
    assert.equal(result.draft, undefined, text);
    assert.equal(result.choices.length, 3, text);
  }
  const noBeans = make('tomato pasta no beans');
  assert.equal(noBeans.draft.items.some(item => /bean/i.test(item.name)), false);
  assert.equal(make('no beans, tomato pasta').draft.recipeId, 'tomato-pasta');
  assert.equal(make('tomato pasta no beans for four people').draft.people, 4);
  assert.equal(menu.createDraft('tomato pasta no beans or tomato', options()).ok, false);
  assert.equal(menu.createDraft('tomato pasta and chicken pasta', options()).ok, false);
});

test('editing quantities or family size resets local approval and preserves the original', () => {
  const draft = make().draft;
  const approved = menu.approveDraft(draft, { now: now + 1000 });
  const before = JSON.stringify(approved);
  const changed = menu.updateDraft(approved, { people: 2 });
  assert.equal(changed.status, 'draft');
  assert.equal(changed.approvedAt, null);
  assert.equal(changed.items[0].amount, 180);
  assert.equal(JSON.stringify(approved), before);
  const unchecked = changed.items.map((item, index) => ({ ...item, included: index !== 0 }));
  const updated = menu.updateDraft(changed, { items: unchecked });
  assert.equal(updated.items[0].included, false);
});

test('approval is a local state change requiring at least one selected ingredient', () => {
  const draft = make().draft;
  const before = JSON.stringify(draft);
  const approved = menu.approveDraft(draft, { now: now + 2000 });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedAt, now + 2000);
  assert.equal(JSON.stringify(draft), before);
  const empty = menu.updateDraft(draft, { items: draft.items.map(item => ({ ...item, included: false })) });
  assert.throws(() => menu.approveDraft(empty, { now }), /at least one/);
  assert.throws(() => menu.approveDraft(draft, { now: now - 1 }), /valid approval time/);
});

test('product preferences are remembered only through the explicit helper call', () => {
  const result = make();
  const original = [];
  const items = result.draft.items.map((item, index) => ({
    ...item, productName: index === 0 ? 'My penne' : index === 1 ? 'My tomatoes' : '',
    store: 'Waitrose', included: index !== 1
  }));
  const draft = menu.updateDraft(result.draft, { items });
  assert.deepEqual(original, []);
  const saved = menu.rememberPreferences(original, draft);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].productName, 'My penne');
  assert.equal(saved[0].source, 'Saved by you in Tidy');
  assert.deepEqual(original, []);
  const replaced = menu.rememberPreferences([penne, tomatoes], draft);
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find(item => item.ingredientId === 'pasta').productName, 'My penne');
  assert.equal(replaced.find(item => item.ingredientId === 'tinnedTomatoes').productName, tomatoes.productName);
});

test('editing a saved product clears remembered provenance until explicitly saved again', () => {
  const draft = make('tomato pasta', { preferences: [penne] }).draft;
  const productChange = menu.updateDraft(draft, { items: draft.items.map((item, index) => index === 0 ? { ...item, productName: 'Different pasta' } : item) });
  assert.equal(productChange.items[0].source, '');
  assert.equal(draft.items[0].source, 'Saved by you in Tidy');
  const cleared = menu.updateDraft(draft, { items: draft.items.map((item, index) => index === 0 ? { ...item, productName: '' } : item) });
  assert.equal(cleared.items[0].source, '');
  assert.equal(cleared.items[0].productName, '');
  const storeChange = menu.updateDraft(draft, { items: draft.items.map((item, index) => index === 0 ? { ...item, store: 'Kibsons' } : item) });
  assert.equal(storeChange.items[0].source, '');
  const amountChange = menu.updateDraft(draft, { items: draft.items.map((item, index) => index === 0 ? { ...item, amount: 400 } : item) });
  assert.equal(amountChange.items[0].source, 'Saved by you in Tidy');
});

test('state validation copies all state and accepts JSON backup round trips', () => {
  const state = { version: 1, people: 4, preferences: [penne], draft: make().draft };
  const checked = menu.validateState(state);
  assert.deepEqual(menu.validateState(JSON.parse(JSON.stringify(checked))), checked);
  checked.preferences[0].productName = 'Changed';
  checked.draft.items[0].amount = 1;
  assert.equal(state.preferences[0].productName, 'Waitrose Penne');
  assert.equal(state.draft.items[0].amount, 360);
});

test('bad quantities, units, duplicate ingredients and malformed approval states are rejected', () => {
  const initial = make().draft;
  for (const amount of [0, -2, NaN, Infinity, 1000001, '12']) {
    assert.throws(() => menu.updateDraft(initial, { items: initial.items.map((item, index) => index === 0 ? { ...item, amount } : item) }), /number greater than zero/);
  }
  assert.throws(() => menu.updateDraft(initial, { items: [{ ...initial.items[0], unit: 'cups' }] }), /g, ml, pieces, or item/);
  assert.throws(() => menu.updateDraft(initial, { items: [initial.items[0], initial.items[0]] }), /Duplicate/);
  assert.throws(() => menu.validateState({ ...menu.emptyState(), draft: { ...initial, status: 'ordered' } }), /status/);
  assert.throws(() => menu.validateState({ ...menu.emptyState(), draft: { ...initial, approvedAt: now } }), /approval time/);
  assert.throws(() => menu.validateState({ ...menu.emptyState(), draft: { ...initial, status: 'approved', approvedAt: null } }), /approval time/);
  assert.throws(() => menu.validateState({ ...menu.emptyState(), draft: { ...initial, recipeId: 'invented' } }), /Unknown recipe/);
});

test('product preferences reject unsupported stores, unsafe URLs, fake history and duplicates', () => {
  const bad = [
    { ...penne, store: 'Amazon' }, { ...penne, url: 'javascript:alert(1)' },
    { ...penne, url: 'http://waitrose.ae/item' }, { ...penne, url: 'https://user:secret@waitrose.ae/' },
    { ...penne, source: 'Your recent Waitrose purchases' }, { ...penne, ingredientId: 'unknown' },
    { ...penne, productName: '' }
  ];
  for (const preference of bad) assert.throws(() => menu.validateState({ ...menu.emptyState(), preferences: [preference] }));
  assert.throws(() => menu.validateState({ ...menu.emptyState(), preferences: [penne, penne] }), /one saved product/);
  const clean = menu.validateState({ ...menu.emptyState(), preferences: [{ ingredientId: 'pasta', productName: 'Penne' }] });
  assert.equal(clean.preferences[0].source, 'Saved by you in Tidy');
});

test('bounded input and plain records protect local backup validation', () => {
  assert.throws(() => menu.createDraft('x'.repeat(1001), options()), /1000/);
  assert.throws(() => menu.validateState({ ...menu.emptyState(), preferences: Array(51).fill(penne) }), /at most 50/);
  assert.throws(() => menu.validateState({ ...menu.emptyState(), version: 2 }), /version/);
  assert.throws(() => menu.validateState([]), /object/);
  let read = false;
  const getter = { version: 1, people: 4, preferences: [], get draft() { read = true; return null; } };
  assert.throws(() => menu.validateState(getter), /data fields/);
  assert.equal(read, false);
});
