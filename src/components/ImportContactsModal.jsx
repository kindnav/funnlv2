import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import { canUseAI } from '../lib/ai'
import { detectHeaderRow, isLinkedInExport } from '../lib/csvHeaderDetect.js'
import { normalizeContactTag, mergeContactTags, splitContactBatches, splitTagsFromCsv } from '../lib/contactCategorization.js'

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

function normalizeHeader(h) {
  return h
    .toLowerCase()
    .replace(/[\s_\-./\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const HEADER_MAP = {
  // ── Name ─────────────────────────────────────────────────────────────────────
  'name': 'name',
  'full name': 'name',
  'fullname': 'name',
  'contact name': 'name',
  'contactname': 'name',
  'person': 'name',
  'person name': 'name',
  'attendee': 'name',
  'attendee name': 'name',
  'contact person': 'name',
  'display name': 'name',
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
  'current employer': 'company',
  'firm': 'company',

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
  'title': 'role',

  // ── Email ─────────────────────────────────────────────────────────────────────
  'email': 'email',
  'email address': 'email',
  'emailaddress': 'email',
  'e mail': 'email',
  'work email': 'email',
  'personal email': 'email',
  'professional email': 'email',
  'contact email': 'email',
  'email id': 'email',

  // ── LinkedIn URL ──────────────────────────────────────────────────────────────
  // NOTE: 'profile link' is intentionally omitted here — it's too generic and is
  // only assigned via value-sniffing in handleFile (when sample values contain linkedin.com)
  'linkedin': 'linkedin_url',
  'linkedin url': 'linkedin_url',
  'linkedin profile': 'linkedin_url',
  'linkedin profile url': 'linkedin_url',
  'linkedin page': 'linkedin_url',
  'linkedin link': 'linkedin_url',
  'li url': 'linkedin_url',
  'li profile': 'linkedin_url',

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

  // ── Tags ──────────────────────────────────────────────────────────────────────
  'tags': 'tags',
  'tag': 'tags',
  'labels': 'tags',
  'categories': 'tags',
  'groups': 'tags',

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

function transformRow(rawRow, assignment) {
  const contact = {}
  for (const [field, cols] of Object.entries(assignment)) {
    if (!cols || cols.length === 0) continue
    if (field === 'tags') {
      // Split on commas, semicolons, pipes, and line breaks; then normalize each tag
      const values = cols.flatMap(col =>
        splitTagsFromCsv(rawRow[col] || '').map(normalizeContactTag).filter(Boolean)
      )
      if (values.length > 0) contact[field] = values
    } else if (field === 'linkedin_url') {
      const raw = cols.map(col => (rawRow[col] || '').trim()).filter(Boolean)[0]
      if (raw) contact.linkedin_url = normalizeUrl(raw)
    } else if (field === 'relationship_note') {
      const combined = cols.map(col => (rawRow[col] || '').trim()).filter(Boolean).join(' | ')
      if (combined) contact[field] = combined
    } else {
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

const STEP_LABEL = { upload: 'Step 1 of 2', map: 'Step 2 of 2', done: 'Done' }

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
  const navigate = useNavigate()
  const [step, setStep]             = useState('upload')
  const [dragging, setDragging]     = useState(false)
  const [parseError, setParseError] = useState('')
  const [headers, setHeaders]       = useState([])
  const [rows, setRows]             = useState([])
  const [assignment, setAssignment] = useState(freshAssignment)
  const [picker, setPicker]         = useState(null)
  const [importing, setImporting]   = useState(false)
  const [importError, setImportError] = useState('')
  const [result, setResult]         = useState(null)
  const fileInputRef = useRef()

  // Pro-gate
  const [isProUser, setIsProUser]   = useState(false)
  const [aiLoading, setAiLoading]   = useState(false)
  const [aiMapped, setAiMapped]     = useState({ applied: false, count: 0, notes: '' })
  const [csvDetection, setCsvDetection] = useState(null)
  // Tracks how many columns were auto-assigned by HEADER_MAP (for analytics mapping_mode)
  const [autoMappedCount, setAutoMappedCount] = useState(0)

  // AI enrichment during import (Pro only)
  const [aiEnrichEnabled, setAiEnrichEnabled] = useState(true)
  // Progress state while importing with AI: null when idle, { categorized, total } while running
  const [importProgress, setImportProgress] = useState(null)
  // Warning shown in done step if some AI categorization batches failed
  const [categorizationWarning, setCategorizationWarning] = useState('')

  // Post-import chooser
  const [showChooser, setShowChooser]   = useState(false)
  const [chooserSearch, setChooserSearch] = useState('')
  const [importedContacts, setImportedContacts] = useState([]) // [{id, name}]

  // Stale-request prevention refs
  const inferenceRunIdRef = useRef(0)   // incremented before each new run; old runs check this
  const isMountedRef = useRef(true)     // set false on unmount; guards all post-await state updates
  const hasFiredMappingAnalyticsRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) canUseAI(data.user.id).then(setIsProUser)
    })
  }, [])

  // Derived
  const assignedSet   = new Set(Object.values(assignment).flat())
  const ignoredCols   = headers.filter(h => !assignedSet.has(h))
  const hasNameMapped = assignment.name.length > 0

  const previewFields = [
    'name',
    ...FUNNL_FIELDS
      .filter(f => f.value !== 'name' && assignment[f.value]?.length > 0)
      .map(f => f.value),
  ].slice(0, 5)
  const previewContacts = rows.slice(0, 5).map(row => transformRow(row, assignment))

  // Count importable rows reactively for the Step 2 Import button label
  const importableCount = useMemo(() => {
    if (!rows.length || !assignment.name.length) return 0
    return rows.filter(row => {
      const nameParts = assignment.name.map(col => (row[col] || '').trim()).filter(Boolean)
      return nameParts.join(' ').trim().length > 0
    }).length
  }, [rows, assignment])

  // Stable mapping signature: used to detect changes between Import calls (analytics dedup)
  function computeMappingSignature() {
    return JSON.stringify(
      Object.fromEntries(Object.entries(assignment).map(([k, v]) => [k, [...v]]))
    )
  }

  // ── File handling ──────────────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return
    setParseError('')
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError("Please select a .csv file. Other formats (like .xlsx) aren't supported yet.")
      return
    }

    let rawText
    try {
      rawText = await file.text()
    } catch {
      setParseError("Couldn't read this file. Make sure it's a valid .csv and try again.")
      return
    }
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1) // strip BOM

    const rawResult = Papa.parse(rawText, { header: false, skipEmptyLines: 'greedy' })
    const allRows = rawResult.data
    const headerIdx = detectHeaderRow(allRows)

    if (headerIdx === -1) {
      track('csv_mapping_failed', { reason: 'no_header' })
      setParseError("Couldn't find a contact header row. Make sure your CSV includes columns like Name, Company, or Email.")
      return
    }

    const rawHeaderRow = allRows[headerIdx]
    const indexedHeaders = rawHeaderRow
      .map((h, i) => ({ name: (h || '').trim(), i }))
      .filter(({ name }) => name.length > 0 && name !== '__parsed_extra')
    const hdrs = indexedHeaders.map(({ name }) => name)

    const dataRows = allRows.slice(headerIdx + 1).map(cells =>
      Object.fromEntries(indexedHeaders.map(({ name, i }) => [name, cells[i] ?? '']))
    )

    if (dataRows.length === 0) {
      track('csv_mapping_failed', { reason: 'no_data_rows' })
      setParseError('This CSV has headers but no data rows.')
      return
    }

    setCsvDetection(
      isLinkedInExport(rawHeaderRow) ? 'linkedin' : headerIdx > 0 ? 'preamble' : null
    )

    const initialAssignment = buildInitialAssignment(hdrs)
    const detectedAutoMapped = Object.values(initialAssignment).flat().length
    setAutoMappedCount(detectedAutoMapped)

    // Value-sniff: 'url', 'link', 'profile url', 'profile link' are too generic for
    // HEADER_MAP but if sample values contain 'linkedin.com' we can safely map them.
    if (initialAssignment.linkedin_url.length === 0) {
      const urlLikeCols = hdrs.filter(h => {
        const n = h.toLowerCase().trim()
        return n === 'url' || n === 'link' || n === 'profile url' || n === 'profile link'
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
    setImportError('')

    // File change → invalidate stale inference runs and analytics dedup
    inferenceRunIdRef.current++
    hasFiredMappingAnalyticsRef.current = null

    if (isProUser) {
      const assignedCols = new Set(Object.values(initialAssignment).flat())
      const unresolvedHdrs = hdrs.filter(h => !assignedCols.has(h))

      setAiLoading(true)
      ;(async () => {
        try {
          const { data: resp, error } = await supabase.functions.invoke('ai-map-csv', {
            body: {
              headers: unresolvedHdrs,
              sample_rows: dataRows.slice(0, 3),
            },
          })
          if (error || !resp?.assignment) throw new Error('no assignment')

          const headerSet = new Set(hdrs)
          const merged = { ...initialAssignment }
          const alreadyAssigned = new Set(Object.values(merged).flat())
          for (const [field, cols] of Object.entries(resp.assignment)) {
            if (!(field in merged)) continue
            const valid = (cols ?? []).filter(
              c => typeof c === 'string' && headerSet.has(c) && !alreadyAssigned.has(c)
            )
            if (valid.length > 0) {
              merged[field] = [...merged[field], ...valid]
              valid.forEach(c => alreadyAssigned.add(c))
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
    inferenceRunIdRef.current++
    hasFiredMappingAnalyticsRef.current = null
    setStep('upload')
    setHeaders([])
    setRows([])
    setAssignment(freshAssignment())
    setPicker(null)
    setParseError('')
    setImportError('')
    setAiLoading(false)
    setAiMapped({ applied: false, count: 0, notes: '' })
    setCsvDetection(null)
    setImportProgress(null)
    setCategorizationWarning('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Sends one batch of ≤20 contacts to ai-categorize-contacts.
  // Minimized categorization context: company, role, how met, existing tags, and existing
  // relationship type. Names, email addresses, LinkedIn URLs, and freeform relationship
  // notes are excluded.
  async function invokeSingleBatch(batch) {
    const payload = batch.map(c => ({
      row_id: c._rowId,
      company: c.company || null,
      role: c.role || null,
      how_met: c.how_met || null,
      existing_tags: c.tags || [],
      existing_relationship_type: c.relationship_type || null,
    }))
    const { data: resp, error } = await supabase.functions.invoke('ai-categorize-contacts', {
      body: { contacts: payload },
    })
    if (error || !Array.isArray(resp?.suggestions)) throw new Error('batch failed')
    return resp.suggestions
  }

  // Runs AI categorization for all contacts and returns { suggestionsMap, failedCount }.
  // Returns null if the run was cancelled (stale inference ID or component unmounted).
  // Calls onProgress(processed, total) after each batch group settles.
  async function runCategorizationForImport(contacts, runId, onProgress) {
    const BATCH_SIZE = 20
    const MAX_CONCURRENT = 2
    const batches = splitContactBatches(contacts, BATCH_SIZE)
    const suggestionsMap = {}
    let failedCount = 0
    let processed = 0

    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const group = batches.slice(i, i + MAX_CONCURRENT)
      const results = await Promise.allSettled(group.map(b => invokeSingleBatch(b)))

      if (runId !== inferenceRunIdRef.current || !isMountedRef.current) return null

      for (let j = 0; j < results.length; j++) {
        const batchSize = group[j].length
        if (results[j].status === 'fulfilled') {
          for (const s of results[j].value) {
            if (s.row_id) suggestionsMap[s.row_id] = s
          }
        } else {
          failedCount += batchSize
        }
        processed += batchSize
        onProgress(processed, contacts.length)
      }
    }

    return { suggestionsMap, failedCount }
  }

  // Assignment UI helpers
  function addColumn(field, col) {
    setAssignment(prev => ({ ...prev, [field]: [...prev[field], col] }))
    setPicker(null)
  }

  function removeColumn(field, col) {
    setAssignment(prev => ({ ...prev, [field]: prev[field].filter(c => c !== col) }))
  }

  function openFieldPicker(field, e) {
    e.stopPropagation()
    if (picker?.mode === 'field' && picker.key === field) { setPicker(null); return }
    setPicker({ mode: 'field', key: field, pos: calcPickerPos(e) })
  }

  function openColPicker(col, e) {
    e.stopPropagation()
    if (picker?.mode === 'col' && picker.key === col) { setPicker(null); return }
    setPicker({ mode: 'col', key: col, pos: calcPickerPos(e, 320) })
  }

  // Import: runs AI categorization (if Pro + enabled), then bulk-inserts contacts.
  // High-confidence AI suggestions are auto-applied; medium/low are ignored.
  // Import continues even if AI categorization fails — contacts land with CSV data.
  async function handleImport() {
    inferenceRunIdRef.current++
    const runId = inferenceRunIdRef.current

    setImporting(true)
    setImportError('')
    setImportProgress(null)
    setCategorizationWarning('')

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

    const withIds = toImport.map(c => ({ ...c, _rowId: crypto.randomUUID() }))

    // Fire mapping analytics once per unique mapping state
    const sig = computeMappingSignature()
    if (sig !== hasFiredMappingAnalyticsRef.current) {
      const mapping_mode = aiMapped.applied ? 'ai_assisted'
        : autoMappedCount > 0 ? 'deterministic'
        : 'manual'
      track('csv_mapping_completed', {
        mapping_mode,
        detected_format: csvDetection === 'linkedin' ? 'linkedin' : 'generic',
        contact_count: withIds.length,
        inferred_tags_enabled: isProUser && aiEnrichEnabled,
        inferred_relationships_enabled: isProUser && aiEnrichEnabled,
      })
      hasFiredMappingAnalyticsRef.current = sig
    }

    let finalContacts
    let catWarning = ''

    if (isProUser && aiEnrichEnabled && withIds.length > 0) {
      setImportProgress({ categorized: 0, total: withIds.length })

      const catResult = await runCategorizationForImport(
        withIds,
        runId,
        (categorized, total) => {
          if (runId === inferenceRunIdRef.current && isMountedRef.current) {
            setImportProgress({ categorized, total })
          }
        }
      )

      if (!isMountedRef.current) return
      if (catResult === null) {
        // Stale run — another import was started; abort silently
        setImporting(false)
        return
      }

      const { suggestionsMap, failedCount } = catResult

      // Auto-apply only high-confidence suggestions.
      // CSV relationship_type is never overwritten by AI.
      finalContacts = withIds.map(({ _rowId, ...c }) => {
        const contact = { ...c, user_id: user.id }
        const sug = suggestionsMap[_rowId]

        if (sug && sug.confidence === 'high') {
          const aiTags = Array.isArray(sug.suggested_tags) ? sug.suggested_tags : []
          const merged = mergeContactTags(contact.tags || [], [], aiTags, [])
          if (merged.length > 0) contact.tags = merged
          else delete contact.tags

          if (sug.suggested_relationship_type && !contact.relationship_type) {
            contact.relationship_type = sug.suggested_relationship_type
          }
        }

        return contact
      })

      if (failedCount > 0) {
        catWarning = `Your contacts were imported, but Funnl could not automatically categorize ${failedCount} of them.`
      }

      setImportProgress(null)
    } else {
      finalContacts = withIds.map(({ _rowId, ...c }) => ({ ...c, user_id: user.id }))
    }

    const { data: insertedRows, error } = await supabase
      .from('contacts')
      .insert(finalContacts)
      .select('id, name')

    setImporting(false)
    if (error) {
      setImportError(`Import failed: ${error.message}. No contacts were saved — please try again.`)
      return
    }

    track('csv_import_used', {
      contacts_imported: finalContacts.length,
      ai_assisted: aiMapped.applied || (isProUser && aiEnrichEnabled),
    })

    const imported = (insertedRows || []).map(r => ({ id: r.id, name: r.name || '' }))
    setImportedContacts(imported)
    setCategorizationWarning(catWarning)
    setResult({ imported: finalContacts.length, skipped })
    setStep('done')
    onImported()
  }

  // Chooser filtered contacts
  const filteredChooserContacts = useMemo(() => {
    const q = chooserSearch.trim().toLowerCase()
    if (!q) return importedContacts
    return importedContacts.filter(c => c.name.toLowerCase().includes(q))
  }, [importedContacts, chooserSearch])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>

      {/* Backdrop */}
      <div className="absolute inset-0 bg-[rgba(0,0,0,0.65)]" onClick={onClose}/>

      {/* Modal panel */}
      <div className="relative w-full max-w-[620px] max-h-[88vh] flex flex-col bg-card border border-line-3 rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.7)]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-line-2 flex-none">
          <div>
            <h2 className="font-display font-bold text-[18px] text-hi leading-tight">Import contacts</h2>
            <p className="text-[11.5px] text-lower font-mono mt-0.5">{STEP_LABEL[step]}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-low hover:text-hi hover:bg-elevated transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div
          className="overflow-y-auto flex-1 px-6 py-5"
          onScroll={() => picker && setPicker(null)}
        >

          {/* ── STEP 1: Upload ── */}
          {step === 'upload' && (
            <div>
              {aiLoading ? (
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
            importing ? (
              /* Import in progress — show progress view instead of mapping UI */
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                {importProgress !== null ? (
                  <>
                    <p className="text-[14px] font-semibold text-hi">Organizing your contacts with Funnl AI…</p>
                    <p className="text-[13px] text-mid">
                      Categorized {importProgress.categorized} of {importProgress.total} contacts
                    </p>
                  </>
                ) : (
                  <p className="text-[14px] font-semibold text-mid">Importing your contacts…</p>
                )}
              </div>
            ) : (
              <div>
                {csvDetection && (
                  <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.40)] rounded-xl">
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
                {aiMapped.applied && (
                  <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.40)] rounded-xl">
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
                {!isProUser && (
                  <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.40)] rounded-xl">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <p className="text-[12.5px] text-accent font-semibold">
                      Pro tip: AI can auto-map your columns and suggest categories for each contact — available with Funnl Pro.
                    </p>
                  </div>
                )}
                {!hasNameMapped && (
                  <div className="flex items-center gap-2.5 mb-4 px-3 py-2.5 bg-[rgba(255,184,77,0.12)] border border-[rgba(255,184,77,0.40)] rounded-xl">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="2" strokeLinecap="round" className="flex-none">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <p className="text-[12.5px] text-warning">
                      Assign at least one column to <strong>Name</strong> to continue — it's required.
                    </p>
                  </div>
                )}

                {/* AI enrichment toggle — Pro users only */}
                {isProUser && (
                  <div className="flex items-start gap-3 mb-4 px-4 py-3.5 bg-elevated border border-line-2 rounded-xl">
                    <input
                      type="checkbox"
                      id="ai-enrich-toggle"
                      checked={aiEnrichEnabled}
                      onChange={e => setAiEnrichEnabled(e.target.checked)}
                      className="mt-[3px] w-4 h-4 accent-[#8B7CFF] cursor-pointer flex-none"
                    />
                    <div className="flex-1">
                      <label htmlFor="ai-enrich-toggle" className="text-[13px] font-semibold text-hi cursor-pointer leading-snug">
                        Automatically organize contacts with Funnl AI
                      </label>
                      <p className="text-[12px] text-muted mt-0.5 leading-relaxed">
                        Adds relevant tags and relationship categories based on the information in your file. You can edit them later.
                      </p>
                    </div>
                  </div>
                )}

                {/* Pool: unassigned columns */}
                <div className="mb-5">
                  {ignoredCols.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-3 bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.40)] rounded-xl">
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
                            type="button"
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

                {/* Field assignment table */}
                <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-1">Funnl fields</p>
                <p className="text-[12px] text-lower mb-3">
                  Click a column above to assign it, or use + Add on any field.
                  Multiple columns combine in chip order — chip order matters for First + Last name.
                </p>
                <div className="divide-y divide-[rgba(255,255,255,0.05)] border border-line-2 rounded-xl overflow-hidden mb-5">
                  {FUNNL_FIELDS.map(field => (
                    <div key={field.value} className="flex items-start gap-3 px-4 py-3 bg-card">
                      <div className="w-[106px] flex-none pt-[7px]">
                        <span className="text-[13px] font-semibold text-hi">{field.label}</span>
                        {field.required && <span className="text-danger text-[12px] ml-0.5">*</span>}
                      </div>
                      <div className="flex-1 flex flex-wrap items-center gap-1.5 pt-1.5 min-h-[32px]">
                        {assignment[field.value].map(col => (
                          <span
                            key={col}
                            className="inline-flex items-center gap-1 bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.22)] text-tag text-[12px] font-mono px-2 py-[5px] rounded-lg leading-none"
                          >
                            {col}
                            <button
                              type="button"
                              onClick={() => removeColumn(field.value, col)}
                              title="Remove"
                              className="text-[rgba(180,168,255,0.45)] hover:text-danger transition-colors ml-0.5 leading-none text-[14px]"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {assignment[field.value].length === 0 && (
                          <span className="text-[12px] text-lower italic pt-[5px]">— not assigned</span>
                        )}
                        {ignoredCols.length > 0 && (
                          <button
                            type="button"
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

                {/* Live preview */}
                <div className="border-t border-line-1 pt-5">
                  <p className="text-[11px] font-bold tracking-[1px] text-lower uppercase font-mono mb-1">Live preview</p>
                  <p className="text-[12px] text-lower mb-3">
                    First {Math.min(rows.length, 5)} of {rows.length} rows · updates instantly
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-line-2">
                    <table className="w-full text-[12px]" style={{ minWidth: previewFields.length * 130 }}>
                      <thead>
                        <tr className="border-b border-line-2 bg-[rgba(255,255,255,0.02)]">
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
                              const val = f === 'tags' ? (contact[f] || []).join(', ') : (contact[f] || '')
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

                {/* Import error (shown after a failed attempt while staying on step 2) */}
                {importError && (
                  <div className="mt-5 flex items-start gap-2.5 px-4 py-3 bg-[rgba(255,107,138,0.08)] border border-[rgba(255,107,138,0.2)] rounded-xl">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                      <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                    </svg>
                    <p className="text-[13px] text-danger">{importError}</p>
                  </div>
                )}
              </div>
            )
          )}

          {/* ── DONE ── */}
          {step === 'done' && result && (
            <div className="py-2">
              {/* Categorization warning if some AI batches failed */}
              {categorizationWarning && (
                <div className="flex items-start gap-2.5 mb-4 px-4 py-3 bg-[rgba(255,184,77,0.12)] border border-[rgba(255,184,77,0.40)] rounded-xl">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="2" strokeLinecap="round" className="flex-none mt-[2px]">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <p className="text-[12.5px] text-warning leading-relaxed">{categorizationWarning}</p>
                </div>
              )}

              {!showChooser ? (
                <>
                  {/* Success header */}
                  <div className="text-center mb-6">
                    <div className="w-[56px] h-[56px] mx-auto mb-5 rounded-[18px] bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.25)] flex items-center justify-center">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5"/>
                      </svg>
                    </div>
                    <p className="font-display font-bold text-[22px] text-hi mb-1">
                      Your contacts are ready
                    </p>
                    <p className="text-[13.5px] text-muted">
                      {result.imported} {result.imported === 1 ? 'contact' : 'contacts'} imported
                      {result.skipped > 0 ? ` · ${result.skipped} skipped (no name)` : ''}
                    </p>
                  </div>

                  {/* Post-import CTA */}
                  <div className="border border-line-2 rounded-xl p-4 bg-elevated">
                    <p className="text-[13.5px] font-semibold text-hi mb-1">Log a recent conversation</p>
                    <p className="text-[12.5px] text-muted mb-4 leading-relaxed">
                      Choose someone you recently contacted so you can save what happened and decide what to do next.
                    </p>
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          track('post_import_action_clicked', { action: 'log_recent_outreach' })
                          setShowChooser(true)
                          setChooserSearch('')
                        }}
                        className="flex items-center justify-between gap-2 w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-5 py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity"
                      >
                        <span>Log recent outreach</span>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M5 12h14M13 6l6 6-6 6"/>
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          track('post_import_action_clicked', { action: 'view_contacts' })
                          navigate('/contacts')
                          onClose()
                        }}
                        className="flex items-center justify-between gap-2 w-full bg-card border border-line-3 text-hi text-[14px] font-semibold px-5 py-[11px] rounded-[11px] hover:bg-elevated transition-colors"
                      >
                        <span>View all contacts</span>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M5 12h14M13 6l6 6-6 6"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                /* Contact chooser: user picks who to log outreach for */
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <button
                      type="button"
                      onClick={() => setShowChooser(false)}
                      className="text-[13px] font-semibold text-low hover:text-hi transition-colors"
                    >
                      ← Back
                    </button>
                    <p className="text-[14px] font-bold text-hi flex-1">Choose a contact</p>
                  </div>
                  <p className="text-[13px] text-muted mb-3 leading-relaxed">
                    Who did you recently reach out to? Pick one to open their profile and log the conversation.
                  </p>
                  {importedContacts.length > 6 && (
                    <input
                      type="text"
                      value={chooserSearch}
                      onChange={e => setChooserSearch(e.target.value)}
                      placeholder="Search by name…"
                      autoFocus
                      className="w-full mb-3 bg-input border border-line-3 rounded-xl px-[13px] py-[10px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors"
                    />
                  )}
                  <div className="border border-line-2 rounded-xl overflow-hidden max-h-[300px] overflow-y-auto">
                    {filteredChooserContacts.length === 0 ? (
                      <p className="px-4 py-3 text-[13px] text-lower text-center">No matches for "{chooserSearch}"</p>
                    ) : filteredChooserContacts.map((c, i) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          navigate(`/contacts/${c.id}`, { state: { openInteractionForm: true } })
                          onClose()
                        }}
                        className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-elevated transition-colors ${
                          i > 0 ? 'border-t border-[rgba(255,255,255,0.05)]' : ''
                        }`}
                      >
                        <span className="text-[13.5px] font-semibold text-hi truncate">{c.name}</span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="2" strokeLinecap="round" className="flex-none">
                          <path d="M5 12h14M13 6l6 6-6 6"/>
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line-2 flex-none flex items-center justify-between gap-3">
          {step === 'upload' && (
            <>
              <div/>
              <button type="button" onClick={onClose} className="text-[14px] font-semibold text-low hover:text-hi transition-colors">
                Cancel
              </button>
            </>
          )}
          {step === 'map' && (
            <>
              <button
                type="button"
                onClick={goBackToUpload}
                disabled={importing}
                className="text-[14px] font-semibold text-low hover:text-hi transition-colors disabled:opacity-40"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={!hasNameMapped || importing}
                className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-6 py-[10px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {importing ? (
                  <>
                    <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    Importing…
                  </>
                ) : (
                  `Import ${importableCount} ${importableCount === 1 ? 'contact' : 'contacts'}`
                )}
              </button>
            </>
          )}
          {step === 'done' && (
            <div className="w-full flex justify-center">
              <button
                type="button"
                onClick={() => {
                  if (!showChooser) track('post_import_action_clicked', { action: 'dismiss' })
                  onClose()
                }}
                className="text-[14px] font-semibold text-low hover:text-hi transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Unified picker — fixed to viewport so scrollable body can't clip it */}
      {picker && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setPicker(null)}/>
          <div
            className="fixed z-[70] bg-elevated border border-[rgba(255,255,255,0.13)] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] py-1 min-w-[180px] max-h-[260px] overflow-y-auto"
            style={{ top: picker.pos.top, left: picker.pos.left }}
          >
            {picker.mode === 'field' ? (
              ignoredCols.length === 0 ? (
                <p className="px-3 py-2 text-[13px] text-lower">No columns available</p>
              ) : (
                ignoredCols.map(col => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => addColumn(picker.key, col)}
                    className="w-full text-left px-3 py-[9px] text-[13px] text-mid hover:text-hi hover:bg-[rgba(255,255,255,0.05)] transition-colors font-mono"
                  >
                    {col}
                  </button>
                ))
              )
            ) : (
              FUNNL_FIELDS.map(field => (
                <button
                  key={field.value}
                  type="button"
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
