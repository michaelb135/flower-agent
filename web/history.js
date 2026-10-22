/* Local change summaries for Ask Tidy. No network access or external actions. */
(function (root) {
  'use strict';
  const MAX_ENTRIES = 500;
  const SECTIONS = ['Tasks', 'Groceries', 'Appointments', 'Menu', 'Household', 'Requests', 'Settings', 'Calendar', 'Planning', 'Backup'];
  const ROUTES = ['family', 'shopping', 'appointments', 'meals', 'household', 'requests', 'calendar', 'planning', 'planning-settings', 'assistant'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function fail(message) { throw new Error(message); }
  function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object.');
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail(label + ' must be plain data.');
    for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value')) fail(label + ' must contain data fields.');
    return value;
  }
  function text(value, fallback, limit, label, required) {
    if (value === undefined) value = fallback;
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(label + ' must be text of at most ' + limit + ' characters.');
    value = value.trim();
    if (required && !value) fail(label + ' is required.');
    return value;
  }
  function dataArray(value, maximum, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail(label + ' must be a plain list of at most ' + maximum + ' items.');
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail(label + ' must contain only list items.');
      if (!Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value')) fail(label + ' must contain data fields.');
    }
    if (Object.keys(value).length !== value.length) fail(label + ' cannot contain missing items.');
    return value;
  }
  function epoch(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail('Invalid history time.');
    return value;
  }
  function emptyHistory() { return { version: 1, entries: [], olderCount: 0 }; }
  function validateHistory(input) {
    record(input, 'Activity history');
    if (input.version !== 1) fail('Unsupported activity history version.');
    const entries = dataArray(input.entries, MAX_ENTRIES, 'Activity history').map(raw => {
      record(raw, 'History entry');
      if (!SECTIONS.includes(raw.section) || !ROUTES.includes(raw.route)) fail('Invalid history section or destination.');
      return { id: text(raw.id, undefined, 160, 'History ID', true), at: epoch(raw.at), section: raw.section,
        title: text(raw.title, undefined, 360, 'History title', true), details: text(raw.details, '', 500, 'History details'), route: raw.route };
    });
    if (new Set(entries.map(item => item.id)).size !== entries.length) fail('Duplicate activity history ID.');
    const olderCount = input.olderCount === undefined ? 0 : input.olderCount;
    if (!Number.isSafeInteger(olderCount) || olderCount < 0) fail('Invalid older history count.');
    return { version: 1, entries, olderCount };
  }
  function inline(value, limit = 300) { return String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit); }
  const quote = value => '“' + inline(value) + '”';
  function hash(value) {
    let a = 2166136261, b = 2246822519;
    for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); a = Math.imul(a ^ code, 16777619); b = Math.imul(b ^ code, 3266489917); }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  function safeTree(value, depth = 0, seen = new Set(), count = { nodes: 0 }) {
    if (++count.nodes > 150000 || depth > 45) fail('History comparison data is too complex.');
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Invalid history comparison number.'); return value; }
    if (typeof value !== 'object' || seen.has(value)) fail('History comparison needs ordinary, acyclic data.');
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      dataArray(value, 15000, 'History comparison');
      result = value.map(item => safeTree(item, depth + 1, seen, count));
    } else {
      record(value, 'History comparison'); result = {};
      for (const key of Object.keys(value).sort()) if (key !== 'activityHistory') Object.defineProperty(result, key, { value: safeTree(value[key], depth + 1, seen, count), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(value); return result;
  }
  function diff(before, after, options = {}) {
    record(before, 'Previous Tidy data'); record(after, 'Current Tidy data'); record(options, 'History options');
    const old = safeTree(before), next = safeTree(after), now = epoch(options.now === undefined ? Date.now() : options.now);
    const prior = before.activityHistory === undefined ? emptyHistory() : validateHistory(before.activityHistory);
    const tail = prior.entries.length ? prior.entries[prior.entries.length - 1].id : 'start-' + prior.olderCount;
    const changes = [];
    function add(section, route, title, details, key, previous, current) {
      const identity = tail + '\n' + key + '\n' + JSON.stringify(previous) + '\n' + JSON.stringify(current);
      const entry = { id: 'change-' + hash(identity), at: now, section, title: inline(title, 360), details: inline(details, 500), route };
      if (options.idFactory !== undefined) { if (typeof options.idFactory !== 'function') fail('History ID factory must be a function.'); entry.id = options.idFactory(changes.length, { ...entry }); }
      changes.push(entry);
    }
    function rows(value, label) {
      if (value === undefined) return [];
      if (!Array.isArray(value)) fail(label + ' must be a list.');
      return value;
    }
    function compareRows(field, handler) {
      const first = new Map(rows(old[field], field).map(item => [item.id, item]));
      const second = new Map(rows(next[field], field).map(item => [item.id, item]));
      for (const [id, item] of first) handler(item, second.get(id), id);
      for (const [id, item] of second) if (!first.has(id)) handler(undefined, item, id);
    }
    const taskFields = ['title', 'category', 'assigneeId', 'dueDate', 'dueTime', 'remindAt', 'priority', 'type', 'quantity', 'notes', 'link', 'repeat', 'status', 'seriesId', 'durationMinutes', 'planningReason'];
    const taskValue = task => task && Object.fromEntries(taskFields.map(key => [key, task[key]]));
    compareRows('tasks', (a, b, id) => {
      const first = taskValue(a), second = taskValue(b); if (same(first, second)) return;
      const item = b || a, kind = item.type === 'grocery' ? ['grocery item', 'Groceries', 'shopping'] : item.type === 'appointment' ? ['appointment record', 'Appointments', 'appointments'] : ['task', 'Tasks', 'family'];
      let verb = !a ? 'Added' : !b ? 'Removed' : a.status !== b.status ? b.status === 'done' ? 'Completed' : 'Reopened' : 'Edited';
      const details = [];
      if (a && b) {
        if (a.title !== b.title) details.push('Previously ' + quote(a.title));
        if (a.quantity !== b.quantity) details.push('Quantity: ' + (inline(b.quantity, 120) || 'not specified'));
        if (a.dueDate !== b.dueDate) details.push('Date: ' + (b.dueDate || 'not set'));
        if (a.dueTime !== b.dueTime) details.push('Time: ' + (b.dueTime || 'not set'));
        if (a.remindAt !== b.remindAt) details.push(b.remindAt === null || b.remindAt === undefined ? 'Reminder removed' : 'Reminder updated');
        if (a.assigneeId !== b.assigneeId) details.push('Assigned to: ' + ((next.members || []).find(member => member.id === b.assigneeId)?.name || 'Unassigned'));
        for (const [key, label] of [['category', 'Category'], ['priority', 'Priority'], ['repeat', 'Repeat schedule']]) if (a[key] !== b[key]) details.push(label + ': ' + inline(b[key], 80));
        if (a.notes !== b.notes) details.push('Notes changed'); if (a.link !== b.link) details.push('Website link changed');
        if (a.type !== b.type) details.push('Record type changed');
        if (a.durationMinutes !== b.durationMinutes || a.planningReason !== b.planningReason) details.push('Planning details changed');
      } else if (b) {
        if (b.quantity) details.push('Quantity: ' + inline(b.quantity, 120));
        if (b.dueDate) details.push('Date: ' + b.dueDate + (b.dueTime ? ' at ' + b.dueTime : ''));
      }
      if (item.type === 'appointment') details.push('Local record; no provider booking confirmed');
      add(kind[1], kind[2], verb + ' ' + kind[0] + ' ' + quote(item.title), details.join('; '), 'task:' + id, first, second);
    });
    compareRows('members', (a, b, id) => {
      if (same(a, b)) return;
      add('Household', 'household', (!a ? 'Added household name ' : !b ? 'Removed household name ' : 'Renamed household member to ') + quote((b || a).name), a && b ? 'Previously ' + quote(a.name) : 'Names are local assignment labels.', 'member:' + id, a, b);
    });
    compareRows('actions', (a, b, id) => {
      if (same(a, b)) return;
      const item = b || a, kind = item.kind === 'booking' ? 'appointment' : item.kind;
      const statuses = { approved_draft: 'Approved ' + kind + ' draft ', cancelled: 'Discarded ' + kind + ' draft ', manually_completed: 'Marked ' + kind + ' draft completed outside Tidy ', needs_review: 'Reopened ' + kind + ' draft ' };
      const title = !a ? 'Prepared ' + kind + ' draft ' : !b ? 'Removed ' + kind + ' draft ' : a.status !== b.status ? statuses[b.status] || 'Updated request draft ' : 'Edited ' + kind + ' draft ';
      add('Requests', item.kind === 'booking' ? 'appointments' : 'requests', title + quote(item.title), item.status === 'manually_completed' ? 'Completion was marked manually; Tidy has not verified it with the provider.' : 'Draft record only; Tidy has not sent, purchased or booked anything.', 'action:' + id, a, b);
    });
    const settings = old.settings || {}, newSettings = next.settings || {};
    for (const [key, title] of [['remindersPaused', 'Changed reminder pause setting'], ['checkinEnabled', 'Changed daily check-ins'], ['checkinTime', 'Changed daily check-in time'], ['healthSquareUrl', 'Changed clinic website']]) if (!same(settings[key], newSettings[key])) {
      const detail = key === 'healthSquareUrl' ? (newSettings[key] ? 'Clinic website saved.' : 'Clinic website removed.') : key === 'checkinTime' ? 'Check-in time: ' + inline(newSettings[key], 20) + ' Dubai time.' : key === 'remindersPaused' ? (newSettings[key] ? 'Reminders paused.' : 'Reminders resumed while Tidy is open.') : (newSettings[key] ? 'Daily check-ins enabled.' : 'Daily check-ins disabled.');
      add('Settings', key === 'healthSquareUrl' ? 'appointments' : 'assistant', title, detail, 'setting:' + key, settings[key], newSettings[key]);
    }
    for (const type of ['breakfast', 'lunch']) for (const day of DAYS) {
      const a = old.mealPlans?.[type]?.[day] || '', b = next.mealPlans?.[type]?.[day] || '';
      if (a !== b) add('Menu', 'meals', (b ? 'Saved ' : 'Cleared ') + day + ' ' + type, b ? 'Meal: ' + inline(b, 300) : 'The weekday meal choice was removed.', 'mealPlan:' + type + ':' + day, a, b);
    }
    const oldMenu = old.menuHelper || {}, newMenu = next.menuHelper || {}, aDraft = oldMenu.draft || null, bDraft = newMenu.draft || null;
    function draftValue(draft) {
      if (!draft) return null;
      return { id: draft.id, request: draft.request, recipeId: draft.recipeId, name: draft.name, people: draft.people, status: draft.status, approvedAt: draft.approvedAt,
        items: (draft.items || []).map(item => Object.fromEntries(['ingredientId', 'name', 'amount', 'unit', 'productName', 'store', 'url', 'included'].map(key => [key, item[key]]))) };
    }
    const aValue = draftValue(aDraft), bValue = draftValue(bDraft);
    if (!same(aValue, bValue)) {
      const item = bDraft || aDraft; let title;
      if (!bDraft) title = 'Removed current meal ';
      else if (!aDraft || aDraft.id !== bDraft.id) title = aDraft ? 'Replaced current meal with ' : 'Prepared meal ingredients for ';
      else if (bDraft.status === 'approved' && (aDraft.status !== bDraft.status || aDraft.approvedAt !== bDraft.approvedAt)) title = 'Confirmed meal grocery draft for ';
      else title = 'Edited meal groceries for ';
      const details = bDraft ? [bDraft.people + (bDraft.people === 1 ? ' person.' : ' people.'), bDraft.status === 'approved' ? 'Shopping draft confirmed; no order placed.' : 'Editable ingredient draft; approval still required.'] : ['The current meal list was removed.'];
      if (aDraft && bDraft && aDraft.id === bDraft.id && !same(aValue.items, bValue.items)) details.push('Ingredients, amounts, inclusion or product choices changed.');
      if (aDraft && bDraft && aDraft.status === 'approved' && bDraft.status !== 'approved') details.push('Previous approval removed for review.');
      add('Menu', 'meals', title + quote(item.name), details.join(' '), 'menu:draft', aValue, bValue);
    } else if ((oldMenu.people || 4) !== (newMenu.people || 4)) add('Menu', 'meals', 'Changed meal serving default', 'People: ' + newMenu.people, 'menu:people', oldMenu.people || 4, newMenu.people || 4);
    const prefs = menu => (menu.preferences || []).map(item => Object.fromEntries(['ingredientId', 'productName', 'store', 'url'].map(key => [key, item[key]])));
    if (!same(prefs(oldMenu), prefs(newMenu))) add('Menu', 'meals', newMenu.preferences?.length ? 'Saved usual product choices' : 'Removed saved product choices', 'Product preferences saved in Tidy; this is not retailer purchase history.', 'menu:preferences', prefs(oldMenu), prefs(newMenu));
    function legacyValue(value) {
      if (!value) return null;
      const result = JSON.parse(JSON.stringify(value));
      if (result.state) for (const key of ['version', 'step', 'preferencesDirty']) delete result.state[key];
      return result;
    }
    function legacyMeaningful(value) {
      if (!value) return false;
      const state = value.state || {}, answers = value.answers || {}, drafts = value.drafts || {};
      const changedDefault = (key, initial) => answers[key] !== undefined && answers[key] !== initial;
      return Boolean(state.prefs || state.menu?.length || state.menuApproved || state.draftApproved || state.pantryReviewed || state.paused || state.delivery || state.extras?.length || Object.keys(state.pantry || {}).length || answers.people || answers.diet || answers.noAllergies || answers.allergies?.length || answers.budget || changedDefault('maxTime', '30') || changedDefault('gymNights', true) || changedDefault('shop', 'Kibsons') || changedDefault('checkinDay', 'Sunday') || changedDefault('checkinTime', '17:00') || value.customIngredientNumber || drafts.mealRequest || drafts.extraInput || drafts.pantryConfirm || Object.keys(drafts.stockInputs || {}).length);
    }
    if (!same(legacyValue(old.mealSnapshot), legacyValue(next.mealSnapshot)) && (legacyMeaningful(old.mealSnapshot) || legacyMeaningful(next.mealSnapshot))) {
      const a = old.mealSnapshot?.state || {}, b = next.mealSnapshot?.state || {};
      const title = !next.mealSnapshot ? 'Removed weekday dinner plan' : !a.draftApproved && b.draftApproved ? 'Confirmed weekday meal grocery draft' : !a.menuApproved && b.menuApproved ? 'Approved weekday dinner menu' : 'Updated weekday dinner planner';
      add('Menu', 'meals', title, b.draftApproved ? 'Shopping draft confirmed; no order placed.' : 'Saved changes to the weekday meal planner.', 'menu:weekday', legacyValue(old.mealSnapshot), legacyValue(next.mealSnapshot));
    }
    if (!same(old.planningProfile, next.planningProfile)) add('Planning', 'planning-settings', next.planningProfile?.enabled ? 'Saved planning hours and preferences' : 'Changed planning hours and preferences', next.planningProfile?.enabled ? 'Automatic task planning enabled with your confirmed hours.' : 'Planning setup changed; automatic scheduling is not enabled.', 'planningProfile', old.planningProfile, next.planningProfile);
    if (!same(old.calendar, next.calendar)) {
      const label = !next.calendar ? 'Removed saved calendar snapshot' : !old.calendar ? 'Imported calendar commitments' : 'Refreshed saved calendar commitments';
      add('Calendar', 'calendar', label, next.calendar ? (next.calendar.events || []).length + ' saved events. This history does not copy event details or account credentials.' : 'The original calendar was not changed.', 'calendar', old.calendar, next.calendar);
    }
    if (new Set(changes.map(item => item.id)).size !== changes.length) fail('Duplicate generated history ID.');
    return changes.map(entry => validateHistory({ version: 1, entries: [entry], olderCount: 0 }).entries[0]);
  }
  function trim(input, count = 1) {
    const history = validateHistory(input);
    if (!Number.isInteger(count) || count < 0 || count > MAX_ENTRIES) fail('Invalid history trim count.');
    const removed = Math.min(count, history.entries.length);
    if (history.olderCount > Number.MAX_SAFE_INTEGER - removed) fail('Older history count is too large.');
    return { version: 1, entries: history.entries.slice(removed), olderCount: history.olderCount + removed };
  }
  function append(before, after, options = {}) {
    const changes = diff(before, after, options);
    if (!changes.length && before.activityHistory === undefined && after.activityHistory === undefined) return undefined;
    if (options.mergeHistories !== undefined && typeof options.mergeHistories !== 'boolean') fail('History merge option must be true or false.');
    const previous = before.activityHistory === undefined ? emptyHistory() : validateHistory(before.activityHistory);
    const incoming = after.activityHistory === undefined ? previous : validateHistory(after.activityHistory);
    // Ordinary writes use the current history, including any deliberate pruning
    // needed to keep the business data within its backup budget. Only restore
    // explicitly unions imported summaries with this browser's previous log.
    const history = options.mergeHistories ? { version: 1, entries: previous.entries.slice(), olderCount: Math.max(previous.olderCount, incoming.olderCount) } : incoming;
    const known = new Set(history.entries.map(item => item.id));
    let imported = false;
    if (options.mergeHistories) for (const entry of incoming.entries) if (!known.has(entry.id)) { history.entries.push(entry); known.add(entry.id); imported = true; }
    if (imported) history.entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    for (const entry of changes) if (!known.has(entry.id)) { history.entries.push(entry); known.add(entry.id); }
    const limit = options.maxEntries === undefined ? MAX_ENTRIES : options.maxEntries;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ENTRIES) fail('History limit must be from 1 to 500.');
    const remove = Math.max(0, history.entries.length - limit);
    if (history.olderCount > Number.MAX_SAFE_INTEGER - remove) fail('Older history count is too large.');
    history.entries = history.entries.slice(remove); history.olderCount += remove;
    return validateHistory(history);
  }
  const api = Object.freeze({ emptyHistory, validateHistory, diff, append, trim });
  root.TidyHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
