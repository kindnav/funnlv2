import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ContactListItem from '../components/ContactListItem'

function ContactsPage() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [howMet, setHowMet] = useState('')
  const [email, setEmail] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [skillsInput, setSkillsInput] = useState('')

  useEffect(() => {
    fetchContacts()
  }, [])

  async function fetchContacts() {
    setLoading(true)
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
    } else {
      setContacts(data)
    }
    setLoading(false)
  }

  function resetForm() {
    setName('')
    setCompany('')
    setRole('')
    setHowMet('')
    setEmail('')
    setLinkedinUrl('')
    setTagsInput('')
    setSkillsInput('')
  }

  async function handleAddContact(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)

    const skills = skillsInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const { error } = await supabase.from('contacts').insert([
      {
        name,
        company: company || null,
        role: role || null,
        how_met: howMet || null,
        email: email || null,
        linkedin_url: linkedinUrl || null,
        tags: tags.length > 0 ? tags : null,
        skills: skills.length > 0 ? skills : null,
      },
    ])

    setSubmitting(false)

    if (error) {
      setError(error.message)
      return
    }

    resetForm()
    setShowForm(false)
    fetchContacts()
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  return (
    <div className="min-h-screen bg-white px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-semibold text-gray-900">Contacts</h1>
          <button onClick={handleSignOut} className="text-sm font-medium text-gray-500 hover:text-gray-700">
            Sign Out
          </button>
        </div>

        <button
          onClick={() => setShowForm((prev) => !prev)}
          className="mb-6 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          {showForm ? 'Cancel' : '+ Add Contact'}
        </button>

        {showForm && (
          <form onSubmit={handleAddContact} className="mb-10 space-y-4 rounded-md border border-gray-200 p-6">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Company</label>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Role</label>
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">How you met</label>
              <input
                value={howMet}
                onChange={(e) => setHowMet(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">LinkedIn URL</label>
              <input
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Tags</label>
              <input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="alumni, recruiter, target firm"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-400">Separate multiple tags with commas</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Skills</label>
              <input
                value={skillsInput}
                onChange={(e) => setSkillsInput(e.target.value)}
                placeholder="python, excel, financial modeling"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-400">Separate multiple skills with commas</p>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-indigo-600 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save Contact'}
            </button>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-gray-400">Loading contacts...</p>
        ) : contacts.length === 0 ? (
          <p className="text-sm text-gray-400">No contacts yet. Add your first one above.</p>
        ) : (
          <ul className="space-y-3">
            {contacts.map((contact) => (
              <ContactListItem key={contact.id} contact={contact} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default ContactsPage
