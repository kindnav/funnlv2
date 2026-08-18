// Timed / all-day event parsing, validation, and derivation for Calendar ingestion.
//
// Pure, cross-runtime (Node + Deno). Uses only Date + Intl.DateTimeFormat, both
// present in Node 20+ and Deno. No browser imports, no Supabase, no I/O.
//
// Google Calendar semantics respected here:
//   - Timed events use start.dateTime / end.dateTime (+ optional timeZone).
//   - All-day events use start.date / end.date, and the end date is EXCLUSIVE.
//   - Recurring instances carry originalStartTime; single events do not (we fall
//     back to start).
// We NEVER invent a midnight timestamp for an all-day event — all-day timing is
// kept as calendar dates, never coerced to an instant.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a UTC instant as the local calendar date (YYYY-MM-DD) in an IANA zone.
 * Intl handles DST correctly. Falls back to UTC for an invalid/unknown zone.
 * @param {Date} date
 * @param {string} timeZone IANA zone id
 * @returns {string} YYYY-MM-DD
 */
export function localDateInTimeZone(date, timeZone) {
  const fmt = (tz) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  try {
    return fmt(timeZone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

/**
 * Parse and validate an event's timing. Fails closed on any malformed or
 * ambiguous shape (both timed and date present, missing end, etc.).
 *
 * @param {{start?: object, end?: object}} event
 * @returns {
 *   { ok: true, kind: 'timed', startAt: Date, endAt: Date, timezone: string|null } |
 *   { ok: true, kind: 'allday', startDate: string, endDate: string } |
 *   { ok: false, reason: string }
 * }
 */
export function parseEventTiming(event) {
  const s = event?.start;
  const e = event?.end;
  if (!s || !e || typeof s !== 'object' || typeof e !== 'object') {
    return { ok: false, reason: 'missing_start_end' };
  }
  const timedStart = typeof s.dateTime === 'string' ? s.dateTime : null;
  const timedEnd = typeof e.dateTime === 'string' ? e.dateTime : null;
  const dateStart = typeof s.date === 'string' ? s.date : null;
  const dateEnd = typeof e.date === 'string' ? e.date : null;

  const hasTimed = timedStart !== null || timedEnd !== null;
  const hasDate = dateStart !== null || dateEnd !== null;
  if (hasTimed && hasDate) return { ok: false, reason: 'mixed_timed_and_allday' };

  if (hasTimed) {
    if (!timedStart || !timedEnd) return { ok: false, reason: 'incomplete_timed' };
    const startAt = new Date(timedStart);
    const endAt = new Date(timedEnd);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return { ok: false, reason: 'invalid_datetime' };
    }
    if (!(endAt.getTime() > startAt.getTime())) {
      return { ok: false, reason: 'end_not_after_start' };
    }
    const timezone = typeof s.timeZone === 'string' && s.timeZone
      ? s.timeZone
      : (typeof e.timeZone === 'string' && e.timeZone ? e.timeZone : null);
    return { ok: true, kind: 'timed', startAt, endAt, timezone };
  }

  if (hasDate) {
    if (!dateStart || !dateEnd) return { ok: false, reason: 'incomplete_allday' };
    if (!DATE_RE.test(dateStart) || !DATE_RE.test(dateEnd)) {
      return { ok: false, reason: 'invalid_date' };
    }
    // Google all-day end.date is exclusive, so a valid event always has end > start.
    if (!(dateEnd > dateStart)) return { ok: false, reason: 'end_date_not_after_start' };
    return { ok: true, kind: 'allday', startDate: dateStart, endDate: dateEnd };
  }

  return { ok: false, reason: 'no_timing' };
}

/**
 * Resolve the original occurrence identity used by the fingerprint.
 * Prefers originalStartTime (stable across reschedules of a recurring instance);
 * falls back to start for single events. Fails closed on malformed input.
 *
 * @param {{originalStartTime?: object, start?: object}} event
 * @returns {{ ok: true, occurrence: {kind:'datetime'|'date', value:string} } | { ok: false, reason: string }}
 */
export function originalOccurrence(event) {
  const src = (event?.originalStartTime && typeof event.originalStartTime === 'object')
    ? event.originalStartTime
    : event?.start;
  if (!src || typeof src !== 'object') return { ok: false, reason: 'missing_occurrence' };
  if (typeof src.dateTime === 'string') {
    const d = new Date(src.dateTime);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: 'invalid_datetime' };
    // Canonical UTC instant so equivalent instants in different offsets match.
    return { ok: true, occurrence: { kind: 'datetime', value: d.toISOString() } };
  }
  if (typeof src.date === 'string' && DATE_RE.test(src.date)) {
    return { ok: true, occurrence: { kind: 'date', value: src.date } };
  }
  return { ok: false, reason: 'invalid_occurrence' };
}

/**
 * The proposed interaction date (YYYY-MM-DD) for a candidate.
 * Timed: the local calendar date of the start instant, in the event/calendar zone.
 * All-day: the (inclusive) start date as-is.
 *
 * @param {ReturnType<typeof parseEventTiming>} timing a successful parse result
 * @param {string} [fallbackTimeZone] calendar default zone when the event has none
 * @returns {string} YYYY-MM-DD
 */
export function deriveInteractionDate(timing, fallbackTimeZone = 'UTC') {
  if (!timing || timing.ok !== true) throw new Error('invalid_timing');
  if (timing.kind === 'allday') return timing.startDate;
  const tz = timing.timezone || fallbackTimeZone || 'UTC';
  return localDateInTimeZone(timing.startAt, tz);
}

/**
 * Whether the event has already completed as of `now`.
 * Timed: end instant is strictly in the past.
 * All-day: the exclusive end date is on/before today's local date (the event's
 * last inclusive day has passed). String compare on YYYY-MM-DD is correct.
 *
 * @param {ReturnType<typeof parseEventTiming>} timing a successful parse result
 * @param {Date} now
 * @param {string} [fallbackTimeZone]
 * @returns {boolean}
 */
export function isCompleted(timing, now, fallbackTimeZone = 'UTC') {
  if (!timing || timing.ok !== true) throw new Error('invalid_timing');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('invalid_now');
  if (timing.kind === 'timed') {
    return timing.endAt.getTime() < now.getTime();
  }
  const today = localDateInTimeZone(now, fallbackTimeZone || 'UTC');
  // end.date is exclusive: event occupies [startDate, endDate). Completed once
  // today has reached or passed the exclusive end boundary.
  return timing.endDate <= today;
}
