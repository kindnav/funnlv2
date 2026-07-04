import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'

const FUNNL_FIELDS = [
  { value: 'name',         label: 'Name (required)' },
  { value: 'company',      label: 'Company' },
  { value: 'role',         label: 'Role' },
  { value: 'email',        label: 'Email' },
  { value: 'linkedin_url', label: 'LinkedIn URL' },
  { value: 'how_met',      label: 'How met' },
  { value: 'tags',         label: 'Tags (comma-separated)' },
  { value: 'skills',       label: 'Skills (comma-separated)' },
  { value: 'ignore',       label: '— Ignore this column —' },
]

// Auto-detect: lowercased CSV header → Funnl field
const HEADER_MAP = {
  // Name
  'name': 'name', 'full name': 'name', 'full_name': 'name',
  'contact name': 'name', 'contact_name': 'name', 'contact': 'name', 'person': 'name',
  // Company
  'company': 'company', 'company name': 'company', 'company_name': 'company',
  'organization': 'company', 'organisation': 'company', 'firm': 'company',
  'employer': 'company', 'org': 'company',
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

function buildInitialMapping(headers) {
  const used = new Set()
  const mapping = {}
  for (const header of headers) {
    const key = header.toLowerCase().trim()
    const field = HEADER_MAP[key]
    if (field && !used.has(field)) {
      mapping[header] = field
      used.add(field)
    } else {
      mapping[header] = 'ignore'
    }
  }
  return mapping
}

function normalizeUrl(url) {
  const s = (url || '').trim()
  if (!s) return null
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return 'https://' + s
}

// AI SEAM: This is the right place to add AI pre-processing later.
// A future AI step would transform rawRow before this function runs — e.g. splitting
// "John Smith, Goldman, analyst" from a single jammed column into separate fields,
// or inferring tags/skills from freeform notes.
// This function itself stays unchanged; the AI step just pre-processes rawRow first.
function transformRow(rawRow, mapping) {
  const contact = {}
  for (const [csvCol, funnlField] of Object.entries(mapping)) {
    if (funnlField === 'ignore') continue
    const raw = (rawRow[csvCol] || '').trim()
    if (!raw) continue
    if (funnlField === 'tags' || funnlField === 'skills') {
      contact[funnlField] = raw.split(',').map(s => s.trim()).filter(Boolean)
    } else if (funnlField === 'linkedin_url') {
      contact.linkedin_url = normalizeUrl(raw)
    } else {
      contact[funnlField] = raw
    }
  }
  return contact
}

function processRows(rows, mapping) {
  const toImport = []
  let skipped = 0
  for (const row of rows) {
    const contact = transformRow(row, mapping)
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
  const [step, setStep] = useState('upload')
  const [dragging, setDragging] = useState(false)
  const [parseError, setParseError] = useState('')
  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [result, setResult] = useState(null)
  const fileInputRef = useRef()

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
        if (!results.meta.fields || results.meta.fields.length === 0) {
          setParseError('This file has no columns — it may be empty or not a valid CSV.')
          return
        }
        if (results.data.length === 0) {
          setParseError('This CSV has column headers but no data rows.')
          return
        }
        setHeaders(results.meta.fields)
        setRows(results.data)
        setMapping(buildInitialMapping(results.meta.fields))
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
    setMapping({})
    setParseError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const hasNameMapped = Object.values(mapping).includes('name')

  // Compute preview counts for confirm step UI
  const { toImport: previewContacts, skipped: previewSkipped } =
    step === 'confirm' ? processRows(rows, mapping) : { toImport: [], skipped: 0 }

  async function handleImport() {
    setImporting(true)
    setImportError('')

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setImportError('Not signed in. Please refresh the page and try again.')
      setImporting(false)
      return
    }

    // Re-compute from current state so values are always fresh
    const { toImport, skipped } = processRows(rows, mapping)

    if (toImport.length === 0) {
      setImportError('No importable rows — every row is missing a name value.')
      setImporting(false)
      return
    }

    const contacts = toImport.map(c => ({ ...c, user_id: user.id }))

    // Single bulk insert — all-or-nothing at the database level.
    // If this fails, zero contacts are saved and the error is shown below.
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>

      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[rgba(0,0,0,0.65)]"
        onClick={onClose}
      />

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

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">

          {/* ── STEP 1: Upload ── */}
          {step === 'upload' && (
            <div>
              <p className="text-[14px] text-muted mb-5 leading-relaxed">
                Upload a CSV file exported from a spreadsheet. Each row becomes one contact.
              </p>

              {/* Drop zone */}
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

              {/* Parse error */}
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
              {/* Preview table */}
              <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-3">
                Preview — first {Math.min(rows.length, 3)} of {rows.length} rows
              </p>
              <div className="overflow-x-auto rounded-xl border border-[rgba(255,255,255,0.07)] mb-6">
                <table style={{ minWidth: headers.length * 110 }} className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)]">
                      {headers.map(h => (
                        <th key={h} className="px-3 py-2 text-left text-lower font-mono font-bold whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 3).map((row, i) => (
                      <tr key={i} className="border-b border-[rgba(255,255,255,0.04)] last:border-0">
                        {headers.map(h => (
                          <td key={h} className="px-3 py-2 text-muted whitespace-nowrap" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row[h] || ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Name required warning */}
              {!hasNameMapped && (
                <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(255,184,77,0.08)] border border-[rgba(255,184,77,0.25)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="2" strokeLinecap="round" className="flex-none">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <p className="text-[12.5px] text-warning">Map one column to <strong>Name</strong> to continue — it's required.</p>
                </div>
              )}

              {/* Column mapping rows */}
              <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-3">Map columns to Funnl fields</p>
              <div className="space-y-2.5">
                {headers.map(header => (
                  <div key={header} className="flex items-center gap-3">
                    <span
                      className="text-[13px] text-hi font-medium flex-none w-[150px] truncate"
                      title={header}
                    >
                      {header}
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#54545E" strokeWidth="2" strokeLinecap="round" className="flex-none">
                      <path d="M5 12h14M13 6l6 6-6 6"/>
                    </svg>
                    <div className="relative flex-1">
                      <select
                        value={mapping[header]}
                        onChange={e => setMapping(m => ({ ...m, [header]: e.target.value }))}
                        className="w-full appearance-none bg-input border border-[rgba(255,255,255,0.09)] rounded-lg pl-3 pr-8 py-[9px] text-[13px] text-hi outline-none focus:border-[rgba(139,124,255,0.5)] cursor-pointer transition-colors"
                      >
                        {FUNNL_FIELDS.map(f => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                      <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 9l6 6 6-6"/>
                      </svg>
                    </div>
                  </div>
                ))}
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
                      About to import {previewContacts.length} {previewContacts.length === 1 ? 'contact' : 'contacts'}
                    </p>
                    {previewSkipped > 0 && (
                      <p className="text-[12.5px] text-warning mt-0.5">
                        {previewSkipped} {previewSkipped === 1 ? 'row' : 'rows'} will be skipped — no name value
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <p className="text-[13px] text-low leading-relaxed mb-5">
                This import is all-or-nothing — if anything fails, zero contacts will be saved and you'll see a clear error message below.
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

        {/* Footer — navigation buttons */}
        <div className="px-6 py-4 border-t border-[rgba(255,255,255,0.07)] flex-none flex items-center justify-between gap-3">

          {step === 'upload' && (
            <>
              <div/>
              <button
                onClick={onClose}
                className="text-[14px] font-semibold text-low hover:text-hi transition-colors"
              >
                Cancel
              </button>
            </>
          )}

          {step === 'map' && (
            <>
              <button
                onClick={goBackToUpload}
                className="text-[14px] font-semibold text-low hover:text-hi transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => { setImportError(''); setStep('confirm') }}
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
                disabled={importing || previewContacts.length === 0}
                className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-6 py-[10px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {importing && (
                  <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                )}
                {importing
                  ? 'Importing…'
                  : `Import ${previewContacts.length} ${previewContacts.length === 1 ? 'contact' : 'contacts'}`
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
    </div>
  )
}

export default ImportContactsModal
