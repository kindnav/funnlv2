import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function DashboardPage() {
  const [contactCount, setContactCount] = useState(0)
  const [interactionCount, setInteractionCount] = useState(0)
  const [followUps, setFollowUps] = useState([])
  const [recentContacts, setRecentContacts] = useState([])
  const [loading, setLoading] = useState(true)

  const today = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    fetchAll()
  }, [])

  async function fetchAll() {
    const [
      { count: contacts },
      { count: interactions },
      { data: followUpsData },
      { data: recentData },
    ] = await Promise.all([
      supabase.from('contacts').select('*', { count: 'exact', head: true }),
      supabase.from('interactions').select('*', { count: 'exact', head: true }),
      supabase
        .from('interactions')
        .select('*, contacts(id, name)')
        .not('follow_up_date', 'is', null)
        .lte('follow_up_date', today)
        .order('follow_up_date', { ascending: true }),
      supabase
        .from('contacts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5),
    ])

    setContactCount(contacts || 0)
    setInteractionCount(interactions || 0)
    setFollowUps(followUpsData || [])
    setRecentContacts(recentData || [])
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="px-6 py-10">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-3xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mb-8 text-gray-500">Here's what's on your radar.</p>

        {/* Stats */}
        <div className="mb-10 grid grid-cols-3 gap-4">
          <div className="rounded-md border border-gray-200 p-5">
            <p className="text-3xl font-bold text-gray-900">{contactCount}</p>
            <p className="mt-1 text-sm text-gray-500">{contactCount === 1 ? 'Contact' : 'Contacts'}</p>
          </div>
          <div className="rounded-md border border-gray-200 p-5">
            <p className="text-3xl font-bold text-gray-900">{interactionCount}</p>
            <p className="mt-1 text-sm text-gray-500">{interactionCount === 1 ? 'Interaction' : 'Interactions'}</p>
          </div>
          <div className={`rounded-md border p-5 ${followUps.length > 0 ? 'border-amber-200 bg-amber-50' : 'border-gray-200'}`}>
            <p className={`text-3xl font-bold ${followUps.length > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
              {followUps.length}
            </p>
            <p className={`mt-1 text-sm ${followUps.length > 0 ? 'text-amber-600' : 'text-gray-500'}`}>
              Follow-up{followUps.length !== 1 ? 's' : ''} due
            </p>
          </div>
        </div>

        {/* Follow-ups due */}
        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Follow-ups due</h2>
          {followUps.length === 0 ? (
            <p className="text-sm text-gray-400">No follow-ups due — you're all caught up.</p>
          ) : (
            <ul className="space-y-2">
              {followUps.map((interaction) => (
                <li key={interaction.id}>
                  <Link
                    to={`/contacts/${interaction.contact_id}`}
                    className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-4 py-3 transition-colors hover:border-amber-300"
                  >
                    <div>
                      <p className="font-medium text-gray-900">
                        {interaction.contacts?.name || 'Unknown contact'}
                      </p>
                      <p className="text-sm text-gray-500">{interaction.type}</p>
                    </div>
                    <p className="shrink-0 text-sm font-medium text-amber-600">{interaction.follow_up_date}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent contacts */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Recent contacts</h2>
            <Link to="/contacts" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">
              View all →
            </Link>
          </div>
          {recentContacts.length === 0 ? (
            <p className="text-sm text-gray-400">
              No contacts yet.{' '}
              <Link to="/contacts" className="text-indigo-600 hover:text-indigo-500">
                Add your first one.
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {recentContacts.map((contact) => (
                <li key={contact.id}>
                  <Link
                    to={`/contacts/${contact.id}`}
                    className="flex items-center justify-between rounded-md border border-gray-200 px-4 py-3 transition-colors hover:border-indigo-300"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{contact.name}</p>
                      {(contact.role || contact.company) && (
                        <p className="text-sm text-gray-500">
                          {[contact.role, contact.company].filter(Boolean).join(' at ')}
                        </p>
                      )}
                    </div>
                    {contact.tags && contact.tags.length > 0 && (
                      <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        {contact.tags[0]}
                        {contact.tags.length > 1 ? ` +${contact.tags.length - 1}` : ''}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

export default DashboardPage
