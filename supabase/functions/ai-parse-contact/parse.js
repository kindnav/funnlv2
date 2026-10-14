// AI Fill: turn the model's text reply into a contact object, WITHOUT ever logging it.
//
// The model's reply is derived from what the user pasted - names, employers, addresses,
// anything about a real person - so it must never reach a log, an error message or a
// response other than the parsed object itself. This module only parses; the caller logs
// the controlled `code` and nothing else.
//
// Behaviour is unchanged from the inline version it replaces: strip one surrounding
// markdown code fence if present, then JSON.parse. A reply that is not valid JSON is
// `unparseable_model_output`; an empty reply is `empty_model_output`, which the inline
// version reported as the same parse failure (JSON.parse('') throws).

/** Controlled failure codes. Safe to log; never contain model output. */
export const PARSE_FAILURE_CODES = Object.freeze(['empty_model_output', 'unparseable_model_output'])

/**
 * @param {unknown} rawText  the model's text block
 * @returns {{ ok: true, contact: object } | { ok: false, code: string }}
 */
export function parseModelContact (rawText) {
  let text = typeof rawText === 'string' ? rawText.trim() : ''
  if (text.length === 0) return { ok: false, code: 'empty_model_output' }
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  let value
  try { value = JSON.parse(text) } catch { return { ok: false, code: 'unparseable_model_output' } }
  // Any JSON value is passed through exactly as before; validating its shape is not part
  // of this logging fix.
  return { ok: true, contact: value }
}
