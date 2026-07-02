import { Link } from 'react-router-dom'

function ContactListItem({ contact }) {
  return (
    <li>
      <Link
        to={`/contacts/${contact.id}`}
        className="block rounded-md border border-gray-200 p-4 transition-colors hover:border-indigo-300"
      >
        <p className="font-semibold text-gray-900">{contact.name}</p>
        {(contact.role || contact.company) && (
          <p className="text-sm text-gray-500">{[contact.role, contact.company].filter(Boolean).join(' at ')}</p>
        )}
        {contact.email && <p className="mt-1 text-sm text-gray-500">{contact.email}</p>}
        {contact.tags && contact.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {contact.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                {tag}
              </span>
            ))}
          </div>
        )}
      </Link>
    </li>
  )
}

export default ContactListItem
