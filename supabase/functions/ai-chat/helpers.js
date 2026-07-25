// Pure functions used by the ai-chat Edge Function.
// Plain JavaScript (no TypeScript annotations) so Node.js test files
// can import them directly without transpilation.

/**
 * Returns today's date in YYYY-MM-DD using local time (not UTC) to match
 * the same date convention used throughout the app.
 */
export function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Formats the user's contacts and interactions into a structured, readable
 * context block for Claude. Notes are capped at 300 characters so one long
 * note can't dominate the token budget. Overdue follow-ups are flagged
 * explicitly so the assistant can surface them naturally.
 *
 * @param {Array} contacts
 * @param {Array} interactions
 * @param {string} today  YYYY-MM-DD
 * @returns {string}
 */
export function formatNetworkContext(contacts, interactions, today) {
  if (contacts.length === 0) {
    return "THE USER'S NETWORK:\nNo contacts have been logged yet."
  }

  // Group interactions by contact_id (DB query is already date-ordered ascending)
  const byContact = new Map()
  for (const ix of interactions) {
    const list = byContact.get(ix.contact_id) ?? []
    list.push(ix)
    byContact.set(ix.contact_id, list)
  }

  const lines = [`CONTACTS (${contacts.length} total):\n`]

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]
    const cInteractions = byContact.get(c.id) ?? []

    const meta = []
    if (c.company)           meta.push(`Company: ${c.company}`)
    if (c.role)              meta.push(`Role: ${c.role}`)
    if (c.how_met)           meta.push(`How met: ${c.how_met}`)
    if (c.relationship_type) meta.push(`Relationship type: ${c.relationship_type}`)

    lines.push(`[${i + 1}] ${c.name}`)
    if (meta.length)              lines.push(`  ${meta.join(' | ')}`)
    if (c.tags?.length)           lines.push(`  Tags: ${c.tags.join(', ')}`)
    if (c.relationship_note)      lines.push(`  Relationship note: ${c.relationship_note}`)
    if (c.email)                  lines.push(`  Email: ${c.email}`)

    if (cInteractions.length === 0) {
      lines.push(`  No interactions logged`)
    } else {
      lines.push(`  Interactions (${cInteractions.length}):`)
      for (const ix of cInteractions) {
        const notes = ix.notes
          ? ` — ${ix.notes.slice(0, 300)}${ix.notes.length > 300 ? '…' : ''}`
          : ''
        const followUp = ix.follow_up_date
          ? ` [Follow up: ${ix.follow_up_date}${ix.follow_up_date < today ? ' — OVERDUE' : ''}]`
          : ''
        lines.push(`    • ${ix.interaction_date} ${ix.type}${notes}${followUp}`)
      }
    }
    lines.push('') // blank line between contacts for readability
  }

  return lines.join('\n')
}
