import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'

// Funnl fields in display order
const FUNNL_FIELDS = [
  { value: 'name',         label: 'Name',        required: true },
  { value: 'company',      label: 'Company' },
  { value: 'role',         label: 'Role' },
  { value: 'email',        label: 'Email' },
  { value: 'linkedin_url', label: 'LinkedIn URL' },
  { value: 'how_met',      label: 'How met' },
  { value: 'tags',         label: 'Tags' },
  { value: 'skills',       label: 'Skills' },
]

// Auto-detect: lowercased CSV header → Funnl field
// First name and last name variants both map to 'name' so they
// both land in assignment.name and join in header order (First before Last).
const HEADER_MAP = {
  // Name — plain
  'name': 'name', 'full name': 'name', 'full_name': 'name',
  'contact name': 'name', 'contact_name': 'name', 'contact': 'name', 'person': 'name',
  // Name — first
  'first name': 'name', 'first_name': 'name', 'firstname': 'name',
  'fname': 'name', 'given name': 'name', 'given_name': 'name',
  // Name — last
  'last name': 'name', 'last_name': 'name', 'lastname': 'name',
  'lname': 'name', 'surname': 'name', 'family name': 'name', 'family_name': 'name',
  // Company
  'company': 'company', 'company name': 'company', 'company_name': 'company',
  'organization': 'company', 'organisation': 'company',
  'firm': 'company', 'employer': 'company', 'org': 'company',
  // Role
  'role': 'role', 'title': 'role', 'job title': 'role', 'job_title': 'role',
  'position': 'role', 'job position': 'role',
  // Email
  'email': 'email', 'email address': 'email', 'email_address': 'email',
  'e-mail': 'email', 'work email': 'email',
  // LinkedIn
  'linkedin': 'linkedin_url', 'linkedin url': 'linkedin_url', 'linkedin_url': 'linkedin_url',
  'linkedin profile': 'linkedin_url', 'linkedin_profile': 'linkedin_url',
  'linkedin link': 'linkedin_url',
  // How met
  'how met': 'how_met', 'how_met': 'how_met', 'how we met': 'how_met',
  'met at': 'how_met', 'met': 'how_met', 'source': 'how_met',
  'where met': 'how_met', 'meeting context': 'how_met',
  // Tags
  'tags': 'tags', 'tag': 'tags', 'label': 'tags', 'labels': 'tags',
  'category': 'tags', 'categories': 'tags', 'type': 'tags',
  // Skills
  'skills': 'skills', 'skill': 'skills', 'expertise': 'skills',
  'tech': 'skills', 'technologies': 'skills', 'technical skills': 'skills',
}

function freshAssignment() {
  return { name: [], company: [], role: [], email: [], linkedin_url: [], how_met: [], tags: [], skills: [] }
}

// Builds initial assignment from CSV headers, iterating in file order so that
// "First Name" lands before "Last Name" in the name array.
function buildInitialAssignment(headers) {
  const result = freshAssignment()
  const used = new Set()
  for (const header of headers) {
    const field = HEADER_MAP[header.toLowerCase().trim()]
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
    if (field === 'tags' || field === 'skills') {
      // Each assigned column is split on commas; all values merged into one flat array
      const values = cols.flatMap(col =>
        (rawRow[col] || '').trim().split(',').map(s => s.trim()).filter(Boolean)
      )
      if (values.length > 0) contact[field] = values
    } else if (field === 'linkedin_url') {
      // First non-empty value wins
      const raw = cols.map(col => (rawRow[col] || '').trim()).filter(Boolean)[0]
      if (raw) contact.linkedin_url = normalizeUrl(raw)
    } else {
      // Text fields: chip order determines join order — empty cells skipped, no double spaces
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

function ImportContactsModal({ onClose, onImported }) {
  const [step, setStep]           = useState('upload')
  const [dragging, setDragging]   = useState(false)
  const [parseError, setParseError] = useState('')
  const [headers, setHeaders]     = useState([])
  const [rows, setRows]           = useState([])
  const [assignment, setAssignment] = useState(freshAssignment)
  const [openPicker, setOpenPicker] = useState(null)   // funnlField value | null
  const [pickerPos, setPickerPos]   = useState({ top: 0, left: 0 })
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [result, setResult]       = useState(null)
  const fileInputRef = useRef()

  // --- Derived ---
  const assignedSet  = new Set(Object.values(assignment).flat())
  const ignoredCols  = headers.filter(h => !assignedSet.has(h))
  const hasNameMapped = assignment.name.length > 0

  // Preview: Name always first, then other assigned fields, max 5 cols total
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
  function handleFile(file) {
    if (!file) return
    setParseError('')
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError("Please select a .csv file. Other formats (like .xlsx) aren't supported yet.")
      return
    }
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim(),
      complete: (results) => {
        if (!results.meta.fields?.length) {
          setParseError('This file has no columns — it may be empty or not a valid CSV.')
          return
        }
        if (results.data.length === 0) {
          setParseError('This CSV has headers but no data rows.')
          return
        }
        setHeaders(results.meta.fields)
        setRows(results.data)
        setAssignment(buildInitialAssignment(results.meta.fields))
        setStep('map')
      },
      error: () => {
        setParseError("Couldn't read this file. Make sure it's a valid .csv and try again.")
      },
    })
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
    setOpenPicker(null)
    setParseError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // --- Assignment ---
  function addColumn(field, col) {
    setAssignment(prev => ({ ...prev, [field]: [...prev[field], col] }))
    setOpenPicker(null)
  }

  function removeColumn(field, col) {
    setAssignment(prev => ({ ...prev, [field]: prev[field].filter(c => c !== col) }))
  }

  function openPickerFor(field, e) {
    e.stopPropagation()
    if (openPicker === field) { setOpenPicker(null); return }
    const rect = e.currentTarget.getBoundingClientRect()
    setPickerPos({ top: rect.bottom + 6, left: rect.left })
    setOpenPicker(field)
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
    // On failure: zero contacts saved, error shown below.
    const { error } = await supabase.from('contacts').insert(contacts)
    setImporting(false)
    if (error) {
      setImportError(`Import failed: ${error.message}. No contacts were saved — please try again.`)
      return
    }
    setResult({ imported: toImport.length, skipped })
    setStep('done')
    onImported()
  }

  // --- Render ---
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>

      {/* Modal backdrop */}
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

        {/* Scrollable body — closes picker on scroll so it never drifts from its button */}
        <div
          className="overflow-y-auto flex-1 px-6 py-5"
          onScroll={() => openPicker && setOpenPicker(null)}
        >

          {/* ── STEP 1: Upload ── */}
          {step === 'upload' && (
            <div>
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
            </div>
          )}

          {/* ── STEP 2: Map columns ── */}
          {step === 'map' && (
            <div>

              {/* Name required warning */}
              {!hasNameMapped && (
                <div className="flex items-center gap-2.5 mb-5 px-3 py-2.5 bg-[rgba(255,184,77,0.08)] border border-[rgba(255,184,77,0.25)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="2" strokeLinecap="round" className="flex-none">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <p className="text-[12.5px] text-warning">
                    Assign at least one column to <strong>Name</strong> to continue — it's required.
                  </p>
                </div>
              )}

              {/* Field assignment table */}
              <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-3">
                For each Funnl field, choose which CSV column(s) feed it
              </p>
              <p className="text-[12px] text-lower mb-4">
                Multiple columns can feed one field — their values join in chip order.
                Tags and Skills: comma-separated values in each cell are split into separate entries.
              </p>

              <div className="divide-y divide-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.07)] rounded-xl overflow-hidden mb-5">
                {FUNNL_FIELDS.map(field => (
                  <div key={field.value} className="flex items-start gap-3 px-4 py-3 bg-card">
                    {/* Field label */}
                    <div className="w-[106px] flex-none pt-[7px]">
                      <span className="text-[13px] font-semibold text-hi">{field.label}</span>
                      {field.required && <span className="text-danger text-[12px] ml-0.5">*</span>}
                    </div>

                    {/* Assigned column chips + Add button */}
                    <div className="flex-1 flex flex-wrap items-center gap-1.5 pt-1.5 min-h-[32px]">
                      {assignment[field.value].map(col => (
                        <span
                          key={col}
                          className="inline-flex items-center gap-1 bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.22)] text-tag text-[12px] font-mono px-2 py-[5px] rounded-lg leading-none"
                        >
                          {col}
                          <button
                            onClick={() => removeColumn(field.value, col)}
                            className="text-[rgba(180,168,255,0.45)] hover:text-danger transition-colors ml-0.5 leading-none text-[14px]"
                            title="Remove"
                          >
                            ×
                          </button>
                        </span>
                      ))}

                      {ignoredCols.length > 0 && (
                        <button
                          onClick={e => openPickerFor(field.value, e)}
                          className="inline-flex items-center gap-1 text-[12px] font-semibold text-low hover:text-accent px-2 py-[5px] rounded-lg hover:bg-[rgba(139,124,255,0.08)] transition-colors leading-none"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <path d="M12 5v14M5 12h14"/>
                          </svg>
                          Add
                        </button>
                      )}

                      {assignment[field.value].length === 0 && ignoredCols.length === 0 && (
                        <span className="text-[12px] text-lower pt-1">—</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Ignored / unused columns */}
              {ignoredCols.length > 0 && (
                <div className="mb-6">
                  <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-2">
                    Not used — click "+ Add" on a field above to use these
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ignoredCols.map(col => (
                      <span
                        key={col}
                        className="text-[12px] text-low bg-elevated border border-[rgba(255,255,255,0.07)] px-2 py-[5px] rounded-lg font-mono"
                      >
                        {col}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Live preview */}
              <div className="border-t border-[rgba(255,255,255,0.06)] pt-5">
                <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-1">
                  Live preview
                </p>
                <p className="text-[12px] text-lower mb-3">
                  Showing first {Math.min(rows.length, 5)} of {rows.length} rows · updates as you change the mapping above
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
                            const val = (f === 'tags' || f === 'skills')
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
                onClick={() => { setImportError(''); setOpenPicker(null); setStep('confirm') }}
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

      {/* Column picker — fixed to viewport so scrollable modal body can't clip it */}
      {openPicker && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpenPicker(null)}/>
          <div
            className="fixed z-[70] bg-elevated border border-[rgba(255,255,255,0.13)] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] py-1 min-w-[180px] max-h-[220px] overflow-y-auto"
            style={{ top: pickerPos.top, left: pickerPos.left }}
          >
            {ignoredCols.map(col => (
              <button
                key={col}
                onClick={() => addColumn(openPicker, col)}
                className="w-full text-left px-3 py-[9px] text-[13px] text-mid hover:text-hi hover:bg-[rgba(255,255,255,0.05)] transition-colors font-mono"
              >
                {col}
              </button>
            ))}
          </div>
        </>
      )}

    </div>
  )
}

export default ImportContactsModal
