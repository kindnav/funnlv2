import { useNavigate } from 'react-router-dom'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'

function ContactListItem({ contact, onDeleteRequest }) {
  const navigate = useNavigate()
  const hasEmail = !!contact.email
  const hasLinkedIn = !!contact.linkedin_url
  const hasTags = contact.tags && contact.tags.length > 0

  return (
    <div
      onClick={() => navigate(`/contacts/${contact.id}`)}
      className="group bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-[18px] cursor-pointer hover:border-[rgba(139,124,255,0.3)] transition-colors flex flex-col gap-[13px]"
    >
      {/* Top row: avatar + name/role + icon buttons */}
      <div className="flex items-start gap-3">
        <div
          className="w-[46px] h-[46px] rounded-[13px] flex items-center justify-center text-[15px] font-bold text-white flex-none"
          style={{ background: getAvatarColor(contact.name) }}
        >
          {getInitials(contact.name)}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[15.5px] font-bold text-hi truncate">{contact.name}</p>
          {(contact.role || contact.company) && (
            <p className="text-[13px] text-muted truncate">
              {[contact.role, contact.company].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>

        {/* Email + LinkedIn icon buttons — dimmed if field is empty */}
        <div className="flex gap-1.5 flex-none">
          {hasEmail ? (
            <a
              href={`mailto:${contact.email}`}
              onClick={(e) => e.stopPropagation()}
              title={contact.email}
              className="w-8 h-8 rounded-[9px] bg-elevated border border-[rgba(255,255,255,0.07)] flex items-center justify-center hover:border-[rgba(139,124,255,0.4)] transition-colors"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A8A94" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
              </svg>
            </a>
          ) : (
            <div
              title="No email saved"
              className="w-8 h-8 rounded-[9px] bg-elevated border border-[rgba(255,255,255,0.07)] flex items-center justify-center opacity-25"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A8A94" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
              </svg>
            </div>
          )}

          {hasLinkedIn ? (
            <a
              href={contact.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open LinkedIn"
              className="w-8 h-8 rounded-[9px] bg-elevated border border-[rgba(255,255,255,0.07)] flex items-center justify-center hover:border-[rgba(139,124,255,0.4)] transition-colors text-[#8A8A94] text-[12px] font-bold font-mono"
            >
              in
            </a>
          ) : (
            <div
              title="No LinkedIn saved"
              className="w-8 h-8 rounded-[9px] bg-elevated border border-[rgba(255,255,255,0.07)] flex items-center justify-center opacity-25 text-[#8A8A94] text-[12px] font-bold font-mono"
            >
              in
            </div>
          )}

          {/* Trash icon — revealed on desktop hover only.
              opacity-0 + pointer-events-none on touch screens prevents accidental mis-taps.
              Mobile users delete via the contact detail page (one tap away). */}
          <button
            onClick={e => { e.stopPropagation(); onDeleteRequest(contact) }}
            title="Delete contact"
            className="w-8 h-8 rounded-[9px] bg-elevated border border-[rgba(255,255,255,0.07)] flex items-center justify-center text-low hover:text-danger hover:border-[rgba(255,107,138,0.35)] opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Tags — only renders if any exist */}
      {hasTags && (
        <div className="flex flex-wrap gap-1.5">
          {contact.tags.map((tag) => (
            <span
              key={tag}
              className="text-[11px] font-semibold text-tag bg-[rgba(108,92,255,0.13)] border border-[rgba(108,92,255,0.22)] px-[9px] py-[3px] rounded-full"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: relationship_type + how_met */}
      {(contact.relationship_type || contact.how_met) && (
        <div className="flex items-center gap-1.5 text-[12px] text-low border-t border-[rgba(255,255,255,0.05)] pt-[11px] min-w-0">
          {contact.relationship_type && (
            <span className="text-[11.5px] font-semibold text-accent shrink-0">{contact.relationship_type}</span>
          )}
          {contact.relationship_type && contact.how_met && (
            <span className="text-lower shrink-0">·</span>
          )}
          {contact.how_met && (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                <path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/>
                <circle cx="12" cy="11" r="2"/>
              </svg>
              <span className="truncate">Met at {contact.how_met}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default ContactListItem
