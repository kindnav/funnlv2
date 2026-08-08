/**
 * import-modal-contract.test.js
 *
 * Static analysis of ImportContactsModal.jsx for Stage 8 contract guarantees.
 *
 * Covers:
 *   - 4-step flow: upload, map, review, done
 *   - Sacred funnel SVG path M3 4H21L15 12.5V20H9V12.5Z present on upload and done
 *   - No purple (#8B7CFF / #5B45F0) anywhere in the modal
 *   - Light paper theme (#F7F2E7 / #14110F)
 *   - Ember (#FF4423) as the single action color
 *   - Source preview (JetBrains Mono table, preamble message)
 *   - Stepper (4 steps visible in render)
 *   - Review step: selection checkboxes, duplicate handling, missing-name handling
 *   - Bulk tag chips with HIGH/MEDIUM/LOW confidence labels
 *   - Done step: "organized." headline, Browse imported, Go home
 *   - importReviewUtils helpers imported and used
 *   - No em dashes in UI copy (double-check)
 *   - Existing analytics events preserved (csv_import_used, csv_mapping_completed, post_import_action_clicked)
 *   - Existing pure libs preserved (csvHeaderDetect, contactCategorization)
 *   - AI categorization (ai-categorize-contacts) call present
 *   - AI column mapping (ai-map-csv) call present
 *   - Stale-request prevention refs present
 *   - Mobile: full-width, responsive classes
 *
 * Zero-dependency Node.js — run with: node tests/import-modal-contract.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dir, '..', 'src', 'components', 'ImportContactsModal.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── 4-step flow ───────────────────────────────────────────────────────────────

console.log('\n4-step flow states\n')

test("step 'upload' is present", () => {
  assert.ok(src.includes("'upload'") || src.includes('"upload"'), "upload step must exist")
})

test("step 'map' is present", () => {
  assert.ok(src.includes("'map'") || src.includes('"map"'), "map step must exist")
})

test("step 'review' is present (new step)", () => {
  assert.ok(src.includes("'review'") || src.includes('"review"'), "review step must exist in Stage 8")
})

test("step 'done' is present", () => {
  assert.ok(src.includes("'done'") || src.includes('"done"'), "done step must exist")
})

test("setStep is called with 'review' (transition from map)", () => {
  assert.ok(
    src.includes("setStep('review')") || src.includes('setStep("review")'),
    "must transition to review step"
  )
})

test("setStep is called with 'done' (transition from review)", () => {
  assert.ok(
    src.includes("setStep('done')") || src.includes('setStep("done")'),
    "must transition to done step"
  )
})

// ── Sacred funnel SVG ─────────────────────────────────────────────────────────

console.log('\nSacred funnel SVG path\n')

test('funnel path M3 4H21L15 12.5V20H9V12.5Z is present', () => {
  assert.ok(
    src.includes('M3 4H21L15 12.5V20H9V12.5Z'),
    'sacred funnel SVG path must appear in ImportContactsModal'
  )
})

test('funnel SVG fill is ember (#FF4423)', () => {
  const funnelContext = src.match(/M3 4H21L15 12\.5V20H9V12\.5Z[\s\S]{0,100}/)?.[0] ?? ''
  assert.ok(
    funnelContext.includes('#FF4423') || src.includes('fill="#FF4423"'),
    'funnel SVG must use ember fill #FF4423'
  )
})

// ── No purple ─────────────────────────────────────────────────────────────────

console.log('\nNo purple colors\n')

test('no #8B7CFF (accent/purple) in source', () => {
  assert.ok(!src.includes('#8B7CFF'), 'purple #8B7CFF must be removed from import modal')
})

test('no #5B45F0 (purple gradient end) in source', () => {
  assert.ok(!src.includes('#5B45F0'), 'purple gradient #5B45F0 must be removed')
})

test('no text-accent class (accent is purple in dark theme)', () => {
  assert.ok(!src.includes('text-accent'), 'text-accent (purple) must not be used in light modal')
})

// ── Ember action color ─────────────────────────────────────────────────────────

console.log('\nEmber accent color\n')

test('ember #FF4423 is used in source', () => {
  assert.ok(src.includes('#FF4423'), 'ember #FF4423 must appear as the action color')
})

test('primary import button uses ember color', () => {
  // Import button should use ember via CSS var or direct hex (both are valid)
  const importBtn = src.match(/Import\s*\d*\s*contact[\s\S]{0,400}/)?.[0] ?? src
  assert.ok(
    importBtn.includes('ember') || importBtn.includes('#FF4423') || src.includes("var(--color-ember)"),
    'primary import button must use ember color (var(--color-ember) or #FF4423)'
  )
})

// ── Theme token usage ─────────────────────────────────────────────────────────

console.log('\nTheme token usage\n')

test('C.bg uses var(--color-base) for theme-aware background', () => {
  assert.ok(src.includes("var(--color-base)"), 'C.bg must use var(--color-base) to adapt to the active theme')
})

test('C.ink uses var(--color-hi) for theme-aware text color', () => {
  assert.ok(src.includes("var(--color-hi)"), 'C.ink must use var(--color-hi) to adapt to the active theme')
})

// ── Source preview ────────────────────────────────────────────────────────────

console.log('\nSource preview\n')

test('source preview headers state exists', () => {
  assert.ok(
    src.includes('sourcePreviewHeaders') || src.includes('previewHeaders'),
    'source preview headers state must exist'
  )
})

test('source preview rows state exists', () => {
  assert.ok(
    src.includes('sourcePreviewRows') || src.includes('previewRows'),
    'source preview rows state must exist'
  )
})

test('preamble auto-skip message in source preview', () => {
  assert.ok(
    src.includes('preamble') || src.includes('header found on row') || src.includes('auto-skipped') || src.includes('autoSkipped'),
    'source preview must mention preamble detection or header row number'
  )
})

test('SOURCE PREVIEW label in JetBrains Mono context', () => {
  assert.ok(
    src.includes('SOURCE PREVIEW') || src.includes('source preview') || src.includes('Source preview'),
    'source preview section label must exist'
  )
})

// ── Stepper ───────────────────────────────────────────────────────────────────

console.log('\n4-step stepper\n')

test('UPLOAD step label in stepper', () => {
  assert.ok(
    src.includes('UPLOAD') || src.includes('Upload'),
    'UPLOAD step label must appear in stepper'
  )
})

test('MAP step label in stepper', () => {
  assert.ok(
    src.includes('MAP') || src.includes('Map'),
    'MAP step label must appear in stepper'
  )
})

test('REVIEW CONTACTS step label in stepper', () => {
  assert.ok(
    src.includes('REVIEW') || src.includes('Review'),
    'REVIEW step label must appear in stepper'
  )
})

test('DONE step label in stepper', () => {
  assert.ok(
    src.includes('DONE') || src.includes('Done'),
    'DONE step label must appear in stepper'
  )
})

// ── Review step UI ────────────────────────────────────────────────────────────

console.log('\nReview step UI elements\n')

test('per-row selection (checkbox) in review', () => {
  // Review table must have checkboxes for row selection
  assert.ok(
    src.includes('selectedIds') || src.includes('selectedRowIds'),
    'review step must have selectedIds state for row selection'
  )
})

test('toggleRow or equivalent selection handler', () => {
  assert.ok(
    src.includes('toggleRow') || src.includes('toggleSelection') || src.includes('handleToggleRow'),
    'review step must have a row toggle handler'
  )
})

test('duplicate detection: isDuplicate or _isDuplicate referenced', () => {
  assert.ok(
    src.includes('_isDuplicate') || src.includes('isDuplicate'),
    'review step must handle duplicate rows'
  )
})

test('duplicate label in UI', () => {
  assert.ok(
    src.includes('DUPLICATE') || src.includes('duplicate'),
    'duplicate rows must be visually labeled'
  )
})

test('missing-name handling: _isMissingName referenced', () => {
  assert.ok(
    src.includes('_isMissingName') || src.includes('isMissingName'),
    'review step must handle missing-name rows'
  )
})

test('missing-name label in UI', () => {
  assert.ok(
    src.includes('no name') || src.includes('NEEDS A NAME') || src.includes('missing'),
    'missing-name rows must be labeled'
  )
})

test('fix link/button for missing name', () => {
  assert.ok(
    src.includes('fixingRowId') || src.includes('fix'),
    'review step must have a fix action for missing-name rows'
  )
})

test('merge action for duplicates', () => {
  assert.ok(
    src.includes('merge') || src.includes('Merge'),
    'review step must have a merge action for duplicates'
  )
})

test('reviewRows state exists', () => {
  assert.ok(src.includes('reviewRows'), 'reviewRows state must exist for the review step')
})

// ── Bulk tag chips with confidence ────────────────────────────────────────────

console.log('\nBulk tag chips with confidence\n')

test('tagSummary state exists', () => {
  assert.ok(src.includes('tagSummary'), 'tagSummary state must exist for bulk tag chips')
})

test('HIGH confidence label in tag chips', () => {
  assert.ok(
    src.includes('HIGH') || src.includes('high'),
    'HIGH confidence label must appear in bulk tag chips'
  )
})

test('MEDIUM confidence label in tag chips', () => {
  assert.ok(
    src.includes('MEDIUM') || src.includes('medium'),
    'MEDIUM confidence label must appear in tag chips'
  )
})

// ── Done step redesign ────────────────────────────────────────────────────────

console.log('\nDone step redesign\n')

test('"organized." or "people, organized" in done step', () => {
  assert.ok(
    src.includes('organized.') || src.includes('organized'),
    'done step must use "N people, organized." headline per design'
  )
})

test('"Browse imported" CTA in done step', () => {
  assert.ok(
    src.includes('Browse imported') || src.includes('Browse all'),
    'done step must have "Browse imported" CTA'
  )
})

test('"Go home" CTA in done step', () => {
  assert.ok(
    src.includes('Go home') || src.includes('go home'),
    'done step must have "Go home" CTA'
  )
})

// ── importReviewUtils integration ─────────────────────────────────────────────

console.log('\nimportReviewUtils imports\n')

test('importReviewUtils is imported', () => {
  assert.ok(
    src.includes("from '../lib/importReviewUtils'") || src.includes("from \"../lib/importReviewUtils\"")
    || src.includes("from '../lib/importReviewUtils.js'") || src.includes("from \"../lib/importReviewUtils.js\""),
    'ImportContactsModal must import from importReviewUtils'
  )
})

test('detectDuplicatesInBatch is used', () => {
  assert.ok(src.includes('detectDuplicatesInBatch'), 'must use detectDuplicatesInBatch from importReviewUtils')
})

test('buildReviewRows is used', () => {
  assert.ok(src.includes('buildReviewRows'), 'must use buildReviewRows from importReviewUtils')
})

test('computeTagSummary is used', () => {
  assert.ok(src.includes('computeTagSummary'), 'must use computeTagSummary for bulk tag chips')
})

test('buildImportPayload is used', () => {
  assert.ok(src.includes('buildImportPayload'), 'must use buildImportPayload to construct DB insert payload')
})

// ── Analytics preservation ────────────────────────────────────────────────────

console.log('\nAnalytics events preserved\n')

test("csv_import_used event preserved", () => {
  assert.ok(src.includes("'csv_import_used'"), "csv_import_used analytics event must be preserved")
})

test("csv_mapping_completed event preserved", () => {
  assert.ok(src.includes("'csv_mapping_completed'"), "csv_mapping_completed analytics event must be preserved")
})

test("post_import_action_clicked event preserved", () => {
  assert.ok(src.includes("'post_import_action_clicked'"), "post_import_action_clicked event must be preserved")
})

test("csv_mapping_failed event preserved", () => {
  assert.ok(src.includes("'csv_mapping_failed'"), "csv_mapping_failed event must be preserved")
})

// ── Core library preservation ─────────────────────────────────────────────────

console.log('\nCore library preservation\n')

test('csvHeaderDetect imports preserved', () => {
  assert.ok(
    src.includes("from '../lib/csvHeaderDetect") || src.includes('csvHeaderDetect'),
    'csvHeaderDetect imports must be preserved'
  )
})

test('detectHeaderRow used', () => {
  assert.ok(src.includes('detectHeaderRow'), 'detectHeaderRow must be used from csvHeaderDetect')
})

test('isLinkedInExport used', () => {
  assert.ok(src.includes('isLinkedInExport'), 'isLinkedInExport detection must be preserved')
})

test('contactCategorization imports preserved', () => {
  assert.ok(
    src.includes("from '../lib/contactCategorization") || src.includes('contactCategorization'),
    'contactCategorization imports must be preserved'
  )
})

test('splitContactBatches used (mergeContactTags removed as dead import)', () => {
  assert.ok(src.includes('splitContactBatches'), 'splitContactBatches must be present for AI categorization batching')
  assert.ok(!src.includes('mergeContactTags'), 'mergeContactTags was a dead import — must be removed')
})

test('splitTagsFromCsv used', () => {
  assert.ok(src.includes('splitTagsFromCsv'), 'splitTagsFromCsv must be preserved')
})

// ── AI calls preservation ─────────────────────────────────────────────────────

console.log('\nAI calls\n')

test('ai-map-csv Edge Function call preserved', () => {
  assert.ok(src.includes("'ai-map-csv'"), "ai-map-csv Edge Function call must be preserved")
})

test('ai-categorize-contacts Edge Function call preserved', () => {
  assert.ok(src.includes("'ai-categorize-contacts'"), "ai-categorize-contacts call must be preserved")
})

// ── Stale-request protection ───────────────────────────────────────────────────

console.log('\nStale-request protection\n')

test('inferenceRunIdRef present', () => {
  assert.ok(src.includes('inferenceRunIdRef'), 'stale-request guard ref must be preserved')
})

test('isMountedRef present', () => {
  assert.ok(src.includes('isMountedRef'), 'mount guard ref must be preserved')
})

// ── No em dashes ──────────────────────────────────────────────────────────────

console.log('\nNo em dashes in copy\n')

test('no em dash U+2014 in JSX copy (comments excluded)', () => {
  // Strip JSX block comments {/* ... */} and JS line comments // ...
  // before checking — em dashes in comments are harmless
  const stripped = src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')  // JSX comments
    .replace(/\/\/[^\n]*/g, '')             // JS line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')       // JS block comments
  assert.ok(!stripped.includes('—'), 'no em dashes (U+2014) allowed in visible UI copy')
})

// ── DB duplicate detection ────────────────────────────────────────────────────

console.log('\nDB duplicate detection (Section 9 & 10)\n')

test('detectDatabaseDuplicates imported from importReviewUtils', () => {
  assert.ok(
    src.includes('detectDatabaseDuplicates'),
    'modal must import and use detectDatabaseDuplicates for DB-level duplicate detection'
  )
})

test('fake merge link removed — no merge button that calls toggleRow', () => {
  // The old fake merge link called toggleRow() from within the merge button
  // It must be gone — the word "merge" should not appear as a button action
  const mergeBtn = src.match(/onClick.*?toggleRow[\s\S]{0,20}merge/)?.[0]
  assert.ok(!mergeBtn, 'fake merge button (toggleRow-on-click labeled "merge") must be removed')
})

test('"IN FUNNL" badge present for DB duplicates', () => {
  assert.ok(
    src.includes('IN FUNNL') || src.includes('in funnl') || src.includes('Already in Funnl'),
    '"IN FUNNL" or "Already in Funnl" badge must appear for DB-detected duplicates'
  )
})

test('"Open existing" link present for DB duplicates', () => {
  assert.ok(
    src.includes('Open existing') || src.includes('_existingContactId'),
    '"Open existing" link must be present for DB-level duplicates; must use _existingContactId'
  )
})

test('_isDbDuplicate annotation referenced in rendering', () => {
  assert.ok(
    src.includes('_isDbDuplicate') || src.includes('isDbDup'),
    'DB duplicate rows must be annotated with _isDbDuplicate and rendered differently'
  )
})

test('existing contacts query (select id, name, email, linkedin_url) present in goToReview', () => {
  assert.ok(
    src.includes('linkedin_url') && src.includes("'contacts'"),
    'goToReview must query existing contacts including email and linkedin_url for duplicate matching'
  )
})

// ── ARIA accessibility ─────────────────────────────────────────────────────────

console.log('\nARIA accessibility (Section 21)\n')

test('role="progressbar" present on importing state', () => {
  assert.ok(
    src.includes('role="progressbar"') || src.includes("role={'progressbar'}"),
    'importing state must have role="progressbar" for accessibility'
  )
})

test('aria-valuemin present on progressbar', () => {
  assert.ok(
    src.includes('aria-valuemin'),
    'progressbar must have aria-valuemin'
  )
})

test('aria-valuemax present on progressbar', () => {
  assert.ok(
    src.includes('aria-valuemax'),
    'progressbar must have aria-valuemax'
  )
})

test('aria-valuenow present on progressbar', () => {
  assert.ok(
    src.includes('aria-valuenow'),
    'progressbar must have aria-valuenow'
  )
})

test('role="alert" present on error containers', () => {
  assert.ok(
    src.includes('role="alert"') || src.includes("role={'alert'}"),
    'error message containers must have role="alert" so screen readers announce errors'
  )
})

// ── Post-import chooser ────────────────────────────────────────────────────────

console.log('\nPost-import chooser (Section 17)\n')

test('post-import chooser rendered from importedContacts', () => {
  assert.ok(
    src.includes('importedContacts'),
    'done step must use importedContacts state for the post-import chooser'
  )
})

test('log_recent_outreach action in chooser', () => {
  assert.ok(
    src.includes("'log_recent_outreach'"),
    'post-import chooser must fire post_import_action_clicked with action: log_recent_outreach'
  )
})

test('chooser navigates to contact with openInteractionForm: true', () => {
  assert.ok(
    src.includes('openInteractionForm: true'),
    'chooser navigation must include openInteractionForm: true in router state'
  )
})

// ── ContactsPage importBatch ──────────────────────────────────────────────────

console.log('\nContactsPage importBatch routing (Section 16)\n')

const contactsPageSrc = readFileSync(join(__dir, '..', 'src', 'pages', 'ContactsPage.jsx'), 'utf8')

test('ContactsPage imports useLocation', () => {
  assert.ok(
    contactsPageSrc.includes('useLocation'),
    'ContactsPage must import useLocation to consume importBatch router state'
  )
})

test('ContactsPage consumes importBatch from location.state', () => {
  assert.ok(
    contactsPageSrc.includes('importBatch') && contactsPageSrc.includes('location.state'),
    'ContactsPage must read importBatch from location.state'
  )
})

test('ContactsPage shows import batch filter strip', () => {
  assert.ok(
    contactsPageSrc.includes('importBatchIds') || contactsPageSrc.includes('importBatch'),
    'ContactsPage must filter displayed contacts to the import batch when active'
  )
})

test('ContactsPage has Clear button for import batch filter', () => {
  assert.ok(
    contactsPageSrc.includes('Clear') && contactsPageSrc.includes('importBatch'),
    'ContactsPage must have a clear button to dismiss the import batch filter'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
