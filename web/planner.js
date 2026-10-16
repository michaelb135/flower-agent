/* Tidy's local planning helper. Suggestions never change a calendar, book,
 * purchase, send a message, or mutate the supplied tasks and routine. */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const MINUTE = 60000;
  const DUBAI = 4 * 3600000;
  const FAMILY_WORDS = /\b(?:kids?|children|homework|schoolwork|school work|family time|with (?:my |the |our )?(?:son|daughter))\b/i;

  function defaults() {
    return { enabled: false, workDays: [1, 2, 3, 4, 5], schoolDays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', kidsHome: '15:00', dayStart: '07:00', dayEnd: '20:30', taskMinutes: 30, familyMinutes: 45, bufferMinutes: 15 };
  }
  function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    // Imported JSON has data properties. Do not execute property getters while
    // inspecting an untrusted object passed to this pure helper.
    return Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value');
    });
  }
  function own(value, key, fallback) {
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : fallback;
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
    const stamp = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
  }
  function clock(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }
  function minutes(value) { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
  function clockText(value) { return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0'); }
  function dayStamp(value) { return Date.parse(value + 'T00:00:00Z') - DUBAI; }
  function dateText(value) { return new Date(value + DUBAI).toISOString().slice(0, 10); }
  function addDays(value, number) { return new Date(Date.parse(value + 'T00:00:00Z') + number * DAY).toISOString().slice(0, 10); }
  function weekday(value) { return new Date(value + 'T00:00:00Z').getUTCDay(); }
  function epoch(value) {
    if (!Number.isSafeInteger(value)) return null;
    const shifted = new Date(value + DUBAI);
    return Number.isFinite(shifted.getTime()) && shifted.getUTCFullYear() >= 1 && shifted.getUTCFullYear() <= 9999 ? value : null;
  }
  function eventEpoch(value) {
    if (typeof value === 'number') return epoch(value);
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !validDate(value.slice(0, 10))) return null;
    return epoch(Date.parse(value));
  }
  function integer(value, low, high) { return Number.isInteger(value) && value >= low && value <= high; }
  function invalid(code, reason, conflict) { return { ok: false, code, reason, conflict: Boolean(conflict) }; }

  function profileValues(input) {
    if (!record(input)) return null;
    const result = defaults();
    for (const key of Object.keys(result)) result[key] = own(input, key, result[key]);
    // Old callers confirmed one shared work/school pattern. Preserve that
    // meaning when the new separate school-days field is absent.
    if (!Object.prototype.hasOwnProperty.call(input, 'schoolDays')) result.schoolDays = result.workDays;
    const validDays = days => Array.isArray(days) && days.length <= 7 && days.every(day => integer(day, 0, 6)) && new Set(days).size === days.length;
    if (typeof result.enabled !== 'boolean' || !validDays(result.workDays) || !validDays(result.schoolDays)) return null;
    if (!['workStart', 'workEnd', 'kidsHome', 'dayStart', 'dayEnd'].every(key => clock(result[key]))) return null;
    if (minutes(result.dayStart) >= minutes(result.dayEnd) || minutes(result.workStart) >= minutes(result.workEnd)) return null;
    if (!integer(result.taskMinutes, 5, 240) || !integer(result.familyMinutes, 5, 240) || !integer(result.bufferMinutes, 0, 120)) return null;
    return result;
  }
  function isFamilyTask(draft) {
    try {
      if (!record(draft)) return false;
      return own(draft, 'category', '') === 'School' || (typeof own(draft, 'title', '') === 'string' && FAMILY_WORDS.test(draft.title));
    } catch (_) { return false; }
  }
  function duration(value, fallback) {
    return value === undefined ? fallback : integer(value, 5, 480) ? value : null;
  }
  function sameTask(left, right) {
    return typeof own(left, 'id', null) === 'string' && left.id !== '' && own(right, 'id', null) === left.id;
  }
  function occurrences(task, startDate, endDate) {
    if (!validDate(task.dueDate) || !clock(task.dueTime)) return null;
    const repeat = own(task, 'repeat', 'none');
    if (!['none', 'daily', 'weekly', 'weekdays'].includes(repeat)) return null;
    if (repeat === 'none') return [task.dueDate];
    const dates = [];
    for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
      if (day < task.dueDate) continue;
      if (repeat === 'daily' || (repeat === 'weekdays' && weekday(day) >= 1 && weekday(day) <= 5) || (repeat === 'weekly' && weekday(day) === weekday(task.dueDate))) dates.push(day);
    }
    return dates;
  }
  function busyRanges(tasks, events, draft, startDate, endDate) {
    if (!Array.isArray(tasks) || tasks.length > 10000 || !Array.isArray(events) || events.length > 5000) return null;
    const ranges = [];
    for (const task of tasks) {
      if (!record(task)) return null;
      if (own(task, 'status', 'open') !== 'open' || sameTask(task, draft)) continue;
      const dueDate = own(task, 'dueDate', '');
      const dueTime = own(task, 'dueTime', '');
      if (!dueDate && !dueTime) {
        const reminder = own(task, 'remindAt', null);
        if (reminder !== null) {
          const stamp = epoch(reminder);
          const length = duration(own(task, 'durationMinutes', undefined), 30);
          if (stamp === null || length === null) return null;
          ranges.push([stamp, stamp + length * MINUTE]);
        }
        continue;
      }
      if (dueDate && !dueTime) { if (!validDate(dueDate)) return null; continue; }
      // A repeat starting yesterday can still occupy this morning. A repeat
      // tomorrow can also reserve a buffer late on the last planning day.
      const firstBusyDate = startDate > '0001-01-01' ? addDays(startDate, -1) : startDate;
      const lastBusyDate = endDate < '9999-12-31' ? addDays(endDate, 1) : endDate;
      const dates = occurrences(task, firstBusyDate, lastBusyDate);
      const length = duration(own(task, 'durationMinutes', undefined), 30);
      if (!dates || length === null) return null;
      for (const date of dates) {
        const start = dayStamp(date) + minutes(dueTime) * MINUTE;
        ranges.push([start, start + length * MINUTE]);
      }
    }
    for (const event of events) {
      if (!record(event)) return null;
      if (own(event, 'cancelled', false) === true || own(event, 'status', '') === 'cancelled' || own(event, 'transparent', false) === true) continue;
      let start = eventEpoch(own(event, 'startAt', null));
      let end = eventEpoch(own(event, 'endAt', null));
      // A date-only all-day range uses an exclusive end date, as calendar
      // exports do. Epoch-based all-day ranges are already absolute ranges.
      if (start === null && end === null && own(event, 'allDay', false) === true && validDate(own(event, 'startDate', '')) && validDate(own(event, 'endDate', ''))) {
        start = dayStamp(event.startDate); end = dayStamp(event.endDate);
      }
      if (start === null || end === null || end <= start) return null;
      ranges.push([start, end]);
    }
    ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    return ranges;
  }
  function overlap(start, end, busy, buffer) {
    const padding = buffer * MINUTE;
    return busy.find(range => start < range[1] + padding && end > range[0] - padding);
  }
  function availability(date, draft, profile) {
    const first = minutes(profile.dayStart);
    const last = minutes(profile.dayEnd);
    const working = profile.workDays.includes(weekday(date));
    const school = profile.schoolDays.includes(weekday(date));
    const workStart = minutes(profile.workStart);
    const workEnd = minutes(profile.workEnd);
    if (isFamilyTask(draft)) return [[Math.max(first, working ? workEnd : first, school ? minutes(profile.kidsHome) : first), last]];
    if (own(draft, 'category', '') === 'Work') return working ? [[Math.max(first, workStart), Math.min(last, workEnd)]] : [];
    return working ? [[first, Math.min(last, workStart)], [Math.max(first, workEnd), last]] : [[first, last]];
  }
  function familyReason(date, profile) {
    const working = profile.workDays.includes(weekday(date));
    const school = profile.schoolDays.includes(weekday(date));
    if (working && school) return 'After your work finishes and the children are home from school, with room around saved commitments.';
    if (working) return 'After your work finishes, on a day without school, with room around saved commitments.';
    if (school) return 'After the children are home from school, on your day off work, with room around saved commitments.';
    return 'On a day off from work and school, within your confirmed family hours and clear of saved commitments.';
  }

  function proposeTask(draft, context) {
    try {
      if (!record(draft) || !record(context)) return invalid('invalid_input', 'I could not read this task safely. Please check its details.');
      const now = epoch(own(context, 'now', Date.now()));
      if (now === null) return invalid('invalid_now', 'Please check the current date and time before planning.');
      const profile = profileValues(own(context, 'profile', null));
      if (!profile) return invalid('invalid_profile', 'Please check your routine and its times before planning.');
      if (!profile.enabled) return invalid('routine_not_confirmed', 'Confirm your family routine first so I can choose a suitable time.');
      const dueDate = own(draft, 'dueDate', '');
      const dueTime = own(draft, 'dueTime', '');
      if (dueDate && !validDate(dueDate)) return invalid('needs_date', 'Please choose a valid calendar date.');
      if (dueTime && !clock(dueTime)) return invalid('needs_time', 'Please choose a clear time, such as 18:00, so I do not guess am or pm.');
      if (dueTime && !dueDate) return invalid('needs_date', 'Which day is that time for? I will keep the time you choose.');
      if (!dueTime && (own(draft, 'type', '') === 'appointment' || own(draft, 'remindAt', null) !== null)) return invalid('needs_time', 'Please choose the appointment or reminder time. I will not move it automatically.');
      const length = duration(own(draft, 'durationMinutes', undefined), isFamilyTask(draft) ? profile.familyMinutes : profile.taskMinutes);
      if (length === null) return invalid('invalid_duration', 'Please choose a task length from 5 to 480 minutes.');
      const firstDate = dateText(now);
      const lastDate = addDays(firstDate, 6);
      if (!validDate(lastDate)) return invalid('invalid_now', 'This date is outside the supported planning range.');
      const checkStart = dueDate && dueTime ? dueDate : firstDate;
      const checkEnd = dueDate && dueTime ? dueDate : lastDate;
      const busy = busyRanges(own(context, 'tasks', []), own(context, 'events', []), draft, checkStart, checkEnd);
      if (!busy) return invalid('invalid_busy_data', 'Some calendar or task times could not be checked. Review them before I choose a time.');

      if (dueDate && dueTime) {
        const start = dayStamp(dueDate) + minutes(dueTime) * MINUTE;
        const end = start + length * MINUTE;
        if (start < now) return invalid('past_time', 'That time has passed. Please choose another date or time.');
        if (minutes(dueTime) + length >= 1440) return invalid('day_boundary', 'This task would finish the next day. Please choose an earlier time or a shorter length.');
        if (overlap(start, end, busy, profile.bufferMinutes)) return invalid('fixed_conflict', 'The time you chose overlaps a saved commitment or the buffer around it. I kept your time; please review the clash.', true);
        return { ok: true, date: dueDate, time: dueTime, durationMinutes: length, endTime: clockText(minutes(dueTime) + length), reason: 'Kept the date and time you chose and checked your saved commitments.', conflict: false };
      }
      if (dueDate && (dueDate < firstDate || dueDate > lastDate)) return invalid(dueDate < firstDate ? 'past_date' : 'outside_horizon', dueDate < firstDate ? 'That day has passed. Please choose today or a future day.' : 'I plan the next seven days. Choose a date in that range or set an exact time yourself.');

      const dates = dueDate ? [dueDate] : Array.from({ length: 7 }, (_, index) => addDays(firstDate, index));
      for (const date of dates) {
        const midnight = dayStamp(date);
        for (const [opening, closing] of availability(date, draft, profile)) {
          // Five-minute starts are readable and never round back into the past.
          let candidate = Math.ceil(Math.max(midnight + opening * MINUTE, now) / (5 * MINUTE)) * 5 * MINUTE;
          const limit = midnight + closing * MINUTE;
          while (candidate + length * MINUTE <= limit) {
            const clash = overlap(candidate, candidate + length * MINUTE, busy, profile.bufferMinutes);
            if (!clash) {
              const startMinute = Math.round((candidate - midnight) / MINUTE);
              const why = isFamilyTask(draft)
                ? familyReason(date, profile)
                : own(draft, 'category', '') === 'Work' ? 'During your confirmed work hours, clear of saved commitments.' : 'Outside your confirmed work hours, clear of saved commitments.';
              return { ok: true, date, time: clockText(startMinute), durationMinutes: length, endTime: clockText(startMinute + length), reason: why, conflict: false };
            }
            candidate = Math.ceil((clash[1] + profile.bufferMinutes * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
          }
        }
      }
      return invalid('no_fit', dueDate ? 'I could not find a free slot on that day within your routine. Try a shorter task or choose another day.' : 'I could not find a free slot in the next seven days within your routine. Try a shorter task or review your commitments.', true);
    } catch (_) {
      return invalid('invalid_input', 'I could not read these planning details safely. Please review the task, routine and calendar.');
    }
  }

  const api = Object.freeze({ defaults, isFamilyTask, proposeTask });
  root.TidyPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
