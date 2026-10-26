/* Atomic local meal, grocery and reminder changes. No retailer operations. */
(function (root) {
  'use strict';

  function models() {
    const node = typeof module !== 'undefined' && module.exports;
    const core = node ? require('./core.js') : root.TidyCore;
    const menu = node ? require('./menu-helper.js') : root.TidyMenuHelper;
    if (!core || !menu) throw new Error('Reload Tidy before preparing this meal.');
    return { core, menu };
  }
  function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(label + ' must be plain data.');
    for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error(label + ' must contain data fields.');
    return value;
  }
  function groceryKey(value) {
    return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim() : '';
  }
  function ingredientKeys(item) {
    return new Set([groceryKey(item.name), groceryKey(item.productName)].filter(Boolean));
  }
  function matchingGroceries(state, item) {
    const keys = ingredientKeys(item);
    return state.tasks.filter(task => task.type === 'grocery' && task.status === 'open' && keys.has(groceryKey(task.title)));
  }
  function notesFor(item, draft) {
    const parts = ['For ' + draft.name + '.'];
    if (item.productName) parts.push('Product choice: ' + item.productName + '.');
    if (item.store) parts.push('Shop: ' + item.store + '.');
    if (item.source) parts.push(item.source + '.');
    return parts.join(' ');
  }
  function prepareMealChanges(state, request, options) {
    record(request, 'Meal actions');
    options = options === undefined ? {} : record(options, 'Meal action options');
    const { core, menu } = models(), now = options.now === undefined ? Date.now() : options.now;
    if (!Number.isSafeInteger(now) || now < Date.parse('0001-01-02T00:00:00Z') || now > Date.parse('9999-12-30T00:00:00Z')) throw new Error('The current time is unavailable. Try again.');
    if (request.addGroceries !== undefined && typeof request.addGroceries !== 'boolean') throw new Error('Choose whether to add meal groceries.');
    // Validation creates independent snapshots. No caller-owned object is changed,
    // including when a later reminder or the complete backup fails validation.
    const old = core.validateChangeSnapshot(state);
    const priorMenu = menu.validateState(old.menuHelper || menu.emptyState());
    const checkedDraft = menu.validateState({ ...menu.emptyState(), draft: request.draft }).draft;
    if (!checkedDraft) throw new Error('Choose a meal before preparing its actions.');
    const draft = menu.updateDraft(checkedDraft, {});
    let candidate = core.validateChangeSnapshot({ ...old, menuHelper: { ...priorMenu, people: draft.people, draft } });
    const summary = { addedGroceryIds: [], keptGroceryIds: [], quantityDifferences: [], reminderId: null, reminderExisting: false };
    if (request.addGroceries) {
      for (const item of draft.items.filter(ingredient => ingredient.included)) {
        const quantity = item.amount + ' ' + item.unit;
        const matches = matchingGroceries(candidate, item);
        if (matches.length) {
          for (const existing of matches) {
            if (!summary.keptGroceryIds.includes(existing.id)) summary.keptGroceryIds.push(existing.id);
            if (!existing.quantity) core.updateTask(candidate, existing.id, { quantity }, now);
            else if (groceryKey(existing.quantity) !== groceryKey(quantity)) summary.quantityDifferences.push({ id: existing.id, title: existing.title, existingQuantity: existing.quantity, suggestedQuantity: quantity });
          }
        } else {
          const added = core.createTask(candidate, { title: item.name, category: 'Shopping', type: 'grocery', quantity, link: item.url, notes: notesFor(item, draft) }, now);
          summary.addedGroceryIds.push(added.id);
        }
      }
    }
    if (request.reminderDraft !== undefined && request.reminderDraft !== null) {
      const reminder = record(request.reminderDraft, 'Cooking reminder');
      if (reminder.type !== undefined && reminder.type !== 'task' || reminder.repeat !== undefined && reminder.repeat !== 'none' || reminder.status !== undefined && reminder.status !== 'open') throw new Error('Choose a one-time local cooking reminder.');
      if (!reminder.dueDate || !reminder.dueTime || !Number.isSafeInteger(reminder.remindAt) || reminder.remindAt <= now || reminder.remindAt !== core.dueEpoch(reminder.dueDate, reminder.dueTime)) throw new Error('Choose an exact future date and time for the cooking reminder.');
      // Validate every supplied field even when an identical reminder already
      // exists, rather than letting the duplicate path bypass task validation.
      const validation = core.defaults();
      validation.members = candidate.members.map(member => ({ ...member }));
      const cleaned = core.createTask(validation, reminder, now);
      const existing = candidate.tasks.find(task => task.type === 'task' && task.status === 'open' && task.repeat === 'none' && groceryKey(task.title) === groceryKey(cleaned.title) && task.dueDate === cleaned.dueDate && task.dueTime === cleaned.dueTime && task.remindAt === cleaned.remindAt);
      if (existing) { summary.reminderId = existing.id; summary.reminderExisting = true; }
      else summary.reminderId = core.createTask(candidate, reminder, now).id;
    }
    candidate = core.validateChangeSnapshot(candidate);
    return { state: candidate, summary };
  }
  function visibleMealItems(state, items) {
    if (!state || !Array.isArray(state.tasks) || !state.menuHelper || !state.menuHelper.draft || state.menuHelper.draft.status !== 'approved') return [];
    if (!Array.isArray(items) || items.length > 30) throw new Error('Meal ingredients must be a short list.');
    return items.filter(item => {
      record(item, 'Meal ingredient');
      return item.included !== false && !matchingGroceries(state, item).length;
    }).map(item => ({ ...item }));
  }

  const api = Object.freeze({ prepareMealChanges, groceryKey, visibleMealItems });
  root.TidyAssistantWorkflow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
