import { useState, useRef, useEffect } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import { canUseAI } from '../lib/ai'
import { detectHeaderRow, isLinkedInExport } from '../lib/csvHeaderDetect.js'

const FUNNL_FIELDS = [
  { value: 'name',              label: 'Name',              required: true },
  { value: 'company',           label: 'Company' },
  { value: 'role',              label: 'Role' },
  { value: 'email',             label: 'Email' },
  { value: 'linkedin_url',      label: 'LinkedIn URL' },
  { value: 'how_met',           label: 'How met' },
  { value: 'tags',              label: 'Tags' },
  { value: 'relationship_type', label: 'Relationship type' },
  { value: 'relationship_note', label: 'Why they matter' },
]

// Normalize a CSV header before lookup:
// lowercase, convert separators (underscores, hyphens, slashes, dots) to spaces,
// collapse multiple spaces. Means first_name / first-name / first.name all become
// 'first name' and match one HEADER_MAP entry — no need to list every variant.
function normalizeHeader(h) {
  return h
    .toLowerCase()
    .replace(/[\s_\-./\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Auto-detect: normalized header → Funnl field.
//
// Design principle: when NOT confident, leave unassigned — a wrong auto-guess that
// needs correcting is worse than an unassigned column that takes one click to place.
//
// Pruned false positives vs previous version:
//   'title'    → removed (Mr./Dr. vs job title — use 'job title' / 'current title')
//   'type'     → removed (too generic — rarely means Funnl tags)
//   'source'   → removed (lead source vs meeting context — ambiguous)
//   'met'      → removed (too short/ambiguous)
//   'label'    → removed (too generic)
//   'org'      → removed (too short — often an ID or GitHub org)
//   'category' → removed (too generic)
//   'tech'     → removed (company sector vs skills list — ambiguous)
//   'contact'  → removed (contact record ID vs person name — ambiguous)
//
// Normalization handles separator variants automatically, so 'first_name' /
// 'first-name' / 'First.Name' all normalize to 'first name' and match that entry.
const HEADER_MAP = {
  // ── Name ─────────────────────────────────────────────────────────────────────
  'name': 'name',
  'full name': 'name',
  'fullname': 'name',        // camelCase without separator
  'contact name': 'name',
  'contactname': 'name',
  'person': 'name',
  'person name': 'name',
  'attendee': 'name',
  'attendee name': 'name',
  'contact person': 'name',
  // Split first / last — auto-combine in chip order (First before Last)
  'first name': 'name',
  'firstname': 'name',
  'fname': 'name',
  'given name': 'name',
  'last name': 'name',
  'lastname': 'name',
  'lname': 'name',
  'surname': 'name',
  'family name': 'name',

  // ── Company ───────────────────────────────────────────────────────────────────
  'company': 'company',
  'company name': 'company',
  'companyname': 'company',
  'organization': 'company',
  'organisation': 'company',
  'employer': 'company',
  'employer name': 'company',
  'workplace': 'company',
  'current company': 'company',
  'firm': 'company',
  // NOT: 'org' (ambiguous), 'work' (ambiguous)

  // ── Role ──────────────────────────────────────────────────────────────────────
  'role': 'role',
  'job title': 'role',
  'jobtitle': 'role',
  'position': 'role',
  'job position': 'role',
  'job role': 'role',
  'current role': 'role',
  'current title': 'role',
  'current position': 'role',
  'occupation': 'role',
  'designation': 'role',
  // NOT: 'title' alone — ambiguous (Mr./Dr. salutation vs job title)

  // ── Email ─────────────────────────────────────────────────────────────────────
  'email': 'email',
  'email address': 'email',
  'emailaddress': 'email',
  'e mail': 'email',         // 'e-mail' normalizes to 'e mail'
  'work email': 'email',
  'personal email': 'email',
  'professional email': 'email',
  'contact email': 'email',
  'email id': 'email',
  // NOT: 'company email' (company's address or person's? — ambiguous)

  // ── LinkedIn URL ──────────────────────────────────────────────────────────────
  'linkedin': 'linkedin_url',
  'linkedin url': 'linkedin_url',
  'linkedin profile': 'linkedin_url',
  'linkedin profile url': 'linkedin_url',
  'linkedin page': 'linkedin_url',
  'linkedin link': 'linkedin_url',
  'li url': 'linkedin_url',
  'li profile': 'linkedin_url',
  // NOT: 'profile' alone, 'url' alone (too generic)

  // ── How met ───────────────────────────────────────────────────────────────────
  'how met': 'how_met',
  'howmet': 'how_met',
  'how we met': 'how_met',
  'where met': 'how_met',
  'where we met': 'how_met',
  'meeting context': 'how_met',
  'met through': 'how_met',
  'met at': 'how_met',
  'met via': 'how_met',
  'introduction': 'how_met',
  // NOT: 'source' (ambiguous), 'met' alone (too short), 'context' alone (too generic)

  // ── Tags ──────────────────────────────────────────────────────────────────────
  'tags': 'tags',
  'tag': 'tags',
  'labels': 'tags',
  // NOT: 'type' alone, 'label' alone, 'category'/'categories' alone (all too generic)

  // ── Relationship type ─────────────────────────────────────────────────────────
  'relationship type': 'relationship_type',
  'contact type': 'relationship_type',
  'connection type': 'relationship_type',
  'relationship': 'relationship_type',

  // ── Relationship note ─────────────────────────────────────────────────────────
  'relationship note': 'relationship_note',
  'why this person matters': 'relationship_note',
  'why they matter': 'relationship_note',
  'notes on relationship': 'relationship_note',
  'context': 'relationship_note',
  // Generic notes column names — the most common names people use in spreadsheets
  // NOT: 'description' (often a company/role description), 'details' (often contact details)
  'notes': 'relationship_note',
  'note': 'relationship_note',
  'comments': 'relationship_note',
  'comment': 'relationship_note',
  'memo': 'relationship_note',
  'additional notes': 'relationship_note',
  'general notes': 'relationship_note',
}

function freshAssignment() {
  return { name: [], company: [], role: [], email: [], linkedin_url: [], how_met: [], tags: [], relationship_type: [], relationship_note: [] }
}

// Iterates headers in file order so 'First Name' lands before 'Last Name' in the
// name array, producing "John Smith" not "Smith John" when joined.
function buildInitialAssignment(headers) {
  const result = freshAssignment()
  const used = new Set()
  for (const header of headers) {
    const field = HEADER_MAP[normalizeHeader(header)]
    if (field && !used.has(header)) {
      result[field] = [...result[field], header]
      used.add(header)
    }
  }
  return result
}

function normalizeUrl(url) {
  const s = (url || '').trim()
  if (!s) return null
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return 'https://' + s
}

// AI SEAM: This is where future AI pre-processing plugs in.
// A future AI step would transform rawRow before this function runs — e.g. splitting
// "John Smith, Goldman, analyst" from a single jammed column into named fields,
// or inferring tags/skills from freeform notes.
// This function stays unchanged; the AI step just pre-processes rawRow first.
function transformRow(rawRow, assignment) {
  const contact = {}
  for (const [field, cols] of Object.entries(assignment)) {
    if (!cols || cols.length === 0) continue
    if (field === 'tags') {
      // Each assigned column split on commas, merged into one flat array
      const values = cols.flatMap(col =>
        (rawRow[col] || '').trim().split(',').map(s => s.trim()).filter(Boolean)
      )
      if (values.length > 0) contact[field] = values
    } else if (field === 'linkedin_url') {
      // First non-empty value wins
      const raw = cols.map(col => (rawRow[col] || '').trim()).filter(Boolean)[0]
      if (raw) contact.linkedin_url = normalizeUrl(raw)
    } else if (field === 'relationship_note') {
      // Multiple note columns join with ' | ' so two freeform sentences stay readable
      const combined = cols.map(col => (rawRow[col] || '').trim()).filter(Boolean).join(' | ')
      if (combined) contact[field] = combined
    } else {
      // Text fields: chip order = join order; empty cells skipped, no double spaces
      const combined = cols.map(col => (rawRow[col] || '').trim()).filter(Boolean).join(' ')
      if (combined) contact[field] = combined
    }
  }
  return contact
}

function processRows(rows, assignment) {
  const toImport = []
  let skipped = 0
  for (const row of rows) {
    const contact = transformRow(row, assignment)
    if (!contact.name || !contact.name.trim()) {
      skipped++
    } else {
      toImport.push(contact)
    }
  }
  return { toImport, skipped }
}

const STEP_LABEL = { upload: 'Step 1 of 3', map: 'Step 2 of 3', confirm: 'Step 3 of 3', done: 'Done' }

// Compute picker position, flipping upward when near the bottom of the viewport
// so the dropdown never gets clipped on mobile or in short windows.
function calcPickerPos(e, estimatedHeight = 240) {
  const rect = e.currentTarget.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const top = spaceBelow > estimatedHeight + 8
    ? rect.bottom + 6
    : rect.top - estimatedHeight - 6
  const left = Math.min(rect.left, window.innerWidth - 204)
  return { top, left }
}

export default function ImportContactsModal({ onClose, onImported }) {
  const [step, setStep]           = useState('upload')
  const [dragging, setDragging]   = useState(false)
  const [parseError, setParseError] = useState('')
  const [headers, setHeaders]     = useState([])
  const [rows, setRows]           = useState([])
  const [assignment, setAssignment] = useState(freshAssignment)

  // Unified picker state — only one picker open at a time.
  // mode 'field': key = funnlField, dropdown lists unassigned columns (field-first flow)
  // mode 'col':   key = CSV header,  dropdown lists Funnl fields    (column-first flow)
  const [picker, setPicker]       = useState(null)

  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [result, setResult]       = useState(null)
  const fileInputRef = useRef()

  // Pro-gate: check once on mount — same pattern as AddContactDrawer
  const [isProUser, setIsProUser]   = useState(false)
  const [aiLoading, setAiLoading]   = useState(false)
  const [aiMapped, setAiMapped]     = useState({ applied: false, count: 0, notes: '' })
  // 'linkedin' | 'preamble' | null — drives the informational banner in Step 2
  const [csvDetection, setCsvDetection] = useState(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) canUseAI(data.user.id).then(setIsProUser)
    })
  }, [])

  // --- Derived ---
  const assignedSet  = new Set(Object.values(assignment).flat())
  const ignoredCols  = headers.filter(h => !assignedSet.has(h))
  const hasNameMapped = assignment.name.length > 0

  const previewFields = [
    'name',
    ...FUNNL_FIELDS
      .filter(f => f.value !== 'name' && assignment[f.value]?.length > 0)
      .map(f => f.value),
  ].slice(0, 5)
  const previewContacts = rows.slice(0, 5).map(row => transformRow(row, assignment))

  const confirmData = step === 'confirm'
    ? processRows(rows, assignment)
    : { toImport: [], skipped: 0 }

  // --- File handling ---
  async function handleFile(file) {
    if (!file) return
    setParseError('')
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError("Please select a .csv file. Other formats (like .xlsx) aren't supported yet.")
      return
    }

    // Two-pass parsing: detect the real header row first, then build keyed objects
    // from that row onward. Fixes exports (like LinkedIn's) that prepend a preamble
    // before the actual header, which breaks single-pass header: true parsing.
    let rawText
    try {
      rawText = await file.text()
    } catch {
      setParseError("Couldn't read this file. Make sure it's a valid .csv and try again.")
      return
    }
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1) // strip BOM

    // Pass 1: parse all rows as arrays with no header inference
    const rawResult = Papa.parse(rawText, { header: false, skipEmptyLines: 'greedy' })
    const allRows = rawResult.data
    const headerIdx = detectHeaderRow(allRows)

    if (headerIdx === -1) {
      setParseError("Couldn't find a contact header row. Make sure your CSV includes columns like Name, Company, or Email.")
      return
    }

    // Extract and trim header cells; build an index → name map for keying data rows
    const rawHeaderRow = allRows[headerIdx]
    const indexedHeaders = rawHeaderRow
      .map((h, i) => ({ name: (h || '').trim(), i }))
      .filter(({ name }) => name.length > 0)
    const hdrs = indexedHeaders.map(({ name }) => name)

    // Pass 2: reconstruct data rows as keyed objects from everything below the header
    const dataRows = allRows.slice(headerIdx + 1).map(cells =>
      Object.fromEntries(indexedHeaders.map(({ name, i }) => [name, cells[i] ?? '']))
    )

    if (dataRows.length === 0) {
      setParseError('This CSV has headers but no data rows.')
      return
    }

    // Drive the informational banner in Step 2
    setCsvDetection(
      isLinkedInExport(rawHeaderRow) ? 'linkedin' : headerIdx > 0 ? 'preamble' : null
    )

    // Deterministic column assignment from header names
    const initialAssignment = buildInitialAssignment(hdrs)

    // Value-sniff: 'URL' / 'Link' are too generic for HEADER_MAP, but if sample values
    // contain 'linkedin.com' it's safe to assign to linkedin_url (LinkedIn export pattern)
    if (initialAssignment.linkedin_url.length === 0) {
      const urlLikeCols = hdrs.filter(h => {
        const n = h.toLowerCase().trim()
        return n === 'url' || n === 'link' || n === 'profile url'
      })
      for (const col of urlLikeCols) {
        const samples = dataRows.slice(0, 5).map(r => (r[col] || '').toLowerCase())
        if (samples.some(v => v.includes('linkedin.com'))) {
          initialAssignment.linkedin_url = [col]
          break
        }
      }
    }

    setHeaders(hdrs)
    setRows(dataRows)
    setAssignment(initialAssignment)
    setAiMapped({ applied: false, count: 0, notes: '' })

    if (isProUser) {
      // Only send unresolved columns to AI — don't let it override deterministic mappings
      const assignedCols = new Set(Object.values(initialAssignment).flat())
      const unresolvedHdrs = hdrs.filter(h => !assignedCols.has(h))

      setAiLoading(true)
      ;(async () => {
        try {
          const { data: resp, error } = await supabase.functions.invoke('ai-map-csv', {
            body: { headers: unresolvedHdrs, sample_rows: dataRows.slice(0, 3) },
          })
          if (error || !resp?.assignment) throw new Error('no assignment')

          const headerSet = new Set(hdrs)
          const merged = { ...initialAssignment }
          const alreadyAssigned = new Set(Object.values(merged).flat())
          let aiCount = 0
          for (const [field, cols] of Object.entries(resp.assignment)) {
            if (!(field in merged)) continue
            const valid = (cols ?? []).filter(
              c => typeof c === 'string' && headerSet.has(c) && !alreadyAssigned.has(c)
            )
            if (valid.length > 0) {
              merged[field] = [...merged[field], ...valid]
              valid.forEach(c => alreadyAssigned.add(c))
              aiCount += valid.length
            }
          }
          const totalMapped = Object.values(merged).flat().length
          setAssignment(merged)
          setAiMapped({ applied: true, count: totalMapped, notes: resp.notes ?? '' })
        } catch {
          // Silent fallback — rule-based assignment already in state
        } finally {
          setAiLoading(false)
          setStep('map')
        }
      })()
    } else {
      setStep('map')
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    handleFile(e.dataTransfer.files[0])
  }

  function goBackToUpload() {
    setStep('upload')
    setHeaders([])
    setRows([])
    setAssignment(freshAssignment())
    setPicker(null)
    setParseError('')
    setAiLoading(false)
    setAiMapped({ applied: false, count: 0, notes: '' })
    setCsvDetection(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // --- Assignment ---
  function addColumn(field, col) {
    setAssignment(prev => ({ ...prev, [field]: [...prev[field], col] }))
    setPicker(null)
  }

  function removeColumn(field, col) {
    setAssignment(prev => ({ ...prev, [field]: prev[field].filter(c => c !== col) }))
  }

  // Field-first: "what columns can I pull into this field?" → lists unassigned cols
  function openFieldPicker(field, e) {
    e.stopPropagation()
    if (picker?.mode === 'field' && picker.key === field) { setPicker(null); return }
    setPicker({ mode: 'field', key: field, pos: calcPickerPos(e) })
  }

  // Column-first: "where does this column go?" → lists Funnl fields
  function openColPicker(col, e) {
    e.stopPropagation()
    if (picker?.mode === 'col' && picker.key === col) { setPicker(null); return }
    setPicker({ mode: 'col', key: col, pos: calcPickerPos(e, 320) })
  }

  // --- Import ---
  async function handleImport() {
    setImporting(true)
    setImportError('')
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setImportError('Not signed in. Please refresh the page and try again.')
      setImporting(false)
      return
    }
    const { toImport, skipped } = processRows(rows, assignment)
    if (toImport.length === 0) {
      setImportError('No importable rows — every row is missing a name value.')
      setImporting(false)
      return
    }
    const contacts = toImport.map(c => ({ ...c, user_id: user.id }))
    // Single bulk insert — all-or-nothing at the database level.
    const { error } = await supabase.from('contacts').insert(contacts)
    setImporting(false)
    if (error) {
      setImportError(`Import failed: ${error.message}. No contacts were saved — please try again.`)
      return
    }
    track('csv_import_used', { contacts_imported: toImport.length, ai_assisted: aiMapped.applied })
    setResult({ imported: toImport.length, skipped })
    setStep('done')
    onImported()
  }

  // --- Render ---
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>

      {/* Backdrop */}
      <div className="absolute inset-0 bg-[rgba(0,0,0,0.65)]" onClick={onClose}/>

      {/* Modal panel */}
      <div className="relative w-full max-w-[620px] max-h-[88vh] flex flex-col bg-card border border-[rgba(255,255,255,0.09)] rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.7)]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[rgba(255,255,255,0.07)] flex-none">
          <div>
            <h2 className="font-display font-bold text-[18px] text-hi leading-tight">Import contacts</h2>
            <p className="text-[11.5px] text-lower font-mono mt-0.5">{STEP_LABEL[step]}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-low hover:text-hi hover:bg-elevated transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        </div>

        {/* Scrollable body — closes picker on scroll so it doesn't drift from its button */}
        <div
          className="overflow-y-auto flex-1 px-6 py-5"
          onScroll={() => picker && setPicker(null)}
        >

          {/* ── STEP 1: Upload ── */}
          {step === 'upload' && (
            <div>
              {aiLoading ? (
                /* Pro users: show spinner while AI infers column mapping */
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                  <p className="text-[14px] font-semibold text-mid">AI is analyzing your columns…</p>
                  <p className="text-[12px] text-lower">Usually about 2 seconds</p>
                </div>
              ) : (
                <>
                  <p className="text-[14px] text-muted mb-5 leading-relaxed">
                    Upload a CSV file exported from a spreadsheet. Each row becomes one contact.
                  </p>
                  <div
                    className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                      dragging
                        ? 'border-accent bg-[rgba(139,124,255,0.07)]'
                        : 'border-[rgba(255,255,255,0.12)] hover:border-[rgba(255,255,255,0.22)] hover:bg-[rgba(255,255,255,0.02)]'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragging(true) }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={handleDrop}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={e => handleFile(e.target.files[0])}
                    />
                    <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-elevated border border-[rgba(255,255,255,0.08)] flex items-center justify-center">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                    </div>
                    <p className="text-[14px] font-semibold text-hi mb-1">Drop a CSV file here</p>
                    <p className="text-[13px] text-low">or click to browse · .csv files only</p>
                  </div>
                  {parseError && (
                    <div className="mt-4 flex items-start gap-2.5 px-4 py-3 bg-[rgba(255,107,138,0.08)] border border-[rgba(255,107,138,0.2)] rounded-xl">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                        <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                      </svg>
                      <p className="text-[13px] text-danger">{parseError}</p>
                    </div>
                  )}
                  <p className="text-[12px] text-lower mt-5 leading-relaxed">
                    Tip: in Google Sheets, go to File → Download → Comma Separated Values (.csv).
                    In Excel, use File → Save As → CSV.
                  </p>
                </>
              )}
            </div>
          )}

          {/* ── STEP 2: Map columns ── */}
          {step === 'map' && (
            <div>

              {/* Detection banner — shown when preamble rows were skipped */}
              {csvDetection && (
                <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(47,212,182,0.08)] border border-[rgba(47,212,182,0.2)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  <p className="text-[12.5px] text-success font-semibold">
                    {csvDetection === 'linkedin'
                      ? 'LinkedIn Connections export detected — skipped the introductory note and auto-mapped your columns below. Review the assignments before importing.'
                      : 'Introductory text was found and skipped — reading contacts from the actual header row.'
                    }
                  </p>
                </div>
              )}

              {/* AI mapping banner — Pro users only, after a successful mapping call */}
              {aiMapped.applied && (
                <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(139,124,255,0.08)] border border-[rgba(139,124,255,0.2)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                  <div>
                    <p className="text-[12.5px] text-accent font-semibold">
                      AI auto-mapped {aiMapped.count} {aiMapped.count === 1 ? 'column' : 'columns'} — review and adjust before importing
                    </p>
                    {aiMapped.notes && (
                      <p className="text-[11.5px] text-mid mt-0.5">{aiMapped.notes}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Upgrade prompt — non-Pro users only; mutually exclusive with the banner above */}
              {!isProUser && (
                <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(139,124,255,0.08)] border border-[rgba(139,124,255,0.2)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                  <p className="text-[12.5px] text-accent font-semibold">
                    Pro tip: AI can auto-map your columns in one click — available with Funnl Pro.
                  </p>
                </div>
              )}

              {/* Name required warning */}
              {!hasNameMapped && (
                <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(255,184,77,0.08)] border border-[rgba(255,184,77,0.25)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="2" strokeLinecap="round" className="flex-none">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <p className="text-[12.5px] text-warning">
                    Assign at least one column to <strong>Name</strong> to continue — it's required.
                  </p>
                </div>
              )}

              {/* ── Pool: unassigned columns (primary entry point for assignment) ── */}
              <div className="mb-5">
                {ignoredCols.length === 0 ? (
                  <div className="flex items-center gap-2 px-4 py-3 bg-[rgba(47,212,182,0.07)] border border-[rgba(47,212,182,0.2)] rounded-xl">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <p className="text-[12.5px] text-success font-medium">All columns placed — check the preview below.</p>
                  </div>
                ) : (
                  <div className="px-4 py-3.5 bg-elevated border border-[rgba(255,255,255,0.08)] rounded-xl">
                    <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-3">
                      Not yet assigned — click a column to place it
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {ignoredCols.map(col => (
                        <button
                          key={col}
                          onClick={e => openColPicker(col, e)}
                          className={`inline-flex items-center gap-1.5 border text-[12px] font-mono px-2.5 py-[6px] rounded-lg transition-colors ${
                            picker?.mode === 'col' && picker.key === col
                              ? 'bg-[rgba(139,124,255,0.15)] border-accent text-hi'
                              : 'bg-card border-[rgba(255,255,255,0.11)] text-mid hover:border-[rgba(139,124,255,0.4)] hover:text-hi'
                          }`}
                        >
                          {col}
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <path d="M6 9l6 6 6-6"/>
                          </svg>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Field assignment table ── */}
              <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-1">
                Funnl fields
              </p>
              <p className="text-[12px] text-lower mb-3">
                Click a column above to assign it, or use + Add on any field.
                Multiple columns combine in chip order — chip order matters for First + Last name.
              </p>

              <div className="divide-y divide-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.07)] rounded-xl overflow-hidden mb-5">
                {FUNNL_FIELDS.map(field => (
                  <div key={field.value} className="flex items-start gap-3 px-4 py-3 bg-card">
                    {/* Field label */}
                    <div className="w-[106px] flex-none pt-[7px]">
                      <span className="text-[13px] font-semibold text-hi">{field.label}</span>
                      {field.required && <span className="text-danger text-[12px] ml-0.5">*</span>}
                    </div>

                    {/* Chips + controls */}
                    <div className="flex-1 flex flex-wrap items-center gap-1.5 pt-1.5 min-h-[32px]">
                      {assignment[field.value].map(col => (
                        <span
                          key={col}
                          className="inline-flex items-center gap-1 bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.22)] text-tag text-[12px] font-mono px-2 py-[5px] rounded-lg leading-none"
                        >
                          {col}
                          <button
                            onClick={() => removeColumn(field.value, col)}
                            title="Remove — returns this column to the unassigned pool above"
                            className="text-[rgba(180,168,255,0.45)] hover:text-danger transition-colors ml-0.5 leading-none text-[14px]"
                          >
                            ×
                          </button>
                        </span>
                      ))}

                      {/* "— not assigned" placeholder so empty fields are visually obvious */}
                      {assignment[field.value].length === 0 && (
                        <span className="text-[12px] text-lower italic pt-[5px]">— not assigned</span>
                      )}

                      {/* + Add: secondary field-first flow (when user knows the field, not the column) */}
                      {ignoredCols.length > 0 && (
                        <button
                          onClick={e => openFieldPicker(field.value, e)}
                          className={`inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-[5px] rounded-lg transition-colors leading-none ${
                            picker?.mode === 'field' && picker.key === field.value
                              ? 'text-accent bg-[rgba(139,124,255,0.12)]'
                              : 'text-low hover:text-accent hover:bg-[rgba(139,124,255,0.08)]'
                          }`}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <path d="M12 5v14M5 12h14"/>
                          </svg>
                          Add
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Live preview ── */}
              <div className="border-t border-[rgba(255,255,255,0.06)] pt-5">
                <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-1">
                  Live preview
                </p>
                <p className="text-[12px] text-lower mb-3">
                  First {Math.min(rows.length, 5)} of {rows.length} rows · updates instantly as you change assignments
                </p>
                <div className="overflow-x-auto rounded-xl border border-[rgba(255,255,255,0.07)]">
                  <table className="w-full text-[12px]" style={{ minWidth: previewFields.length * 130 }}>
                    <thead>
                      <tr className="border-b border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)]">
                        {previewFields.map(f => {
                          const fd = FUNNL_FIELDS.find(x => x.value === f)
                          return (
                            <th key={f} className="px-3 py-2 text-left text-lower font-mono font-bold whitespace-nowrap">
                              {fd.label}
                            </th>
                          )
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {previewContacts.map((contact, i) => (
                        <tr key={i} className="border-b border-[rgba(255,255,255,0.04)] last:border-0">
                          {previewFields.map(f => {
                            const val = f === 'tags'
                              ? (contact[f] || []).join(', ')
                              : (contact[f] || '')
                            return (
                              <td key={f} className="px-3 py-2 max-w-[160px]">
                                {val
                                  ? <span className="text-muted block truncate">{val}</span>
                                  : <span className="text-lower">—</span>
                                }
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>
          )}

          {/* ── STEP 3: Confirm ── */}
          {step === 'confirm' && (
            <div>
              <div className="bg-elevated border border-[rgba(255,255,255,0.07)] rounded-xl p-5 mb-4">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-xl bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.2)] flex items-center justify-center flex-none">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                  </div>
                  <div>
                    <p className="text-[16px] font-bold text-hi">
                      About to import {confirmData.toImport.length} {confirmData.toImport.length === 1 ? 'contact' : 'contacts'}
                    </p>
                    {confirmData.skipped > 0 && (
                      <p className="text-[12.5px] text-warning mt-0.5">
                        {confirmData.skipped} {confirmData.skipped === 1 ? 'row' : 'rows'} will be skipped — no name value
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-[13px] text-low leading-relaxed mb-5">
                This import is all-or-nothing — if anything fails, zero contacts will be saved and you'll see a clear error.
              </p>
              {importError && (
                <div className="flex items-start gap-2.5 px-4 py-3 bg-[rgba(255,107,138,0.08)] border border-[rgba(255,107,138,0.2)] rounded-xl">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                    <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                  </svg>
                  <p className="text-[13px] text-danger">{importError}</p>
                </div>
              )}
            </div>
          )}

          {/* ── DONE ── */}
          {step === 'done' && result && (
            <div className="py-6 text-center">
              <div className="w-[56px] h-[56px] mx-auto mb-5 rounded-[18px] bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.25)] flex items-center justify-center">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
              </div>
              <p className="font-display font-bold text-[22px] text-hi mb-2">
                Imported {result.imported} {result.imported === 1 ? 'contact' : 'contacts'}
              </p>
              {result.skipped > 0 && (
                <p className="text-[13px] text-low mb-1">
                  {result.skipped} {result.skipped === 1 ? 'row' : 'rows'} skipped — no name value
                </p>
              )}
              <p className="text-[13.5px] text-muted mt-1">Your contacts list has been updated.</p>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[rgba(255,255,255,0.07)] flex-none flex items-center justify-between gap-3">
          {step === 'upload' && (
            <>
              <div/>
              <button onClick={onClose} className="text-[14px] font-semibold text-low hover:text-hi transition-colors">
                Cancel
              </button>
            </>
          )}
          {step === 'map' && (
            <>
              <button onClick={goBackToUpload} className="text-[14px] font-semibold text-low hover:text-hi transition-colors">
                ← Back
              </button>
              <button
                onClick={() => { setImportError(''); setPicker(null); setStep('confirm') }}
                disabled={!hasNameMapped}
                className="bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-6 py-[10px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <button
                onClick={() => setStep('map')}
                disabled={importing}
                className="text-[14px] font-semibold text-low hover:text-hi transition-colors disabled:opacity-40"
              >
                ← Back
              </button>
              <button
                onClick={handleImport}
                disabled={importing || confirmData.toImport.length === 0}
                className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-6 py-[10px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {importing && (
                  <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                )}
                {importing
                  ? 'Importing…'
                  : `Import ${confirmData.toImport.length} ${confirmData.toImport.length === 1 ? 'contact' : 'contacts'}`
                }
              </button>
            </>
          )}
          {step === 'done' && (
            <button
              onClick={onClose}
              className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-6 py-[10px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          )}
        </div>
      </div>

      {/* Unified picker — fixed to viewport so scrollable modal body can't clip it.
          Closes automatically when body scrolls (onScroll handler above). */}
      {picker && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setPicker(null)}/>
          <div
            className="fixed z-[70] bg-elevated border border-[rgba(255,255,255,0.13)] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] py-1 min-w-[180px] max-h-[260px] overflow-y-auto"
            style={{ top: picker.pos.top, left: picker.pos.left }}
          >
            {picker.mode === 'field' ? (
              // Field-first: list unassigned columns to pull into the open field
              ignoredCols.length === 0 ? (
                <p className="px-3 py-2 text-[13px] text-lower">No columns available</p>
              ) : (
                ignoredCols.map(col => (
                  <button
                    key={col}
                    onClick={() => addColumn(picker.key, col)}
                    className="w-full text-left px-3 py-[9px] text-[13px] text-mid hover:text-hi hover:bg-[rgba(255,255,255,0.05)] transition-colors font-mono"
                  >
                    {col}
                  </button>
                ))
              )
            ) : (
              // Column-first: list Funnl fields to place the clicked column into
              FUNNL_FIELDS.map(field => (
                <button
                  key={field.value}
                  onClick={() => addColumn(field.value, picker.key)}
                  className="w-full text-left px-3 py-[9px] text-[13px] text-mid hover:text-hi hover:bg-[rgba(255,255,255,0.05)] transition-colors flex items-center justify-between gap-3"
                >
                  <span>{field.label}</span>
                  {field.required && <span className="text-danger text-[10.5px] font-mono flex-none">required</span>}
                </button>
              ))
            )}
          </div>
        </>
      )}

    </div>
  )
}
