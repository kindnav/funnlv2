/**
 * InteractionFormFields — the fields of the "Log interaction" form, shared by the desktop
 * inline form (ContactDetailPage) and the phone bottom sheet (LogInteractionSheet).
 *
 * One implementation of: Type, Date (required), Notes, Follow-up date, and the outreach
 * controls (Email/Message: opt-in checkbox + status; Call/Other: a status select;
 * Coffee chat/Event: none), plus the form error. State and the submit handler stay in
 * ContactDetailPage, so mutation logic, analytics and Log Result behaviour have one
 * source of truth. Every field has a programmatic label (idPrefix keeps ids unique).
 */

const TYPE_OPTIONS = ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other']
const iCls = 'w-full bg-input border border-line-3 rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'
const sCls = `${iCls} cursor-pointer`

const STATUS_OPTIONS = [
  ['awaiting_response', 'Awaiting response'],
  ['responded', 'Responded'],
  ['meeting_booked', 'Meeting booked'],
  ['no_response', 'No response'],
  ['declined', 'Declined'],
]

export default function InteractionFormFields({
  idPrefix,
  type, onTypeChange,
  interactionDate, setInteractionDate,
  notes, setNotes,
  followUpDate, setFollowUpDate,
  trackOutreach, setTrackOutreach,
  outreachStatus, setOutreachStatus,
  formError,
  typeSelectRef,
  followUpDateRef,
}) {
  const id = (name) => `${idPrefix}-${name}`
  return (
    <>
      <div>
        <label className={lCls} htmlFor={id('type')}>Type</label>
        <select id={id('type')} ref={typeSelectRef} value={type} onChange={e => onTypeChange(e.target.value)} className={sCls}>
          {TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
        </select>
      </div>

      <div>
        <label className={lCls} htmlFor={id('date')}>
          Date <span style={{ color: 'var(--color-ember)' }}>*</span>
        </label>
        <input id={id('date')} type="date" value={interactionDate} onChange={e => setInteractionDate(e.target.value)} required className={iCls}/>
      </div>

      <div>
        <label className={lCls} htmlFor={id('notes')}>Notes</label>
        <textarea
          id={id('notes')}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
          placeholder="What did you talk about? Any key takeaways?"
          className={`${iCls} resize-y min-h-[80px]`}
        />
      </div>

      <div>
        <label className={lCls} htmlFor={id('followup')}>Follow-up date</label>
        <input id={id('followup')} ref={followUpDateRef} type="date" value={followUpDate} onChange={e => setFollowUpDate(e.target.value)} className={iCls}/>
      </div>

      {/* Outreach — Email / Message: explicit opt-in */}
      {(type === 'Email' || type === 'Message') && (
        <div className="space-y-2.5">
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={trackOutreach}
              onChange={e => {
                setTrackOutreach(e.target.checked)
                if (e.target.checked && !outreachStatus) setOutreachStatus('awaiting_response')
                if (!e.target.checked) setOutreachStatus('')
              }}
              className="w-4 h-4 accent-[#FF4423] cursor-pointer"
            />
            <span className="text-[13px] font-semibold text-hi">This was outreach I sent</span>
          </label>
          <p className="text-[12px] text-lower">
            Track the response manually. Automatic inbox syncing is not enabled.
          </p>
          {trackOutreach && (
            <select aria-label="Outreach status" value={outreachStatus} onChange={e => setOutreachStatus(e.target.value)} className={sCls}>
              {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          )}
        </div>
      )}

      {/* Outreach — Call / Other: a direct status select */}
      {(type === 'Call' || type === 'Other') && (
        <div>
          <label className={lCls} htmlFor={id('outreach-status')}>
            Outreach status
            <span className="text-lower font-normal ml-1">
              — Track the outcome manually. Automatic syncing is not enabled.
            </span>
          </label>
          <select id={id('outreach-status')} value={outreachStatus} onChange={e => setOutreachStatus(e.target.value)} className={sCls}>
            <option value="">— not set —</option>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      )}

      {formError && (
        <p className="text-sm font-medium" style={{ color: 'var(--color-danger)' }}>{formError}</p>
      )}
    </>
  )
}
