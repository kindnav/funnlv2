// Outlook PR-B — deterministic sanitization and minimization of one message's content.
//
// Pure, cross-runtime. No imports, no I/O, no logging, no randomness, no clock.
// Given the same input it always produces the same output, so its behaviour is fully
// pinned by tests rather than by a model.
//
// ── WHAT THIS MODULE IS FOR ───────────────────────────────────────────────────
// It turns one Graph message body into the SMALLEST piece of readable current-message
// text that can support an interaction summary, plus (separately) the sender's
// signature block, because a signature is the one place a company or job title is
// stated explicitly rather than inferred.
//
// ── WHAT IT NEVER TOUCHES ─────────────────────────────────────────────────────
// Attachments, inline attachment payloads and raw MIME are never inputs to this
// sanitizer and have no code path here: nothing requests them, and this function's
// signature accepts only the two body projections and the subject
// (`bodyContentType`/`bodyContent`, `uniqueBodyContentType`/`uniqueBodyContent`,
// `subject`).
//
// Microsoft message headers are a different case, and the distinction matters:
//   * They ARE fetched - by the transport's single bounded per-message GET, which
//     selects `internetMessageHeaders` alongside the body (see CONTENT_SELECT in
//     outlookGraphTransport.js). That is deliberate: automation/bulk-list detection
//     needs them, and fetching them there avoids a second round trip.
//   * The transport immediately reduces the raw collection to the controlled
//     automation facts (booleans and small enums) via `automationFactsFromHeaders`
//     and DISCARDS the collection; it is never returned from `readMessageContent`.
//   * Raw headers are therefore never passed into this sanitizer, and no header name
//     or value can reach the Anthropic request, a fingerprint, a stored draft, the
//     database, storage, a file, or a log.
//
// ── STORAGE / LOGGING INVARIANT ───────────────────────────────────────────────
// The strings this module returns are MEMORY-ONLY working values. Nothing here writes
// to storage or logs, and no caller may persist `text` or `signature`: the PR-A schema
// has no column for them, and the only persisted derivatives are the bounded
// `draft_summary` / `draft_follow_up` / `retained_subject` fields, which are produced
// downstream and independently length-checked against the applied CHECK constraints.

// ── Bounds ────────────────────────────────────────────────────────────────────
export const MAX_INPUT_CHARS = 200_000       // refuse to even scan beyond this
export const MAX_TEXT_CHARS = 4_000          // sanitized current-message text kept
export const MAX_SIGNATURE_CHARS = 600       // signature block kept
export const MAX_SUBJECT_CHARS = 160         // matches ncc_subject_bounds (<= 160)
export const MAX_EPISODE_CHARS = 12_000      // aggregate across an episode's messages
export const MAX_EPISODE_MESSAGES = 6        // messages contributed to one episode
export const MIN_USABLE_CHARS = 2            // below this there is nothing to summarize
export const MAX_SIGNATURE_LINES = 10

// Controlled outcome codes. These are the only failure strings returned.
export const SANITIZE_CODES = Object.freeze([
  'empty_content', 'binary_like', 'oversized_content', 'no_usable_text', 'malformed_content',
])

// ── Character classes stripped unconditionally ────────────────────────────────
// C0/C1 controls except \n and \t; DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g')
// Bidirectional overrides/isolates. These can visually reverse text so that what a
// reviewer reads is not what the model read — a real spoofing vector, always removed.
const BIDI_RE = new RegExp('[\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]', 'g')
// Zero-width and other nonprinting formatting characters (can hide instructions inside words).
const INVISIBLE_RE = new RegExp('[\\u00AD\\u200B-\\u200D\\u2060\\u2061-\\u2064\\uFEFF]', 'g')
// Runs of spaces / non-breaking spaces. Escaped-string form for the same reason.
const NBSP_RUN_RE = new RegExp('[ \\u00A0]{2,}', 'g')

// Elements whose ENTIRE content is discarded (script/style/markup-only, tracking).
const DROP_BLOCK_RE =
  /<(script|style|head|noscript|template|svg|math|object|embed|applet|iframe|frameset)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
// Unclosed variants of the same tags. A malformed `<script>evil()` with no closing
// tag must not leak its body as prose, so everything from the opening tag to the end
// of the input is discarded — the remaining markup is untrustworthy anyway.
const DROP_OPEN_RE = /<(script|style|head|noscript|template|svg|math|object|embed|applet|iframe|frameset)\b[\s\S]*$/i
const COMMENT_RE = /<!--[\s\S]*?-->/g
const CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/g
const DOCTYPE_RE = /<![^>]*>/g
// Void/media elements that carry no text: img is the classic tracking pixel.
const VOID_DROP_RE = /<(img|input|link|meta|base|source|track|area|col|param)\b[^>]*\/?>/gi
// Block-ish tags that imply a line break when flattened.
const BLOCK_BREAK_RE = /<\/?(p|div|br|tr|li|h[1-6]|blockquote|table|thead|tbody|section|article|header|footer|ul|ol|pre|hr)\b[^>]*>/gi
const ANY_TAG_RE = /<[^>]*>/g

const ENTITIES = Object.freeze({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&nbsp;': ' ', '&#160;': ' ', '&mdash;': '-', '&ndash;': '-', '&hellip;': '...',
  '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&#8217;': "'",
})

/** Looks like markup even if Graph claimed `text`. */
export function looksLikeHtml(s) {
  if (typeof s !== 'string') return false
  return /<\s*(html|body|div|p|br|span|table|a|img|head|meta|style|script)\b/i.test(s) ||
    /<\/[a-z][a-z0-9]*\s*>/i.test(s)
}

/** Conservative numeric/named entity decode. Never evaluates anything. */
export function decodeEntities(s) {
  let out = s.replace(/&[a-zA-Z#0-9]{2,10};/g, (m) => {
    const lower = m.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(ENTITIES, lower)) return ENTITIES[lower]
    const dec = /^&#(\d{1,7});$/.exec(m)
    if (dec) {
      const cp = Number(dec[1])
      if (cp >= 32 && cp <= 0x10FFFF) { try { return String.fromCodePoint(cp) } catch { return ' ' } }
      return ' '
    }
    const hex = /^&#x([0-9a-f]{1,6});$/i.exec(m)
    if (hex) {
      const cp = parseInt(hex[1], 16)
      if (cp >= 32 && cp <= 0x10FFFF) { try { return String.fromCodePoint(cp) } catch { return ' ' } }
      return ' '
    }
    return ' '
  })
  // A second pass catches one level of double-encoding (&amp;lt; -> &lt; -> <).
  out = out.replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
  return out
}

/** Flatten HTML to plain text, dropping every element that carries no readable text. */
export function htmlToText(html) {
  if (typeof html !== 'string') return ''
  let s = html
  s = s.replace(COMMENT_RE, ' ').replace(CDATA_RE, ' ')
  s = s.replace(DROP_BLOCK_RE, ' ')
  s = s.replace(DROP_OPEN_RE, ' ')
  s = s.replace(VOID_DROP_RE, ' ')
  s = s.replace(BLOCK_BREAK_RE, '\n')
  s = s.replace(DOCTYPE_RE, ' ')
  s = s.replace(ANY_TAG_RE, ' ')
  s = decodeEntities(s)
  return s
}

/** Remove control, bidi and nonprinting characters, then normalize whitespace. */
export function stripUnsafeCharacters(s) {
  if (typeof s !== 'string') return ''
  return s
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(INVISIBLE_RE, '')
    .replace(/\t/g, ' ')
    .replace(NBSP_RUN_RE, ' ')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Quoted history ────────────────────────────────────────────────────────────
// Markers that begin the PREVIOUS message in a reply chain. Matched at line start.
const QUOTE_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}\s*$/i,
  /^-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^_{5,}\s*$/,
  /^on\s.{1,240}\bwrote:\s*$/i,
  /^from:\s*\S.*$/i,
  /^sent from my \w+/i,
  /^>{1,}\s?/,
]

/**
 * Cut the message at the first quoted-history marker. Graph's `uniqueBody` already
 * does this server-side, so this is the fallback for when only `body` is available (or
 * when uniqueBody came back empty).
 * @returns {{ text:string, quotedRemoved:boolean }}
 */
export function trimQuotedHistory(text) {
  if (typeof text !== 'string' || text.length === 0) return { text: '', quotedRemoved: false }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.length === 0) continue
    for (const re of QUOTE_MARKERS) {
      if (re.test(line)) {
        // A marker on the very first non-empty line would leave nothing; in that case
        // keep the text as-is and let the length checks decide.
        const head = lines.slice(0, i).join('\n').trim()
        if (head.length === 0) return { text: text.trim(), quotedRemoved: false }
        return { text: head, quotedRemoved: true }
      }
    }
  }
  return { text: text.trim(), quotedRemoved: false }
}

// ── Legal / boilerplate footers ───────────────────────────────────────────────
const FOOTER_MARKERS = [
  /\bthis (e-?mail|message) (and any attachments? )?(is|are) (intended|confidential)/i,
  /\bconfidentiality notice\b/i,
  /\bif you are not the intended recipient\b/i,
  /\bplease consider the environment before printing\b/i,
  /\bto unsubscribe\b/i,
  /\bunsubscribe\b.{0,40}\bpreferences\b/i,
  /\bview (this|it) in your browser\b/i,
  /\ball rights reserved\b/i,
]

/**
 * Cut an oversized legal/marketing footer. Only trims when the removed tail is
 * actually boilerplate-sized, so a short sign-off is never mistaken for a disclaimer.
 * @returns {{ text:string, footerRemoved:boolean }}
 */
export function trimFooter(text) {
  if (typeof text !== 'string' || text.length === 0) return { text: '', footerRemoved: false }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    for (const re of FOOTER_MARKERS) {
      if (re.test(line)) {
        const head = lines.slice(0, i).join('\n').trim()
        if (head.length < MIN_USABLE_CHARS) return { text: text.trim(), footerRemoved: false }
        return { text: head, footerRemoved: true }
      }
    }
  }
  return { text: text.trim(), footerRemoved: false }
}

// ── Signature ─────────────────────────────────────────────────────────────────
// A signature is kept because it is the ONLY source this product accepts for an
// explicit company/role proposal (see the ncc_*_evidence_check constraints, which
// admit 'explicit_signature' / 'explicit_body' and deliberately NOT a domain guess).
const SIG_DELIM_RE = /^--\s*$/
// Cues that a trailing block is a signature rather than prose.
const SIG_CUE_RE =
  /(\b(director|manager|engineer|analyst|associate|partner|founder|recruiter|intern|president|officer|lead|head of|vp|ceo|cto|cfo|coo)\b|\|\s*\S|\b(inc|llc|ltd|plc|gmbh|corp|capital|partners|group|university|college)\b)/i

/**
 * Split a trailing signature block off the message text.
 * Prefers an explicit `--` delimiter; otherwise takes a short trailing block that
 * carries signature cues. Returns both halves, each independently bounded.
 * @returns {{ text:string, signature:string|null }}
 */
export function splitSignature(text) {
  if (typeof text !== 'string' || text.length === 0) return { text: '', signature: null }
  const lines = text.split('\n')

  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
    if (SIG_DELIM_RE.test(lines[i])) {
      const sig = lines.slice(i + 1).join('\n').trim()
      const body = lines.slice(0, i).join('\n').trim()
      if (sig.length > 0 && body.length >= MIN_USABLE_CHARS) {
        return { text: body, signature: sig.slice(0, MAX_SIGNATURE_CHARS) }
      }
      return { text: text.trim(), signature: null }
    }
  }

  // No delimiter: consider the last few non-empty lines.
  let start = lines.length
  let seen = 0
  for (let i = lines.length - 1; i >= 0 && seen < MAX_SIGNATURE_LINES; i--) {
    if (lines[i].trim().length === 0) {
      if (seen > 0) break
      continue
    }
    start = i
    seen += 1
  }
  if (seen === 0 || start === 0) return { text: text.trim(), signature: null }
  const tail = lines.slice(start).join('\n').trim()
  const head = lines.slice(0, start).join('\n').trim()
  // Only treat it as a signature when it is short, cue-bearing, and leaves real body.
  if (head.length >= MIN_USABLE_CHARS && tail.length <= MAX_SIGNATURE_CHARS && SIG_CUE_RE.test(tail)) {
    return { text: head, signature: tail }
  }
  return { text: text.trim(), signature: null }
}

/**
 * Heuristic: does this look like binary/base64 payload rather than prose?
 * Guards against a mis-typed body or an inline payload leaking into the text path.
 */
export function looksBinary(s) {
  if (typeof s !== 'string' || s.length === 0) return false
  const sample = s.slice(0, 4000)
  let replacement = 0
  for (const ch of sample) if (ch === '�') replacement += 1
  if (replacement / Math.max(sample.length, 1) > 0.02) return true
  // A long unbroken base64-ish run with no spaces is not prose.
  if (/[A-Za-z0-9+/]{400,}={0,2}/.test(sample)) return true
  const letters = (sample.match(/[\p{L}\p{N}\s.,!?'"()@:;-]/gu) || []).length
  return letters / sample.length < 0.6
}

/** Bounded, control-free subject suitable for `retained_subject` (<= 160 chars). */
export function sanitizeSubject(subject) {
  if (typeof subject !== 'string') return null
  const s = stripUnsafeCharacters(subject).replace(/\n+/g, ' ').trim()
  if (s.length === 0) return null
  return s.slice(0, MAX_SUBJECT_CHARS)
}

/**
 * Sanitize ONE message's content.
 *
 * `uniqueBody` is preferred because Graph already excludes the quoted conversation
 * history from it; `body` is the fallback and is then quote-trimmed locally.
 *
 * @param {{ bodyContentType:('text'|'html'|null), bodyContent:string,
 *           uniqueBodyContentType:('text'|'html'|null), uniqueBodyContent:string,
 *           subject?:string }} input
 * @returns {{ ok:true, text:string, signature:string|null, subject:string|null,
 *             flags:{ source:'uniqueBody'|'body', wasHtml:boolean, quotedRemoved:boolean,
 *                     footerRemoved:boolean, truncated:boolean } }
 *         | { ok:false, code:string }}
 */
export function sanitizeMessageContent(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'malformed_content' }
  }
  const uniq = typeof input.uniqueBodyContent === 'string' ? input.uniqueBodyContent : ''
  const full = typeof input.bodyContent === 'string' ? input.bodyContent : ''
  if (uniq.length > MAX_INPUT_CHARS || full.length > MAX_INPUT_CHARS) {
    return { ok: false, code: 'oversized_content' }
  }
  if (uniq.trim().length === 0 && full.trim().length === 0) return { ok: false, code: 'empty_content' }

  const useUnique = uniq.trim().length > 0
  const raw = useUnique ? uniq : full
  const declared = useUnique ? input.uniqueBodyContentType : input.bodyContentType

  if (looksBinary(raw)) return { ok: false, code: 'binary_like' }

  // Graph MAY return HTML even though `Prefer: outlook.body-content-type="text"` was
  // sent (the preference is advisory and only confirmed by Preference-Applied), so the
  // declared type is treated as a hint and the content is sniffed as well.
  const wasHtml = declared === 'html' || looksLikeHtml(raw)
  let text = wasHtml ? htmlToText(raw) : raw
  text = stripUnsafeCharacters(text)
  if (text.length === 0) return { ok: false, code: 'no_usable_text' }

  // Only the `body` fallback needs local quote trimming; uniqueBody is already trimmed.
  let quotedRemoved = false
  if (!useUnique) {
    const q = trimQuotedHistory(text)
    text = q.text
    quotedRemoved = q.quotedRemoved
  }

  const f = trimFooter(text)
  text = f.text

  const s = splitSignature(text)
  text = s.text
  const signature = s.signature

  if (text.length < MIN_USABLE_CHARS) return { ok: false, code: 'no_usable_text' }
  if (looksBinary(text)) return { ok: false, code: 'binary_like' }

  const truncated = text.length > MAX_TEXT_CHARS
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS)

  return {
    ok: true,
    text,
    signature: signature ? signature.slice(0, MAX_SIGNATURE_CHARS) : null,
    subject: sanitizeSubject(input.subject),
    flags: {
      source: useUnique ? 'uniqueBody' : 'body',
      wasHtml,
      quotedRemoved,
      footerRemoved: f.footerRemoved,
      truncated,
    },
  }
}

/**
 * Apply the AGGREGATE bound across the messages of one episode. Keeps the most recent
 * messages (the ones an interaction summary is actually about) and stops once the
 * total budget or the message cap is reached.
 *
 * @param {Array<{ timestampIso:string, sanitized:{text:string,signature:string|null} }>} parts
 * @returns {{ kept:Array<object>, totalChars:number, droppedForBudget:number }}
 */
export function boundEpisodeContent(parts) {
  const list = Array.isArray(parts) ? parts.slice() : []
  list.sort((a, b) => String(b?.timestampIso ?? '').localeCompare(String(a?.timestampIso ?? '')))
  const kept = []
  let total = 0
  let dropped = 0
  for (const p of list) {
    const text = p && p.sanitized && typeof p.sanitized.text === 'string' ? p.sanitized.text : ''
    if (kept.length >= MAX_EPISODE_MESSAGES || total + text.length > MAX_EPISODE_CHARS) {
      dropped += 1
      continue
    }
    kept.push(p)
    total += text.length
  }
  kept.reverse()   // chronological for the reader
  return { kept, totalChars: total, droppedForBudget: dropped }
}
