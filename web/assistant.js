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

  const api = Object.freeze({ parse, planClarification, resolveClarification });
  root.TidyAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
