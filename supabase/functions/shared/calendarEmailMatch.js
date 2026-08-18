// Deterministic email matching for Calendar ingestion (Phase A).
//
// Pure, cross-runtime (Node + Deno). No browser imports, no Supabase, no I/O.
// This module NEVER fuzzy-matches and NEVER creates a contact — it only decides,
// for a single normalized email address, whether it maps to exactly one of the
// current user's stored contacts.
//
// Normalization semantics are centralized here (trim + lowercase) so the shared
// Edge runtime does not depend on any browser-only module (e.g. src/lib/*).

// Local part prefixes that indicate an automated / no-reply / system sender.
// Matched at the START of the local part, terminated by end-of-part or a
// separator (. + _ -) so "noreply", "no-reply", "no_reply.team" all match but
// "noreplyfan" (a real word) does not, and "norbert" does not.
const AUTOMATED_LOCAL_RE =
  /^(no[-_]?reply|do[-_]?not[-_]?reply|donotreply|mailer-daemon|postmaster|bounce|bounces|notification|notifications|automated|auto[-_]?reply)($|[._+-])/;

// Google-generated calendar addresses (resources, rooms, group calendars,
// holidays, imported feeds). These are never real people.
const GOOGLE_CALENDAR_DOMAIN_SUFFIX = '.calendar.google.com';
const GOOGLE_CALENDAR_NOTIFICATION = 'calendar-notification@google.com';

/**
 * Canonical Calendar email normalization: trim + lowercase.
 * Non-string / empty input normalizes to '' (treated as "no address").
 * @param {unknown} email
 * @returns {string}
 */
export function normalizeCalendarEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * True when the (already normalized) address is a resource, room, group,
 * automated, or no-reply address that must never become a contact match.
 * Fails closed: malformed / partless addresses are treated as excluded.
 * @param {string} normalizedEmail
 * @returns {boolean}
 */
export function isExcludedAddress(normalizedEmail) {
  if (typeof normalizedEmail !== 'string' || normalizedEmail.length === 0) return true;
  const at = normalizedEmail.indexOf('@');
  // Must have exactly one '@' with non-empty local and domain parts.
  if (at <= 0 || at !== normalizedEmail.lastIndexOf('@') || at === normalizedEmail.length - 1) {
    return true;
  }
  if (normalizedEmail === GOOGLE_CALENDAR_NOTIFICATION) return true;
  const local = normalizedEmail.slice(0, at);
  const domain = normalizedEmail.slice(at + 1);
  if (domain.endsWith(GOOGLE_CALENDAR_DOMAIN_SUFFIX)) return true;
  if (AUTOMATED_LOCAL_RE.test(local)) return true;
  return false;
}

/**
 * True when the address is the connected user's own address (case/space
 * insensitive). Used to exclude the user from their own event's attendee list.
 * @param {string} normalizedEmail already normalized
 * @param {unknown} connectedEmail raw connected-account email
 * @returns {boolean}
 */
export function isConnectedUserEmail(normalizedEmail, connectedEmail) {
  const self = normalizeCalendarEmail(connectedEmail);
  if (!self || !normalizedEmail) return false;
  return normalizedEmail === self;
}

/**
 * Resolve a single normalized email against the user's contacts.
 * Contacts: array of { id, email } (email may be null/blank).
 *
 * Result:
 *   { result: 'excluded' }              excluded/blank address — never a candidate
 *   { result: 'none' }                  zero contact matches
 *   { result: 'matched', contactId }    exactly one contact with this email
 *   { result: 'ambiguous', count }      2+ contacts share this normalized email
 *
 * Never fuzzy matches. Never mutates inputs. Never creates a contact.
 * @param {string} normalizedEmail
 * @param {Array<{id: string, email?: string|null}>} contacts
 */
export function resolveContactMatch(normalizedEmail, contacts) {
  if (isExcludedAddress(normalizedEmail)) return { result: 'excluded' };
  if (!Array.isArray(contacts)) return { result: 'none' };
  const ids = [];
  const seen = new Set();
  for (const c of contacts) {
    if (!c || typeof c.id !== 'string') continue;
    if (normalizeCalendarEmail(c.email) !== normalizedEmail) continue;
    if (seen.has(c.id)) continue; // guard duplicate rows for the same contact id
    seen.add(c.id);
    ids.push(c.id);
  }
  if (ids.length === 0) return { result: 'none' };
  if (ids.length === 1) return { result: 'matched', contactId: ids[0] };
  return { result: 'ambiguous', count: ids.length };
}

/**
 * Reduce a list of raw event email addresses to the distinct set of matched
 * contact ids, while reporting how many produced ambiguous duplicates.
 * Excludes the connected user, excluded/automated addresses, and blanks.
 *
 * @param {Array<unknown>} rawEmails organizer + attendee emails
 * @param {Array<{id: string, email?: string|null}>} contacts
 * @param {unknown} connectedEmail
 * @returns {{ matchedContactIds: string[], ambiguousCount: number }}
 */
export function matchEventContacts(rawEmails, contacts, connectedEmail) {
  const matched = new Set();
  const consideredAddresses = new Set();
  let ambiguousCount = 0;
  const list = Array.isArray(rawEmails) ? rawEmails : [];
  for (const raw of list) {
    const n = normalizeCalendarEmail(raw);
    if (!n || consideredAddresses.has(n)) continue;
    consideredAddresses.add(n);
    if (isConnectedUserEmail(n, connectedEmail)) continue;
    const m = resolveContactMatch(n, contacts);
    if (m.result === 'matched') matched.add(m.contactId);
    else if (m.result === 'ambiguous') ambiguousCount += 1;
    // 'excluded' / 'none' contribute nothing.
  }
  return { matchedContactIds: [...matched], ambiguousCount };
}
