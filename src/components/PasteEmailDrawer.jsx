import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import {
  requestPasteDraft, messageForPasteCode, initialAttribution, resolveInteractionDate,
  createPasteSaver, messageForSave, reviewErrors, MAX_NOTE_CHARS,
} from '../lib/pasteEmailCapture'

// Paste an email (Pro): paste -> review -> save, in one drawer.
//
// The pasted text lives only in this component's state. It is sent once to ai-paste-email,
// never stored or logged, and cleared after a successful save or when the drawer is cancelled.
// Nothing reaches the database until the reviewer presses Save.

const MAX_PASTE_CHARS = 12_000

const inputClass = 'w-full bg-input border border-line-3 rounded-xl px-[13px] py-[10px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors'
const labelClass = 'block text-[12px] font-semibold text-mid mb-1.5'

function PasteEmailDrawer ({ contacts = [], preselectedContact = null, onClose, onSaved }) {
  const [step, setStep] = useState('paste')
  const [text, setText] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState('')

  const [candidates, setCandidates] = useState([])
  const [warning, setWarning] = useState(null)
  const [person, setPerson] = useState(null)
  const [otherContactId, setOtherContactId] = useState('')
  const [addresses, setAddresses] = useState([])
  const [aiFields, setAiFields] = useState({})
  const [contactDraft, setContactDraft] = useState({ name: '', email: '', company: '', role: '', how_met: '', linkedin_url: '' })
  const [interaction, setInteraction] = useState({ date: '', notes: '', followUpDate: '' })
  const [dateNote, setDateNote] = useState('')
  const [followUpSuggestion, setFollowUpSuggestion] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null)

  const saverRef = useRef(null)

  // Explicit cancellation clears the raw paste before the drawer goes away.
  function cancel () {
    setText('')
    onClose?.()
  }

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape' && !saving) { setText(''); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  async function draft () {
    setError('')
    if (!text.trim()) { setError(messageForPasteCode('empty')); return }
    setDrafting(true)
    const r = await requestPasteDraft(supabase, text)
    setDrafting(false)
    if (!r.ok) { setError(messageForPasteCode(r.code)); return }

    const d = r.data
    const att = initialAttribution({
      preselectedContactId: preselectedContact?.id ?? null,
      addresses: d.addresses,
      contacts,
    })
    setCandidates(att.candidates)
    setWarning(att.warning)
    setPerson(att.person)
    setAddresses(Array.isArray(d.addresses) ? d.addresses.map((a) => a.address) : [])
    setAiFields(d.contact?.fields ?? {})

    let tz = 'UTC'
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { /* keep UTC */ }
    const dt = resolveInteractionDate(d.date, tz)
    setInteraction({ date: dt.value, notes: d.note?.summary ?? '', followUpDate: '' })
    setDateNote(dt.note)
    setFollowUpSuggestion(d.note?.follow_up ?? '')

    saverRef.current = createPasteSaver({
      insertContact: async (payload) => {
        const { data, error: e } = await supabase.from('contacts').insert([payload]).select('id').single()
        if (e || !data?.id) return { error: true }
        track('contact_added', { via_ai_fill: true, has_tags: Array.isArray(payload.tags) && payload.tags.length > 0, has_relationship_type: false })
        return { id: data.id }
      },
      insertInteraction: async (payload) => {
        const { error: e } = await supabase.from('interactions').insert([payload])
        if (e) return { error: true }
        track('interaction_logged', { interaction_type: 'Email', has_follow_up: !!payload.follow_up_date, has_notes: !!payload.notes })
        window.dispatchEvent(new Event('funnl:interactions-changed'))
        if (payload.follow_up_date) {
          track('followup_set')
          window.dispatchEvent(new Event('funnl:followups-changed'))
        }
        return { ok: true }
      },
    })
    setStep('review')
  }

  // Choosing "new contact" offers the AI's fields - and ONLY then. They are never applied to an
  // existing contact, and nothing is filled in merely because an address was found.
  function choose (next) {
    if (saverRef.current?.snapshot().createdContactId) return   // locked once a contact exists
    setPerson(next)
    if (next?.kind === 'new') {
      setContactDraft((cur) => ({
        name: cur.name || aiFields.name || '',
        email: cur.email || '',
        company: cur.company || aiFields.company || '',
        role: cur.role || aiFields.role || '',
        how_met: cur.how_met || aiFields.how_met || '',
        linkedin_url: cur.linkedin_url || aiFields.linkedin_url || '',
        tags: aiFields.tags ?? [],
        relationship_note: aiFields.relationship_note ?? '',
      }))
    }
  }

  async function save () {
    if (!saverRef.current || saving) return
    setSaving(true)
    const r = await saverRef.current.save({ person, contactDraft, interaction })
    setSaving(false)
    setSaveResult(r)
    if (r.status === 'saved') {
      setText('')   // successful completion clears the raw paste
      onSaved?.({ contactId: r.contactId })
    }
  }

  const locked = !!saveResult?.createdContactId
  const errors = useMemo(() => reviewErrors({
    person: locked ? { kind: 'existing', contactId: saveResult.createdContactId } : person,
    contactDraft,
    interaction,
  }), [person, contactDraft, interaction, locked, saveResult])
  const done = saveResult?.status === 'saved' || saveResult?.status === 'already_saved'
  const otherContacts = contacts.filter((c) => !candidates.some((x) => x.matches.some((m) => m.id === c.id)))

  return (
    <>
      <div className="fixed inset-0 z-40" style={{ background: 'var(--color-backdrop)', animation: 'fade-in 0.2s ease-out' }} onClick={() => { if (!saving) cancel() }} />
      <div
        role="dialog"
        aria-label="Paste an email"
        className="fixed inset-y-0 right-0 w-full md:w-[480px] z-50 flex flex-col"
        style={{ background: 'var(--color-card)', borderLeft: '1px solid var(--color-line-3)', boxShadow: '-30px 0 60px rgba(0,0,0,0.3)', animation: 'slide-in-right 0.25s ease-out' }}
      >
        <div className="flex items-center justify-between px-[26px] py-[22px] border-b border-line-1 flex-none">
          <h2 className="font-display text-[18px] font-bold text-hi">Paste an email</h2>
          <button type="button" onClick={cancel} disabled={saving} aria-label="Close"
            className="w-[34px] h-[34px] rounded-[9px] border border-line-2 flex items-center justify-center hover:border-line-3 transition-colors"
            style={{ background: 'var(--color-elevated)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-[26px] py-[22px] space-y-5">
          {step === 'paste' && (
            <>
              <div className="p-4 rounded-xl border border-line-2 text-[12.5px] leading-relaxed text-mid" style={{ background: 'var(--color-elevated)' }} data-testid="paste-email-explanation">
                Funnl sends the email you paste to Anthropic (Claude) to draft a contact and an interaction note for you to review.
                Email addresses Funnl recognises are replaced before it is sent and stay in Funnl, for matching your contacts.
                Funnl cannot guarantee every identifying detail is removed. The text you paste is not stored, and nothing is saved until you press Save.{' '}
                <Link to="/privacy" target="_blank" rel="noopener noreferrer" className="text-accent underline">Privacy policy</Link>
              </div>
              {preselectedContact && (
                <p className="text-[13px] text-mid">Logging an email with <span className="text-hi font-semibold">{preselectedContact.name}</span>.</p>
              )}
              <div>
                <label htmlFor="paste-email-text" className={labelClass}>Email</label>
                <textarea id="paste-email-text" value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_PASTE_CHARS))}
                  rows={12} maxLength={MAX_PASTE_CHARS} placeholder="Paste the email or thread here…" className={inputClass + ' resize-y'} />
                <p className="text-[11px] text-lower mt-1">{text.length.toLocaleString('en-US')} / {MAX_PASTE_CHARS.toLocaleString('en-US')}</p>
              </div>
              {error && <p className="text-[12.5px]" style={{ color: 'var(--color-danger)' }} role="alert">{error}</p>}
            </>
          )}

          {step === 'review' && (
            <>
              <section className="space-y-2">
                <h3 className="text-[13px] font-bold text-hi">Who is this email with?</h3>
                {preselectedContact ? (
                  <>
                    <p className="text-[13px] text-mid">{preselectedContact.name}</p>
                    {warning === 'preselected_not_in_paste' && (
                      <p className="text-[12px]" style={{ color: 'var(--color-warning)' }}>
                        {preselectedContact.name}&apos;s saved email address does not appear in this email. Check it is the right person.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="space-y-1.5" role="radiogroup" aria-label="Choose the person">
                    {candidates.flatMap((c) => c.matches.map((m) => (
                      <label key={`${c.address}:${m.id}`} className="flex items-center gap-2 text-[13px] text-hi">
                        <input type="radio" name="paste-person" disabled={locked}
                          checked={person?.kind === 'existing' && person.contactId === m.id && !otherContactId}
                          onChange={() => { setOtherContactId(''); choose({ kind: 'existing', contactId: m.id }) }} />
                        {m.name} <span className="text-lower text-[12px]">({c.address})</span>
                      </label>
                    )))}
                    <div className="flex items-center gap-2 text-[13px] text-hi">
                      <input type="radio" name="paste-person" disabled={locked} aria-label="Another existing contact"
                        checked={person?.kind === 'existing' && !!otherContactId && person.contactId === otherContactId}
                        onChange={() => { if (otherContactId) choose({ kind: 'existing', contactId: otherContactId }) }} />
                      <select value={otherContactId} disabled={locked} className={inputClass}
                        onChange={(e) => { setOtherContactId(e.target.value); if (e.target.value) choose({ kind: 'existing', contactId: e.target.value }) }}>
                        <option value="">Another existing contact…</option>
                        {otherContacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <label className="flex items-center gap-2 text-[13px] text-hi">
                      <input type="radio" name="paste-person" disabled={locked}
                        checked={person?.kind === 'new'} onChange={() => { setOtherContactId(''); choose({ kind: 'new' }) }} />
                      A new contact
                    </label>
                    {!person && <p className="text-[12px] text-lower">Choose who this email is with. Funnl does not decide this for you.</p>}
                  </div>
                )}
              </section>

              {person?.kind === 'new' && !preselectedContact && (
                <section className="space-y-3" data-testid="paste-email-new-contact">
                  <h3 className="text-[13px] font-bold text-hi">New contact</h3>
                  <p className="text-[12px] text-lower">Suggested from the email. Check each one describes this person, and clear anything you are not sure of.</p>
                  <div><label className={labelClass}>Name *</label>
                    <input className={inputClass} value={contactDraft.name} disabled={locked} onChange={(e) => setContactDraft({ ...contactDraft, name: e.target.value })} /></div>
                  <div><label className={labelClass}>Email</label>
                    <select className={inputClass} value={contactDraft.email} disabled={locked} onChange={(e) => setContactDraft({ ...contactDraft, email: e.target.value })}>
                      <option value="">None</option>
                      {addresses.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select></div>
                  <div><label className={labelClass}>Company</label>
                    <input className={inputClass} value={contactDraft.company} disabled={locked} onChange={(e) => setContactDraft({ ...contactDraft, company: e.target.value })} /></div>
                  <div><label className={labelClass}>Role</label>
                    <input className={inputClass} value={contactDraft.role} disabled={locked} onChange={(e) => setContactDraft({ ...contactDraft, role: e.target.value })} /></div>
                  <div><label className={labelClass}>How you met</label>
                    <input className={inputClass} value={contactDraft.how_met} disabled={locked} onChange={(e) => setContactDraft({ ...contactDraft, how_met: e.target.value })} /></div>
                  <div><label className={labelClass}>LinkedIn</label>
                    <input className={inputClass} value={contactDraft.linkedin_url} disabled={locked} onChange={(e) => setContactDraft({ ...contactDraft, linkedin_url: e.target.value })} /></div>
                </section>
              )}

              <section className="space-y-3">
                <h3 className="text-[13px] font-bold text-hi">Email interaction</h3>
                <div><label htmlFor="paste-email-date" className={labelClass}>Date *</label>
                  <input id="paste-email-date" type="date" className={inputClass} value={interaction.date} disabled={done}
                    onChange={(e) => setInteraction({ ...interaction, date: e.target.value })} />
                  {dateNote && <p className="text-[11.5px] text-lower mt-1">{dateNote}</p>}</div>
                <div><label htmlFor="paste-email-notes" className={labelClass}>Note</label>
                  <textarea id="paste-email-notes" rows={8} maxLength={MAX_NOTE_CHARS} className={inputClass + ' resize-y'} value={interaction.notes} disabled={done}
                    onChange={(e) => setInteraction({ ...interaction, notes: e.target.value })} />
                  <p className="text-[11px] text-lower mt-1">Drafted from the email. Edit anything that is wrong.</p></div>
                {followUpSuggestion && <p className="text-[12px] text-mid">Suggested next step: {followUpSuggestion}</p>}
                <div><label htmlFor="paste-email-followup" className={labelClass}>Follow-up date (optional)</label>
                  <input id="paste-email-followup" type="date" className={inputClass} value={interaction.followUpDate} disabled={done}
                    onChange={(e) => setInteraction({ ...interaction, followUpDate: e.target.value })} /></div>
              </section>

              {saveResult && (
                <div role="status" aria-live="polite" data-testid="paste-email-save-status"
                  className="p-3 rounded-xl border border-line-2 text-[12.5px] space-y-1" style={{ background: 'var(--color-elevated)' }}>
                  <p className="text-hi">{messageForSave(saveResult)}</p>
                  <p className="text-mid">Contact: {saveResult.contactSaved ? 'saved' : (person?.kind === 'existing' && !locked ? 'existing contact' : 'not saved')} · Interaction: {saveResult.interactionSaved ? 'saved' : 'not saved'}</p>
                </div>
              )}
              {!done && errors.length > 0 && (
                <ul className="text-[12px] text-lower list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-[26px] py-[18px] border-t border-line-1 flex-none">
          <button type="button" onClick={cancel} disabled={saving}
            className="h-[38px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-mid hover:border-line-3 transition-colors">
            {done ? 'Close' : 'Cancel'}
          </button>
          {step === 'paste' && (
            <button type="button" onClick={draft} disabled={drafting || !text.trim()}
              className="h-[38px] px-4 rounded-[10px] text-[13px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}>
              {drafting ? 'Drafting…' : 'Draft from email'}
            </button>
          )}
          {step === 'review' && !done && (
            <button type="button" onClick={save} disabled={saving || errors.length > 0}
              className="h-[38px] px-4 rounded-[10px] text-[13px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}>
              {saving ? 'Saving…' : (saveResult?.contactSaved && !saveResult.interactionSaved ? 'Save interaction' : 'Save')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

export default PasteEmailDrawer
