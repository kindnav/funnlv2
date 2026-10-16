/**
 * log-interaction-form.test.js — one Log interaction form, two containers.
 *
 * The desktop inline form and the phone bottom sheet used to be two copies of the same
 * fields, both mounted at once with one hidden by CSS. The hidden sheet's focus trap and
 * Escape handler then acted on desktop, and it held the shared follow-up-date ref, so
 * "Create a follow-up" focused an invisible input. These contracts pin the fix; the
 * behaviour itself is proven in a real browser by tests/local/log-interaction-browser.mjs.
 *
 * Run with: node tests/log-interaction-form.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const fields = read('../src/components/InteractionFormFields.jsx')
const sheet = read('../src/components/LogInteractionSheet.jsx')
const page = read('../src/pages/ContactDetailPage.jsx')
const hook = read('../src/lib/useMediaQuery.js')

test('the fields are implemented once, in InteractionFormFields', () => {
  for (const s of ['What did you talk about? Any key takeaways?', 'This was outreach I sent', 'Follow-up date', '— not set —']) {
    assert.ok(fields.includes(s), s)
    assert.ok(!sheet.includes(s), `sheet must not duplicate: ${s}`)
  }
  assert.ok(!page.includes('What did you talk about? Any key takeaways?'), 'page must not duplicate the new-interaction fields')
  assert.ok(sheet.includes('<InteractionFormFields') && page.includes('<InteractionFormFields'))
})

test('exactly one container is mounted per breakpoint', () => {
  assert.ok(hook.includes("export const MD_UP = '(min-width: 768px)'"))
  assert.ok(page.includes('const isDesktop = useMediaQuery(MD_UP)'))
  assert.ok(page.includes('{showForm && isDesktop && ('), 'inline form only from md up')
  assert.ok(page.includes('open={showForm && !isDesktop}'), 'sheet only below md')
  assert.ok(!page.includes('hidden md:block mb-5'), 'no CSS-only hiding of a mounted form')
})

test('both containers submit through the one handler with the one follow-up ref', () => {
  const inline = page.slice(page.indexOf('{showForm && isDesktop && ('), page.indexOf('{/* Interaction timeline */}'))
  assert.ok(inline.includes('onSubmit={handleLogInteraction}'))
  assert.ok(inline.includes('followUpDateRef={followUpDateInputRef}'))
  const sheetProps = page.slice(page.indexOf('<LogInteractionSheet'), page.indexOf('/>', page.indexOf('<LogInteractionSheet')))
  assert.ok(sheetProps.includes('onSubmit={handleLogInteraction}'))
  assert.ok(sheetProps.includes('followUpDateRef={followUpDateInputRef}'))
  assert.ok(sheetProps.includes('onTypeChange={handleTypeChange}') && inline.includes('onTypeChange={handleTypeChange}'))
})

test('ids stay unique per container and every field is labelled', () => {
  assert.ok(sheet.includes('idPrefix="ls"') && page.includes('idPrefix="lf"'))
  for (const name of ['type', 'date', 'notes', 'followup', 'outreach-status']) {
    assert.ok(fields.includes(`htmlFor={id('${name}')}`) && fields.includes(`id={id('${name}')}`), name)
  }
  assert.ok(fields.includes('aria-label="Outreach status"'), 'the Email/Message status select is named')
})

test('the outreach rules are unchanged', () => {
  assert.ok(fields.includes("(type === 'Email' || type === 'Message') && ("))
  assert.ok(fields.includes("(type === 'Call' || type === 'Other') && ("))
  assert.ok(fields.includes("if (e.target.checked && !outreachStatus) setOutreachStatus('awaiting_response')"))
  assert.ok(fields.includes("if (!e.target.checked) setOutreachStatus('')"))
  for (const v of ['awaiting_response', 'responded', 'meeting_booked', 'no_response', 'declined']) assert.ok(fields.includes(`'${v}'`), v)
})

test('desktop keeps Escape-to-close and returns focus to the Log control', () => {
  const inline = page.slice(page.indexOf('{showForm && isDesktop && ('), page.indexOf('{/* Interaction timeline */}'))
  assert.ok(inline.includes("if (e.key === 'Escape') { e.stopPropagation(); setShowForm(false); setTimeout(() => logCTARef.current?.focus(), 0) }"))
})

test('the phone sheet keeps its dialog semantics, focus trap, Escape and scroll lock', () => {
  for (const s of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby={SHEET_TITLE_ID}', 'useFocusTrap(sheetRef, open)',
    "if (e.key === 'Escape') { e.stopPropagation(); onClose() }", "document.body.style.overflow = 'hidden'", 'typeSelectRef={typeSelRef}']) {
    assert.ok(sheet.includes(s), s)
  }
})
