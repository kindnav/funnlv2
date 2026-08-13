import { useState, useRef, useEffect, useMemo, useCallback, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import { detectHeaderRow, isLinkedInExport } from '../lib/csvHeaderDetect.js'
import { normalizeContactTag, splitContactBatches, splitTagsFromCsv } from '../lib/contactCategorization.js'
import {
  detectDuplicatesInBatch,
  detectDatabaseDuplicates,
  buildReviewRows,
  computeTagSummary,
  buildImportPayload,
  computeDoneStats,
  buildDoneStatsLine,
} from '../lib/importReviewUtils.js'
import {
  SUGGESTION_STATES,
  RELATIONSHIP_TYPE_VALUES,
  initSuggestionReview,
  getFinalTags,
  getFinalRelType,
  acceptTagSuggestion,
  rejectTagSuggestion,
  editTagSuggestion,
  acceptRelTypeSuggestion,
  rejectRelTypeSuggestion,
  changeRelTypeSuggestion,
} from '../lib/importSuggestionReview.js'
import { executeBatchImport, retryBatchImport } from '../lib/importBatchExecutor.js'
import { useProStatus } from '../lib/useProStatus.js'
import { hasProAccess } from '../lib/pro-ui-status.js'

// Modal palette — uses CSS custom properties so the modal adapts to the active theme.
const C = {
  bg:          'var(--color-base)',
  bgCard:      'var(--color-elevated)',
  bgInput:     'var(--color-input)',
  bgBorderBox: 'var(--color-elevated)',
  ink:         'var(--color-hi)',
  inkMid:      'var(--color-mid)',
  inkLow:      'var(--color-low)',
  inkLower:    'var(--color-lower)',
  border:      'var(--color-line-2)',
  borderSub:   'var(--color-line-1)',
  borderStr:   'var(--color-line-3)',
  ember:       'var(--color-ember)',
  emberFaint:  'rgba(255,68,35,0.08)',
  emberBorder: 'rgba(255,68,35,0.22)',
  danger:      'var(--color-danger)',
  dangerFaint: 'rgba(194,51,77,0.07)',
  dangerBorder:'rgba(194,51,77,0.30)',
  warn:        'var(--color-warning)',
  warnFaint:   'rgba(165,106,0,0.08)',
  warnBorder:  'rgba(165,106,0,0.28)',
  success:     'var(--color-success)',
  successFaint:'rgba(46,125,91,0.08)',
  successBorder:'rgba(46,125,91,0.30)',
}

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
  return h.toLowerCase().replace(/[\s_\-./\\]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const HEADER_MAP = {
  'name': 'name', 'full name': 'name', 'fullname': 'name', 'contact name': 'name',
  'contactname': 'name', 'person': 'name', 'person name': 'name',
  'attendee': 'name', 'attendee name': 'name', 'contact person': 'name',
  'display name': 'name', 'first name': 'name', 'firstname': 'name',
  'fname': 'name', 'given name': 'name', 'last name': 'name',
  'lastname': 'name', 'lname': 'name', 'surname': 'name', 'family name': 'name',
  'company': 'company', 'company name': 'company', 'companyname': 'company',
  'organization': 'company', 'organisation': 'company', 'employer': 'company',
  'employer name': 'company', 'workplace': 'company', 'current company': 'company',
  'current employer': 'company', 'firm': 'company',
  'role': 'role', 'job title': 'role', 'jobtitle': 'role', 'position': 'role',
  'job position': 'role', 'job role': 'role', 'current role': 'role',
  'current title': 'role', 'current position': 'role', 'occupation': 'role',
  'designation': 'role', 'title': 'role',
  'email': 'email', 'email address': 'email', 'emailaddress': 'email',
  'e mail': 'email', 'work email': 'email', 'personal email': 'email',
  'professional email': 'email', 'contact email': 'email', 'email id': 'email',
  'linkedin': 'linkedin_url', 'linkedin url': 'linkedin_url',
  'linkedin profile': 'linkedin_url', 'linkedin profile url': 'linkedin_url',
  'linkedin page': 'linkedin_url', 'linkedin link': 'linkedin_url',
  'li url': 'linkedin_url', 'li profile': 'linkedin_url',
  'how met': 'how_met', 'howmet': 'how_met', 'how we met': 'how_met',
  'where met': 'how_met', 'where we met': 'how_met', 'meeting context': 'how_met',
  'met through': 'how_met', 'met at': 'how_met', 'met via': 'how_met',
  'introduction': 'how_met',
  'tags': 'tags', 'tag': 'tags', 'labels': 'tags', 'categories': 'tags', 'groups': 'tags',
  'relationship type': 'relationship_type', 'contact type': 'relationship_type',
  'connection type': 'relationship_type', 'relationship': 'relationship_type',
  'relationship note': 'relationship_note', 'why this person matters': 'relationship_note',
  'why they matter': 'relationship_note', 'notes on relationship': 'relationship_note',
  'context': 'relationship_note', 'notes': 'relationship_note', 'note': 'relationship_note',
  'comments': 'relationship_note', 'comment': 'relationship_note',
  'memo': 'relationship_note', 'additional notes': 'relationship_note',
  'general notes': 'relationship_note',
}

function freshAssignment() {
  return {
    name: [], company: [], role: [], email: [], linkedin_url: [],
    how_met: [], tags: [], relationship_type: [], relationship_note: [],
  }
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

function calcPickerPos(e, estimatedHeight = 240) {
  const rect = e.currentTarget.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const top = spaceBelow > estimatedHeight + 8
    ? rect.bottom + 6
    : rect.top - estimatedHeight - 6
  const left = Math.min(rect.left, window.innerWidth - 204)
  return { top, left }
}

const STEP_ORDER = ['upload', 'map', 'review', 'done']
function stepIndex(s) { return STEP_ORDER.indexOf(s) }

function Stepper({ step }) {
  const cur = stepIndex(step)
  const steps = [
    { id: 'upload', label: 'Upload' },
    { id: 'map',    label: 'Map' },
    { id: 'review', label: 'Review' },
    { id: 'done',   label: 'Done' },
  ]
  return (
    <ol
      aria-label="Import steps"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 0, listStyle: 'none', margin: 0, padding: 0 }}
    >
      {steps.map((s, i) => {
        const past   = i < cur
        const active = i === cur
        return (
          <Fragment key={s.id}>
            {i > 0 && (
              <li
                aria-hidden="true"
                style={{
                  flex: 1, height: 1, marginTop: 11,
                  background: past ? C.ember : C.border,
                  minWidth: 8, maxWidth: 24,
                }}
              />
            )}
            <li
              aria-current={active ? 'step' : undefined}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
            >
              {active && <span className="sr-only">Current step: </span>}
              <div style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                background: (past || active) ? C.ember : 'transparent',
                border: `1.5px solid ${(past || active) ? C.ember : C.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: (past || active) ? '#fff' : C.inkLower,
                fontSize: 10, fontWeight: 700,
              }}>
                {past ? (
                  <>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <span className="sr-only">{s.label} (completed)</span>
                  </>
                ) : (i + 1)}
              </div>
              <span style={{
                fontSize: 8.5, fontWeight: active ? 700 : 500,
                letterSpacing: '0.07em',
                color: active ? C.ember : past ? C.inkMid : C.inkLower,
                textTransform: 'uppercase', whiteSpace: 'nowrap',
                fontFamily: '"JetBrains Mono", monospace',
              }} aria-hidden="true">{s.label}</span>
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}

export default function ImportContactsModal({ onClose, onImported }) {
  const navigate = useNavigate()

  // Pro status via shared context — single RPC call shared across all modals/pages
  const proStatus = useProStatus()
  const isProUser = hasProAccess(proStatus)

  const [step, setStep]               = useState('upload')
  const [dragging, setDragging]       = useState(false)
  const [parseError, setParseError]   = useState('')
  const [headers, setHeaders]         = useState([])
  const [rows, setRows]               = useState([])
  const [assignment, setAssignment]   = useState(freshAssignment)
  const [picker, setPicker]           = useState(null)
  const [importing, setImporting]     = useState(false)
  const [importError, setImportError] = useState('')
  const [result, setResult]           = useState(null)
  const fileInputRef = useRef()

  // AI column mapping state
  const [aiLoading, setAiLoading]       = useState(false)
  const [aiMapped, setAiMapped]         = useState({ applied: false, count: 0, notes: '' })
  const [csvDetection, setCsvDetection] = useState(null)
  const [autoMappedCount, setAutoMappedCount] = useState(0)
  const [aiEnrichEnabled, setAiEnrichEnabled] = useState(true)
  const [importProgress, setImportProgress]   = useState(null)

  // Source preview (shown on upload step after file parse)
  const [sourcePreviewHeaders, setSourcePreviewHeaders] = useState([])
  const [sourcePreviewRows, setSourcePreviewRows]       = useState([])
  const [headerRowIndex, setHeaderRowIndex]             = useState(-1)

  // Review step
  const [reviewRows, setReviewRows]   = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [tagSummary, setTagSummary]   = useState([])
  const [fixingRowId, setFixingRowId] = useState(null)
  const [fixNameValue, setFixNameValue] = useState('')
  const [dbDupMap, setDbDupMap]       = useState(new Map()) // rowId → {id, name} for DB-existing dups

  // Per-row AI suggestion review state: Map<rowId, RowSuggestionState>
  const [suggestionReview, setSuggestionReview] = useState(() => new Map())
  // Set of rowIds where the user explicitly chose to import despite the DB duplicate warning
  const [dbDupOverrides, setDbDupOverrides]     = useState(() => new Set())
  // Populated after executeBatchImport completes; used for retry and done-step stats
  const [executionResult, setExecutionResult]   = useState(null)
  // Payload items for retry (failed rows only)
  const [retryPayloadItems, setRetryPayloadItems] = useState(null)

  // Done step stats
  const [doneStats, setDoneStats]       = useState(null)
  const [doneStatsLine, setDoneStatsLine] = useState('')
  const [importedContacts, setImportedContacts] = useState([])
  const [chooserQuery, setChooserQuery] = useState('')

  // Suggestion editing state
  const [editingTagId, setEditingTagId]               = useState(null)  // stable suggestionId being inline-edited
  const [editingTagValue, setEditingTagValue]         = useState('')
  const [changingRelTypeRowId, setChangingRelTypeRowId] = useState(null) // rowId with relType change open

  // Import execution reactive progress (0–100); drives aria-valuenow
  const [execProgress, setExecProgress]               = useState(0)

  // Discard confirmation
  const [showDiscardConfirm, setShowDiscardConfirm]   = useState(false)

  // Refs
  const inferenceRunIdRef         = useRef(0)
  // Incremented once per file parse; stable across Map→Review→Map→Review cycles.
  // Prefix ensures _rowId never collides between separate file loads.
  const fileRunIdRef              = useRef(0)
  const isMountedRef              = useRef(true)
  const hasFiredMappingAnalyticsRef = useRef(null)
  const modalRef                  = useRef(null)
  const completionHeadingRef      = useRef(null)
  const importProgressRef         = useRef(0) // 0..100, used for aria-valuenow
  const triggerElementRef         = useRef(null) // focus-return-to-trigger on close

  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  // Single close gate — all close sources call this instead of onClose directly.
  // Active import: block. Done step or empty upload: close immediately.
  // Otherwise: show discard confirmation.
  const requestClose = useCallback(() => {
    if (importing) return
    if (step === 'done' || (rows.length === 0 && step === 'upload')) {
      onClose()
      return
    }
    setShowDiscardConfirm(true)
  }, [importing, step, rows.length, onClose])

  // Body scroll lock + focus return to trigger on unmount
  useEffect(() => {
    triggerElementRef.current = document.activeElement
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
      triggerElementRef.current?.focus()
    }
  }, [])

  // Focus trap + Escape close
  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return

    // Focus first interactive element in modal on mount
    const focusable = modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length > 0) focusable[0].focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        requestClose()
        return
      }
      if (e.key !== 'Tab') return
      if (!modal) return
      const focusableEls = Array.from(modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => !el.closest('[aria-hidden="true"]'))
      if (focusableEls.length === 0) return
      const first = focusableEls[0]
      const last  = focusableEls[focusableEls.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [importing, onClose, requestClose])

  // Move focus to completion heading when done step is reached
  useEffect(() => {
    if (step === 'done' && completionHeadingRef.current) {
      completionHeadingRef.current.focus()
    }
  }, [step])

  // Derived
  const assignedSet   = new Set(Object.values(assignment).flat())
  const ignoredCols   = headers.filter(h => !assignedSet.has(h))
  const hasNameMapped = assignment.name.length > 0
  const selectedCount = selectedIds.size

  const previewFields = [
    'name',
    ...FUNNL_FIELDS
      .filter(f => f.value !== 'name' && assignment[f.value]?.length > 0)
      .map(f => f.value),
  ].slice(0, 5)
  const previewContacts = rows.slice(0, 5).map(row => transformRow(row, assignment))

  const importableCount = useMemo(() => {
    if (!rows.length || !assignment.name.length) return 0
    return rows.filter(row => {
      const nameParts = assignment.name.map(col => (row[col] || '').trim()).filter(Boolean)
      return nameParts.join(' ').trim().length > 0
    }).length
  }, [rows, assignment])

  function computeMappingSignature() {
    return JSON.stringify(
      Object.fromEntries(Object.entries(assignment).map(([k, v]) => [k, [...v]]))
    )
  }

  // File handling
  async function handleFile(file) {
    if (!file) return
    setParseError('')
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Please select a .csv file. Other formats (like .xlsx) are not supported yet.')
      return
    }

    let rawText
    try {
      rawText = await file.text()
    } catch {
      setParseError("Could not read this file. Make sure it is a valid .csv and try again.")
      return
    }
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1)

    const rawResult = Papa.parse(rawText, { header: false, skipEmptyLines: 'greedy' })
    const allRows = rawResult.data
    const headerIdx = detectHeaderRow(allRows)

    if (headerIdx === -1) {
      track('csv_mapping_failed', { reason: 'no_header' })
      setParseError("Could not find a contact header row. Make sure your CSV includes columns like Name, Company, or Email.")
      return
    }

    const rawHeaderRow = allRows[headerIdx]
    const indexedHeaders = rawHeaderRow
      .map((h, i) => ({ name: (h || '').trim(), i }))
      .filter(({ name }) => name.length > 0 && name !== '__parsed_extra')
    const hdrs = indexedHeaders.map(({ name }) => name)

    const dataRows = allRows.slice(headerIdx + 1).map((cells, sourceRowNumber) =>
      Object.fromEntries([
        ...indexedHeaders.map(({ name, i }) => [name, cells[i] ?? '']),
        ['_sourceRowNumber', sourceRowNumber],
      ])
    )

    if (dataRows.length === 0) {
      track('csv_mapping_failed', { reason: 'no_data_rows' })
      setParseError('This CSV has headers but no data rows.')
      return
    }

    setCsvDetection(
      isLinkedInExport(rawHeaderRow) ? 'linkedin' : headerIdx > 0 ? 'preamble' : null
    )

    // Source preview: raw rows before and including the header
    const previewRawRows = allRows.slice(0, Math.min(headerIdx + 1, 5))
    setSourcePreviewHeaders(hdrs)
    setSourcePreviewRows(previewRawRows)
    setHeaderRowIndex(headerIdx)

    const initialAssignment = buildInitialAssignment(hdrs)
    const detectedAutoMapped = Object.values(initialAssignment).flat().length
    setAutoMappedCount(detectedAutoMapped)

    // Value-sniff URL-like columns for linkedin
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
    inferenceRunIdRef.current++
    fileRunIdRef.current++          // new stable file-run ID; row IDs in Review are prefixed with this
    hasFiredMappingAnalyticsRef.current = null

    // For Pro users, kick off AI column mapping in background.
    // Stays on upload step (showing source preview) until aiLoading resolves.
    if (isProUser) {
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
          // Silent fallback to rule-based assignment
        } finally {
          setAiLoading(false)
        }
      })()
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
    setSourcePreviewHeaders([])
    setSourcePreviewRows([])
    setHeaderRowIndex(-1)
    setReviewRows([])
    setSelectedIds(new Set())
    setTagSummary([])
    setFixingRowId(null)
    setFixNameValue('')
    setDbDupMap(new Map())
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function goToMap() {
    setStep('map')
  }

  // Sends one batch to ai-categorize-contacts
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

  // Advance from map to review: run AI categorization, build review rows
  async function goToReview() {
    inferenceRunIdRef.current++
    const runId = inferenceRunIdRef.current

    setImporting(true)
    setImportError('')
    setImportProgress(null)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setImportError('Not signed in. Please refresh the page and try again.')
      setImporting(false)
      return
    }

    // Build all contacts including nameless (they show in review with fix option).
    // _rowId is stable across Map→Review cycles because fileRunIdRef is fixed per file load.
    // Format: f{fileRunId}:{sourceRowIndex} — never reuses indices between file loads.
    const fileRunId = fileRunIdRef.current
    const allContacts = rows.map(row => ({
      ...transformRow(row, assignment),
      _rowId: `f${fileRunId}:${row._sourceRowNumber}`,
    }))

    if (allContacts.length === 0) {
      setImportError('No rows to import.')
      setImporting(false)
      return
    }

    // Fire mapping analytics once per unique mapping state
    const sig = computeMappingSignature()
    if (sig !== hasFiredMappingAnalyticsRef.current) {
      const mapping_mode = aiMapped.applied ? 'ai_assisted'
        : autoMappedCount > 0 ? 'deterministic'
        : 'manual'
      track('csv_mapping_completed', {
        mapping_mode,
        detected_format: csvDetection === 'linkedin' ? 'linkedin' : 'generic',
        contact_count: allContacts.length,
        inferred_tags_enabled: isProUser && aiEnrichEnabled,
        inferred_relationships_enabled: isProUser && aiEnrichEnabled,
      })
      hasFiredMappingAnalyticsRef.current = sig
    }

    let suggestionsMap = {}

    if (isProUser && aiEnrichEnabled && allContacts.length > 0) {
      setImportProgress({ categorized: 0, total: allContacts.length })
      const catResult = await runCategorizationForImport(
        allContacts, runId,
        (categorized, total) => {
          if (runId === inferenceRunIdRef.current && isMountedRef.current) {
            setImportProgress({ categorized, total })
          }
        }
      )
      if (!isMountedRef.current) return
      if (catResult === null) {
        setImporting(false)
        return
      }
      suggestionsMap = catResult.suggestionsMap
    }

    // Fetch existing contacts for DB duplicate detection (single query, RLS-scoped to user).
    // company field required for name+company dedup (name-alone matching removed).
    const { data: existingContacts } = await supabase
      .from('contacts')
      .select('id, name, company, email, linkedin_url')
    if (!isMountedRef.current) return

    const duplicatesMap = detectDuplicatesInBatch(allContacts)
    const dbDups = detectDatabaseDuplicates(allContacts, existingContacts || [])

    const baseRows = buildReviewRows(allContacts, suggestionsMap, duplicatesMap)

    // Annotate DB duplicates: shown with "IN FUNNL" badge, deselected by default.
    // User may override via "Import as separate contact" button.
    const rRows = baseRows.map(r => {
      const dbDup = dbDups.get(r._rowId)
      if (!dbDup) return r
      return {
        ...r,
        _isDbDuplicate: true,
        _existingContactId: dbDup.id,
        _existingContactName: dbDup.name,
        _defaultSelected: false,
      }
    })

    const tSummary = computeTagSummary(rRows)
    const defaultSelected = new Set(
      rRows.filter(r => r._defaultSelected).map(r => r._rowId)
    )

    setDbDupMap(dbDups)
    setReviewRows(rRows)
    setSelectedIds(defaultSelected)
    setTagSummary(tSummary)
    // Preserve existing suggestion review decisions for stable rowIds (Back→Review→Back→Review)
    setSuggestionReview(prev => initSuggestionReview(rRows, prev))
    // Reset overrides for a fresh review of these rows
    setDbDupOverrides(new Set())
    setImportProgress(null)
    setImporting(false)
    setStep('review')
  }

  // Build payload items with _rowId for failure tracking (strips _* before DB insert)
  function buildTrackedPayload(resolvedRows, selectedIds, userId) {
    const payload = buildImportPayload(resolvedRows, selectedIds, userId)
    // Correlate by position: buildImportPayload preserves order and filters only selected valid rows
    const selectedValidRowIds = resolvedRows
      .filter(r => selectedIds.has(r._rowId) && r.name && r.name.trim())
      .map(r => r._rowId)
    return payload.map((contact, i) => ({
      ...contact,
      _rowId: selectedValidRowIds[i] || `payload-${i}`,
    }))
  }

  // Insert selected rows from review step using batched executor
  async function handleImportReview() {
    setImporting(true)
    setImportError('')
    importProgressRef.current = 0
    setExecProgress(0)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setImportError('Not signed in. Please refresh the page and try again.')
      setImporting(false)
      return
    }

    // Pre-apply suggestion review: nullify _suggestion so buildImportPayload skips auto-apply.
    // The resolved tags/relType are already baked into each row before building the payload.
    const resolvedRows = reviewRows.map(r => {
      const rowState = suggestionReview.get(r._rowId)
      const finalTags    = getFinalTags(r.tags || [], rowState)
      const finalRelType = getFinalRelType(r.relationship_type, rowState)
      return {
        ...r,
        tags:              finalTags.length > 0 ? finalTags : r.tags,
        relationship_type: finalRelType !== undefined ? finalRelType : r.relationship_type,
        _suggestion:       null, // prevent buildImportPayload from re-applying old suggestion
      }
    })

    const payloadItems = buildTrackedPayload(resolvedRows, selectedIds, user.id)
    if (payloadItems.length === 0) {
      setImportError('No contacts selected. Select at least one contact to import.')
      setImporting(false)
      return
    }

    const execResult = await executeBatchImport(payloadItems, supabase, {
      onProgress: fraction => {
        const pct = Math.round(fraction * 100)
        importProgressRef.current = pct
        setExecProgress(pct)
      },
    })

    if (!isMountedRef.current) return
    setImporting(false)

    const importedCount = execResult.successful
    const importedIds   = execResult.successfulIds

    track('csv_import_used', {
      contacts_imported: importedCount,
      ai_assisted: aiMapped.applied || (isProUser && aiEnrichEnabled),
    })

    const stats     = computeDoneStats(reviewRows, importedCount)
    const statsLine = buildDoneStatsLine(tagSummary, stats)

    setDoneStats(stats)
    setDoneStatsLine(statsLine)
    setImportedContacts(execResult.successfulContacts.map(r => ({ id: r.id, name: r.name || '' })))
    setResult({ imported: importedCount, importedIds })
    setExecutionResult(execResult)
    setRetryPayloadItems(execResult.failedPayloadItems.length > 0 ? execResult.failedPayloadItems : null)
    setStep('done')
    onImported()
  }

  // Retry only failed rows from a previous execution
  async function handleRetry() {
    if (!retryPayloadItems || !executionResult) return
    setImporting(true)
    setImportError('')
    importProgressRef.current = 0
    setExecProgress(0)

    const mergedResult = await retryBatchImport(retryPayloadItems, executionResult, supabase, {
      onProgress: fraction => {
        const pct = Math.round(fraction * 100)
        importProgressRef.current = pct
        setExecProgress(pct)
      },
    })

    if (!isMountedRef.current) return
    setImporting(false)

    const importedCount = mergedResult.successful + mergedResult.skipped
    const importedIds   = mergedResult.successfulIds

    track('csv_import_used', {
      contacts_imported: mergedResult.successful,
      ai_assisted: aiMapped.applied || (isProUser && aiEnrichEnabled),
    })

    const stats     = computeDoneStats(reviewRows, importedCount)
    const statsLine = buildDoneStatsLine(tagSummary, stats)

    setDoneStats(stats)
    setDoneStatsLine(statsLine)
    setImportedContacts(mergedResult.successfulContacts.map(r => ({ id: r.id, name: r.name || '' })))
    setResult({ imported: importedCount, importedIds })
    setExecutionResult(mergedResult)
    setRetryPayloadItems(mergedResult.failedPayloadItems.length > 0 ? mergedResult.failedPayloadItems : null)
  }

  // Column assignment helpers
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

  // Review step helpers
  function toggleRow(rowId) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  function toggleAllRows() {
    // Selectable = not missing-name AND not a within-file dup AND not a DB dup without explicit override.
    // Within-file duplicates and DB duplicates are never bulk-selected; they require individual override.
    const selectableIds = reviewRows
      .filter(r =>
        !r._isMissingName &&
        !r._isDuplicate &&
        (!r._isDbDuplicate || dbDupOverrides.has(r._rowId))
      )
      .map(r => r._rowId)
    const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id))
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(selectableIds))
    }
  }

  function overrideDbDup(rowId) {
    setDbDupOverrides(prev => {
      const next = new Set(prev)
      next.add(rowId)
      return next
    })
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.add(rowId)
      return next
    })
  }

  function handleFixName(rowId) {
    const trimmed = fixNameValue.trim()
    if (!trimmed) return
    setReviewRows(prev => prev.map(r => {
      if (r._rowId !== rowId) return r
      return { ...r, name: trimmed, _isMissingName: false, _defaultSelected: true }
    }))
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.add(rowId)
      return next
    })
    setFixingRowId(null)
    setFixNameValue('')
  }

  // ── Suggestion editing helpers ─────────────────────────────────────────────

  function saveTagEdit(rowId, suggestionId) {
    const trimmed = editingTagValue.trim()
    setSuggestionReview(prev => editTagSuggestion(prev, rowId, suggestionId, trimmed))
    setEditingTagId(null)
    setEditingTagValue('')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ animation: 'fade-in 0.15s ease-out' }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ background: 'var(--color-backdrop)' }} onClick={requestClose}/>

      {/* Modal panel - light paper theme */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        className="relative w-full max-w-[640px] max-h-[88vh] flex flex-col rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        style={{ background: C.bg, color: C.ink, border: `1px solid ${C.border}` }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-6 pt-5 pb-4 flex-none"
          style={{ borderBottom: `1px solid ${C.border}` }}
        >
          <div className="flex-1 mr-4">
            <h2
              id="import-modal-title"
              ref={completionHeadingRef}
              tabIndex={-1}
              className="font-display font-bold text-[17px] leading-tight mb-3 outline-none"
              style={{ color: C.ink }}
            >
              Import contacts
            </h2>
            <Stepper step={step}/>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors flex-none mt-0.5"
            style={{ color: C.inkLow }}
            onMouseEnter={e => { e.currentTarget.style.background = C.bgCard; e.currentTarget.style.color = C.ink }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.inkLow }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        </div>

        {/* Discard confirmation overlay — shown when user tries to close with unsaved work */}
        {showDiscardConfirm && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-dialog-title"
            className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl"
            style={{ background: 'rgba(20,17,15,0.82)' }}
          >
            <div
              className="mx-6 rounded-2xl px-6 py-5 shadow-lg"
              style={{ background: C.bg, border: `1px solid ${C.border}`, maxWidth: 340 }}
            >
              <h3
                id="discard-dialog-title"
                className="text-[15px] font-bold mb-2"
                style={{ color: C.ink }}
              >Discard this import?</h3>
              <p className="text-[13px] mb-5" style={{ color: C.inkMid }}>
                Your file, column mapping, and any review decisions will be lost.
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="flex-1 text-[13px] font-semibold px-4 py-2 rounded-xl"
                  style={{ background: C.ember, color: '#fff' }}
                  onClick={() => setShowDiscardConfirm(false)}
                >Keep editing</button>
                <button
                  type="button"
                  className="flex-1 text-[13px] font-semibold px-4 py-2 rounded-xl"
                  style={{ background: C.bgCard, color: C.inkMid, border: `1px solid ${C.border}` }}
                  onClick={() => { setShowDiscardConfirm(false); onClose() }}
                >Discard import</button>
              </div>
            </div>
          </div>
        )}

        {/* Scrollable body */}
        <div
          className="overflow-y-auto flex-1 px-6 py-5"
          onScroll={() => picker && setPicker(null)}
        >

          {/* STEP 1: Upload */}
          {step === 'upload' && (
            <div>
              {aiLoading && sourcePreviewHeaders.length > 0 ? (
                /* AI column mapping in progress - show preview + loading indicator */
                <div>
                  <SourcePreview
                    headers={sourcePreviewHeaders}
                    rows={sourcePreviewRows}
                    headerRowIndex={headerRowIndex}
                  />
                  <div
                    className="mt-4 flex items-center gap-2.5 px-4 py-3 rounded-xl"
                    style={{ background: C.emberFaint, border: `1px solid ${C.emberBorder}` }}
                  >
                    <svg className="animate-spin flex-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.ember} strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    <p className="text-[12.5px] font-semibold" style={{ color: C.ember }}>
                      AI is analyzing your column headers...
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Dropzone */}
                  {sourcePreviewHeaders.length === 0 ? (
                    <>
                      <p className="text-[13.5px] mb-5 leading-relaxed" style={{ color: C.inkMid }}>
                        Upload a CSV file from a spreadsheet. Each row becomes one contact.
                      </p>
                      <div
                        className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors"
                        style={{
                          borderColor: dragging ? C.ember : C.border,
                          background: dragging ? C.emberFaint : 'transparent',
                        }}
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
                        {/* Sacred funnel mark */}
                        <div className="flex justify-center mb-4">
                          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                            <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
                          </svg>
                        </div>
                        <p className="text-[14px] font-bold mb-1" style={{ color: C.ink }}>
                          Drop a CSV file here
                        </p>
                        <p className="text-[13px]" style={{ color: C.inkLow }}>
                          or click to browse &middot; .csv files only
                        </p>
                      </div>
                      {parseError && (
                        <div
                          className="mt-4 flex items-start gap-2.5 px-4 py-3 rounded-xl"
                          style={{ background: C.dangerFaint, border: `1px solid ${C.dangerBorder}` }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.danger} strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                            <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                          </svg>
                          <p className="text-[13px]" style={{ color: C.danger }}>{parseError}</p>
                        </div>
                      )}
                      <p className="text-[12px] mt-5 leading-relaxed" style={{ color: C.inkLower }}>
                        Tip: in Google Sheets go to File &rarr; Download &rarr; CSV. In Excel use File &rarr; Save As &rarr; CSV.
                      </p>
                    </>
                  ) : (
                    /* File parsed - show source preview */
                    <>
                      {parseError && (
                        <div
                          className="mb-4 flex items-start gap-2.5 px-4 py-3 rounded-xl"
                          style={{ background: C.dangerFaint, border: `1px solid ${C.dangerBorder}` }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.danger} strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                            <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                          </svg>
                          <p className="text-[13px]" style={{ color: C.danger }}>{parseError}</p>
                        </div>
                      )}
                      <SourcePreview
                        headers={sourcePreviewHeaders}
                        rows={sourcePreviewRows}
                        headerRowIndex={headerRowIndex}
                      />
                      <p className="mt-4 text-[12.5px]" style={{ color: C.inkLow }}>
                        {rows.length} data {rows.length === 1 ? 'row' : 'rows'} found.{' '}
                        <button
                          type="button"
                          onClick={() => { fileInputRef.current?.click() }}
                          className="underline"
                          style={{ color: C.ember }}
                        >
                          Choose a different file
                        </button>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".csv"
                          className="hidden"
                          onChange={e => handleFile(e.target.files[0])}
                        />
                      </p>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* STEP 2: Map columns */}
          {step === 'map' && (
            importing ? (
              <div className="flex flex-col items-center justify-center py-14 gap-3">
                <svg className="animate-spin" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={C.ember} strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                {importProgress !== null ? (
                  <>
                    <p className="text-[14px] font-semibold" style={{ color: C.ink }}>
                      Organizing your contacts with Funnl AI...
                    </p>
                    <p className="text-[13px]" style={{ color: C.inkMid }}>
                      Analyzed {importProgress.categorized} of {importProgress.total} contacts
                    </p>
                  </>
                ) : (
                  <p className="text-[14px] font-semibold" style={{ color: C.inkMid }}>
                    Preparing review...
                  </p>
                )}
              </div>
            ) : (
              <div>
                {csvDetection && (
                  <div
                    className="flex items-start gap-2.5 mb-4 px-3 py-2.5 rounded-xl"
                    style={{ background: C.successFaint, border: `1px solid ${C.successBorder}` }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-0.5">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <p className="text-[12.5px] font-semibold" style={{ color: C.success }}>
                      {csvDetection === 'linkedin'
                        ? 'LinkedIn Connections export detected. Introductory note skipped; columns auto-mapped below.'
                        : 'Introductory text found and skipped. Reading contacts from the actual header row.'
                      }
                    </p>
                  </div>
                )}
                {aiMapped.applied && (
                  <div
                    className="flex items-start gap-2.5 mb-4 px-3 py-2.5 rounded-xl"
                    style={{ background: C.emberFaint, border: `1px solid ${C.emberBorder}` }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.ember} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-0.5">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <div>
                      <p className="text-[12.5px] font-semibold" style={{ color: C.ember }}>
                        AI auto-mapped {aiMapped.count} {aiMapped.count === 1 ? 'column' : 'columns'} - review and adjust before continuing
                      </p>
                      {aiMapped.notes && (
                        <p className="text-[11.5px] mt-0.5" style={{ color: C.inkMid }}>{aiMapped.notes}</p>
                      )}
                    </div>
                  </div>
                )}
                {!isProUser && (
                  <div
                    className="flex items-start gap-2.5 mb-4 px-3 py-2.5 rounded-xl"
                    style={{ background: C.emberFaint, border: `1px solid ${C.emberBorder}` }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.ember} strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <p className="text-[12.5px]" style={{ color: C.inkMid }}>
                      <span className="font-semibold" style={{ color: C.ember }}>Pro tip:</span>{' '}
                      AI can auto-map columns and suggest categories for each contact - available with Funnl Pro.
                    </p>
                  </div>
                )}
                {!hasNameMapped && (
                  <div
                    className="flex items-start gap-2.5 mb-4 px-3 py-2.5 rounded-xl"
                    style={{ background: C.warnFaint, border: `1px solid ${C.warnBorder}` }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.warn} strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <p className="text-[12.5px]" style={{ color: C.warn }}>
                      Assign at least one column to <strong>Name</strong> to continue - it is required.
                    </p>
                  </div>
                )}

                {/* AI enrichment toggle */}
                {isProUser && (
                  <div
                    className="flex items-start gap-3 mb-4 px-4 py-3.5 rounded-xl"
                    style={{ background: C.bgCard, border: `1px solid ${C.border}` }}
                  >
                    <input
                      type="checkbox"
                      id="ai-enrich-toggle"
                      checked={aiEnrichEnabled}
                      onChange={e => setAiEnrichEnabled(e.target.checked)}
                      className="mt-[3px] w-4 h-4 cursor-pointer flex-none"
                      style={{ accentColor: C.ember }}
                    />
                    <div className="flex-1">
                      <label htmlFor="ai-enrich-toggle" className="text-[13px] font-semibold cursor-pointer leading-snug" style={{ color: C.ink }}>
                        Automatically organize contacts with Funnl AI
                      </label>
                      <p className="text-[12px] mt-0.5 leading-relaxed" style={{ color: C.inkMid }}>
                        Adds relevant tags and relationship categories based on your file. You can edit them in the next step.
                      </p>
                    </div>
                  </div>
                )}

                {/* Pool: unassigned columns */}
                <div className="mb-5">
                  {ignoredCols.length === 0 ? (
                    <div
                      className="flex items-center gap-2 px-4 py-3 rounded-xl"
                      style={{ background: C.successFaint, border: `1px solid ${C.successBorder}` }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5"/>
                      </svg>
                      <p className="text-[12.5px] font-medium" style={{ color: C.success }}>All columns placed - check the preview below.</p>
                    </div>
                  ) : (
                    <div
                      className="px-4 py-3.5 rounded-xl"
                      style={{ background: C.bgCard, border: `1px solid ${C.border}` }}
                    >
                      <p
                        className="text-[10.5px] font-bold tracking-[1px] uppercase mb-3"
                        style={{ color: C.inkLower, fontFamily: '"JetBrains Mono", monospace' }}
                      >
                        Not yet assigned - click a column to place it
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {ignoredCols.map(col => (
                          <button
                            key={col}
                            type="button"
                            onClick={e => openColPicker(col, e)}
                            className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-[6px] rounded-lg transition-colors"
                            style={{
                              fontFamily: '"JetBrains Mono", monospace',
                              background: picker?.mode === 'col' && picker.key === col ? C.emberFaint : C.bgInput,
                              border: `1px solid ${picker?.mode === 'col' && picker.key === col ? C.ember : C.border}`,
                              color: picker?.mode === 'col' && picker.key === col ? C.ink : C.inkMid,
                            }}
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
                <p
                  className="text-[10.5px] font-bold tracking-[1px] uppercase mb-1"
                  style={{ color: C.inkLower, fontFamily: '"JetBrains Mono", monospace' }}
                >
                  Funnl fields
                </p>
                <p className="text-[12px] mb-3" style={{ color: C.inkLower }}>
                  Click a column above to assign it, or use + Add on any field.
                  Multiple columns combine in chip order.
                </p>
                <div
                  className="rounded-xl overflow-hidden mb-5"
                  style={{ border: `1px solid ${C.border}` }}
                >
                  {FUNNL_FIELDS.map((field, fi) => (
                    <div
                      key={field.value}
                      className="flex items-start gap-3 px-4 py-3"
                      style={{
                        background: C.bg,
                        borderTop: fi > 0 ? `1px solid ${C.borderSub}` : 'none',
                      }}
                    >
                      <div className="w-[108px] flex-none pt-[7px]">
                        <span className="text-[13px] font-semibold" style={{ color: C.ink }}>{field.label}</span>
                        {field.required && <span className="text-[12px] ml-0.5" style={{ color: C.danger }}>*</span>}
                      </div>
                      <div className="flex-1 flex flex-wrap items-center gap-1.5 pt-1.5 min-h-[32px]">
                        {assignment[field.value].map(col => (
                          <span
                            key={col}
                            className="inline-flex items-center gap-1 text-[12px] px-2 py-[5px] rounded-lg leading-none"
                            style={{
                              fontFamily: '"JetBrains Mono", monospace',
                              background: C.emberFaint,
                              border: `1px solid ${C.emberBorder}`,
                              color: C.ember,
                            }}
                          >
                            {col}
                            <button
                              type="button"
                              onClick={() => removeColumn(field.value, col)}
                              className="ml-0.5 leading-none text-[14px] transition-colors"
                              style={{ color: 'rgba(255,68,35,0.5)' }}
                              onMouseEnter={e => { e.currentTarget.style.color = C.danger }}
                              onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,68,35,0.5)' }}
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                        {assignment[field.value].length === 0 && (
                          <span className="text-[12px] italic pt-[5px]" style={{ color: C.inkLower }}>
                            not assigned
                          </span>
                        )}
                        {ignoredCols.length > 0 && (
                          <button
                            type="button"
                            onClick={e => openFieldPicker(field.value, e)}
                            className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-[5px] rounded-lg transition-colors leading-none"
                            style={{
                              color: picker?.mode === 'field' && picker.key === field.value ? C.ember : C.inkLow,
                              background: picker?.mode === 'field' && picker.key === field.value ? C.emberFaint : 'transparent',
                            }}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
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
                <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20 }}>
                  <p
                    className="text-[10.5px] font-bold tracking-[1px] uppercase mb-1"
                    style={{ color: C.inkLower, fontFamily: '"JetBrains Mono", monospace' }}
                  >
                    Live preview
                  </p>
                  <p className="text-[12px] mb-3" style={{ color: C.inkLower }}>
                    First {Math.min(rows.length, 5)} of {rows.length} rows &middot; updates instantly
                  </p>
                  <div className="overflow-x-auto rounded-xl" style={{ border: `1px solid ${C.border}` }}>
                    <table className="w-full text-[12px]" style={{ minWidth: previewFields.length * 130 }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${C.border}`, background: C.bgCard }}>
                          {previewFields.map(f => {
                            const fd = FUNNL_FIELDS.find(x => x.value === f)
                            return (
                              <th key={f} className="px-3 py-2 text-left whitespace-nowrap"
                                style={{ color: C.inkLow, fontFamily: '"JetBrains Mono", monospace', fontWeight: 700 }}>
                                {fd.label}
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {previewContacts.map((contact, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.borderSub}` }}>
                            {previewFields.map(f => {
                              const val = f === 'tags' ? (contact[f] || []).join(', ') : (contact[f] || '')
                              return (
                                <td key={f} className="px-3 py-2 max-w-[160px]">
                                  {val
                                    ? <span className="block truncate" style={{ color: C.inkMid }}>{val}</span>
                                    : <span style={{ color: C.inkLower }}>-</span>
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

                {importError && (
                  <div
                    className="mt-5 flex items-start gap-2.5 px-4 py-3 rounded-xl"
                    style={{ background: C.dangerFaint, border: `1px solid ${C.dangerBorder}` }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.danger} strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                      <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                    </svg>
                    <p className="text-[13px]" style={{ color: C.danger }}>{importError}</p>
                  </div>
                )}
              </div>
            )
          )}

          {/* STEP 3: Review contacts */}
          {step === 'review' && (
            <div>
              {/* Bulk AI tag chips */}
              {tagSummary.length > 0 && (
                <div className="mb-5">
                  <p
                    className="text-[10.5px] font-bold tracking-[1px] uppercase mb-2"
                    style={{ color: C.inkLower, fontFamily: '"JetBrains Mono", monospace' }}
                  >
                    AI suggested tags
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {tagSummary.map(({ tag, count, confidence }) => (
                      <div
                        key={tag}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px]"
                        style={{
                          background: C.bgCard,
                          border: `1px solid ${C.border}`,
                          color: C.ink,
                        }}
                      >
                        <span className="font-semibold">{tag}</span>
                        <span style={{ color: C.inkLow }}>&middot; {count}</span>
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                          style={{
                            background: confidence === 'high' ? C.successFaint
                              : confidence === 'medium' ? C.warnFaint
                              : C.bgInput,
                            color: confidence === 'high' ? C.success
                              : confidence === 'medium' ? C.warn
                              : C.inkLow,
                          }}
                        >
                          {confidence === 'high' ? 'HIGH' : confidence === 'medium' ? 'MEDIUM' : 'LOW'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Selection header */}
              <div className="flex items-center justify-between mb-3">
                <p className="text-[13px] font-semibold" style={{ color: C.ink }}>
                  {selectedCount} of {reviewRows.length} selected
                </p>
                <button
                  type="button"
                  onClick={toggleAllRows}
                  className="text-[12.5px] font-semibold transition-colors"
                  style={{ color: C.ember }}
                >
                  {reviewRows
                    .filter(r => !r._isMissingName && !r._isDuplicate && (!r._isDbDuplicate || dbDupOverrides.has(r._rowId)))
                    .every(r => selectedIds.has(r._rowId))
                    ? 'Deselect all'
                    : 'Select all'}
                </button>
              </div>

              {/* Review table */}
              <div className="overflow-x-auto rounded-xl" style={{ border: `1px solid ${C.border}` }}>
                <table className="w-full text-[13px]" style={{ minWidth: 480 }}>
                  <thead>
                    <tr style={{ background: C.bgCard, borderBottom: `1px solid ${C.border}` }}>
                      <th className="px-3 py-2 w-10"></th>
                      <th className="px-3 py-2 text-left font-semibold" style={{ color: C.inkMid }}>Name</th>
                      <th className="px-3 py-2 text-left font-semibold hidden sm:table-cell" style={{ color: C.inkMid }}>Company</th>
                      <th className="px-3 py-2 text-left font-semibold hidden md:table-cell" style={{ color: C.inkMid }}>Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewRows.map((row, i) => {
                      const isDup     = row._isDuplicate
                      const isMissing = row._isMissingName
                      const isDbDup   = row._isDbDuplicate
                      const isSelected = selectedIds.has(row._rowId)
                      const rowBg = isMissing ? C.dangerFaint : isDup || isDbDup ? C.warnFaint : 'transparent'
                      return (
                        <tr
                          key={row._rowId}
                          style={{
                            background: rowBg,
                            borderTop: i > 0 ? `1px solid ${C.borderSub}` : 'none',
                          }}
                        >
                          {/* Checkbox — within-file dups and DB dups disabled unless user explicitly overrides */}
                          <td className="px-3 py-2.5 w-10">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleRow(row._rowId)}
                              disabled={
                                (isMissing && fixingRowId !== row._rowId) ||
                                (isDup && !dbDupOverrides.has(row._rowId)) ||
                                (isDbDup && !dbDupOverrides.has(row._rowId))
                              }
                              className="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                              style={{ accentColor: C.ember }}
                            />
                          </td>

                          {/* Name column */}
                          <td className="px-3 py-2.5">
                            {fixingRowId === row._rowId ? (
                              <div className="flex items-center gap-2">
                                <input
                                  autoFocus
                                  type="text"
                                  value={fixNameValue}
                                  onChange={e => setFixNameValue(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') handleFixName(row._rowId)
                                    if (e.key === 'Escape') { setFixingRowId(null); setFixNameValue('') }
                                  }}
                                  placeholder="Enter name..."
                                  className="flex-1 rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none min-w-0"
                                  style={{
                                    background: C.bgInput,
                                    border: `1px solid ${C.ember}`,
                                    color: C.ink,
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => handleFixName(row._rowId)}
                                  className="text-[12px] font-semibold px-2.5 py-1.5 rounded-lg flex-none"
                                  style={{ background: C.ember, color: '#fff' }}
                                >
                                  Save
                                </button>
                              </div>
                            ) : (
                              <div>
                                <span className="font-medium" style={{ color: isMissing ? C.danger : C.ink }}>
                                  {row.name || '(no name)'}
                                </span>
                                {isDup && (
                                  <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                                    <span
                                      className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded"
                                      style={{ background: C.warnBorder, color: C.warn }}
                                    >
                                      DUPLICATE
                                    </span>
                                    <span className="text-[11px]" style={{ color: C.warn }}>
                                      of &ldquo;{row._duplicateOfName}&rdquo;
                                    </span>
                                    {!dbDupOverrides.has(row._rowId) && (
                                      <button
                                        type="button"
                                        onClick={() => overrideDbDup(row._rowId)}
                                        className="text-[11px] font-semibold underline"
                                        style={{ color: C.inkMid }}
                                      >
                                        Import as separate contact
                                      </button>
                                    )}
                                  </div>
                                )}
                                {isDbDup && (
                                  <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                                    <span
                                      className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded"
                                      style={{ background: 'rgba(46,125,91,0.12)', color: C.success }}
                                    >
                                      IN FUNNL
                                    </span>
                                    <a
                                      href={`/contacts/${row._existingContactId}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[11px] font-semibold underline"
                                      style={{ color: C.success }}
                                    >
                                      Open existing &rarr;
                                    </a>
                                    {!dbDupOverrides.has(row._rowId) && (
                                      <button
                                        type="button"
                                        onClick={() => overrideDbDup(row._rowId)}
                                        className="text-[11px] font-semibold underline"
                                        style={{ color: C.inkMid }}
                                      >
                                        Import as separate contact
                                      </button>
                                    )}
                                  </div>
                                )}
                                {isMissing && (
                                  <div className="mt-0.5 flex items-center gap-1.5">
                                    <span
                                      className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded"
                                      style={{ background: C.dangerBorder, color: C.danger }}
                                    >
                                      NEEDS A NAME
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setFixingRowId(row._rowId)
                                        setFixNameValue('')
                                      }}
                                      className="text-[11px] font-semibold underline"
                                      style={{ color: C.danger }}
                                    >
                                      fix
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>

                          {/* Company */}
                          <td className="px-3 py-2.5 max-w-[140px] hidden sm:table-cell">
                            <span className="block truncate text-[12.5px]" style={{ color: C.inkMid }}>
                              {row.company || ''}
                            </span>
                          </td>

                          {/* Tags + per-row AI suggestion chips */}
                          <td className="px-3 py-2.5 hidden md:table-cell">
                            <div className="flex flex-wrap gap-1">
                              {/* CSV tags */}
                              {(row.tags || []).slice(0, 3).map(t => (
                                <span
                                  key={t}
                                  className="text-[10.5px] px-1.5 py-0.5 rounded"
                                  style={{ background: C.bgCard, color: C.inkMid, border: `1px solid ${C.border}` }}
                                >
                                  {t}
                                </span>
                              ))}
                              {/* AI tag suggestion chips — full PENDING/ACCEPTED/EDITED state machine */}
                              {(() => {
                                const rowState = suggestionReview.get(row._rowId)
                                return (rowState?.tags || []).map(item => {
                                  const { PENDING, ACCEPTED, REJECTED, EDITED } = SUGGESTION_STATES
                                  if (item.state === REJECTED) return null
                                  const isEditing = editingTagId === item.id
                                  const displayLabel = item.state === EDITED ? item.editedValue : item.tag

                                  if (isEditing) {
                                    return (
                                      <span key={item.id} className="inline-flex items-center gap-0.5">
                                        <input
                                          autoFocus
                                          type="text"
                                          value={editingTagValue}
                                          onChange={e => setEditingTagValue(e.target.value)}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter') { e.preventDefault(); saveTagEdit(row._rowId, item.id) }
                                            if (e.key === 'Escape') { setEditingTagId(null); setEditingTagValue('') }
                                          }}
                                          className="text-[10.5px] px-1.5 py-0.5 rounded outline-none"
                                          style={{ background: C.bgInput, color: C.ink, border: `1px solid ${C.ember}`, width: 80 }}
                                        />
                                        <button
                                          type="button"
                                          aria-label="Save tag edit"
                                          className="text-[10px] px-1 py-0.5 rounded font-semibold"
                                          style={{ background: C.ember, color: '#fff' }}
                                          onClick={() => saveTagEdit(row._rowId, item.id)}
                                        >Save</button>
                                        <button
                                          type="button"
                                          aria-label="Cancel tag edit"
                                          className="text-[10px] px-1 py-0.5 rounded"
                                          style={{ color: C.inkLow }}
                                          onClick={() => { setEditingTagId(null); setEditingTagValue('') }}
                                        >✕</button>
                                      </span>
                                    )
                                  }

                                  const isPending  = item.state === PENDING
                                  const isAccepted = item.state === ACCEPTED || item.state === EDITED
                                  const chipBg     = isPending  ? C.emberFaint   : C.successFaint
                                  const chipColor  = isPending  ? C.ember        : C.success
                                  const chipBorder = isPending  ? C.emberBorder  : C.successBorder

                                  return (
                                    <span
                                      key={item.id}
                                      className="inline-flex items-center gap-0.5 text-[10.5px] px-1.5 py-0.5 rounded"
                                      style={{ background: chipBg, color: chipColor, border: `1px solid ${chipBorder}` }}
                                    >
                                      {displayLabel}
                                      {isPending && (
                                        <button
                                          type="button"
                                          aria-label={`Accept tag suggestion "${item.tag}"`}
                                          className="ml-0.5 leading-none font-bold hover:opacity-70"
                                          style={{ color: chipColor, fontSize: 10 }}
                                          onClick={() => setSuggestionReview(prev => acceptTagSuggestion(prev, row._rowId, item.id))}
                                        >+</button>
                                      )}
                                      {isAccepted && (
                                        <button
                                          type="button"
                                          aria-label={`Edit tag "${displayLabel}"`}
                                          className="ml-0.5 leading-none hover:opacity-70"
                                          style={{ color: chipColor, fontSize: 10 }}
                                          onClick={() => { setEditingTagId(item.id); setEditingTagValue(displayLabel) }}
                                        >✎</button>
                                      )}
                                      <button
                                        type="button"
                                        aria-label={isAccepted ? `Remove accepted tag "${displayLabel}"` : `Reject tag suggestion "${item.tag}"`}
                                        className="leading-none hover:opacity-70"
                                        style={{ color: C.inkLow, fontSize: 10 }}
                                        onClick={() => setSuggestionReview(prev => rejectTagSuggestion(prev, row._rowId, item.id))}
                                      >✕</button>
                                    </span>
                                  )
                                })
                              })()}
                              {/* AI relationship-type suggestion chip — full PENDING/ACCEPTED/EDITED state machine */}
                              {(() => {
                                const rowState = suggestionReview.get(row._rowId)
                                const rt = rowState?.relType
                                if (!rt || rt.state === SUGGESTION_STATES.REJECTED) return null
                                const isPending  = rt.state === SUGGESTION_STATES.PENDING
                                const isAccepted = rt.state === SUGGESTION_STATES.ACCEPTED || rt.state === SUGGESTION_STATES.EDITED
                                const displayVal = rt.state === SUGGESTION_STATES.EDITED ? rt.editedValue : rt.value
                                const chipBg     = isPending ? C.warnFaint    : C.successFaint
                                const chipColor  = isPending ? C.warn         : C.success
                                const chipBorder = isPending ? C.warnBorder   : C.successBorder
                                const isChanging = changingRelTypeRowId === row._rowId
                                return (
                                  <span key="ai-reltype" className="inline-flex items-center gap-0.5 text-[10.5px] rounded"
                                    style={{ background: chipBg, border: `1px solid ${chipBorder}` }}
                                  >
                                    <span className="pl-1.5 py-0.5 inline-flex items-center gap-0.5" style={{ color: chipColor }}>
                                      <span className="text-[9px] font-bold tracking-wide uppercase" style={{ color: C.inkLow }}>rel:</span>
                                      {displayVal}
                                    </span>
                                    {isPending && (
                                      <button
                                        type="button"
                                        aria-label={`Accept relationship type suggestion "${rt.value}"`}
                                        className="leading-none font-bold hover:opacity-70 px-0.5 py-0.5"
                                        style={{ color: chipColor, fontSize: 10 }}
                                        onClick={() => setSuggestionReview(prev => acceptRelTypeSuggestion(prev, row._rowId))}
                                      >+</button>
                                    )}
                                    {isAccepted && !isChanging && (
                                      <button
                                        type="button"
                                        aria-label="Change relationship type"
                                        className="leading-none hover:opacity-70 px-0.5 py-0.5"
                                        style={{ color: chipColor, fontSize: 10 }}
                                        onClick={() => setChangingRelTypeRowId(row._rowId)}
                                      >✎</button>
                                    )}
                                    {isChanging && (
                                      <select
                                        autoFocus
                                        className="text-[10.5px] rounded outline-none mx-0.5"
                                        style={{ background: C.bgInput, color: C.ink, border: `1px solid ${C.ember}` }}
                                        defaultValue={displayVal}
                                        onChange={e => {
                                          setSuggestionReview(prev => changeRelTypeSuggestion(prev, row._rowId, e.target.value))
                                          setChangingRelTypeRowId(null)
                                        }}
                                        onBlur={() => setChangingRelTypeRowId(null)}
                                      >
                                        <option value="">- Cancel -</option>
                                        {RELATIONSHIP_TYPE_VALUES.map(v => (
                                          <option key={v} value={v}>{v}</option>
                                        ))}
                                      </select>
                                    )}
                                    <button
                                      type="button"
                                      aria-label={`Reject relationship type suggestion "${rt.value}"`}
                                      className="leading-none hover:opacity-70 pr-1.5 py-0.5"
                                      style={{ color: C.inkLow, fontSize: 10 }}
                                      onClick={() => setSuggestionReview(prev => rejectRelTypeSuggestion(prev, row._rowId))}
                                    >✕</button>
                                  </span>
                                )
                              })()}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="mt-3 text-[12px] leading-relaxed" style={{ color: C.inkLow }}>
                Partial import allowed. Unresolved rows are skipped and can be added later.
              </p>

              {importError && (
                <div
                  role="alert"
                  className="mt-4 flex items-start gap-2.5 px-4 py-3 rounded-xl"
                  style={{ background: C.dangerFaint, border: `1px solid ${C.dangerBorder}` }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.danger} strokeWidth="2" strokeLinecap="round" className="flex-none mt-0.5">
                    <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                  </svg>
                  <p className="text-[13px]" style={{ color: C.danger }}>{importError}</p>
                </div>
              )}
            </div>
          )}

          {/* STEP 4: Done — full, partial, or zero success */}
          {step === 'done' && result && executionResult && (() => {
            const isFull    = executionResult.failed === 0
            const isPartial = executionResult.failed > 0 && executionResult.successful > 0
            const isZero    = executionResult.failed > 0 && executionResult.successful === 0
            const attempted = executionResult.attempted || 1
            const fillPct   = Math.round((executionResult.successful / attempted) * 100)

            return (
              <div className="py-4 text-center">
                {/* Sacred funnel mark — animated fill shows import progress fraction */}
                <div className="flex justify-center mb-5 relative" style={{ width: 44, height: 44, margin: '0 auto 20px' }}>
                  {/* Gray base layer */}
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', top: 0, left: 0 }} aria-hidden="true">
                    <path d="M3 4H21L15 12.5V20H9V12.5Z" fill={C.inkLower} opacity="0.2"/>
                  </svg>
                  {/* Ember fill layer — clipped from bottom based on fillPct */}
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" style={{
                    position: 'absolute', top: 0, left: 0,
                    clipPath: `inset(${100 - fillPct}% 0 0 0)`,
                    transition: 'clip-path 0.5s ease-out',
                  }} aria-hidden="true">
                    <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
                  </svg>
                </div>

                {isFull && (
                  <>
                    <p className="font-display font-bold text-[26px] mb-2" style={{ color: C.ink }}>
                      {result.imported} {result.imported === 1 ? 'person' : 'people'}, organized.
                    </p>
                    {doneStatsLine ? (
                      <p className="text-[13px] mb-8" style={{ color: C.inkMid }}>{doneStatsLine}</p>
                    ) : (
                      <p className="text-[13px] mb-8" style={{ color: C.inkMid }}>
                        {result.imported} {result.imported === 1 ? 'contact' : 'contacts'} ready to go.
                      </p>
                    )}
                  </>
                )}

                {isPartial && (
                  <>
                    <p className="font-display font-bold text-[22px] mb-2" style={{ color: C.ink }}>
                      {executionResult.successful} of {executionResult.attempted} imported
                    </p>
                    <p className="text-[13px] mb-2" style={{ color: C.warn }}>
                      {executionResult.failed} {executionResult.failed === 1 ? 'contact' : 'contacts'} could not be saved. You can retry them below.
                    </p>
                    <button
                      type="button"
                      onClick={handleRetry}
                      disabled={importing}
                      className="mb-6 text-[13px] font-bold px-5 py-2.5 rounded-xl transition-opacity hover:opacity-90 disabled:opacity-50"
                      style={{ background: C.ember, color: '#fff' }}
                    >
                      {importing ? 'Retrying...' : `Retry ${executionResult.failed} failed`}
                    </button>
                  </>
                )}

                {isZero && (
                  <>
                    <p className="font-display font-bold text-[22px] mb-2" style={{ color: C.danger }}>
                      Import failed
                    </p>
                    <p className="text-[13px] mb-2" style={{ color: C.inkMid }}>
                      None of the {executionResult.attempted} contacts could be saved. Check your connection and try again.
                    </p>
                    <button
                      type="button"
                      onClick={handleRetry}
                      disabled={importing}
                      className="mb-6 text-[13px] font-bold px-5 py-2.5 rounded-xl transition-opacity hover:opacity-90 disabled:opacity-50"
                      style={{ background: C.ember, color: '#fff' }}
                    >
                      {importing ? 'Retrying...' : 'Try again'}
                    </button>
                  </>
                )}

                {!isZero && (
                  <div className="flex flex-col gap-3 max-w-[320px] mx-auto">
                    <button
                      type="button"
                      onClick={() => {
                        track('post_import_action_clicked', { action: 'view_contacts' })
                        navigate('/contacts', { state: { importBatch: result.importedIds ?? [] } })
                        onClose()
                      }}
                      className="w-full text-[14px] font-bold px-5 py-3 rounded-xl transition-opacity hover:opacity-90"
                      style={{ background: C.ember, color: '#fff' }}
                    >
                      Browse imported
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        track('post_import_action_clicked', { action: 'dismiss' })
                        navigate('/')
                        onClose()
                      }}
                      className="w-full text-[14px] font-semibold px-5 py-3 rounded-xl transition-colors"
                      style={{
                        background: 'transparent',
                        border: `1px solid ${C.border}`,
                        color: C.inkMid,
                      }}
                    >
                      Go home
                    </button>
                  </div>
                )}

                {/* Post-import chooser: log outreach for a specific just-imported contact */}
                {importedContacts.length > 0 && !isZero && (
                  <div
                    className="mt-6 pt-5 max-w-[320px] mx-auto text-left"
                    style={{ borderTop: `1px solid ${C.border}` }}
                  >
                    <p className="text-[12px] font-semibold mb-2.5 text-center" style={{ color: C.inkLow }}>
                      Or log a recent conversation
                    </p>
                    {importedContacts.length > 5 && (
                      <input
                        type="text"
                        value={chooserQuery}
                        onChange={e => setChooserQuery(e.target.value)}
                        placeholder="Search contacts..."
                        className="w-full rounded-xl px-3 py-2 text-[13px] mb-2 outline-none"
                        style={{ background: C.bgInput, border: `1px solid ${C.border}`, color: C.ink }}
                      />
                    )}
                    <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto">
                      {importedContacts
                        .filter(c => !chooserQuery || c.name.toLowerCase().includes(chooserQuery.toLowerCase()))
                        .slice(0, 10)
                        .map(c => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              track('post_import_action_clicked', { action: 'log_recent_outreach' })
                              navigate(`/contacts/${c.id}`, { state: { openInteractionForm: true } })
                              onClose()
                            }}
                            className="w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-colors hover:opacity-80"
                            style={{ background: C.bgCard, border: `1px solid ${C.borderSub}`, color: C.inkMid }}
                          >
                            {c.name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

        </div>

        {/* Footer */}
        <div
          className="px-6 py-4 flex-none flex items-center justify-between gap-3"
          style={{ borderTop: `1px solid ${C.border}` }}
        >
          {step === 'upload' && (
            <>
              <button
                type="button"
                onClick={requestClose}
                className="text-[14px] font-semibold transition-colors"
                style={{ color: C.inkLow }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={goToMap}
                disabled={sourcePreviewHeaders.length === 0 || aiLoading}
                className="flex items-center gap-2 text-[14px] font-bold px-5 py-[9px] rounded-xl transition-opacity hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: C.ember, color: '#fff' }}
              >
                {aiLoading ? (
                  <>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    Analyzing...
                  </>
                ) : (
                  'Next →'
                )}
              </button>
            </>
          )}
          {step === 'map' && (
            <>
              <button
                type="button"
                onClick={goBackToUpload}
                disabled={importing}
                className="text-[14px] font-semibold transition-colors disabled:opacity-40"
                style={{ color: C.inkLow }}
              >
                &larr; Back
              </button>
              <button
                type="button"
                onClick={goToReview}
                disabled={!hasNameMapped || importing}
                className="flex items-center gap-2 text-[14px] font-bold px-5 py-[9px] rounded-xl transition-opacity hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: C.ember, color: '#fff' }}
              >
                {importing ? (
                  <>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    Preparing...
                  </>
                ) : (
                  `Review contacts →`
                )}
              </button>
            </>
          )}
          {step === 'review' && (
            <>
              <button
                type="button"
                onClick={() => setStep('map')}
                disabled={importing}
                className="text-[14px] font-semibold transition-colors disabled:opacity-40"
                style={{ color: C.inkLow }}
              >
                &larr; Back
              </button>
              <button
                type="button"
                onClick={handleImportReview}
                disabled={selectedCount === 0 || importing}
                className="flex items-center gap-2 text-[14px] font-bold px-5 py-[9px] rounded-xl transition-opacity hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: C.ember, color: '#fff' }}
              >
                {importing ? (
                  <>
                    <span
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={execProgress}
                      aria-label="Importing contacts"
                      className="sr-only"
                    />
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    Importing...
                  </>
                ) : (
                  `Import ${selectedCount} ${selectedCount === 1 ? 'contact' : 'contacts'}`
                )}
              </button>
            </>
          )}
          {step === 'done' && (
            <div/>
          )}
        </div>
      </div>

      {/* Picker - fixed to viewport, light themed */}
      {picker && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setPicker(null)}/>
          <div
            className="fixed z-[70] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.15)] py-1 min-w-[180px] max-h-[260px] overflow-y-auto"
            style={{
              top: picker.pos.top,
              left: picker.pos.left,
              background: C.bg,
              border: `1px solid ${C.borderStr}`,
            }}
          >
            {picker.mode === 'field' ? (
              ignoredCols.length === 0 ? (
                <p className="px-3 py-2 text-[13px]" style={{ color: C.inkLower }}>No columns available</p>
              ) : (
                ignoredCols.map(col => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => addColumn(picker.key, col)}
                    className="w-full text-left px-3 py-[9px] text-[13px] transition-colors"
                    style={{ color: C.inkMid, fontFamily: '"JetBrains Mono", monospace' }}
                    onMouseEnter={e => { e.currentTarget.style.background = C.bgCard; e.currentTarget.style.color = C.ink }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.inkMid }}
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
                  className="w-full text-left px-3 py-[9px] text-[13px] transition-colors flex items-center justify-between gap-3"
                  style={{ color: C.inkMid }}
                  onMouseEnter={e => { e.currentTarget.style.background = C.bgCard; e.currentTarget.style.color = C.ink }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.inkMid }}
                >
                  <span>{field.label}</span>
                  {field.required && (
                    <span className="text-[10.5px] flex-none" style={{ color: C.danger, fontFamily: '"JetBrains Mono", monospace' }}>required</span>
                  )}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Source preview panel - shown on upload step after a file is parsed
function SourcePreview({ headers, rows, headerRowIndex }) {
  if (!headers.length) return null
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p
          className="text-[10.5px] font-bold tracking-[1px] uppercase"
          style={{ color: C.inkLower, fontFamily: '"JetBrains Mono", monospace' }}
        >
          SOURCE PREVIEW
        </p>
        <p className="text-[11px]" style={{ color: C.inkLower }}>
          {headerRowIndex > 0
            ? `preamble auto-skipped · header found on row ${headerRowIndex + 1}`
            : 'first rows shown before mapping'}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl" style={{ border: `1px solid ${C.border}` }}>
        <table className="w-full" style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
          <thead>
            <tr style={{ background: C.bgCard, borderBottom: `1px solid ${C.border}` }}>
              {headers.slice(0, 6).map((h, i) => (
                <th key={i} className="px-3 py-2 text-left whitespace-nowrap font-bold"
                  style={{ color: C.inkMid }}>
                  {h}
                </th>
              ))}
              {headers.length > 6 && (
                <th className="px-3 py-2 text-left" style={{ color: C.inkLower }}>
                  +{headers.length - 6} more
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(Math.max(0, headerRowIndex), headerRowIndex + 4).filter((_, ri) => ri > 0).slice(0, 3).map((row, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.borderSub}` }}>
                {headers.slice(0, 6).map((h, ci) => {
                  const val = Array.isArray(row) ? (row[ci] ?? '') : (row[h] ?? '')
                  return (
                    <td key={ci} className="px-3 py-1.5 max-w-[140px]">
                      <span className="block truncate" style={{ color: C.inkMid }}>{val || ''}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
