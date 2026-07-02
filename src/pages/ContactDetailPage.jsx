import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function ContactDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Edit state
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Delete state
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Log interaction state
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [type, setType] = useState('Coffee chat')
  const [interactionDate, setInteractionDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')

  // Edit/delete interaction state
  const [editingInteractionId, setEditingInteractionId] = useState(null)
  const [interactionEditForm, setInteractionEditForm] = useState({})
  const [savingInteraction, setSavingInteraction] = useState(false)
  const [interactionSaveError, setInteractionSaveError] = useState('')
  const [deletingInteractionId, setDeletingInteractionId] = useState(null)

  useEffect(() => {
    fetchContact()
    fetchInteractions()
  }, [id])

  async function fetchContact() {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      setError(error.message)
    } else {
      setContact(data)
    }
    setLoading(false)
  }

  async function fetchInteractions() {
    const { data, error } = await supabase
      .from('interactions')
      .select('*')
      .eq('contact_id', id)
      .order('interaction_date', { ascending: false })

    if (!error) {
      setInteractions(data)
    }
  }

  function startEdit() {
    setEditForm({
      name: contact.name,
      company: contact.company || '',
      role: contact.role || '',
      howMet: contact.how_met || '',
      email: contact.email || '',
      linkedinUrl: contact.linkedin_url || '',
      tagsInput: contact.tags ? contact.tags.join(', ') : '',
      skillsInput: contact.skills ? contact.skills.join(', ') : '',
    })
    setSaveError('')
    setIsEditing(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError('')

    const tags = editForm.tagsInput.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    const skills = editForm.skillsInput.split(',').map((s) => s.trim()).filter((s) => s.length > 0)

    const { error } = await supabase
      .from('contacts')
      .update({
        name: editForm.name,
        company: editForm.company || null,
        role: editForm.role || null,
        how_met: editForm.howMet || null,
        email: editForm.email || null,
        linkedin_url: editForm.linkedinUrl || null,
        tags: tags.length > 0 ? tags : null,
        skills: skills.length > 0 ? skills : null,
      })
      .eq('id', id)

    setSaving(false)

    if (error) {
      setSaveError(error.message)
      return
    }

    setIsEditing(false)
    fetchContact()
  }

  async function handleDelete() {
    const { error } = await supabase.from('contacts').delete().eq('id', id)

    if (error) {
      setError(error.message)
      return
    }

    navigate('/contacts')
  }

  function startEditInteraction(interaction) {
    setInteractionEditForm({
      type: interaction.type || 'Coffee chat',
      date: interaction.interaction_date,
      notes: interaction.notes || '',
      followUpDate: interaction.follow_up_date || '',
    })
    setInteractionSaveError('')
    setEditingInteractionId(interaction.id)
  }

  async function handleSaveInteraction(e) {
    e.preventDefault()
    setSavingInteraction(true)
    setInteractionSaveError('')

    const { error } = await supabase
      .from('interactions')
      .update({
        type: interactionEditForm.type,
        interaction_date: interactionEditForm.date,
        notes: interactionEditForm.notes || null,
        follow_up_date: interactionEditForm.followUpDate || null,
      })
      .eq('id', editingInteractionId)

    setSavingInteraction(false)

    if (error) {
      setInteractionSaveError(error.message)
      return
    }

    setEditingInteractionId(null)
    fetchInteractions()
  }

  async function handleDeleteInteraction(interactionId) {
    const { error } = await supabase.from('interactions').delete().eq('id', interactionId)

    if (!error) {
      setDeletingInteractionId(null)
      fetchInteractions()
    }
  }

  async function handleLogInteraction(e) {
    e.preventDefault()
    setSubmitting(true)
    setFormError('')

    const { error } = await supabase.from('interactions').insert([{
      contact_id: id,
      type,
      interaction_date: interactionDate,
      notes: notes || null,
      follow_up_date: followUpDate || null,
    }])

    setSubmitting(false)

    if (error) {
      setFormError(error.message)
      return
    }

    setNotes('')
    setFollowUpDate('')
    setShowForm(false)
    fetchInteractions()
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white px-6 py-10">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    )
  }

  if (error || !contact) {
    return (
      <div className="min-h-screen bg-white px-6 py-10">
        <Link to="/contacts" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">← Back to Contacts</Link>
        <p className="mt-4 text-sm text-red-600">{error || 'Contact not found.'}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white px-6 py-10">
      <div className="mx-auto max-w-2xl">

        <Link to="/contacts" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">
          ← Back to Contacts
        </Link>

        {/* Profile */}
        <div className="mt-6 mb-10">
          {isEditing ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Name *</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  required
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Company</label>
                <input
                  value={editForm.company}
                  onChange={(e) => setEditForm({ ...editForm, company: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Role</label>
                <input
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">How you met</label>
                <input
                  value={editForm.howMet}
                  onChange={(e) => setEditForm({ ...editForm, howMet: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">LinkedIn URL</label>
                <input
                  value={editForm.linkedinUrl}
                  onChange={(e) => setEditForm({ ...editForm, linkedinUrl: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Tags</label>
                <input
                  value={editForm.tagsInput}
                  onChange={(e) => setEditForm({ ...editForm, tagsInput: e.target.value })}
                  placeholder="alumni, recruiter, target firm"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
                <p className="mt-1 text-xs text-gray-400">Separate multiple tags with commas</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Skills</label>
                <input
                  value={editForm.skillsInput}
                  onChange={(e) => setEditForm({ ...editForm, skillsInput: e.target.value })}
                  placeholder="python, excel, financial modeling"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                />
                <p className="mt-1 text-xs text-gray-400">Separate multiple skills with commas</p>
              </div>

              {saveError && <p className="text-sm text-red-600">{saveError}</p>}

              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-3xl font-semibold text-gray-900">{contact.name}</h1>
                  {(contact.role || contact.company) && (
                    <p className="mt-1 text-lg text-gray-500">
                      {[contact.role, contact.company].filter(Boolean).join(' at ')}
                    </p>
                  )}
                </div>
                <div className="ml-4 flex shrink-0 items-center gap-4">
                  <button
                    onClick={startEdit}
                    className="text-sm font-medium text-gray-500 hover:text-gray-800"
                  >
                    Edit
                  </button>
                  {confirmingDelete ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Delete everything?</span>
                      <button
                        onClick={handleDelete}
                        className="text-sm font-medium text-red-600 hover:text-red-500"
                      >
                        Yes, delete
                      </button>
                      <button
                        onClick={() => setConfirmingDelete(false)}
                        className="text-sm font-medium text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmingDelete(true)}
                      className="text-sm font-medium text-red-500 hover:text-red-600"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-6 space-y-2">
                {contact.how_met && (
                  <p className="text-sm text-gray-600">
                    <span className="font-medium text-gray-700">How met: </span>
                    {contact.how_met}
                  </p>
                )}
                {contact.email && (
                  <p className="text-sm text-gray-600">
                    <span className="font-medium text-gray-700">Email: </span>
                    <a href={`mailto:${contact.email}`} className="text-indigo-600 hover:text-indigo-500">
                      {contact.email}
                    </a>
                  </p>
                )}
                {contact.linkedin_url && (
                  <p className="text-sm text-gray-600">
                    <span className="font-medium text-gray-700">LinkedIn: </span>
                    <a
                      href={contact.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 hover:text-indigo-500"
                    >
                      {contact.linkedin_url}
                    </a>
                  </p>
                )}
              </div>

              {contact.tags && contact.tags.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Tags</p>
                  <div className="flex flex-wrap gap-2">
                    {contact.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {contact.skills && contact.skills.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Skills</p>
                  <div className="flex flex-wrap gap-2">
                    {contact.skills.map((skill) => (
                      <span key={skill} className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Interactions */}
        {!isEditing && (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900">Interactions</h2>
              <button
                onClick={() => setShowForm((prev) => !prev)}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                {showForm ? 'Cancel' : '+ Log Interaction'}
              </button>
            </div>

            {showForm && (
              <form onSubmit={handleLogInteraction} className="mb-6 space-y-3 rounded-md border border-gray-200 p-4">
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
                    rows={4}
                    placeholder="What did you talk about? Any key takeaways?"
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

                {formError && <p className="text-sm text-red-600">{formError}</p>}

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
              <ul className="space-y-3">
                {interactions.map((interaction) => (
                  <li key={interaction.id} className="rounded-md border border-gray-200 p-4">
                    {editingInteractionId === interaction.id ? (
                      <form onSubmit={handleSaveInteraction} className="space-y-3">
                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
                          <select
                            value={interactionEditForm.type}
                            onChange={(e) => setInteractionEditForm({ ...interactionEditForm, type: e.target.value })}
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
                            value={interactionEditForm.date}
                            onChange={(e) => setInteractionEditForm({ ...interactionEditForm, date: e.target.value })}
                            required
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
                          <textarea
                            value={interactionEditForm.notes}
                            onChange={(e) => setInteractionEditForm({ ...interactionEditForm, notes: e.target.value })}
                            rows={3}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-gray-700">Follow-up date</label>
                          <input
                            type="date"
                            value={interactionEditForm.followUpDate}
                            onChange={(e) => setInteractionEditForm({ ...interactionEditForm, followUpDate: e.target.value })}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                          />
                        </div>
                        {interactionSaveError && <p className="text-sm text-red-600">{interactionSaveError}</p>}
                        <div className="flex gap-3">
                          <button
                            type="submit"
                            disabled={savingInteraction}
                            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                          >
                            {savingInteraction ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingInteractionId(null)}
                            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-medium text-gray-800">{interaction.type || 'Interaction'}</p>
                            <p className="text-xs text-gray-400">{interaction.interaction_date}</p>
                          </div>
                          <div className="ml-4 flex shrink-0 items-center gap-3">
                            <button
                              onClick={() => startEditInteraction(interaction)}
                              className="text-sm font-medium text-gray-400 hover:text-gray-700"
                            >
                              Edit
                            </button>
                            {deletingInteractionId === interaction.id ? (
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleDeleteInteraction(interaction.id)}
                                  className="text-sm font-medium text-red-600 hover:text-red-500"
                                >
                                  Yes, delete
                                </button>
                                <button
                                  onClick={() => setDeletingInteractionId(null)}
                                  className="text-sm font-medium text-gray-400 hover:text-gray-600"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setDeletingInteractionId(interaction.id)}
                                className="text-sm font-medium text-red-400 hover:text-red-500"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                        {interaction.notes && (
                          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{interaction.notes}</p>
                        )}
                        {interaction.follow_up_date && (
                          <p className="mt-2 text-xs font-medium text-amber-600">Follow up: {interaction.follow_up_date}</p>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

export default ContactDetailPage
