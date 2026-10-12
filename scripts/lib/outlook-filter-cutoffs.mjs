// Cutoff arithmetic for the owner-run conversation-lookup filter check.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE SCRIPT. The production builder formats an
// instant with `toODataInstant`, which TRUNCATES the fraction (`.replace(/\.\d{3}Z$/, 'Z')`).
// So the cutoff that is actually TRANSMITTED is the containing second, not the instant we
// chose - and a helper that reasons about the instant it chose rather than the one it sends
// will make claims the request cannot support.
//
// REPRODUCED AS A WRONG CLAIM, which is why this exists: with a message at `10:00:00.100Z`
// and `10:00:00.900Z`, the midpoint is `10:00:00.500Z`, the helper said its cutoff was
// "between the two instants", and the builder sent `10:00:00Z` - below BOTH of them. The
// request could not discriminate the two properties at all, and would have been reported as
// though it had.
//
// Everything here reasons about the TRANSMITTED value, by calling the production builder's
// own formatter. The builder itself is not changed.

import { toODataInstant } from '../../supabase/functions/shared/outlookGraphTransport.js'

const SECOND = 1000

/** What the builder will actually put on the wire for this instant. */
export function transmitted (iso) {
  return toODataInstant(iso)
}

const ms = (iso) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** The start of the second containing this instant. */
const floorSecond = (t) => Math.floor(t / SECOND) * SECOND

const isoSecond = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * A cutoff that INCLUDES the chosen message, and whether it is an EXACT boundary test.
 *
 * `ge` is inclusive, so the containing second always includes the message. It is only an
 * exact inclusive-BOUNDARY test when the transmitted cutoff equals the message's own
 * timestamp - which is to say, when that timestamp has no fractional part. With a fraction
 * the request still demonstrates inclusion, but the boundary it probes is up to a second
 * below the message, and claiming otherwise would be claiming something untested.
 *
 * @returns {{ ok: boolean, cutoff: string|null, transmitted: string|null, exact: boolean }}
 */
export function inclusiveCutoff (iso) {
  const t = ms(iso)
  if (t === null) return { ok: false, cutoff: null, transmitted: null, exact: false }
  const cutoff = isoSecond(floorSecond(t))
  return { ok: true, cutoff, transmitted: cutoff, exact: t === floorSecond(t) }
}

/**
 * A cutoff that EXCLUDES the chosen message: the first whole second strictly after the one
 * containing it. Correct for a fractional instant too, where "one second later" alone would
 * have been formatted back down into the same second.
 */
export function exclusiveCutoff (iso) {
  const t = ms(iso)
  if (t === null) return { ok: false, cutoff: null, transmitted: null }
  const cutoff = isoSecond(floorSecond(t) + SECOND)
  return { ok: true, cutoff, transmitted: cutoff }
}

/**
 * A whole-second cutoff that is STRICTLY BETWEEN two instants after builder formatting, so
 * the same message is included under one property and excluded under the other.
 *
 * The only candidate worth trying is the first whole second after the earlier instant: any
 * later whole second is further from the earlier one and no more likely to stay below the
 * later one. If that candidate is not strictly below the later instant, no whole second is,
 * and the honest answer is NOT AVAILABLE.
 *
 * STRICT on purpose. A cutoff exactly equal to the later instant would also discriminate -
 * `ge` includes it - but reporting a result that turns on an equality edge invites an
 * argument about the edge rather than about the provider. NOT AVAILABLE is the safer answer
 * and the one the owner can act on: pick another message.
 *
 * @returns {{ available: boolean, cutoff: string|null, transmitted: string|null,
 *             includedUnder: 'a'|'b'|null, excludedUnder: 'a'|'b'|null, reason: string|null }}
 */
export function discriminatingCutoff (isoA, isoB) {
  const none = (reason) => ({
    available: false, cutoff: null, transmitted: null,
    includedUnder: null, excludedUnder: null, reason,
  })
  const a = ms(isoA)
  const b = ms(isoB)
  if (a === null || b === null) return none('one of the instants is not a timestamp')
  if (a === b) return none('the two instants are identical, so no cutoff can separate them')

  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const candidate = floorSecond(lo) + SECOND
  if (!(candidate > lo && candidate < hi)) {
    return none('the two instants fall inside the same second, or are separated only by a '
      + 'fraction, so no WHOLE second lies strictly between them once the builder truncates')
  }
  const cutoff = isoSecond(candidate)
  const includedUnder = a > b ? 'a' : 'b'
  return {
    available: true,
    cutoff,
    transmitted: cutoff,
    includedUnder,
    excludedUnder: includedUnder === 'a' ? 'b' : 'a',
    reason: null,
  }
}

/** Would a message with this property value be returned under this transmitted cutoff? */
export function wouldInclude (messageIso, transmittedCutoffIso) {
  const m = ms(messageIso)
  const c = ms(transmittedCutoffIso)
  if (m === null || c === null) return null
  return m >= c
}
