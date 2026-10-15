/* Tidy's local data model. No network requests, credentials or external actions. */
(function (root) {
  'use strict';

  const BACKUP_LIMIT = 1024 * 1024;
  const MEAL_LIMIT = 256 * 1024;
  const DAY_MS = 86400000;
  const DUBAI_OFFSET = 4 * 3600000;
  const CATEGORIES = ['Work', 'Home', 'School', 'Shopping', 'Health'];
  const REPEATS = ['none', 'daily', 'weekly', 'weekdays'];
  const ACTION_STATUSES = ['needs_review', 'approved_draft', 'cancelled', 'manually_completed'];
  const MEAL_PLAN_TYPES = ['breakfast', 'lunch'];
  const MEAL_PLAN_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  let sequence = 0;

  function fail(message) { throw new Error(message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object.');
    return value;
  }
  function string(value, fallback, max, label, required) {
    if (value === undefined) value = fallback;
    if (typeof value !== 'string' || value.length > max) fail(label + ' must be text of at most ' + max + ' characters.');
    const result = value.trim();
    if (required && !result) fail(label + ' is required.');
    return result;
  }
  function choice(value, fallback, options, label) {
    if (value === undefined) value = fallback;
    if (!options.includes(value)) fail('Invalid ' + label + '.');
    return value;
  }
  function epoch(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) fail('Invalid ' + label + '.');
    return value;
  }
  function reminderEpoch(value, label) {
    epoch(value, label);
    const year = new Date(value + DUBAI_OFFSET).getUTCFullYear();
    // Reminders must fit the same four-digit Dubai calendar dates that the
    // task editor supports. A valid JavaScript epoch can still overflow after
    // applying Dubai's offset, or produce a year the editor cannot represent.
    if (!Number.isInteger(year) || year < 1 || year > 9999) fail('Invalid ' + label + '; use a Dubai date from years 0001 to 9999.');
    return value;
  }
  function bool(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') fail(label + ' must be true or false.');
    return value;
  }
  function date(value, label, empty) {
    if (empty && (value === undefined || value === '')) return '';
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) fail('Invalid ' + label + '; use YYYY-MM-DD.');
    const parsed = Date.parse(value + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) fail('Invalid calendar date for ' + label + '.');
    return value;
  }
  function time(value, label, empty) {
    if (empty && (value === undefined || value === '')) return '';
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Invalid ' + label + '; use HH:mm.');
    return value;
  }
  function link(value) {
    value = string(value, '', 2048, 'Website link');
    if (!value) return '';
    let parsed;
    try { parsed = new URL(value); } catch (_) { fail('Use a valid HTTPS website link.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) fail('Use an HTTPS website link without embedded credentials.');
    return parsed.href;
  }
  function bytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    let size = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return size;
  }
  function list(value, maximum, label) {
    if (!Array.isArray(value) || value.length > maximum) fail(label + ' must be a list of at most ' + maximum + ' items.');
    return value;
  }
  function unique(items, label) {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) fail('Duplicate ' + label + ' ID.');
      ids.add(item.id);
    }
  }
  function makeId(items, now, prefix) {
    let result;
    do {
      const random = root.crypto && typeof root.crypto.randomUUID === 'function'
        ? root.crypto.randomUUID()
        : Math.random().toString(36).slice(2) + '-' + (++sequence).toString(36);
      result = (prefix || 'task') + '-' + now.toString(36) + '-' + random;
    } while (items.some(item => item.id === result));
    return result;
  }
  function defaults() {
    return {
      schemaVersion: 1,
      members: [{ id: 'mum', name: 'Mum' }, { id: 'dad', name: 'Dad' }, { id: 'child', name: 'Child' }, { id: 'nanny', name: 'Nanny' }],
      tasks: [], actions: [],
      settings: { timezone: 'Asia/Dubai', remindersPaused: false, checkinEnabled: false, checkinTime: '09:00', checkinLastDate: '', healthSquareUrl: '' },
      mealSnapshot: null, mealSummary: []
    };
  }
  function today(now = Date.now()) {
    epoch(now, 'current time');
    return new Date(now + DUBAI_OFFSET).toISOString().slice(0, 10);
  }
  function addDays(value, count) {
    date(value, 'date');
    if (!Number.isInteger(count) || Math.abs(count) > 366000) fail('Invalid number of days.');
    const result = new Date(Date.parse(value + 'T00:00:00.000Z') + count * DAY_MS).toISOString().slice(0, 10);
    return date(result, 'resulting date');
  }
  function dueEpoch(value, clock = '09:00') {
    date(value, 'due date');
    time(clock, 'due time');
    return Date.parse(value + 'T' + clock + ':00.000Z') - DUBAI_OFFSET;
  }
  function cleanTask(input, memberIds) {
    object(input, 'Task');
    const result = {
      id: string(input.id, undefined, 120, 'Task ID', true),
      title: string(input.title, undefined, 300, 'Task title', true),
      category: choice(input.category, 'Home', CATEGORIES, 'task category'),
      assigneeId: input.assigneeId === undefined || input.assigneeId === null ? null : string(input.assigneeId, '', 120, 'Assignee ID', true),
      dueDate: date(input.dueDate, 'due date', true),
      dueTime: time(input.dueTime, 'due time', true),
      remindAt: input.remindAt === undefined || input.remindAt === null ? null : reminderEpoch(input.remindAt, 'reminder time'),
      deliveredReminderAt: input.deliveredReminderAt === undefined || input.deliveredReminderAt === null ? null : reminderEpoch(input.deliveredReminderAt, 'delivered reminder time'),
      priority: choice(input.priority, 'normal', ['normal', 'high'], 'task priority'),
      type: choice(input.type, 'task', ['task', 'appointment', 'grocery'], 'task type'),
      quantity: string(input.quantity, '', 120, 'Quantity'),
      notes: string(input.notes, '', 10000, 'Task notes'),
      link: link(input.link),
      repeat: choice(input.repeat, 'none', REPEATS, 'repeat schedule'),
      status: choice(input.status, 'open', ['open', 'done'], 'task status'),
      createdAt: epoch(input.createdAt, 'creation time'),
      completedAt: input.completedAt === undefined || input.completedAt === null ? null : epoch(input.completedAt, 'completion time')
    };
    if (result.assigneeId !== null && !memberIds.has(result.assigneeId)) fail('This family member does not exist.');
    if (result.dueTime && !result.dueDate) fail('A task with a due time also needs a due date.');
    if (result.repeat !== 'none' && !result.dueDate) fail('A repeating task needs a due date.');
    if (result.status === 'open' && result.completedAt !== null) fail('An open task cannot have a completion time.');
    if (result.status === 'done' && result.completedAt === null) fail('A completed task needs a completion time.');
    if (input.seriesId !== undefined) result.seriesId = string(input.seriesId, '', 120, 'Series ID', true);
    return result;
  }
  function cleanAction(input) {
    object(input, 'Action');
    return {
      id: string(input.id, undefined, 120, 'Action ID', true),
      kind: choice(input.kind, undefined, ['purchase', 'booking', 'message'], 'action kind'),
      title: string(input.title, undefined, 300, 'Action title', true),
      details: string(input.details, '', 10000, 'Action details'),
      provider: string(input.provider, '', 120, 'Provider'),
      link: link(input.link),
      status: choice(input.status, 'needs_review', ACTION_STATUSES, 'action status'),
      createdAt: epoch(input.createdAt, 'action creation time')
    };
  }
  function cleanMealSnapshot(value) {
    if (value === undefined || value === null) return null;
    let nodes = 0;
    const visited = new Set();
    function clone(item, depth) {
      if (++nodes > 20000 || depth > 20) fail('Meal data is too complex.');
      if (item === null || typeof item === 'boolean') return item;
      if (typeof item === 'number') {
        if (!Number.isFinite(item)) fail('Invalid number in meal data.');
        return item;
      }
      if (typeof item === 'string') {
        if (item.length > MEAL_LIMIT) fail('Meal text is too long.');
        return item;
      }
      if (typeof item !== 'object' || visited.has(item)) fail('Meal data must be ordinary JSON without cycles.');
      const prototype = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail('Meal data must be ordinary JSON.');
      visited.add(item);
      let result;
      if (Array.isArray(item)) result = item.map(child => clone(child, depth + 1));
      else {
        result = {};
        for (const key of Object.keys(item)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 200) fail('Invalid meal data key.');
          result[key] = clone(item[key], depth + 1);
        }
      }
      visited.delete(item);
      return result;
    }
    const result = clone(value, 0);
    if (bytes(JSON.stringify(result)) > MEAL_LIMIT) fail('Meal data exceeds the 256 KiB limit.');
    return result;
  }
  function cleanMealPlans(value) {
    function ordinary(input, label) {
      object(input, label);
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) fail(label + ' must be an ordinary object.');
      return input;
    }
    ordinary(value, 'Meal plans');
    const result = {};
    for (const type of MEAL_PLAN_TYPES) {
      const plan = value[type] === undefined ? {} : ordinary(value[type], 'Meal plan');
      result[type] = {};
      for (const day of MEAL_PLAN_DAYS) result[type][day] = string(plan[day], '', 300, 'Meal name');
    }
    return result;
  }
  function validateSnapshot(data) {
    object(data, 'Backup');
    if (data.schemaVersion !== 1) fail('Unsupported backup version.');
    const members = list(data.members, 30, 'Family members').map(member => {
      object(member, 'Family member');
      return { id: string(member.id, undefined, 120, 'Member ID', true), name: string(member.name, undefined, 120, 'Member name', true) };
    });
    if (!members.length) fail('At least one family member is required.');
    unique(members, 'member');
    const memberIds = new Set(members.map(member => member.id));
    const tasks = list(data.tasks, 10000, 'Tasks').map(task => cleanTask(task, memberIds));
    const actions = list(data.actions, 2000, 'Actions').map(cleanAction);
    unique(tasks, 'task'); unique(actions, 'action');
    const inputSettings = data.settings === undefined ? {} : object(data.settings, 'Settings');
    const settings = {
      timezone: choice(inputSettings.timezone, 'Asia/Dubai', ['Asia/Dubai'], 'timezone'),
      remindersPaused: bool(inputSettings.remindersPaused, false, 'Paused reminders'),
      checkinEnabled: bool(inputSettings.checkinEnabled, false, 'Daily check-in'),
      checkinTime: time(inputSettings.checkinTime === undefined ? '09:00' : inputSettings.checkinTime, 'check-in time'),
      checkinLastDate: date(inputSettings.checkinLastDate, 'last check-in date', true),
      healthSquareUrl: link(inputSettings.healthSquareUrl)
    };
    const mealSummary = list(data.mealSummary === undefined ? [] : data.mealSummary, 5, 'Meal summary').map(meal => {
      object(meal, 'Meal summary');
      return { day: string(meal.day, '', 20, 'Meal day', true), name: string(meal.name, '', 120, 'Meal name', true) };
    });
    const result = { schemaVersion: 1, members, tasks, actions, settings, mealSnapshot: cleanMealSnapshot(data.mealSnapshot), mealSummary };
    // Keep old backups byte-for-byte stable: manual breakfast/lunch plans are
    // optional until someone saves one, rather than expanding every old state.
    if (data.mealPlans !== undefined) result.mealPlans = cleanMealPlans(data.mealPlans);
    if (bytes(JSON.stringify(result)) > BACKUP_LIMIT) fail('Backup exceeds the 1 MiB limit.');
    return result;
  }
  function updateMealPlan(state, type, values) {
    object(state, 'State');
    choice(type, undefined, MEAL_PLAN_TYPES, 'meal plan type');
    object(values, 'Meal plan');
    // Validate the whole candidate before assigning anything: an invalid name
    // or a full backup must leave all existing responsibilities recoverable.
    const mealPlans = cleanMealPlans({ ...(state.mealPlans === undefined ? {} : cleanMealPlans(state.mealPlans)), [type]: values });
    const candidate = validateSnapshot({ ...state, mealPlans });
    state.mealPlans = candidate.mealPlans;
    return state.mealPlans[type];
  }
  function stateMembers(state) {
    object(state, 'State');
    list(state.tasks, 10000, 'Tasks');
    return new Set(list(state.members, 30, 'Family members').map(member => member.id));
  }
  function findTask(state, id) {
    stateMembers(state);
    const task = state.tasks.find(item => item.id === id);
    if (!task) fail('Task not found.');
    return task;
  }
  function createMember(state, input, now = Date.now()) {
    stateMembers(state); object(input, 'Family member'); epoch(now, 'current time');
    if (state.members.length >= 30) fail('The household limit of 30 names has been reached.');
    const member = {
      id: input.id === undefined ? makeId(state.members, now, 'person') : string(input.id, undefined, 120, 'Member ID', true),
      name: string(input.name, undefined, 120, 'Member name', true)
    };
    if (state.members.some(item => item.name.trim().toLowerCase() === member.name.toLowerCase())) fail('That household name already exists. Choose a different name so assignments are clear.');
    // Existing or imported duplicate names remain readable. Uniqueness applies
    // only to adding a new name, and the whole candidate is checked first.
    validateSnapshot({ ...state, members: [...state.members, member] });
    state.members.push(member);
    return member;
  }
  function createTask(state, input, now = Date.now()) {
    const memberIds = stateMembers(state);
    object(input, 'Task'); epoch(now, 'current time');
    if (state.tasks.length >= 10000) fail('Task limit reached.');
    const task = cleanTask({ ...input, id: input.id === undefined ? makeId(state.tasks, now) : input.id, status: 'open', createdAt: now, completedAt: null }, memberIds);
    if (state.tasks.some(item => item.id === task.id)) fail('Duplicate task ID.');
    // A valid but oversized in-memory edit would also be impossible to export.
    // Validate the whole candidate before committing; storage failures are handled
    // separately by persist and can still leave recoverable edits in the tab.
    validateSnapshot({ ...state, tasks: [...state.tasks, task] });
    state.tasks.push(task);
    return task;
  }
  function updateTask(state, id, patch, now = Date.now()) {
    const task = findTask(state, id);
    object(patch, 'Task update'); epoch(now, 'current time');
    for (const key of ['id', 'createdAt', 'completedAt', 'status', 'seriesId']) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== task[key]) fail('Use completion or reopening to change task status; task identity is fixed.');
    }
    const next = { ...task, ...patch };
    const scheduleChanged = (patch.dueDate !== undefined && patch.dueDate !== task.dueDate) || (patch.dueTime !== undefined && patch.dueTime !== task.dueTime);
    if (scheduleChanged && !Object.prototype.hasOwnProperty.call(patch, 'remindAt')) next.remindAt = null;
    const reminderChanged = Object.prototype.hasOwnProperty.call(patch, 'remindAt') && patch.remindAt !== task.remindAt;
    if ((scheduleChanged || reminderChanged) && !Object.prototype.hasOwnProperty.call(patch, 'deliveredReminderAt')) next.deliveredReminderAt = null;
    const cleaned = cleanTask(next, stateMembers(state));
    validateSnapshot({ ...state, tasks: state.tasks.map(item => item === task ? cleaned : item) });
    Object.assign(task, cleaned);
    return task;
  }
  function nextDate(task, now) {
    const start = task.dueDate > today(now) ? task.dueDate : today(now);
    if (task.repeat === 'weekly') {
      // A late completion must preserve the family's chosen weekday.
      const elapsedDays = (Date.parse(start + 'T00:00:00.000Z') - Date.parse(task.dueDate + 'T00:00:00.000Z')) / DAY_MS;
      return addDays(task.dueDate, (Math.floor(elapsedDays / 7) + 1) * 7);
    }
    let result = addDays(start, 1);
    if (task.repeat === 'weekdays') {
      while ([0, 6].includes(new Date(result + 'T00:00:00.000Z').getUTCDay())) result = addDays(result, 1);
    }
    return result;
  }
  function completeTask(state, id, now = Date.now()) {
    const task = findTask(state, id); epoch(now, 'current time');
    if (task.status === 'done') return task;
    // Prepare and validate the next occurrence before changing the current task.
    let upcoming = null;
    const seriesId = task.seriesId || task.id;
    if (task.repeat !== 'none') {
      const next = nextDate(task, now);
      // Re-completing an older, reopened occurrence must not create a second
      // active successor just because today's date has advanced since completion.
      const existing = state.tasks.find(item => item.id !== task.id && item.seriesId === seriesId &&
        (item.dueDate === next || (item.status === 'open' && item.dueDate > task.dueDate)));
      if (!existing) {
        if (state.tasks.length >= 10000) fail('Task limit reached; the next occurrence could not be created.');
        const reminder = task.remindAt === null ? null : dueEpoch(next, task.dueTime || '09:00') + task.remindAt - dueEpoch(task.dueDate, task.dueTime || '09:00');
        upcoming = cleanTask({ ...task, id: makeId(state.tasks, now), seriesId, dueDate: next, remindAt: reminder, deliveredReminderAt: null, createdAt: now, completedAt: null, status: 'open' }, stateMembers(state));
      }
    }
    const completed = { ...task, status: 'done', completedAt: now };
    if (task.repeat !== 'none') completed.seriesId = seriesId;
    const tasks = state.tasks.map(item => item === task ? completed : item);
    if (upcoming) tasks.push(upcoming);
    validateSnapshot({ ...state, tasks });
    Object.assign(task, completed);
    if (upcoming) state.tasks.push(upcoming);
    return task;
  }
  function reopenTask(state, id, now = Date.now()) {
    const task = findTask(state, id); epoch(now, 'current time');
    const reopened = { ...task, status: 'open', completedAt: null };
    validateSnapshot({ ...state, tasks: state.tasks.map(item => item === task ? reopened : item) });
    Object.assign(task, reopened);
    // An existing future occurrence stays intact; completing again deduplicates it.
    return task;
  }
  function stopRepeating(state, id) {
    const task = findTask(state, id);
    const seriesId = task.seriesId || task.id;
    const belongsToSeries = item => item.id === seriesId || item.id === task.id || item.seriesId === seriesId;
    const tasks = state.tasks.map(item => belongsToSeries(item) ? { ...item, repeat: 'none' } : item);
    validateSnapshot({ ...state, tasks });
    // Historical occurrences must also stop: reopening an old completed item
    // must not silently start the stopped routine again.
    for (const item of state.tasks) if (belongsToSeries(item)) item.repeat = 'none';
    return task;
  }
  function deleteTask(state, id) {
    const task = findTask(state, id);
    state.tasks.splice(state.tasks.indexOf(task), 1);
    return task;
  }
  function dueReminders(state, now = Date.now()) {
    epoch(now, 'current time'); stateMembers(state);
    if (state.settings && state.settings.remindersPaused) return [];
    return state.tasks.filter(task => task.status === 'open' && task.remindAt !== null && task.remindAt <= now && task.deliveredReminderAt !== task.remindAt)
      .sort((a, b) => a.remindAt - b.remindAt);
  }
  function backupJSON(state) {
    // Keep the exact same byte accounting as import validation and persistence.
    const text = JSON.stringify(validateSnapshot(state));
    if (bytes(text) > BACKUP_LIMIT) fail('Backup exceeds the 1 MiB limit.');
    return text;
  }
  function parseBackup(text) {
    if (typeof text !== 'string' || bytes(text) > BACKUP_LIMIT) fail('Backup must be JSON text of at most 1 MiB.');
    let data;
    try { data = JSON.parse(text); } catch (_) { fail('The backup is not valid JSON.'); }
    return validateSnapshot(data);
  }
  function persist(storage, state, key = 'tidy.app.v1') {
    if (!storage || typeof storage.setItem !== 'function') fail('Local saving is unavailable. Export a backup before closing Tidy.');
    const text = backupJSON(state);
    try { storage.setItem(key, text); }
    catch (_) { fail('Tidy could not save locally. Storage may be full or unavailable; export a backup.'); }
    return true;
  }
  function persistIfUnchanged(storage, state, expectedText, key = 'tidy.app.v1') {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') fail('Local saving is unavailable. Export a backup before closing Tidy.');
    const text = backupJSON(state);
    let current;
    try { current = storage.getItem(key); } catch (_) { fail('Tidy could not read local storage. Export a backup before closing.'); }
    if (current !== expectedText) {
      const problem = new Error('Another tab changed the saved data. Your changes remain in this tab; export a backup before closing.');
      problem.code = 'TIDY_STORAGE_CONFLICT';
      throw problem;
    }
    try { storage.setItem(key, text); }
    catch (_) { fail('Tidy could not save locally. Storage may be full or unavailable; export a backup.'); }
    return text;
  }
  function load(storage, key = 'tidy.app.v1') {
    if (!storage || typeof storage.getItem !== 'function') fail('Local storage is unavailable.');
    let text;
    try { text = storage.getItem(key); } catch (_) { fail('Tidy could not read local storage.'); }
    if (text === null || text === undefined) return null;
    return parseBackup(text);
  }

  const api = Object.freeze({ defaults, today, addDays, dueEpoch, createMember, createTask, updateTask, completeTask, reopenTask, stopRepeating, deleteTask, dueReminders, updateMealPlan, validateSnapshot, backupJSON, parseBackup, persist, persistIfUnchanged, load });
  root.TidyCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
