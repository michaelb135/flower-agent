/* Tidy's local capture helper. This uses explicit rules, not an AI service.
 * Parsing never saves, sends, purchases, books, or reads another application.
 * Render user-provided strings as text, never as HTML.
 */
(function (root) {
  'use strict';

  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const CATEGORY_NAMES = ['Work', 'Home', 'School', 'Shopping', 'Health'];
  const GROCERY_WORDS = /\b(?:ketchup|milk|bread|eggs?|rice|pasta|chicken|fish|potatoes?|tomatoes?|cheese|butter|yogu?rt|fruit|apples?|bananas?|onions?|carrots?|salt|pepper|oil|flour|sugar|tea|coffee|water|juice|cereal|lettuce|cucumber|garlic|soap|toilet paper|tissues|detergent)\b/i;
  const BARE_GROCERY = /^(?:(?:some|organic|fresh|whole|skimmed|semi-skimmed|low-fat|brown|white|sliced|frozen|red|green|olive|cooking|drinking)\s+)*(?:ketchup|milk|bread|eggs?|rice|pasta|chicken|fish|potatoes?|tomatoes?|cheese|butter|yogu?rt|fruit|apples?|bananas?|onions?|carrots?|salt|pepper|oil|flour|sugar|tea|coffee|water|juice|cereal|lettuce|cucumber|garlic|soap|toilet paper|tissues|detergent)$/i;
  const NATURAL_TASK_PREFIX = /^(?:please\s+)?(?:i|we)\s+(?:have|need)\s+to\s+(.+)$/i;
  const PERSONAL_TASK_VERB = /^(?:do|help|check|review|pack|prepare|finish|complete|work|clean|tidy|take|pick|drop|collect|drive|walk|exercise|study|read|call|plan|organise|organize|spend|write|practise|practice|make|cook)\b/i;
  const EXTERNAL_APP_ACCESS = /\b(?:read|access|check|sync|connect|import|fetch|search|retrieve|open|scan|delete)\b[\s\S]*\b(?:WhatsApp|Gmail|Outlook|Google Calendar|Apple Calendar|iCloud|(?:my|our|all|the)\s+(?:emails?|messages?|calendars?))\b/i;
  const UNSUPPORTED_TIMING_CUE = /\b(?:tonight|lunchtime|bedtime)\b|\b(?:this|tomorrow|today|next|every|each|in the|during the|by|before|after|around)\s+(?:(?:early|late)\s+)?(?:morning|afternoon|evening|night)\b|\b(?:morning|afternoon|evening|night)\s*[.!?]*$|\b(?:before|after|during|by)\s+(?:(?:my|our|the)\s+)?(?:work|school|gym|lunch|dinner|breakfast|bed(?:time)?)\b|\bwhen\s+(?:(?:i|we|they|the kids|the children)\s+)?(?:get|come|gets|comes)\s+home\b/i;
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
    const ambiguousHours = [];
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
    const timeRE = /\b(\d{1,2})(?::(\d{2}))?(?:\s+o['’]?clock)?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight)\b/gi;
    const timeSpans = [];
    let unresolvedClock = false;
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
      else {
        unresolvedClock = true;
        problems.push('That time is not valid. Use a time such as 3 pm or 15:30.');
      }
      remove(match);
      timeSpans.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(/\b(\d{1,2})\s+o['’]?clock\b/gi)) {
      if (timeSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
      unresolvedClock = true;
      ambiguousHours.push(Number(match[1]));
      problems.push(`Do you mean ${match[1]} am or ${match[1]} pm? Please choose an exact Dubai time.`);
      remove(match);
      timeSpans.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(/\bat\s+(\d{1,2})(?:[:.]\d{1,2})?/gi)) {
      const numberIndex = match.index + match[0].indexOf(match[1]);
      if (!timeSpans.some(([start, end]) => numberIndex >= start && numberIndex < end)) {
        unresolvedClock = true;
        ambiguousHours.push(Number(match[1]));
        problems.push('Please specify an unambiguous time, such as 3 pm or 15:00.');
        remove(match);
        timeSpans.push([match.index, match.index + match[0].length]);
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
    const duration = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[ -](?:five|one|two|three|four))?|thirty|forty[ -]five|sixty|ninety|an?|half(?:\\s+an?)?|a quarter(?:\\s+of\\s+an?)?)\\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)';
    const offset = new RegExp(`\\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\\s+(?:before|after|early|earlier|later|ahead(?:\\s+of)?)\\b|\\b(?:in|before|after)\\s+${duration}\\b`, 'i');
    const approximateClock = timeSpans.some(([start]) => /\b(?:before|after|by|around|about)\s*$/i.test(text.slice(0, start)));
    const unsupportedClock = offset.test(text) || (timeSpans.length && approximateClock);
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
      dueTime: !unresolvedClock && !foreignZone && !unsupportedClock && new Set(times).size === 1 ? times[0] : '',
      repeat: new Set(repeats).size === 1 ? repeats[0] : 'none', title,
      clockRequested: timeSpans.length > 0,
      ambiguousHour: ambiguousHours.length && new Set(ambiguousHours).size === 1 && ambiguousHours[0] >= 1 && ambiguousHours[0] <= 12 ? ambiguousHours[0] : null,
      compactSafe: !(ambiguousHours.length && times.length) && new Set(ambiguousHours).size <= 1 && new Set(dates).size <= 1 && new Set(times).size <= 1 && problems.every((problem) => /^Do you mean \d+ am or \d+ pm\?|^Please specify an unambiguous time,/.test(problem)),
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
    const efficient = opts.efficientMode === true;
    const assumptions = [];

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
    if (prefix && !/^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:add|create|make|do|put|set|schedule)\s+(?:(?:me|us)\s+)?(?:an?\s+|the\s+)?)?(?:task|(?:work|home|school|shopping|health)(?:\s+task)?|grocer(?:y|ies)|shopping list|appointment|reminder|notification|alarm)$/i.test(prefix[1].trim())) {
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

    let naturalTaskRequested = false;
    const stripNaturalTaskPrefix = (value) => {
      const match = value.match(NATURAL_TASK_PREFIX);
      if (!match) return value;
      if (PERSONAL_TASK_VERB.test(match[1]) && !EXTERNAL_APP_ACCESS.test(match[1])) naturalTaskRequested = true;
      return match[1];
    };
    text = stripNaturalTaskPrefix(text);
    if (/^(?:please\s+)?help\s+(?:(?:me|us)\s+)?(?:(?:the|my|our)\s+)?(?:kids|children)\b.*\b(?:homework|schoolwork|school work|study|studies)\b/i.test(text)) naturalTaskRequested = true;
    if (efficient && PERSONAL_TASK_VERB.test(text.replace(/^(?:please\s+)?(?:(?:can|could)\s+you\s+)?/i, '')) && !EXTERNAL_APP_ACCESS.test(text)) naturalTaskRequested = true;

    const reminderRE = /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:remind|notify)\s+(?:me|us)|(?:set|create|add|schedule|put|make|do)\s+(?:(?:me|us)\s+)?(?:an?\s+|the\s+)?(?:reminder|notification|alarm)\b(?:\s+for\s+(?:me|us))?|(?:reminder|notification|alarm)\s*:)(?:\s+(?:to|about)\b)?\s*:?\s*/i;
    let isReminder = reminderRE.test(text);
    if (isReminder) {
      text = text.replace(reminderRE, '');
      // Spoken requests sometimes repeat the command after a pause. Remove a
      // second command only after punctuation, preserving ordinary task text.
      const restated = text.match(/^[,;.]\s*(.+)$/);
      if (restated && reminderRE.test(restated[1])) text = restated[1].replace(reminderRE, '');
    }
    let appointmentRequested = false;
    let clarificationContext = null;
    const needDetails = (message, draft, missing) => {
      const result = clarify(message, draft, missing);
      if (isReminder) result.reminderRequested = true;
      if (appointmentRequested) result.appointmentRequested = true;
      if (efficient && clarificationContext) result.clarificationContext = clarificationContext;
      if (assumptions.length) result.assumptions = [...assumptions];
      return result;
    };

    // Requests to spend money, contact someone or arrange bookings are drafts only.
    const prepareAction = (request) => {
      const actionMatch = request.match(/^(?:please\s+)?(?:(?:can|could) you\s+)?(book|reserve|schedule(?=\s+(?:(?:an?|the)\s+)?appointment\b)|buy|purchase|order|send(?:\s+(?:a|the))?\s+message|message|email|contact)\b\s*(.*)/i);
      if (!actionMatch) return null;
      if (request.length > 300) return clarify('Please shorten the action request to 300 characters or fewer. Nothing has been sent, purchased, or booked.');
      const verb = actionMatch[1].toLowerCase();
      const kind = /book|reserve|schedule/.test(verb) ? 'booking' : /buy|purchase|order/.test(verb) ? 'purchase' : 'message';
      const action = { kind, status: 'needs_review', title: request, details: request, createdFrom: 'local-capture' };
      const noun = kind === 'booking' ? 'booking request' : kind === 'purchase' ? 'purchase request' : 'message request';
      return {
        kind: 'action', action,
        message: `I can prepare a ${noun} for your wife's review. This is a local draft: nothing has been sent, purchased, or booked. Provider support has not been verified.`
      };
    };
    const directAction = !isReminder && prepareAction(text);
    if (directAction) return directAction;

    let recognised = isReminder || draft.assigneeId !== null || naturalTaskRequested;
    let explicitTaskRequested = false;
    let categoryExplicit = false;
    const categoryPrefix = text.match(/^(?:add\s+(?:a\s+)?)?(work|home|school|shopping|health)(?:\s+task)?\s*:\s*/i);
    if (categoryPrefix) {
      draft.category = CATEGORY_NAMES.find((category) => category.toLowerCase() === categoryPrefix[1].toLowerCase());
      categoryExplicit = true;
      recognised = true;
      explicitTaskRequested = true;
      text = text.slice(categoryPrefix[0].length);
    }
    if (/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?task\s*:?\s*/i.test(text)) {
      recognised = true;
      explicitTaskRequested = true;
      text = text.replace(/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?task\s*:?\s*/i, '');
    }
    const beforeNaturalPrefix = text;
    text = stripNaturalTaskPrefix(text);
    if (text !== beforeNaturalPrefix) {
      if (naturalTaskRequested) recognised = true;
      const nestedAction = !isReminder && prepareAction(text);
      if (nestedAction) return nestedAction;
    }
    const appointmentRE = /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:add|create|make|do|put)\s+(?:(?:me|us)\s+)?(?:an?\s+|the\s+)?)?appointment(?:\s*:\s*|\s+|$)/i;
    if (appointmentRE.test(text)) {
      recognised = true;
      appointmentRequested = true;
      draft.type = 'appointment';
      draft.category = categoryExplicit ? draft.category : 'Health';
      text = text.replace(appointmentRE, '').replace(/^(?:with|for)\s+(?:the\s+)?/i, '');
    }

    const groceryPrefix = text.match(/^(?:groceries|grocery|shopping list)\s*:\s*(.+)$/i);
    const groceryAdd = text.match(/^(?:please\s+)?add\s+(.+?)\s+to\s+(?:the\s+)?(?:grocery|shopping)\s+list[.!]?$/i);
    const outOf = text.match(/^(?:we(?:'re| are)|i(?:'m| am))\s+out of\s+(.+)|^(?:we|i)\s+(?:have\s+)?run out of\s+(.+)/i);
    const need = text.match(/^(?:we|i)\s+need\s+(?!to\b)(.+)/i);
    const groceryTrip = text.match(/^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:get|do)\s+(?:(?:me|us)\s+)?(?:(?:a|the|some|my|our)\s+)?(?:grocery(?:\s+shopping)?|groceries)(?=$|[\s,.!?])\s*(.*)$/i);
    const getGrocery = text.match(/^(?:please\s+)?(?:(?:can|could)\s+you\s+)?get\s+(?:(?:me|us)\s+)?(?:some\s+)?(.+)$/i);
    const bareItem = efficient && BARE_GROCERY.test(temporal(text, dateToday).title.replace(/^(\d+(?:\.\d+)?\s*(?:kg|g|l|ml|packs?|bottles?|boxes?)?)\s+(?:of\s+)?/i, ''));
    let groceryCapture = false;
    if (!isReminder && draft.type !== 'appointment' && groceryTrip && !temporal(groceryTrip[1], dateToday).title) {
      // A grocery trip is a responsibility, not an item to purchase. Keep the
      // trailing schedule so a requested clock time can become a real reminder.
      recognised = groceryCapture = true;
      draft.category = 'Shopping';
      text = 'Grocery shopping ' + groceryTrip[1];
    } else if (!isReminder && draft.type !== 'appointment' && (groceryPrefix || groceryAdd || outOf || (need && GROCERY_WORDS.test(need[1])) || (getGrocery && GROCERY_WORDS.test(getGrocery[1])) || bareItem)) {
      recognised = true;
      groceryCapture = true;
      draft.type = 'grocery';
      draft.category = 'Shopping';
      text = groceryPrefix ? groceryPrefix[1] : groceryAdd ? groceryAdd[1] : outOf ? (outOf[1] || outOf[2]) : need && GROCERY_WORDS.test(need[1]) ? need[1] : getGrocery ? getGrocery[1] : text;
    }
    if (!categoryExplicit && draft.type === 'task') {
      if (/\b(?:school|homework|schoolwork|PE kit)\b/i.test(text) || (/\b(?:kids|children)\b/i.test(text) && /\b(?:work|study|studies|learning|reading)\b/i.test(text))) draft.category = 'School';
      else if (/\b(?:clinic|hospital|dentist|doctor|medical)\b/i.test(text)) draft.category = 'Health';
    }

    const when = temporal(text, dateToday);
    if (efficient && UNSUPPORTED_TIMING_CUE.test(text)) {
      when.problems.push('Please choose an exact Dubai date and time. I cannot apply dayparts or times relative to work, school or meals yet.');
      when.compactSafe = false;
      when.dueTime = '';
    }
    if (groceryCapture && when.clockRequested) isReminder = true;
    Object.assign(draft, {
      title: when.title, dueDate: when.dueDate, dueTime: when.dueTime, repeat: when.repeat
    });
    if (efficient && recognised && draft.type !== 'appointment' && draft.repeat === 'none' && !draft.dueDate && draft.dueTime && !when.problems.length) {
      draft.dueDate = dueEpoch(dateToday, draft.dueTime) > now ? dateToday : addDays(dateToday, 1);
      assumptions.push(`Using ${draft.dueDate === dateToday ? 'today' : 'tomorrow'} (${draft.dueDate}), the next ${draft.dueTime} Dubai time.`);
    }
    if (isReminder && !draft.title) draft.title = 'Reminder';
    const quantity = draft.type === 'grocery' && draft.title.match(/^(\d+(?:\.\d+)?\s*(?:kg|g|l|ml|packs?|bottles?|boxes?)?)\s+(?:of\s+)?(.+)$/i);
    if (quantity) {
      draft.quantity = quantity[1];
      draft.title = quantity[2];
    }
    if (isReminder && draft.dueDate && draft.dueTime) draft.remindAt = dueEpoch(draft.dueDate, draft.dueTime);

    const plannedReminder = efficient && isReminder && opts.planningEnabled === true && !when.clockRequested && !when.problems.length;
    clarificationContext = {
      safe: recognised && when.compactSafe && draft.title.length <= 300,
      ambiguousHour: when.ambiguousHour, clockRequested: when.clockRequested,
      autoPlanEligible: plannedReminder || ((naturalTaskRequested || explicitTaskRequested) && draft.type === 'task' && !isReminder && !when.clockRequested && !EXTERNAL_APP_ACCESS.test(text) && !prepareAction(text))
    };

    const missing = [];
    if (!draft.title) missing.push('title');
    if (draft.title.length > 300) return needDetails('Please shorten the task title to 300 characters or fewer. The editable draft has not been saved.', draft, ['title']);
    if (((isReminder && !plannedReminder) || draft.type === 'appointment' || draft.repeat !== 'none') && !draft.dueDate) missing.push('dueDate');
    if (!missing.includes('dueDate') && (naturalTaskRequested || explicitTaskRequested) && when.clockRequested && !draft.dueDate) missing.push('dueDate');
    if (((isReminder && !plannedReminder) || draft.type === 'appointment') && !draft.dueTime) missing.push('dueTime');
    if (assignmentProblem) missing.push('assigneeId');
    if (when.problems.length) {
      draft.remindAt = null;
      return needDetails(when.problems.join(' ') + ' Please check the editable draft; it has not been saved.', draft, ['dateOrTime', ...missing]);
    }
    if ((isReminder && draft.remindAt !== null && draft.remindAt <= now) || (efficient && when.clockRequested && draft.dueDate && draft.dueTime && dueEpoch(draft.dueDate, draft.dueTime) <= now)) {
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
    const flexibleTask = ((naturalTaskRequested || explicitTaskRequested) && !isReminder || plannedReminder) && draft.type === 'task' && !when.clockRequested && !draft.dueTime && draft.remindAt === null && !EXTERNAL_APP_ACCESS.test(text) && (plannedReminder || !prepareAction(text));
    if (draft.type === 'grocery') {
      return { kind: 'grocery', draft, ...(assumptions.length ? { assumptions: [...assumptions] } : {}), ...(isReminder ? { reminderRequested: true } : {}), message: `Review this shared grocery-list item and save it locally. No order will be placed.${categoryNote}` };
    }
    return {
      kind: 'task', draft,
      ...(efficient ? { clarificationContext } : {}),
      ...(assumptions.length ? { assumptions: [...assumptions] } : {}),
      ...(flexibleTask ? { flexibleTaskRequested: true, ...(opts.planningEnabled === true ? { autoPlanRequested: true } : {}) } : {}),
      ...(isReminder ? { reminderRequested: true } : {}),
      ...(appointmentRequested ? { appointmentRequested: true } : {}),
      message: draft.type === 'appointment'
        ? 'Review and save this appointment you entered locally. Tidy has not contacted the provider or confirmed a booking.'
        : isReminder
          ? `Review and save this reminder in Dubai time. Notifications depend on the app's permission and available reminder support.${categoryNote}`
          : `Review and save this task locally.${categoryNote}`
    };
  }

  // These helpers fill only the fields an existing capture is waiting for.
  // A short answer is never interpreted as a new purchase, booking or message.
  function clarificationInfo(result, options) {
    if (!result || result.kind !== 'clarify' || !result.draft || !Array.isArray(result.missing)) return null;
    let context = result.clarificationContext;
    if (!context && options && typeof options.text === 'string') {
      const original = parse(options.text, { ...options, efficientMode: true });
      if (original.kind === 'clarify') context = original.clarificationContext;
    }
    if (!context || context.safe !== true || result.missing.some((field) => !['title', 'dueDate', 'dueTime', 'dateOrTime', 'assigneeId'].includes(field))) return null;
    return context;
  }

  function clarificationNow(options) {
    const now = !options || options.now === undefined ? Date.now() : Number(options.now);
    return Number.isSafeInteger(now) && now >= Date.parse('0001-01-02T00:00:00Z') && now <= Date.parse('9999-12-30T00:00:00Z') ? now : null;
  }

  function clockLabel(time) {
    const [hour, minute] = time.split(':').map(Number);
    return `${hour % 12 || 12}${minute ? ':' + pad(minute) : ''} ${hour < 12 ? 'am' : 'pm'}`;
  }

  function planClarification(result, options) {
    const opts = options || {};
    const context = clarificationInfo(result, opts);
    const now = clarificationNow(opts);
    const fallback = { question: result && result.message || 'Please check the details.', choices: [], advanced: true };
    if (!context || now === null) return fallback;
    const missing = new Set(result.missing);
    const draft = result.draft;
    if (missing.has('title')) return { question: draft.type === 'appointment' ? 'What is the appointment for?' : 'What should I remind you to do?', choices: [], advanced: false };
    const dateToday = today(now);
    const needsDate = missing.has('dueDate');
    const needsTime = missing.has('dueTime') || missing.has('dateOrTime');
    const dates = needsDate ? Array.from({ length: 7 }, (_, index) => addDays(dateToday, index))
      .filter((date) => validDate(date) && (draft.repeat !== 'weekdays' || ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())))
      .slice(0, 2) : [draft.dueDate];
    const dayLabel = (date) => date === dateToday ? 'Today' : date === addDays(dateToday, 1) ? 'Tomorrow' : date;
    if (needsDate && !needsTime && !draft.dueTime) return {
      question: 'Which day should I use?', advanced: false,
      choices: dates.map((date) => ({ label: dayLabel(date), patch: { dueDate: date } }))
    };
    if (needsDate || needsTime) {
      const times = !needsTime && draft.dueTime ? [draft.dueTime] : context.ambiguousHour
        ? [`${pad(context.ambiguousHour % 12)}:00`, `${pad(context.ambiguousHour % 12 + 12)}:00`]
        : ['09:00', '12:00', '18:00', '20:00'];
      const candidates = [];
      for (const date of dates) for (const time of times) {
        if (!validDate(date) || dueEpoch(date, time) <= now) continue;
        const day = dayLabel(date);
        candidates.push({ label: `${day} ${clockLabel(time)}`, patch: { ...(needsDate ? { dueDate: date } : {}), ...(needsTime ? { dueTime: time } : {}) } });
      }
      return {
        question: needsDate && needsTime ? `When should I ${result.reminderRequested ? 'remind you' : 'put it'}? Choose a Dubai time.` : needsTime ? `What time on ${draft.dueDate}? All times are Dubai time.` : 'Which day should I use?',
        choices: candidates.slice(0, 4), advanced: false
      };
    }
    if (missing.has('assigneeId')) {
      const members = Array.isArray(opts.members) ? opts.members.filter((member) => member && typeof member.id === 'string' && typeof member.name === 'string') : [];
      return { question: 'Who should this be for?', choices: [...members.slice(0, 3).map((member) => ({ label: member.name, patch: { assigneeId: member.id } })), { label: 'Leave unassigned', patch: { assigneeId: null } }], advanced: false };
    }
    return fallback;
  }

  function resolveClarification(result, answer, options) {
    const opts = options || {};
    const context = clarificationInfo(result, opts);
    const now = clarificationNow(opts);
    if (!context || now === null) return result && result.kind === 'clarify' ? result : clarify('Please review this request before continuing.', undefined, ['intent']);
    const original = result.draft;
    const draft = { ...original };
    const missing = new Set(result.missing.filter((field) => field !== 'dateOrTime'));
    if (result.missing.includes('dateOrTime')) missing.add('dueTime');
    const assumptions = [...(Array.isArray(result.assumptions) ? result.assumptions : [])];
    const retry = (message, unresolved = [...missing]) => ({
      ...result, kind: 'clarify', draft: { ...draft, remindAt: null }, missing: unresolved,
      message, clarificationContext: { ...context }, ...(assumptions.length ? { assumptions } : {})
    });
    let patch;
    if (typeof answer === 'string') {
      if (!answer.trim() || answer.length > 2000) return retry('Please give one short answer, or open all details.');
      const text = answer.normalize('NFKC').replace(/\s+/g, ' ').trim();
      const when = temporal(/^\d{1,2}$/.test(text) ? `at ${text}` : text, today(now));
      if (when.problems.length) return { ...retry(when.problems.join(' ')), clarificationContext: { ...context, safe: when.compactSafe, ambiguousHour: when.ambiguousHour } };
      patch = {};
      if (when.dueDate) patch.dueDate = when.dueDate;
      if (when.dueTime) patch.dueTime = when.dueTime;
      if (missing.has('assigneeId') && when.title) {
        const members = Array.isArray(opts.members) ? opts.members : [];
        const matches = members.filter((member) => member && typeof member.name === 'string' && member.name.trim().toLowerCase() === when.title.toLowerCase());
        if (matches.length === 1) patch.assigneeId = matches[0].id;
        else if (/^(?:unassigned|leave unassigned|no one|nobody)$/i.test(when.title)) patch.assigneeId = null;
        else if (!missing.has('title')) return retry('Please choose a family member, or leave it unassigned.');
      }
      if (missing.has('title') && when.title && !Object.prototype.hasOwnProperty.call(patch, 'assigneeId')) patch.title = when.title;
      else if (when.title && !Object.prototype.hasOwnProperty.call(patch, 'assigneeId')) return retry('Please give just the missing date or time, or open all details to change the request.');
    } else if (answer && typeof answer === 'object' && !Array.isArray(answer) && (Object.getPrototypeOf(answer) === Object.prototype || Object.getPrototypeOf(answer) === null)) patch = answer;
    else return retry('Please choose an option, type an answer, or open all details.');

    const fields = ['title', 'dueDate', 'dueTime', 'assigneeId'];
    const updates = {};
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      if (!missing.has(field)) {
        if (patch[field] !== original[field]) return retry('I kept the details you already gave me. Open all details if you want to change them.');
        continue;
      }
      const value = patch[field];
      if (field === 'title' && (typeof value !== 'string' || !value.trim() || value.length > 300)) return retry('Please use a title from 1 to 300 characters.');
      if (field === 'dueDate' && (typeof value !== 'string' || !validDate(value))) return retry('Please choose a real date, such as YYYY-MM-DD.');
      if (field === 'dueTime' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) return retry('Please choose an exact Dubai time, such as 7 pm or 19:00.');
      if (field === 'assigneeId' && value !== null && !(Array.isArray(opts.members) && opts.members.some((member) => member && member.id === value))) return retry('Please choose a known family member, or leave it unassigned.');
      updates[field] = typeof value === 'string' ? value.trim() : value;
    }
    Object.assign(draft, updates);
    for (const field of Object.keys(updates)) missing.delete(field);
    if ((Object.prototype.hasOwnProperty.call(patch, 'dueDate') || Object.prototype.hasOwnProperty.call(patch, 'dueTime')) && draft.dueDate && draft.dueTime && dueEpoch(draft.dueDate, draft.dueTime) > now) {
      missing.delete('dueDate');
      missing.delete('dueTime');
    }
    if (missing.has('dueDate') && !draft.dueDate && draft.dueTime && draft.type !== 'appointment' && draft.repeat === 'none' && opts.efficientMode === true) {
      draft.dueDate = dueEpoch(today(now), draft.dueTime) > now ? today(now) : addDays(today(now), 1);
      missing.delete('dueDate');
      assumptions.push(`Using ${draft.dueDate === today(now) ? 'today' : 'tomorrow'} (${draft.dueDate}), the next ${draft.dueTime} Dubai time.`);
    }
    if (draft.dueDate && draft.dueTime && dueEpoch(draft.dueDate, draft.dueTime) <= now) {
      missing.add('dueDate'); missing.add('dueTime');
      return retry('That time has already passed in Dubai. Please choose a future date and time.');
    }
    if (missing.size) return retry(planClarification({ ...result, draft, missing: [...missing] }, opts).question);
    draft.remindAt = result.reminderRequested && draft.dueDate && draft.dueTime ? dueEpoch(draft.dueDate, draft.dueTime) : null;
    const autoPlan = context.autoPlanEligible && !draft.dueTime && opts.planningEnabled === true;
    return {
      kind: draft.type === 'grocery' ? 'grocery' : 'task', draft,
      ...(result.reminderRequested ? { reminderRequested: true } : {}),
      ...(result.appointmentRequested ? { appointmentRequested: true } : {}),
      ...(context.autoPlanEligible && !draft.dueTime ? { flexibleTaskRequested: true } : {}),
      ...(autoPlan ? { autoPlanRequested: true } : {}),
      ...(assumptions.length ? { assumptions } : {}),
      message: draft.type === 'grocery' ? 'Save this grocery-list item locally. No order will be placed.' : draft.type === 'appointment' ? 'Save this appointment locally. Tidy has not contacted the provider or confirmed a booking.' : result.reminderRequested ? 'Save this reminder in Dubai time. Reminder delivery depends on available support.' : 'Save this task locally.'
    };
  }

  // These standalone commands connect Ask Tidy to existing local screens.
  // They are deliberately separate from parse(): requests to save, remind,
  // purchase, book or message still follow the established review flow.
  function routeRequest(input) {
    if (typeof input !== 'string' || input.length > 1000 || !input.trim() || /[\u0000-\u001f\u007f<>]/.test(input)) return null;
    const text = input.normalize('NFKC').replace(/\s+/g, ' ').trim()
      .replace(/[.!?]+$/, '').trim().replace(/^please\s+/i, '').replace(/\s+please$/i, '').trim();
    if (!text || /https?:\/\/|javascript:|data:/i.test(text)) return null;
    const navigation = text.match(/^(?:open|show)(?: me)?(?: my| the)? (menu|groceries|grocery list|shopping list|calendar|tasks|requests|requests to review|today)$/i);
    if (navigation) {
      const destinations = {
        menu: ['meals', 'your menu'], groceries: ['shopping', 'your groceries'],
        'grocery list': ['shopping', 'your groceries'], 'shopping list': ['shopping', 'your groceries'],
        calendar: ['calendar', 'your calendar'], tasks: ['family', 'your tasks'],
        requests: ['requests', 'your requests to review'], 'requests to review': ['requests', 'your requests to review'],
        today: ['today', 'Today']
      };
      const destination = destinations[navigation[1].toLowerCase()];
      return { kind: 'navigate', view: destination[0], reply: 'Opening ' + destination[1] + '.' };
    }
    if (/^(?:organise|organize|plan) my day$/i.test(text)) return {
      kind: 'organise', reply: 'I’ll check your confirmed hours and saved commitments to organise your day.'
    };
    const shortMeal = text.match(/^(?:i|we) (?:want|would like) (.+)$/i);
    const shortDish = shortMeal ? shortMeal[1].replace(/^(?:a|an|some)\s+/i, '') : '';
    const clearDish = /^(?:(?:tomato|chicken|tuna|vegetable|veggie)\s+(?:pasta|spaghetti|penne)\b|(?:pasta|spaghetti|penne)\s+(?:(?:with|to)\s+)?(?:tomato(?:es)?|chicken|tuna|vegetables?)\b|(?:chicken|fish)\s+(?:and\s+)?rice\b|(?:cheese|avocado)\s+(?:on\s+)?toast\b|(?:pancakes?|omelette|omelet|porridge|pizza)\b)/i.test(shortDish)
      && !/\b(?:packets?|packs?|bottles?|jars?|cans?|tins?|boxes|bags?|kilograms?|litres?|liters?|grams?|kg|ml)\b|\bpasta sauce\b/i.test(shortDish);
    const meal = text.match(/^(?:i|we) (?:want|would like) to eat (.+)$/i)
      || text.match(/^prepare(?: my| the)? (?:groceries|grocery list) for (.+)$/i)
      || text.match(/^(?:make|cook|prepare)(?: me| us)? (.+?) for (?:breakfast|lunch|dinner)$/i)
      || (clearDish ? shortMeal : null);
    if (!meal) return null;
    const request = meal[1].trim();
    // Servings belong to the meal; scheduling and additional actions do not.
    // In particular, do not turn "remind me" or "buy" into an approved draft.
    if (!request || /[;]|\b(?:buy|order|purchase|pay|checkout|book|appointment|remind|reminder|notify|send|message|email|text|call|connect|access|read|delete|cancel)\b/i.test(request)) return null;
    if (/\b(?:open|show|add|plan|organise|organize|make|cook|prepare|set)\b/i.test(request)) return null;
    if (/\b(?:today|tomorrow|tonight|next|every|each|daily|weekly|weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:at|before|after|around|by)\s+(?:\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|noon\b|midnight\b)|\b\d{1,2}:\d{2}\b|\b\d+\s*(?:am|pm)\b|\bo['’]?clock\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i.test(request)) return null;
    if (/\b(?:at|before|after|around|by|until|during|january|february|march|april|may|june|july|august|september|october|november|december)\b|\bin\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|half|a|an)\s+(?:minutes?|hours?|days?|weeks?)\b/i.test(request)) return null;
    // The menu catalogue supports no beans. Other dietary restrictions need
    // the established clarification path, not an unchecked recipe substitution.
    const dietary = request.replace(/\b(?:no|without|avoid|exclude|excluding) beans?\b/gi, '');
    if (/\b(?:no|without|avoid|exclude|excluding|allerg\w*|intoleran\w*|coeliac|celiac|gluten|dairy|vegan|vegetarian|keto|halal|kosher|lactose|diabetic|nut[ -]?free|low[ -]?(?:carb|sodium|salt|sugar))\b/i.test(dietary)) return null;
    return { kind: 'meal', request, reply: 'I’ll prepare an editable ingredient draft for you to review. No order will be placed.' };
  }

  function workflowBlocked(message) {
    return { kind: 'meal-workflow', request: '', addGroceries: false, reminder: null, blocked: true,
      message, reply: message + ' Nothing has been changed.' };
  }

  // Only this small, explicit meal flow is decomposed. General conjunctions
  // stay with the existing parser, rather than silently dropping another job.
  function planMealRequest(input, options) {
    if (typeof input !== 'string' || !input.trim()) return null;
    const raw = input.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
    const mealHint = /\b(?:(?:we|i)(?:'re|'m| are| am| will be)? having|(?:we|i) (?:want|would like) to eat)\b/i.test(raw)
      || /\b(?:make|cook|prepare)\b[\s\S]*\bfor (?:breakfast|lunch|dinner)\b/i.test(raw);
    const actionHint = /\b(?:ingredients|remind|notify|buy|order|purchase|send|book|reserve|message|email)\b/i.test(raw);
    if (!mealHint || !actionHint) return null;
    const unsafe = 'I can prepare a meal, add its ingredients to your local list and set a cooking reminder. Please ask for purchases, bookings, messages or other jobs separately.';
    if (raw.length > 1000 || /[\u0000-\u001f\u007f<>]|https?:\/\/|javascript:|data:/i.test(raw)) return workflowBlocked('Please use one short meal request without links or markup.');
    if (/\b(?:buy|order|purchase|pay|checkout|book|reserve|send|message|email|contact|connect|access|read|fetch|scan|sync|delete|cancel|remove|ignore)\b/i.test(raw)
      || /\b(?:don't|do not|never|not now|skip|instead of)\b/i.test(raw)) return workflowBlocked(unsafe);
    const now = clarificationNow(options);
    if (now === null) return workflowBlocked('The current time is unavailable. Please try again.');
    const text = raw.replace(/\bat(?=\d)/gi, 'at ');
    const boundary = /\s*(?:[,.!?;]\s*|\s+(?:and(?:\s+then)?|then)\s+)(?=(?:please\s+)?(?:add|put|remind|notify|buy|order|purchase|book|reserve|send|message|email|call|clean|pack|check|delete|cancel)\b)/i;
    const parts = text.split(boundary).map(value => value.replace(/^[\s,.;!?]+|[\s,.;!?]+$/g, '').replace(/^please\s+/i, '').trim());
    if (parts.length < 2 || parts.length > 3) return workflowBlocked('Please name the meal, then say “add the ingredients” and optionally “remind me to cook at 6 pm”.');
    const mealWhen = temporal(parts[0], today(now));
    if (mealWhen.problems.length || mealWhen.clockRequested || mealWhen.repeat !== 'none' || UNSUPPORTED_TIMING_CUE.test(parts[0])) return workflowBlocked('Please give one meal day and put an exact Dubai time in the cooking reminder.');
    const meal = mealWhen.title.match(/^(?:we|i)(?:'re|'m| are| am| will be)? having\s+(.+)$/i)
      || mealWhen.title.match(/^(?:we|i) (?:want|would like) to eat\s+(.+)$/i)
      || mealWhen.title.match(/^(?:make|cook|prepare)(?: me| us)?\s+(.+?)\s+for (?:breakfast|lunch|dinner)$/i);
    if (!meal) return workflowBlocked('Please start with the dish, such as “We’re having tomato pasta”.');
    const request = meal[1].replace(/\s+for (?:breakfast|lunch|dinner)$/i, '').trim();
    const dietary = request.replace(/\b(?:no|without|avoid|exclude|excluding) beans?\b/gi, '');
    if (!request || /\b(?:add|put|remind|notify|make|cook|prepare|plan|organise|organize|set|have|need|want|start|stop)\b/i.test(request)
      || /\b(?:no|without|avoid|exclude|excluding|allerg\w*|intoleran\w*|coeliac|celiac|gluten|dairy|vegan|vegetarian|keto|halal|kosher|lactose|diabetic|nut[ -]?free|low[ -]?(?:carb|sodium|salt|sugar))\b/i.test(dietary)) return workflowBlocked('Please review dietary restrictions or additional instructions in Menu before preparing this meal.');
    let addGroceries = false, reminderText = null;
    for (const part of parts.slice(1)) {
      if (/^(?:add|put)\s+(?:(?:the|its|these|those|all the)\s+)?ingredients(?:\s+(?:for (?:it|this|that|the meal)|we need))?(?:\s+(?:to|in|on)\s+(?:(?:my|our|the)\s+)?(?:groceries|grocery list|shopping list))?$/i.test(part)
        || /^add what we need(?: to (?:(?:my|our|the) )?(?:groceries|grocery list|shopping list))?$/i.test(part)) {
        if (addGroceries) return workflowBlocked('Please ask once to add the ingredients.');
        addGroceries = true;
      } else if (/^(?:remind|notify)\s+(?:me|us)\b/i.test(part) && !reminderText) reminderText = part;
      else return workflowBlocked(unsafe);
    }
    let reminder = null;
    if (reminderText) {
      const body = reminderText.replace(/^(?:remind|notify)\s+(?:me|us)(?:\s+to)?\s*/i, '');
      const when = temporal(body, today(now));
      const allowed = new RegExp('^(?:cook|start(?: cooking)?|make|prepare)(?: (?:(?:the|our|my) )?(?:meal|dinner|lunch|breakfast|it|this|that|' + escapeRE(request) + '))?$', 'i');
      if (!allowed.test(when.title)) return workflowBlocked('For this meal, ask me to remind you to cook or start cooking. Ask for other reminders separately.');
      if (UNSUPPORTED_TIMING_CUE.test(body) || when.repeat !== 'none') return workflowBlocked('Please choose an exact Dubai date and time for this meal’s cooking reminder.');
      // A cooking reminder needs the requested clock. General family planning
      // must not turn its missing time into an unscheduled task result.
      reminder = parse(reminderText + (mealWhen.dueDate && !when.dueDate ? ' on ' + mealWhen.dueDate : ''), { ...(options || {}), planningEnabled: false, efficientMode: true });
      if (reminder.draft) reminder.draft.title = 'Cook ' + request.replace(/\s+for\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+(?:people|persons?|servings?))?$/i, '');
      if (mealWhen.dueDate && when.dueDate && mealWhen.dueDate !== when.dueDate) {
        reminder = { kind: 'clarify', draft: { ...baseDraft(), title: reminder.draft?.title || 'Cook ' + request, dueTime: when.dueTime }, missing: ['dueDate', ...(!when.dueTime ? ['dueTime'] : [])], reminderRequested: true,
          clarificationContext: { safe: true, ambiguousHour: when.ambiguousHour, clockRequested: when.clockRequested, autoPlanEligible: false },
          message: 'The meal and reminder have different days. Which single day should I use for the cooking reminder? Nothing has been changed.' };
      }
      if (reminder.kind !== 'task' && reminder.kind !== 'clarify') return workflowBlocked(unsafe);
    }
    return { kind: 'meal-workflow', request, addGroceries, reminder,
      reply: 'I’ll prepare the meal ingredients' + (addGroceries ? ', add them to your local grocery list' : '') + (reminder ? ' and set your cooking reminder' : '') + '. No order will be placed.' };
  }

  function parseReminderCorrection(input, target, options) {
    if (typeof input !== 'string' || !input.trim()) return null;
    const text = input.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim();
    const match = text.match(/^(?:(?:actually|sorry|no)\s*[,;:]?\s*)?(?:make\s+(?:it|that)(?:\s+to)?|(?:change|move|reschedule|set)\s+(?:it|that|(?:the|my)\s+reminder)(?:\s+to)?|(?:change|move|reschedule)\s+(?:the|my)\s+time\s+to)\s*(.+)$/i);
    if (!match) return null;
    const problem = message => ({ kind: 'reminder-correction', result: clarify(message, undefined, ['intent']) });
    if (text.length > 1000 || /[\u0000-\u001f\u007f<>]|https?:\/\/|javascript:|data:/i.test(text)) return problem('Please give just the new date or time for your reminder.');
    if (!target || typeof target !== 'object' || typeof target.title !== 'string' || !target.title.trim() || !validDate(target.dueDate || '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(target.dueTime || '')) return problem('Which reminder do you want to change? Open or ask for a reminder first, then give me its new date or time.');
    const now = clarificationNow(options);
    if (now === null) return problem('The current time is unavailable. Please try again.');
    const replacement = match[1].replace(/\bat(?=\d)/gi, 'at ').replace(/^(\d{1,2})$/, 'at $1'), when = temporal(replacement, today(now));
    if (/\b(?:don't|do not|not|never|cancel|delete|remove|buy|order|purchase|pay|book|send|message|email|and|then)\b/i.test(replacement)
      || when.title || !when.dueDate && !when.clockRequested && !when.problems.length) return problem('Please give just the new reminder date or time, such as “make it tomorrow at 6:30 pm”.');
    if (UNSUPPORTED_TIMING_CUE.test(replacement) || when.repeat !== 'none') return problem('Please choose an exact Dubai date and time; I cannot apply relative times or a new repeat pattern here.');
    const schedule = replacement + (!when.dueDate ? ' on ' + target.dueDate : '') + (!when.clockRequested ? ' at ' + target.dueTime : '');
    const result = parse('Remind me to update this reminder ' + schedule, { ...(options || {}), efficientMode: true });
    if (result.draft) {
      const kept = {};
      for (const field of ['title', 'category', 'assigneeId', 'priority', 'type', 'quantity', 'notes', 'link', 'repeat']) if (target[field] !== undefined) kept[field] = target[field];
      result.draft = { ...result.draft, ...kept };
    }
    return { kind: 'reminder-correction', result };
  }

  const api = Object.freeze({ parse, planClarification, resolveClarification, routeRequest, planMealRequest, parseReminderCorrection });
  root.TidyAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
