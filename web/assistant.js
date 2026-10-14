/* Tidy's local capture helper. This uses explicit rules, not an AI service.
 * Parsing never saves, sends, purchases, books, or reads another application.
 * Render user-provided strings as text, never as HTML.
 */
(function (root) {
  'use strict';

  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const CATEGORY_NAMES = ['Work', 'Home', 'School', 'Shopping', 'Health'];
  const GROCERY_WORDS = /\b(?:ketchup|milk|bread|eggs?|rice|pasta|chicken|fish|potatoes?|tomatoes?|cheese|butter|yogu?rt|fruit|apples?|bananas?|onions?|carrots?|salt|pepper|oil|flour|sugar|tea|coffee|water|juice|cereal|lettuce|cucumber|garlic|soap|toilet paper|tissues|detergent)\b/i;
  const pad = (n) => String(n).padStart(2, '0');
  const escapeRE = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function today(now) {
    if (root.TidyCore && root.TidyCore.today) return root.TidyCore.today(now);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(now));
    const part = (name) => parts.find((p) => p.type === name).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function addDays(date, n) {
    if (root.TidyCore && root.TidyCore.addDays) return root.TidyCore.addDays(date, n);
    const stamp = new Date(`${date}T12:00:00Z`);
    stamp.setUTCDate(stamp.getUTCDate() + n);
    return stamp.toISOString().slice(0, 10);
  }

  function dueEpoch(date, time) {
    if (root.TidyCore && root.TidyCore.dueEpoch) return root.TidyCore.dueEpoch(date, time);
    return new Date(`${date}T${time}:00+04:00`).getTime();
  }

  function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) return false;
    const stamp = new Date(`${date}T12:00:00Z`);
    return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === date;
  }

  function baseDraft() {
    return {
      title: '', category: 'Home', assigneeId: null, dueDate: '', dueTime: '',
      remindAt: null, priority: 'normal', type: 'task', quantity: '', notes: '',
      link: '', repeat: 'none'
    };
  }

  function clarify(message, draft, missing) {
    const result = { kind: 'clarify', message, missing: missing || [] };
    if (draft) result.draft = draft;
    return result;
  }

  function temporal(text, dateToday) {
    const spans = [];
    const dates = [];
    const times = [];
    const problems = [];
    const repeats = [];
    const remove = (match) => spans.push([match.index, match.index + match[0].length]);
    const recurrenceRE = /\b(?:every weekday|weekdays|every day|daily|every week|weekly|monday to friday)\b/gi;
    for (const match of text.matchAll(recurrenceRE)) {
      repeats.push(/weekday|monday to friday/i.test(match[0]) ? 'weekdays' : /day|daily/i.test(match[0]) ? 'daily' : 'weekly');
      remove(match);
    }
    if (/\bevery\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)) {
      repeats.push('weekly');
    }
    if (new Set(repeats).size > 1) problems.push('Choose one repeat pattern: daily, weekdays, or weekly.');
    if (/\b(?:monthly|every month|yearly|every year|fortnightly|every other|every \d+ (?:days?|weeks?))\b/i.test(text)) {
      problems.push('That repeat pattern is not supported yet. Choose daily, weekdays, or weekly.');
    }
    if (/\b(?:day after tomorrow|next week|next month|next weekend|this weekend|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(text)) {
      problems.push('Please use a calendar date, today, tomorrow, or a weekday without “next”.');
    }
    const withinRemoved = (index) => spans.some(([start, end]) => index >= start && index < end);
    const dateRE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
    for (const match of text.matchAll(dateRE)) {
      if (withinRemoved(match.index)) continue;
      const token = match[0].toLowerCase();
      if (/^\d/.test(token)) {
        if (validDate(token)) dates.push(token);
        else problems.push('That calendar date is not valid. Please choose a real date.');
      } else if (token === 'today') dates.push(dateToday);
      else if (token === 'tomorrow') dates.push(addDays(dateToday, 1));
      else if (token === 'yesterday') dates.push(addDays(dateToday, -1));
      else {
        const current = new Date(`${dateToday}T12:00:00Z`).getUTCDay();
        dates.push(addDays(dateToday, (WEEKDAYS.indexOf(token) - current + 7) % 7));
      }
      remove(match);
    }
    // Slash dates and short numeric dates have locale-dependent meanings.
    if (/\b\d{1,4}[/.]\d{1,2}(?:[/.]\d{1,4})?\b/.test(text)) {
      problems.push('Please enter the date as YYYY-MM-DD so the day and month are clear.');
    }
    const timeRE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight)\b/gi;
    const timeSpans = [];
    for (const match of text.matchAll(timeRE)) {
      let hours;
      let minutes;
      let valid = true;
      if (match[6]) {
        hours = match[6].toLowerCase() === 'noon' ? 12 : 0;
        minutes = 0;
      } else if (match[3]) {
        hours = Number(match[1]);
        minutes = Number(match[2] || '0');
        valid = hours >= 1 && hours <= 12 && minutes < 60;
        hours = hours % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
      } else {
        hours = Number(match[4]);
        minutes = Number(match[5]);
        valid = hours < 24 && minutes < 60;
      }
      if (valid) times.push(`${pad(hours)}:${pad(minutes)}`);
      else problems.push('That time is not valid. Use a time such as 3 pm or 15:30.');
      remove(match);
      timeSpans.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(/\bat\s+(\d{1,2})(?:[:.]\d{1,2})?/gi)) {
      const numberIndex = match.index + match[0].indexOf(match[1]);
      if (!timeSpans.some(([start, end]) => numberIndex >= start && numberIndex < end)) {
        problems.push('Please specify an unambiguous time, such as 3 pm or 15:00.');
      }
    }
    // A foreign clock label is a request to convert time, which this local
    // helper cannot do. Also catch named zones next to a clock reading instead
    // of interpreting the time as Dubai and leaving the zone in the title.
    const foreignClockLabel = timeSpans.some(([, end]) => {
      const label = text.slice(end).match(/^\s*(?:in\s+)?([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,2})\s+time\b/iu);
      return label && !/^Dubai$/i.test(label[1]);
    });
    const foreignZone = foreignClockLabel || /\b(?:GMT|UTC|EST|EDT|PST|PDT|BST|CET|CEST|EET|EEST|IST|CST|CDT|MST|MDT|AEST|AEDT|JST|SGT|HKT|London time|New York time|Pacific time|Eastern time|Central time|Mountain time|India time|Indian time)\b/i.test(text) || /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/.test(text);
    if (foreignZone) {
      problems.push('This demo uses Dubai time. Please enter the equivalent Dubai date and time.');
    }
    for (const match of text.matchAll(/\b(?:in\s+)?Dubai\s+time\b/gi)) remove(match);
    // Lead times and approximate clock readings require a decision from the
    // person entering them; keeping only the clock would schedule a wrong alert.
    const duration = '(?:\\d+(?:\\.\\d+)?|one|two|three|an?|half(?:\\s+an?)?|a quarter(?:\\s+of\\s+an?)?)\\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)';
    const offset = new RegExp(`\\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\\s+(?:before|after|early|earlier|later|ahead(?:\\s+of)?)\\b|\\b(?:in|before|after)\\s+${duration}\\b`, 'i');
    const approximateClock = timeSpans.some(([start]) => /\b(?:before|after|by|around|about)\s*$/i.test(text.slice(0, start)));
    const unsupportedClock = timeSpans.length && (offset.test(text) || approximateClock);
    if (unsupportedClock) {
      problems.push('I cannot apply a reminder lead time or an approximate time yet. Please enter the exact reminder date and time in Dubai time.');
    }
    if (new Set(dates).size > 1) problems.push('I found different dates. Which single date should I use?');
    if (new Set(times).size > 1) problems.push('I found different times. Which single time should I use?');
    let title = text;
    for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
      title = title.slice(0, start) + ' ' + title.slice(end);
    }
    title = title.replace(/\b(?:on|at|for|every)\s*(?=[,.;!?]|$)/gi, '')
      .replace(/\s+/g, ' ').replace(/^[\s,:;.]+|[\s,:;.!?]+$/g, '').trim();
    return {
      dueDate: new Set(dates).size === 1 ? dates[0] : '',
      dueTime: !foreignZone && !unsupportedClock && new Set(times).size === 1 ? times[0] : '',
      repeat: new Set(repeats).size === 1 ? repeats[0] : 'none', title,
      problems: Array.from(new Set(problems))
    };
  }

  function parse(input, options) {
    const opts = options || {};
    const now = opts.now === undefined ? Date.now() : Number(opts.now);
    if (!Number.isSafeInteger(now) || now < Date.parse('0001-01-02T00:00:00Z') || now > Date.parse('9999-12-30T00:00:00Z')) {
      return clarify('The current time is unavailable. Please try again.');
    }
    if (typeof input !== 'string' || !input.trim()) return clarify('What would you like to remember or prepare?');
    if (input.length > 2000) return clarify('Please use one short request at a time (up to 2,000 characters).');
    let text = input.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
    const dateToday = today(now);
    const members = Array.isArray(opts.members) ? opts.members : [];
    const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];

    if (/^(?:what (?:do i|do we|does the family) (?:need|have) to do today|what(?:'s| is) (?:on|due) today|show (?:my |our |the )?(?:tasks|to-?do list) (?:for )?today)[?.!]*$/i.test(text)) {
      const due = tasks.filter((task) => task && task.dueDate === dateToday && !task.completed && !task.completedAt && task.status !== 'done' && task.status !== 'completed');
      const answer = {
        date: dateToday, count: due.length,
        tasks: due.map(({ id, title, category, assigneeId, dueTime }) => ({ id, title, category, assigneeId, dueTime }))
      };
      return {
        kind: 'answer', answer,
        message: due.length
          ? `You have ${due.length} unfinished locally saved ${due.length === 1 ? 'task' : 'tasks'} due today: ${due.map((task) => task.title).join('; ')}. This does not include other apps.`
          : 'There are no unfinished locally saved tasks due today. I have not checked calendars, messages, or other apps.'
      };
    }

    const draft = baseDraft();
    let assignmentProblem = '';
    const namedMembers = members.filter(member => member && typeof member.name === 'string' && member.name.trim());
    const memberGroups = new Map();
    for (const member of namedMembers) {
      const name = member.name.trim().toLowerCase();
      if (!memberGroups.has(name)) memberGroups.set(name, []);
      memberGroups.get(name).push(member);
    }
    const prefix = text.match(/^([^:]{1,60}):\s*(.+)$/);
    if (prefix && !/^(?:(?:add|create)\s+(?:a\s+)?)?(?:task|(?:work|home|school|shopping|health)(?:\s+task)?|grocer(?:y|ies)|shopping list|appointment|reminder)$/i.test(prefix[1].trim())) {
      const people = memberGroups.get(prefix[1].trim().toLowerCase()) || [];
      if (people.length) {
        if (people.length === 1) draft.assigneeId = people[0].id;
        else assignmentProblem = `More than one family member has the name “${prefix[1].trim()}”. Choose which person is responsible.`;
        text = prefix[2];
      } else if (/^[\p{L}][\p{L} '-]*$/u.test(prefix[1])) {
        assignmentProblem = `“${prefix[1].trim()}” is not a known family member. Choose a member or leave this unassigned.`;
        text = prefix[2];
      }
    }
    const assignedNames = [];
    // Prefer the complete longest name (for example Dad Junior before Dad),
    // and inspect all people with that name before removing the phrase.
    const names = [...memberGroups.keys()].sort((a, b) => b.length - a.length);
    if (names.length) {
      const re = new RegExp(`\\b(?:assign(?:ed)? to)\\s+(${names.map(escapeRE).join('|')})(?=$|[\\s,.!?])`, 'gi');
      text = text.replace(re, (_, name) => {
        const people = memberGroups.get(name.toLowerCase());
        if (people.length === 1) assignedNames.push(people[0].id);
        else assignmentProblem = `More than one family member has the name “${people[0].name}”. Choose which person is responsible.`;
        return '';
      }).trim();
    }
    if (new Set([draft.assigneeId, ...assignedNames].filter((id) => id !== null)).size > 1) assignmentProblem = 'Choose one person responsible for this task.';
    else if (assignedNames.length) draft.assigneeId = assignedNames[0];
    if (/\bassign(?:ed)? to\b/i.test(text)) assignmentProblem = 'Choose a known family member for the assignment.';
    if (assignmentProblem) draft.assigneeId = null;

    const reminderRE = /^(?:please\s+)?(?:remind\s+(?:me|us)|(?:set|create|add|schedule)\s+(?:a\s+)?reminder(?:\s+for\s+(?:me|us))?)(?:\s+(?:to|about))?\s*:?\s*/i;
    const isReminder = reminderRE.test(text);
    if (isReminder) text = text.replace(reminderRE, '');
    const needDetails = (message, draft, missing) => {
      const result = clarify(message, draft, missing);
      if (isReminder) result.reminderRequested = true;
      return result;
    };

    // Requests to spend money, contact someone or arrange bookings are drafts only.
    const actionMatch = !isReminder && text.match(/^(?:please\s+)?(?:can you\s+)?(book|reserve|buy|purchase|order|send(?:\s+(?:a|the))?\s+message|message|email|contact)\b\s*(.*)/i);
    if (actionMatch) {
      if (text.length > 300) return clarify('Please shorten the action request to 300 characters or fewer. Nothing has been sent, purchased, or booked.');
      const verb = actionMatch[1].toLowerCase();
      const kind = /book|reserve/.test(verb) ? 'booking' : /buy|purchase|order/.test(verb) ? 'purchase' : 'message';
      const action = { kind, status: 'needs_review', title: text, details: text, createdFrom: 'local-capture' };
      const noun = kind === 'booking' ? 'booking request' : kind === 'purchase' ? 'purchase request' : 'message request';
      return {
        kind: 'action', action,
        message: `I can prepare a ${noun} for your wife's review. This is a local draft: nothing has been sent, purchased, or booked. Provider support has not been verified.`
      };
    }

    let recognised = isReminder || draft.assigneeId !== null;
    let categoryExplicit = false;
    const categoryPrefix = text.match(/^(?:add\s+(?:a\s+)?)?(work|home|school|shopping|health)(?:\s+task)?\s*:\s*/i);
    if (categoryPrefix) {
      draft.category = CATEGORY_NAMES.find((category) => category.toLowerCase() === categoryPrefix[1].toLowerCase());
      categoryExplicit = true;
      recognised = true;
      text = text.slice(categoryPrefix[0].length);
    }
    if (/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?task\s*:?\s*/i.test(text)) {
      recognised = true;
      text = text.replace(/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?task\s*:?\s*/i, '');
    }
    if (/^(?:add\s+(?:an?\s+)?)?appointment\s*:\s*/i.test(text)) {
      recognised = true;
      draft.type = 'appointment';
      draft.category = categoryExplicit ? draft.category : 'Health';
      text = text.replace(/^(?:add\s+(?:an?\s+)?)?appointment\s*:\s*/i, '');
    }

    const groceryPrefix = text.match(/^(?:groceries|grocery|shopping list)\s*:\s*(.+)$/i);
    const groceryAdd = text.match(/^(?:please\s+)?add\s+(.+?)\s+to\s+(?:the\s+)?(?:grocery|shopping)\s+list[.!]?$/i);
    const outOf = text.match(/^(?:we(?:'re| are)|i(?:'m| am))\s+out of\s+(.+)|^(?:we|i)\s+(?:have\s+)?run out of\s+(.+)/i);
    const need = text.match(/^(?:we|i)\s+need\s+(?!to\b)(.+)/i);
    if (!isReminder && draft.type !== 'appointment' && (groceryPrefix || groceryAdd || outOf || (need && GROCERY_WORDS.test(need[1])))) {
      recognised = true;
      draft.type = 'grocery';
      draft.category = 'Shopping';
      text = groceryPrefix ? groceryPrefix[1] : groceryAdd ? groceryAdd[1] : outOf ? (outOf[1] || outOf[2]) : need[1];
    }
    if (!categoryExplicit && draft.type === 'task') {
      if (/\b(?:school|homework|PE kit)\b/i.test(text)) draft.category = 'School';
      else if (/\b(?:clinic|hospital|dentist|doctor|medical)\b/i.test(text)) draft.category = 'Health';
    }

    const when = temporal(text, dateToday);
    Object.assign(draft, {
      title: when.title, dueDate: when.dueDate, dueTime: when.dueTime, repeat: when.repeat
    });
    const quantity = draft.type === 'grocery' && draft.title.match(/^(\d+(?:\.\d+)?\s*(?:kg|g|l|ml|packs?|bottles?|boxes?)?)\s+(?:of\s+)?(.+)$/i);
    if (quantity) {
      draft.quantity = quantity[1];
      draft.title = quantity[2];
    }
    if (isReminder && draft.dueDate && draft.dueTime) draft.remindAt = dueEpoch(draft.dueDate, draft.dueTime);

    const missing = [];
    if (!draft.title) missing.push('title');
    if (draft.title.length > 300) return needDetails('Please shorten the task title to 300 characters or fewer. The editable draft has not been saved.', draft, ['title']);
    if ((isReminder || draft.type === 'appointment' || draft.repeat !== 'none') && !draft.dueDate) missing.push('dueDate');
    if ((isReminder || draft.type === 'appointment') && !draft.dueTime) missing.push('dueTime');
    if (assignmentProblem) missing.push('assigneeId');
    if (when.problems.length) {
      draft.remindAt = null;
      return needDetails(when.problems.join(' ') + ' Please check the editable draft; it has not been saved.', draft, ['dateOrTime', ...missing]);
    }
    if (isReminder && draft.remindAt !== null && draft.remindAt <= now) {
      draft.remindAt = null;
      return needDetails('That reminder time has already passed in Dubai. Please choose a future date and time; nothing has been scheduled.', draft, ['dueDate', 'dueTime']);
    }
    if (missing.length) {
      let message = assignmentProblem || (!draft.title ? 'What should the task be called?' : !draft.dueDate ? 'What date should I use?' : 'What time should I use? All times are Dubai time.');
      message += ' Please check the editable draft; it has not been saved.';
      return needDetails(message, draft, missing);
    }
    if (!recognised) {
      return needDetails('I am not sure what you want me to do. You can edit this Home task draft, or start with “Add task”, “Remind me”, “Appointment:”, or “Add … to the shopping list”. Nothing has been saved.', draft, ['intent']);
    }
    const categoryNote = draft.category === 'Home' && !categoryExplicit ? ' The category defaults to Home and can be changed.' : '';
    if (draft.type === 'grocery') {
      return { kind: 'grocery', draft, message: `Review this shared grocery-list item and save it locally. No order will be placed.${categoryNote}` };
    }
    return {
      kind: 'task', draft,
      message: draft.type === 'appointment'
        ? 'Review and save this appointment you entered locally. Tidy has not contacted the provider or confirmed a booking.'
        : isReminder
          ? `Review and save this reminder in Dubai time. Notifications depend on the app's permission and available reminder support.${categoryNote}`
          : `Review and save this task locally.${categoryNote}`
    };
  }

  const api = Object.freeze({ parse });
  root.TidyAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
