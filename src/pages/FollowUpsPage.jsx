import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'
import TopBar from '../components/TopBar'
import ContactPickerModal from '../components/ContactPickerModal'
import {
  getLocalToday,
  localDateOffset,
  groupAndSortFollowUps,
  waitingCount,
  waitingCopy,
  dueLabelStr,
  waitingLabelStr,
  completionLabel,
  completionMethodLabel,
} from '../lib/followUpUtils'
import {
  completeFollowUp,
  snoozeFollowUp,
  undoFollowUp,
  markResponded,
  nudgeFollowUp,
} from '../lib/followUpActions'
import {
  classifySwipeGesture,
  shouldLockHorizontal,
  swipeGestureToAction,
} from '../lib/swipeGesture'

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ name, size = 40 }) {
  return (
    <div
      className="rounded-xl flex items-center justify-center text-[13px] font-bold flex-none"
      style={{ width: size, height: size, background: getAvatarColor(name || ''), color: 'var(--color-paper)' }}
    >
      {getInitials(name || '?')}
    </div>
  )
}

// ── Group heading ─────────────────────────────────────────────────────────────

function GroupHeading({ label, count, color }) {
  return (
    <div className="flex items-center gap-2 pt-5 pb-3 px-5">
      <span className="w-2 h-2 rounded-full flex-none" style={{ background: color }} aria-hidden="true"/>
      <span className="text-[11px] font-bold tracking-[0.6px] uppercase font-mono" style={{ color }}>
        {label}
      </span>
      <span className="text-[11px] font-mono" style={{ color: 'var(--color-low)' }}>· {count}</span>
    </div>
  )
}

// ── Row divider ───────────────────────────────────────────────────────────────

function RowDivider() {
  return <div className="mx-5" style={{ borderTop: '1px solid var(--color-line-1)' }}/>
}

// ── Per-row error ─────────────────────────────────────────────────────────────

function RowError({ msg }) {
  if (!msg) return null
  return (
    <p
      role="alert"
      aria-live="assertive"
      className="text-[11.5px] font-medium mt-1 ml-[54px]"
      style={{ color: 'var(--color-danger)' }}
    >
      {msg}
    </p>
  )
}

// ── Accessible date-action popover ────────────────────────────────────────────
// Shared by Snooze (on dated rows) and Nudge (on awaiting-response rows).
//
// Props:
//   popoverId    – unique string used for aria-controls / aria-expanded
//   isOpen       – boolean
//   onClose      – () => void
//   onOption     – (option: string) => void  (option ∈ 'tomorrow'|'three_days'|'one_week'|'custom')
//   customDate   – string  YYYY-MM-DD
//   onCustomDate – (val: string) => void
//   isSaving     – boolean
//   error        – string
//   label        – button group label (e.g. 'Snooze' | 'Nudge')
//   triggerRef   – ref to the trigger button (focus is restored to it on close)
//   today        – YYYY-MM-DD (min date for custom input)

function DateActionPopover({ popoverId, isOpen, onClose, onOption, customDate, onCustomDate, isSaving, error, label, triggerRef, today }) {
  const menuRef = useRef(null)
  const firstOptionRef = useRef(null)
  const errorId = `${popoverId}-error`

  // Focus first option when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => firstOptionRef.current?.focus(), 0)
    }
  }, [isOpen])

  // Escape closes menu
  useEffect(() => {
    if (!isOpen) return
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); setTimeout(() => triggerRef?.current?.focus(), 0) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, triggerRef])

  // Outside click closes menu
  useEffect(() => {
    if (!isOpen) return
    function onDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const options = [
    { label: 'Tomorrow',  opt: 'tomorrow'   },
    { label: 'In 3 days', opt: 'three_days' },
    { label: 'In 1 week', opt: 'one_week'   },
  ]

  const minDate = localDateOffset(today, 1)

  return (
    <div
      ref={menuRef}
      id={popoverId}
      role="dialog"
      aria-label={label}
      className="absolute top-full left-0 mt-1.5 w-[200px] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-20 p-2 space-y-0.5"
      style={{ background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}
    >
      {options.map(({ label: optLabel, opt }, i) => (
        <button
          key={opt}
          ref={i === 0 ? firstOptionRef : undefined}
          type="button"
          onClick={() => { onOption(opt) }}
          disabled={isSaving}
          className="w-full text-left text-[13px] px-3 py-[7px] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: 'var(--color-mid)' }}
          onFocus={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
          onBlur={e => (e.currentTarget.style.background = '')}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)', e.currentTarget.style.color = 'var(--color-hi)')}
          onMouseLeave={e => (e.currentTarget.style.background = '', e.currentTarget.style.color = 'var(--color-mid)')}
        >
          {optLabel}
        </button>
      ))}

      <div className="pt-2 mt-1 px-1 space-y-1.5" style={{ borderTop: '1px solid var(--color-line-2)' }}>
        <label htmlFor={`${popoverId}-custom`} className="text-[11px] font-mono" style={{ color: 'var(--color-low)', display: 'block' }}>
          Custom date
        </label>
        <input
          id={`${popoverId}-custom`}
          type="date"
          value={customDate}
          onChange={e => onCustomDate(e.target.value)}
          min={minDate}
          className="w-full rounded-lg px-3 py-[7px] text-[12.5px] outline-none transition-colors"
          style={{
            background: 'var(--color-input)',
            border: '1px solid var(--color-line-3)',
            color: 'var(--color-hi)',
            colorScheme: 'dark',
          }}
        />
        <button
          type="button"
          onClick={() => { if (customDate) onOption('custom') }}
          disabled={isSaving || !customDate}
          className="w-full text-[12.5px] font-semibold rounded-lg px-3 py-[6px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            color: '#FF4423',
            background: 'rgba(255,68,35,0.10)',
            border: '1px solid rgba(255,68,35,0.22)',
          }}
        >
          Confirm
        </button>
        {error && (
          <p id={errorId} role="alert" className="text-[11.5px]" style={{ color: 'var(--color-danger)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Open dated follow-up row (Overdue / Today / Upcoming) ─────────────────────

function OpenFollowUpRow({ item, today, isSaving, rowError: rowErr, popoverOpenId, popoverMode, onOpenPopover, onClosePopover, onDone, onSnoozeOption, customDate, onCustomDate, popoverError, isLast, swipeRevealed, onSwipeReveal, onSwipeClose }) {
  const triggerRef = useRef(null)
  const rowRef     = useRef(null)
  const touchState = useRef({ startX: 0, startY: 0, locked: false })

  // Progressive-enhancement swipe: right → reveal Done, left → reveal Snooze.
  // Uses addEventListener (not JSX) so touchmove can be { passive: false }
  // to call preventDefault() once horizontal lock is committed.
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    function onStart(e) {
      const t = e.touches[0]
      touchState.current = { startX: t.clientX, startY: t.clientY, locked: false }
    }
    function onMove(e) {
      const t = e.touches[0]
      const dx = t.clientX - touchState.current.startX
      const dy = t.clientY - touchState.current.startY
      if (!touchState.current.locked && shouldLockHorizontal(dx, dy)) {
        touchState.current.locked = true
      }
      if (touchState.current.locked) e.preventDefault()
    }
    function onEnd(e) {
      const t = e.changedTouches[0]
      const dx = t.clientX - touchState.current.startX
      const dy = t.clientY - touchState.current.startY
      const action = swipeGestureToAction(classifySwipeGesture(dx, dy))
      if (action === 'reveal-done') {
        onSwipeReveal(item.id, 'reveal-done')
      } else if (action === 'reveal-date-action') {
        onSwipeReveal(item.id, 'reveal-date-action')
      } else if (swipeRevealed) {
        onSwipeClose()
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove',  onMove,  { passive: false })
    el.addEventListener('touchend',   onEnd,   { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove',  onMove)
      el.removeEventListener('touchend',   onEnd)
    }
  }, [item.id, swipeRevealed, onSwipeReveal, onSwipeClose, onOpenPopover])

  const name = item.contacts?.name || 'Unknown'
  const company = item.contacts?.company
  const role = item.contacts?.role
  const dateStr = item.follow_up_date
  const popoverId = `snooze-${item.id}`
  const isPopoverOpen = popoverOpenId === item.id && popoverMode === 'snooze'

  return (
    <div>
      <div
        ref={rowRef}
        className="px-5 py-4"
      >
        {/* Top row: avatar + contact info + due label */}
        <div className="flex items-start gap-3">
          <Link
            to={`/contacts/${item.contact_id}`}
            onClick={e => e.stopPropagation()}
            tabIndex={-1}
            className="flex-none"
            aria-label={`Open ${name}'s profile`}
          >
            <Avatar name={name} size={40}/>
          </Link>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/contacts/${item.contact_id}`}
                onClick={e => e.stopPropagation()}
                className="text-[14px] font-semibold no-underline hover:underline"
                style={{ color: 'var(--color-hi)' }}
              >
                {name}
              </Link>
              {company && (
                <span className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>
                  {company}{role ? ` · ${role}` : ''}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[12px] font-mono" style={{ color: 'var(--color-low)' }}>
                {item.type}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-lower)' }}>·</span>
              <span className="text-[12px] font-mono" style={{ color: 'var(--color-low)' }}>
                {item.interaction_date}
              </span>
            </div>

            {item.notes && (
              <p
                className="text-[12.5px] mt-1 leading-snug line-clamp-2"
                style={{ color: 'var(--color-muted)' }}
                title={item.notes}
              >
                {item.notes}
              </p>
            )}
          </div>

          {/* Due label badge */}
          <span
            className="text-[11px] font-mono font-semibold px-2.5 py-1 rounded-full flex-none whitespace-nowrap"
            style={
              dateStr < today
                ? { color: 'var(--color-danger)', background: 'rgba(255,107,138,0.12)', border: '1px solid rgba(255,107,138,0.22)' }
                : dateStr === today
                  ? { color: 'var(--color-warning)', background: 'rgba(255,184,77,0.12)', border: '1px solid rgba(255,184,77,0.22)' }
                  : { color: 'var(--color-mid)',    background: 'rgba(255,255,255,0.05)',  border: '1px solid var(--color-line-2)' }
            }
          >
            {dueLabelStr(dateStr, today)}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3 ml-[52px] flex-wrap">

          {/* Done */}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onDone() }}
            disabled={isSaving}
            className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-[5px] rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--color-hi)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-3)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            Done
          </button>

          {/* Snooze / Reschedule */}
          <div className="relative" onClick={e => e.stopPropagation()}>
            <button
              ref={triggerRef}
              type="button"
              aria-expanded={isPopoverOpen}
              aria-controls={popoverId}
              onClick={() => isPopoverOpen ? onClosePopover() : onOpenPopover(item.id, 'snooze', triggerRef.current)}
              disabled={isSaving}
              className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-[5px] rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--color-mid)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-3)' }}
            >
              {dateStr > today ? 'Reschedule' : 'Snooze'}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d={isPopoverOpen ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}/>
              </svg>
            </button>

            <DateActionPopover
              popoverId={popoverId}
              isOpen={isPopoverOpen}
              onClose={() => { onClosePopover(); setTimeout(() => triggerRef.current?.focus(), 0) }}
              onOption={onSnoozeOption}
              customDate={customDate}
              onCustomDate={onCustomDate}
              isSaving={isSaving}
              error={popoverError}
              label={dateStr > today ? 'Reschedule' : 'Snooze'}
              triggerRef={triggerRef}
              today={today}
            />
          </div>

          {/* Log Result */}
          <Link
            to={`/contacts/${item.contact_id}`}
            state={{ openInteractionForm: true, sourceFollowUpId: item.id }}
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 text-[12px] font-semibold px-3 py-[5px] rounded-[7px] no-underline transition-colors"
            style={{ color: '#FF4423', background: 'rgba(255,68,35,0.08)', border: '1px solid rgba(255,68,35,0.18)' }}
          >
            Log Result
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </Link>
        </div>

        {/* Swipe-reveal Done tray (progressive enhancement) */}
        {swipeRevealed === 'reveal-done' && (
          <div className="flex items-center gap-2 mt-2 ml-[52px]">
            <button
              type="button"
              onClick={() => { onSwipeClose(); onDone() }}
              disabled={isSaving}
              className="flex-1 text-[12.5px] font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-40"
              style={{ background: 'rgba(47,212,182,0.15)', color: 'var(--color-success)', border: '1px solid rgba(47,212,182,0.3)' }}
            >
              ✓ Confirm done
            </button>
            <button
              type="button"
              onClick={onSwipeClose}
              className="text-[12px] px-3 py-2.5 rounded-xl transition-colors"
              style={{ color: 'var(--color-low)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Swipe-reveal Snooze tray — tap to open date popover (progressive enhancement) */}
        {swipeRevealed === 'reveal-date-action' && (
          <div className="flex items-center gap-2 mt-2 ml-[52px]">
            <button
              type="button"
              onClick={() => { onSwipeClose(); onOpenPopover(item.id, 'snooze', triggerRef.current) }}
              disabled={isSaving}
              className="flex-1 text-[12.5px] font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-40"
              style={{ background: 'rgba(255,68,35,0.12)', color: '#FF4423', border: '1px solid rgba(255,68,35,0.25)' }}
            >
              Snooze / Reschedule
            </button>
            <button
              type="button"
              onClick={onSwipeClose}
              className="text-[12px] px-3 py-2.5 rounded-xl transition-colors"
              style={{ color: 'var(--color-low)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}
            >
              Cancel
            </button>
          </div>
        )}

        <RowError msg={rowErr}/>
      </div>
      {!isLast && <RowDivider/>}
    </div>
  )
}

// ── Awaiting-response row ─────────────────────────────────────────────────────

function AwaitingRow({ item, today, isSaving, rowError: rowErr, popoverOpenId, popoverMode, onOpenPopover, onClosePopover, onMarkResponded, onNudgeOption, customDate, onCustomDate, popoverError, isLast, swipeRevealed, onSwipeReveal, onSwipeClose }) {
  const triggerRef = useRef(null)
  const rowRef     = useRef(null)
  const touchState = useRef({ startX: 0, startY: 0, locked: false })

  // Progressive-enhancement swipe: right → reveal Mark Responded, left → open Nudge popover.
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    function onStart(e) {
      const t = e.touches[0]
      touchState.current = { startX: t.clientX, startY: t.clientY, locked: false }
    }
    function onMove(e) {
      const t = e.touches[0]
      const dx = t.clientX - touchState.current.startX
      const dy = t.clientY - touchState.current.startY
      if (!touchState.current.locked && shouldLockHorizontal(dx, dy)) {
        touchState.current.locked = true
      }
      if (touchState.current.locked) e.preventDefault()
    }
    function onEnd(e) {
      const t = e.changedTouches[0]
      const dx = t.clientX - touchState.current.startX
      const dy = t.clientY - touchState.current.startY
      const action = swipeGestureToAction(classifySwipeGesture(dx, dy))
      if (action === 'reveal-done') {
        onSwipeReveal(item.id, 'reveal-done')
      } else if (action === 'reveal-date-action') {
        onSwipeReveal(item.id, 'reveal-date-action')
      } else if (swipeRevealed) {
        onSwipeClose()
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove',  onMove,  { passive: false })
    el.addEventListener('touchend',   onEnd,   { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove',  onMove)
      el.removeEventListener('touchend',   onEnd)
    }
  }, [item.id, swipeRevealed, onSwipeReveal, onSwipeClose, onOpenPopover])

  const name = item.contacts?.name || 'Unknown'
  const company = item.contacts?.company
  const role = item.contacts?.role
  const popoverId = `nudge-${item.id}`
  const isPopoverOpen = popoverOpenId === item.id && popoverMode === 'nudge'

  return (
    <div>
      <div ref={rowRef} className="px-5 py-4">
        {/* Top row: avatar + contact info + waiting label */}
        <div className="flex items-start gap-3">
          <Link to={`/contacts/${item.contact_id}`} tabIndex={-1} className="flex-none" aria-label={`Open ${name}'s profile`}>
            <Avatar name={name} size={40}/>
          </Link>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/contacts/${item.contact_id}`}
                className="text-[14px] font-semibold no-underline hover:underline"
                style={{ color: 'var(--color-hi)' }}
              >
                {name}
              </Link>
              {company && (
                <span className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>
                  {company}{role ? ` · ${role}` : ''}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[12px] font-mono" style={{ color: 'var(--color-low)' }}>
                {item.type}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-lower)' }}>·</span>
              <span className="text-[12px] font-mono" style={{ color: 'var(--color-low)' }}>
                {item.interaction_date}
              </span>
            </div>

            {item.notes && (
              <p
                className="text-[12.5px] mt-1 leading-snug line-clamp-2"
                style={{ color: 'var(--color-muted)' }}
                title={item.notes}
              >
                {item.notes}
              </p>
            )}
          </div>

          {/* Waiting label */}
          <span
            className="text-[11px] font-mono font-semibold px-2.5 py-1 rounded-full flex-none whitespace-nowrap"
            style={{ color: 'var(--color-warning)', background: 'rgba(255,184,77,0.1)', border: '1px solid rgba(255,184,77,0.2)' }}
          >
            {waitingLabelStr(item.interaction_date, today)}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3 ml-[52px] flex-wrap">

          {/* Mark responded */}
          <button
            type="button"
            onClick={() => onMarkResponded()}
            disabled={isSaving}
            className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-[5px] rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--color-success)', background: 'rgba(47,212,182,0.08)', border: '1px solid rgba(47,212,182,0.2)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            Mark responded
          </button>

          {/* Nudge */}
          <div className="relative">
            <button
              ref={triggerRef}
              type="button"
              aria-expanded={isPopoverOpen}
              aria-controls={popoverId}
              onClick={() => isPopoverOpen ? onClosePopover() : onOpenPopover(item.id, 'nudge', triggerRef.current)}
              disabled={isSaving}
              className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-[5px] rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--color-mid)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-3)' }}
            >
              Nudge
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d={isPopoverOpen ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}/>
              </svg>
            </button>

            <DateActionPopover
              popoverId={popoverId}
              isOpen={isPopoverOpen}
              onClose={() => { onClosePopover(); setTimeout(() => triggerRef.current?.focus(), 0) }}
              onOption={onNudgeOption}
              customDate={customDate}
              onCustomDate={onCustomDate}
              isSaving={isSaving}
              error={popoverError}
              label="Nudge — set a follow-up date"
              triggerRef={triggerRef}
              today={today}
            />
          </div>
        </div>

        {/* Swipe-reveal Mark Responded tray (progressive enhancement) */}
        {swipeRevealed === 'reveal-done' && (
          <div className="flex items-center gap-2 mt-2 ml-[52px]">
            <button
              type="button"
              onClick={() => { onSwipeClose(); onMarkResponded() }}
              disabled={isSaving}
              className="flex-1 text-[12.5px] font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-40"
              style={{ background: 'rgba(47,212,182,0.15)', color: 'var(--color-success)', border: '1px solid rgba(47,212,182,0.3)' }}
            >
              ✓ Mark responded
            </button>
            <button
              type="button"
              onClick={onSwipeClose}
              className="text-[12px] px-3 py-2.5 rounded-xl transition-colors"
              style={{ color: 'var(--color-low)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Swipe-reveal Nudge tray — tap to open date popover (progressive enhancement) */}
        {swipeRevealed === 'reveal-date-action' && (
          <div className="flex items-center gap-2 mt-2 ml-[52px]">
            <button
              type="button"
              onClick={() => { onSwipeClose(); onOpenPopover(item.id, 'nudge', triggerRef.current) }}
              disabled={isSaving}
              className="flex-1 text-[12.5px] font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-40"
              style={{ background: 'rgba(255,68,35,0.12)', color: '#FF4423', border: '1px solid rgba(255,68,35,0.25)' }}
            >
              Nudge — set a date
            </button>
            <button
              type="button"
              onClick={onSwipeClose}
              className="text-[12px] px-3 py-2.5 rounded-xl transition-colors"
              style={{ color: 'var(--color-low)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}
            >
              Cancel
            </button>
          </div>
        )}

        <RowError msg={rowErr}/>
      </div>
      {!isLast && <RowDivider/>}
    </div>
  )
}

// ── Recently completed row ────────────────────────────────────────────────────

function CompletedRow({ item, today, isSaving, rowError: rowErr, onUndo, isLast }) {
  const name = item.contacts?.name || 'Unknown'
  const company = item.contacts?.company
  const methodLbl = completionMethodLabel(item.follow_up_completion_method)
  const whenLbl = completionLabel(item.follow_up_completed_at, today)

  return (
    <div>
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <Link to={`/contacts/${item.contact_id}`} tabIndex={-1} className="flex-none" aria-label={`Open ${name}'s profile`}>
            <div
              className="rounded-xl flex items-center justify-center text-[13px] font-bold flex-none"
              style={{ width: 40, height: 40, background: 'var(--color-card)', border: '1px solid var(--color-line-2)', color: 'var(--color-low)' }}
            >
              {getInitials(name || '?')}
            </div>
          </Link>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/contacts/${item.contact_id}`}
                className="text-[13.5px] font-medium no-underline hover:underline"
                style={{ color: 'var(--color-mid)' }}
              >
                {name}
              </Link>
              {company && (
                <span className="text-[12px]" style={{ color: 'var(--color-low)' }}>
                  {company}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[12px] font-mono" style={{ color: 'var(--color-lower)' }}>
                {item.type}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-lower)' }}>·</span>
              <span className="text-[12px] font-mono" style={{ color: 'var(--color-lower)' }}>
                {whenLbl}{methodLbl ? ` · ${methodLbl}` : ''}
              </span>
            </div>
          </div>

          {/* Success indicator */}
          <span
            className="text-[11px] font-mono font-semibold px-2.5 py-1 rounded-full flex-none"
            style={{ color: 'var(--color-success)', background: 'rgba(47,212,182,0.08)', border: '1px solid rgba(47,212,182,0.15)' }}
          >
            Done
          </span>
        </div>

        {/* Undo */}
        <div className="mt-2 ml-[52px]">
          <button
            type="button"
            onClick={onUndo}
            disabled={isSaving}
            className="text-[11.5px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--color-low)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-mid)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-low)')}
          >
            Undo
          </button>
        </div>

        <RowError msg={rowErr}/>
      </div>
      {!isLast && <RowDivider/>}
    </div>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="px-5 py-10 space-y-8" aria-label="Loading follow-ups" aria-busy="true">
      {[40, 55, 45].map((w, i) => (
        <div key={i} className="flex gap-3">
          <div className="w-10 h-10 rounded-xl flex-none" style={{ background: 'var(--color-elevated)' }}/>
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 rounded-full" style={{ width: `${w}%`, background: 'var(--color-elevated)' }}/>
            <div className="h-2.5 rounded-full" style={{ width: '30%', background: 'var(--color-elevated)' }}/>
          </div>
        </div>
      ))}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════════

export default function FollowUpsPage() {
  const navigate = useNavigate()

  // ── Data ──────────────────────────────────────────────────────────────────
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading]           = useState(true)
  const [fetchError, setFetchError]     = useState('')
  const [pickerOpen, setPickerOpen]     = useState(false)
  const [pickerContacts, setPickerContacts] = useState([])

  // ── Per-row state (keyed by interaction id) ────────────────────────────────
  // { [id]: { saving: boolean, error: string } }
  const [rowState, setRowState] = useState({})

  function setRowSaving(id, val) {
    setRowState(s => ({ ...s, [id]: { ...(s[id] || {}), saving: val, error: val ? '' : (s[id]?.error || '') } }))
  }
  function setRowError(id, msg) {
    setRowState(s => ({ ...s, [id]: { saving: false, error: msg } }))
  }

  // ── Popover state (one open at a time) ────────────────────────────────────
  const [popoverOpenId, setPopoverOpenId]   = useState(null)
  const [popoverMode, setPopoverMode]       = useState(null) // 'snooze' | 'nudge'
  const [customDate, setCustomDate]         = useState('')
  const [popoverError, setPopoverError]     = useState('')
  const popoverTriggerRef = useRef(null)  // DOM element — restored focus after popover closes on success

  // ── Swipe reveal (progressive enhancement) ───────────────────────────────
  const [swipeOpenId, setSwipeOpenId]         = useState(null)
  const [swipeOpenAction, setSwipeOpenAction] = useState(null)

  function openSwipeReveal(id, action) { setSwipeOpenId(id); setSwipeOpenAction(action) }
  function closeSwipeReveal() { setSwipeOpenId(null); setSwipeOpenAction(null) }

  // ── Page-level feedback (quiet refetch errors) ────────────────────────────
  const [pageFeedback, setPageFeedback]     = useState(null)
  const feedbackTimer = useRef(null)

  const today = getLocalToday()

  // Stable dispatch callback — passed to followUpActions as the event dep.
  const followupDispatch = useCallback(
    () => window.dispatchEvent(new Event('funnl:followups-changed')),
    []
  )

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchFollowUps = useCallback(async (quiet = false) => {
    if (!quiet) { setFetchError(''); setLoading(true) }

    // Fetch 8 days back (UTC midnight) for recently-completed; client-side filter to 7 local days.
    // Must use UTC date arithmetic to avoid local-time drift near day boundaries.
    const eightAgo = new Date()
    eightAgo.setUTCDate(eightAgo.getUTCDate() - 8)
    eightAgo.setUTCHours(0, 0, 0, 0)
    const eightAgoISO = eightAgo.toISOString()

    const { data, error } = await supabase
      .from('interactions')
      .select([
        'id', 'contact_id', 'type', 'interaction_date', 'notes',
        'follow_up_date', 'outreach_status', 'created_at',
        'follow_up_completed_at', 'follow_up_previous_date', 'follow_up_completion_method',
        'contacts ( id, name, company, role )',
      ].join(', '))
      .or([
        'follow_up_date.not.is.null',
        'outreach_status.eq.awaiting_response',
        `follow_up_completed_at.gte.${eightAgoISO}`,
      ].join(','))
      .order('created_at', { ascending: false })

    if (!quiet) setLoading(false)
    if (error) {
      if (quiet) showPageFeedback('error', "Couldn't refresh — your list may be out of date.")
      else setFetchError(error.message)
      return
    }
    setInteractions(data || [])
  }, [])

  useEffect(() => { fetchFollowUps() }, [fetchFollowUps])

  // Refresh on funnl:followups-changed (badge-driven sibling updates)
  useEffect(() => {
    const handler = () => fetchFollowUps(true)
    window.addEventListener('funnl:followups-changed', handler)
    return () => window.removeEventListener('funnl:followups-changed', handler)
  }, [fetchFollowUps])

  // Cleanup feedback timer
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current) }, [])

  function showPageFeedback(type, msg) {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    setPageFeedback({ type, msg })
    if (type === 'success') {
      feedbackTimer.current = setTimeout(() => setPageFeedback(null), 3500)
    }
  }

  // ── Popover helpers ────────────────────────────────────────────────────────

  function openPopover(id, mode, domEl) {
    setPopoverOpenId(id)
    setPopoverMode(mode)
    setCustomDate('')
    setPopoverError('')
    popoverTriggerRef.current = domEl ?? null
  }
  function closePopoverWithFocus() {
    const el = popoverTriggerRef.current
    closePopover()
    if (el) setTimeout(() => el.focus(), 0)
  }

  function closePopover() {
    setPopoverOpenId(null)
    setPopoverMode(null)
    setCustomDate('')
    setPopoverError('')
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  async function handleDone(interactionId) {
    const target = interactions.find(i => i.id === interactionId)
    if (!target) return
    setRowSaving(interactionId, true)
    try {
      const result = await completeFollowUp(target, { client: supabase, track, dispatch: followupDispatch })
      if (!result.ok) { setRowError(interactionId, result.errorMessage); return }
      closeSwipeReveal()
      await fetchFollowUps(true)
    } finally {
      setRowSaving(interactionId, false)
    }
  }

  // ── Snooze ─────────────────────────────────────────────────────────────────

  async function handleSnooze(interactionId, option) {
    const target = interactions.find(i => i.id === interactionId)
    if (!target) return
    setRowSaving(interactionId, true)
    try {
      const result = await snoozeFollowUp(target, option, customDate, today, { client: supabase, track, dispatch: followupDispatch })
      if (!result.ok) { setPopoverError(result.errorMessage); return }
      closePopoverWithFocus()
      await fetchFollowUps(true)
    } finally {
      setRowSaving(interactionId, false)
    }
  }

  // ── Nudge (set date on awaiting-response row) ──────────────────────────────

  async function handleNudge(interactionId, option) {
    const target = interactions.find(i => i.id === interactionId)
    if (!target) return
    setRowSaving(interactionId, true)
    try {
      const result = await nudgeFollowUp(target, option, customDate, today, { client: supabase, track, dispatch: followupDispatch })
      if (!result.ok) { setPopoverError(result.errorMessage); return }
      closePopoverWithFocus()
      await fetchFollowUps(true)
    } finally {
      setRowSaving(interactionId, false)
    }
  }

  // ── Mark responded ─────────────────────────────────────────────────────────

  async function handleMarkResponded(interactionId) {
    const target = interactions.find(i => i.id === interactionId)
    if (!target) return
    setRowSaving(interactionId, true)
    try {
      const result = await markResponded(target, { client: supabase, track })
      if (!result.ok) { setRowError(interactionId, result.errorMessage); return }
      closeSwipeReveal()
      await fetchFollowUps(true)
    } finally {
      setRowSaving(interactionId, false)
    }
  }

  // ── Undo ───────────────────────────────────────────────────────────────────

  async function handleUndo(interactionId) {
    const target = interactions.find(i => i.id === interactionId)
    if (!target) return
    setRowSaving(interactionId, true)
    try {
      const result = await undoFollowUp(target, { client: supabase, dispatch: followupDispatch })
      if (!result.ok) { setRowError(interactionId, result.errorMessage); return }
      await fetchFollowUps(true)
    } finally {
      setRowSaving(interactionId, false)
    }
  }

  // ── Contact picker (for "never used" empty state) ──────────────────────────

  async function openContactPicker() {
    const { data } = await supabase.from('contacts').select('id, name, company')
    setPickerContacts(data || [])
    setPickerOpen(true)
  }

  function handlePickerSelect(contact) {
    setPickerOpen(false)
    navigate(`/contacts/${contact.id}`, { state: { openInteractionForm: true } })
  }

  // ── Derived groups ─────────────────────────────────────────────────────────

  const { overdue, today: todayItems, upcoming, awaitingResponse, recentlyCompleted } =
    groupAndSortFollowUps(interactions, today)

  const wCount   = waitingCount(overdue, todayItems, awaitingResponse)
  const wCopy    = waitingCopy(wCount)
  const hasAny   = interactions.length > 0
  const neverUsed = !hasAny && !loading && !fetchError
  const fullyCaughtUp = wCount === 0 && (upcoming.length > 0 || recentlyCompleted.length > 0)

  // ── Render ─────────────────────────────────────────────────────────────────

  function openCommandPalette() {
    window.dispatchEvent(new CustomEvent('funnl:open-command-palette'))
  }

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen" style={{ background: 'var(--color-surface)' }}>
        <TopBar title="Follow-ups" searchPlaceholder="Find, log, or ask anything…" onSearchClick={openCommandPalette}/>
        <Skeleton/>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="flex flex-col min-h-screen" style={{ background: 'var(--color-surface)' }}>
        <TopBar title="Follow-ups" searchPlaceholder="Find, log, or ask anything…" onSearchClick={openCommandPalette}/>
        <div className="flex flex-col items-center justify-center flex-1 p-6 md:p-12">
          <div
            className="w-12 h-12 mx-auto mb-4 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(255,107,138,0.1)', border: '1px solid rgba(255,107,138,0.2)' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <p className="font-semibold mb-2" style={{ color: 'var(--color-hi)' }}>Couldn't load your follow-ups</p>
          <p className="text-sm mb-5" style={{ color: 'var(--color-muted)' }}>Check your connection and try again.</p>
          <button
            onClick={() => fetchFollowUps()}
            className="text-sm font-semibold transition-colors"
            style={{ color: '#FF4423' }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--color-surface)' }}>
      <TopBar title="Follow-ups" searchPlaceholder="Find, log, or ask anything…" onSearchClick={openCommandPalette}/>

      <div className="flex-1 px-4 py-5 md:px-6 md:py-6 max-w-3xl mx-auto w-full">

        {/* Page-level quiet-refetch feedback */}
        {pageFeedback && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 mb-4 px-4 py-3 rounded-xl text-[13px] font-medium"
            style={
              pageFeedback.type === 'success'
                ? { color: 'var(--color-success)', background: 'rgba(47,212,182,0.08)', border: '1px solid rgba(47,212,182,0.2)' }
                : { color: 'var(--color-danger)',  background: 'rgba(255,107,138,0.08)', border: '1px solid rgba(255,107,138,0.2)' }
            }
          >
            {pageFeedback.msg}
          </div>
        )}

        {/* ── Never-used empty state ─────────────────────────────────────────── */}
        {neverUsed && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div
              className="w-16 h-16 mx-auto mb-5 rounded-[18px] flex items-center justify-center"
              style={{ background: 'rgba(255,68,35,0.08)', border: '1px solid rgba(255,68,35,0.18)' }}
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FF4423" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
              </svg>
            </div>
            <h2 className="font-display font-semibold text-[18px] mb-2" style={{ color: 'var(--color-hi)' }}>
              No follow-ups yet
            </h2>
            <p className="text-[14px] leading-relaxed mb-7 max-w-xs" style={{ color: 'var(--color-muted)' }}>
              When you log an interaction and set a follow-up date, it appears here so you never lose track.
            </p>
            <button
              type="button"
              onClick={openContactPicker}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-semibold transition-colors"
              style={{ background: '#FF4423', color: '#14110F' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Log an interaction
            </button>
          </div>
        )}

        {/* ── Active content ─────────────────────────────────────────────────── */}
        {!neverUsed && (
          <>
            {/* Page summary */}
            {wCopy && (
              <div className="mb-5">
                <p className="text-[15px] font-semibold" style={{ color: 'var(--color-hi)' }}>
                  {wCopy}
                </p>
                <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-muted)' }}>
                  Work through these to stay on top of your relationships.
                </p>
              </div>
            )}

            {/* Fully caught up banner */}
            {fullyCaughtUp && (
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-xl mb-5"
                style={{ background: 'rgba(47,212,182,0.07)', border: '1px solid rgba(47,212,182,0.18)' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
                <div>
                  <p className="text-[14px] font-semibold" style={{ color: 'var(--color-success)' }}>Fully caught up.</p>
                  {upcoming.length > 0 && (
                    <p className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>
                      Next: {upcoming[0].contacts?.name || 'Unknown'} on {upcoming[0].follow_up_date}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* ── Overdue ──────────────────────────────────────────────────── */}
            {overdue.length > 0 && (
              <div
                className="rounded-2xl mb-4 overflow-hidden"
                style={{ border: '1px solid rgba(255,107,138,0.2)', background: 'var(--color-card)' }}
              >
                <GroupHeading label="Overdue" count={overdue.length} color="var(--color-danger)"/>
                {overdue.map((item, i) => (
                  <OpenFollowUpRow
                    key={item.id}
                    item={item}
                    today={today}
                    isSaving={rowState[item.id]?.saving || false}
                    rowError={rowState[item.id]?.error || ''}
                    popoverOpenId={popoverOpenId}
                    popoverMode={popoverMode}
                    onOpenPopover={openPopover}
                    onClosePopover={closePopover}
                    onDone={() => handleDone(item.id)}
                    onSnoozeOption={opt => handleSnooze(item.id, opt)}
                    customDate={popoverOpenId === item.id ? customDate : ''}
                    onCustomDate={setCustomDate}
                    popoverError={popoverOpenId === item.id ? popoverError : ''}
                    isLast={i === overdue.length - 1}
                    swipeRevealed={swipeOpenId === item.id ? swipeOpenAction : null}
                    onSwipeReveal={openSwipeReveal}
                    onSwipeClose={closeSwipeReveal}
                  />
                ))}
              </div>
            )}

            {/* ── Today ────────────────────────────────────────────────────── */}
            {todayItems.length > 0 && (
              <div
                className="rounded-2xl mb-4 overflow-hidden"
                style={{ border: '1px solid rgba(255,184,77,0.2)', background: 'var(--color-card)' }}
              >
                <GroupHeading label="Today" count={todayItems.length} color="var(--color-warning)"/>
                {todayItems.map((item, i) => (
                  <OpenFollowUpRow
                    key={item.id}
                    item={item}
                    today={today}
                    isSaving={rowState[item.id]?.saving || false}
                    rowError={rowState[item.id]?.error || ''}
                    popoverOpenId={popoverOpenId}
                    popoverMode={popoverMode}
                    onOpenPopover={openPopover}
                    onClosePopover={closePopover}
                    onDone={() => handleDone(item.id)}
                    onSnoozeOption={opt => handleSnooze(item.id, opt)}
                    customDate={popoverOpenId === item.id ? customDate : ''}
                    onCustomDate={setCustomDate}
                    popoverError={popoverOpenId === item.id ? popoverError : ''}
                    isLast={i === todayItems.length - 1}
                  />
                ))}
              </div>
            )}

            {/* ── Awaiting response ─────────────────────────────────────────── */}
            {awaitingResponse.length > 0 && (
              <div
                className="rounded-2xl mb-4 overflow-hidden"
                style={{ border: '1px solid rgba(255,184,77,0.15)', background: 'var(--color-card)' }}
              >
                <GroupHeading label="Awaiting response" count={awaitingResponse.length} color="var(--color-warning)"/>
                <p className="px-5 pb-2 text-[12px]" style={{ color: 'var(--color-low)' }}>
                  These conversations are waiting for a reply and don't have a follow-up date set.
                </p>
                {awaitingResponse.map((item, i) => (
                  <AwaitingRow
                    key={item.id}
                    item={item}
                    today={today}
                    isSaving={rowState[item.id]?.saving || false}
                    rowError={rowState[item.id]?.error || ''}
                    popoverOpenId={popoverOpenId}
                    popoverMode={popoverMode}
                    onOpenPopover={openPopover}
                    onClosePopover={closePopover}
                    onMarkResponded={() => handleMarkResponded(item.id)}
                    onNudgeOption={opt => handleNudge(item.id, opt)}
                    customDate={popoverOpenId === item.id ? customDate : ''}
                    onCustomDate={setCustomDate}
                    popoverError={popoverOpenId === item.id ? popoverError : ''}
                    isLast={i === awaitingResponse.length - 1}
                    swipeRevealed={swipeOpenId === item.id ? swipeOpenAction : null}
                    onSwipeReveal={openSwipeReveal}
                    onSwipeClose={closeSwipeReveal}
                  />
                ))}
              </div>
            )}

            {/* ── Upcoming ──────────────────────────────────────────────────── */}
            {upcoming.length > 0 && (
              <div
                className="rounded-2xl mb-4 overflow-hidden"
                style={{ border: '1px solid var(--color-line-2)', background: 'var(--color-card)' }}
              >
                <GroupHeading label="Upcoming" count={upcoming.length} color="var(--color-mid)"/>
                {upcoming.map((item, i) => (
                  <OpenFollowUpRow
                    key={item.id}
                    item={item}
                    today={today}
                    isSaving={rowState[item.id]?.saving || false}
                    rowError={rowState[item.id]?.error || ''}
                    popoverOpenId={popoverOpenId}
                    popoverMode={popoverMode}
                    onOpenPopover={openPopover}
                    onClosePopover={closePopover}
                    onDone={() => handleDone(item.id)}
                    onSnoozeOption={opt => handleSnooze(item.id, opt)}
                    customDate={popoverOpenId === item.id ? customDate : ''}
                    onCustomDate={setCustomDate}
                    popoverError={popoverOpenId === item.id ? popoverError : ''}
                    isLast={i === upcoming.length - 1}
                  />
                ))}
              </div>
            )}

            {/* ── Recently completed ────────────────────────────────────────── */}
            {recentlyCompleted.length > 0 && (
              <div
                className="rounded-2xl mb-4 overflow-hidden"
                style={{ border: '1px solid var(--color-line-1)', background: 'var(--color-card)' }}
              >
                <GroupHeading label="Recently completed" count={recentlyCompleted.length} color="var(--color-success)"/>
                {recentlyCompleted.map((item, i) => (
                  <CompletedRow
                    key={item.id}
                    item={item}
                    today={today}
                    isSaving={rowState[item.id]?.saving || false}
                    rowError={rowState[item.id]?.error || ''}
                    onUndo={() => handleUndo(item.id)}
                    isLast={i === recentlyCompleted.length - 1}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* BottomNav safe area padding */}
        <div className="h-4 md:hidden"/>
      </div>

      {/* Contact picker for "never used" empty state CTA */}
      {pickerOpen && (
        <ContactPickerModal
          title="Log an interaction"
          contacts={pickerContacts}
          onSelect={handlePickerSelect}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
