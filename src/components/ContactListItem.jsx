import { useState } from 'react'

function ContactListItem({ contact, interactions, onLogInteraction }) {
  const [expanded, setExpanded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [type, setType] = useState('Coffee chat')
  const [interactionDate, setInteractionDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')

    const result = await onLogInteraction(contact.id, {
      type,
      interaction_date: interactionDate,
      notes: notes || null,
      follow_up_date: followUpDate || null,
    })

    setSubmitting(false)

    if (result?.error) {
      setError(result.error)
      return
    }

    setNotes('')
    setFollowUpDate('')
    setShowForm(false)
  }

  return (
    <li className="rounded-md border border-gray-200 p-4">
      <button onClick={() => setExpanded((prev) => !prev)} className="flex w-full items-center justify-between text-left">
        <div>
          <p className="font-semibold text-gray-900">{contact.name}</p>
          {(contact.role || contact.company) && (
            <p className="text-sm text-gray-500">{[contact.role, contact.company].filter(Boolean).join(' at ')}</p>
          )}
        </div>
        <span className="text-sm text-gray-400">{expanded ? 'Hide' : 'View'} interactions</span>
      </button>

      {contact.email && <p className="mt-2 text-sm text-gray-500">{contact.email}</p>}
      {contact.tags && contact.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {contact.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
              {tag}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <button
            onClick={() => setShowForm((prev) => !prev)}
            className="mb-4 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            {showForm ? 'Cancel' : '+ Log Interaction'}
          </button>

          {showForm && (
            <form onSubmit={handleSubmit} className="mb-4 space-y-3 rounded-md border border-gray-200 p-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                >
                  <option>Coffee chat</option>
                  <option>Email</option>
                  <option>Event</option>
                  <option>Call</option>
                  <option>Message</option>
                  <option>Other</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Date *</label>
                <input
                  type="date"
                  value={interactionDate}
                  onChange={(e) => setInteractionDate(e.target.value)}
                  required
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Follow-up date</label>
                <input
                  type="date"
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-md bg-indigo-600 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Save Interaction'}
              </button>
            </form>
          )}

          {interactions.length === 0 ? (
            <p className="text-sm text-gray-400">No interactions logged yet.</p>
          ) : (
            <ul className="space-y-2">
              {interactions.map((interaction) => (
                <li key={interaction.id} className="rounded-md bg-gray-50 p-3 text-sm">
                  <p className="font-medium text-gray-700">
                    {interaction.type || 'Interaction'} — {interaction.interaction_date}
                  </p>
                  {interaction.notes && <p className="mt-1 text-gray-600">{interaction.notes}</p>}
                  {interaction.follow_up_date && (
                    <p className="mt-1 text-xs text-gray-400">Follow up: {interaction.follow_up_date}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export default ContactListItem
