import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ALLOWED_REL_TYPES = new Set([
  'Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other',
])

const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low'])

// Clients generate crypto.randomUUID() v4 UUIDs for row_id.
// Validate strictly: no truncation, no mutation, no logging of IDs.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Cap at 20 contacts per call — client batches larger imports.
// Oversized requests are rejected with HTTP 400 (not silently sliced).
const MAX_CONTACTS = 20

// Normalize a tag string: trim, lowercase, reject empty or >50 chars.
// Returns null for invalid inputs.
function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  if (t.length === 0 || t.length > 50) return null
  return t
}

// Normalize an array of tags: strings only, trim, lowercase, dedup, max `limit`.
function normalizeTags(rawTags: unknown[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of rawTags) {
    const t = normalizeTag(raw)
    if (t && !seen.has(t)) {
      seen.add(t)
      result.push(t)
      if (result.length >= limit) break
    }
  }
  return result
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Verify the caller's auth token ─────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2. Check ai_enabled via service-role key (authoritative) ──────────────
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('ai_enabled')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile?.ai_enabled) {
      return new Response(
        JSON.stringify({ error: 'Funnl AI is a Pro feature — access not enabled for this account' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Parse and size-check input ─────────────────────────────────────────
    const body = await req.json()
    const rawContacts: unknown = body?.contacts

    if (!Array.isArray(rawContacts) || rawContacts.length === 0) {
      return new Response(
        JSON.stringify({ error: 'contacts must be a non-empty array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (rawContacts.length > MAX_CONTACTS) {
      return new Response(
        JSON.stringify({ error: `Too many contacts — send at most ${MAX_CONTACTS} per call` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Validate and sanitize input ────────────────────────────────────────
    // row_id: must be a valid UUID v4 — no truncation, not derived from contact data.
    // Duplicate input row_ids are rejected outright so the output is always unambiguous.
    // Names, emails, and LinkedIn URLs are excluded — not needed for category inference.
    const seenInputIds = new Set<string>()

    const sanitized: Array<{
      row_id: string
      company: string | null
      role: string | null
      how_met: string | null
      relationship_note: string | null
      existing_tags: string[]
      existing_relationship_type: string | null
    }> = []

    for (const c of rawContacts as unknown[]) {
      if (typeof c !== 'object' || c === null) continue
      const contact = c as Record<string, unknown>

      // UUID v4 validation — no truncation, no .slice()
      const rowId = typeof contact.row_id === 'string' ? contact.row_id : null
      if (!rowId || !UUID_V4_RE.test(rowId)) {
        return new Response(
          JSON.stringify({ error: 'Each contact must include a valid UUID v4 row_id' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      if (seenInputIds.has(rowId)) {
        return new Response(
          JSON.stringify({ error: 'Duplicate row_id in request — each contact must have a unique row_id' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      seenInputIds.add(rowId)

      // existing_tags: sanitize for use as context (trim, lowercase, cap) without
      // mutating the contact's actual explicit CSV tags
      const rawExistingTags = Array.isArray(contact.existing_tags) ? contact.existing_tags : []
      const existingTags = normalizeTags(rawExistingTags as unknown[], 10)

      sanitized.push({
        row_id: rowId,
        company: typeof contact.company === 'string' ? contact.company.slice(0, 200) : null,
        role: typeof contact.role === 'string' ? contact.role.slice(0, 200) : null,
        how_met: typeof contact.how_met === 'string' ? contact.how_met.slice(0, 200) : null,
        relationship_note: typeof contact.relationship_note === 'string'
          ? contact.relationship_note.slice(0, 400)
          : null,
        existing_tags: existingTags,
        existing_relationship_type: typeof contact.existing_relationship_type === 'string' &&
          ALLOWED_REL_TYPES.has(contact.existing_relationship_type)
          ? contact.existing_relationship_type
          : null,
      })
    }

    if (sanitized.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No valid contacts after sanitization' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 5. Build the prompt ────────────────────────────────────────────────────
    const contactsJson = JSON.stringify(sanitized, null, 2)

    const prompt = `You are categorizing contacts in Funnl, a networking CRM for students recruiting for internships and jobs.

For each contact below, suggest:
- suggested_tags: informal relationship labels like "recruiter", "alumni", "mentor", "founder", "target firm". Max 5 per contact, lowercased. Only suggest if clearly inferable from the contact's role and company. Use [] if uncertain.
- suggested_relationship_type: one of Mentor, Collaborator, Referral path, Potential employer, Connector, Other — or null. Only if the role/company strongly suggests one type.
- confidence: exactly "high", "medium", or "low". Required on every entry.
  - high: very clear from role and company (e.g. role=Recruiter → suggested_tags=["recruiter"])
  - medium: probable but not certain
  - low: speculative

Rules:
1. Return the SAME row_id you received — do not modify it
2. Be conservative: a wrong suggestion is worse than no suggestion
3. Do not suggest tags or types already listed in existing_tags or existing_relationship_type
4. Never infer sensitive attributes (health, politics, religion, demographics)
5. You may omit contacts where you have no useful suggestions
6. Return ONLY a valid JSON array — no markdown fences, no explanation

Contacts to categorize:
${contactsJson}

Return format — include only contacts where you have at least one suggestion:
[
  { "row_id": "...", "suggested_tags": [...], "suggested_relationship_type": null, "confidence": "high" },
  ...
]`

    // ── 6. Call Anthropic Haiku ────────────────────────────────────────────────
    // ANTHROPIC_API_KEY is stored in Supabase secrets — never in any file in this repo.
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!anthropicRes.ok) {
      // Log status only — never log response body which may echo contact data
      console.error('[ai-categorize-contacts] provider_error', anthropicRes.status)
      return new Response(
        JSON.stringify({ error: 'AI service error — please try again' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const anthropicData = await anthropicRes.json()
    let rawContent = (anthropicData.content?.[0]?.text ?? '').trim()

    if (rawContent.startsWith('```')) {
      rawContent = rawContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    }

    // ── 7. Parse Claude's response ─────────────────────────────────────────────
    let parsed: unknown
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      console.error('[ai-categorize-contacts] invalid_json')
      return new Response(
        JSON.stringify({ error: 'Could not parse AI response — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!Array.isArray(parsed)) {
      console.error('[ai-categorize-contacts] invalid_shape')
      return new Response(
        JSON.stringify({ error: 'Unexpected AI response format — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 8. Sanitize and deduplicate output ────────────────────────────────────
    // - row_id must match one we sent; unknown IDs are discarded
    // - first valid suggestion per row_id wins; later duplicates are ignored
    // - confidence must be valid; invalid → entire suggestion discarded
    // - tags: strings only, trim, lowercase, dedup, max 5, max 50 chars each
    // - relType: must be one of the allowed values
    const usedOutputIds = new Set<string>()

    const suggestions = (parsed as unknown[]).flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return []
      const e = entry as Record<string, unknown>

      const rowId = typeof e.row_id === 'string' ? e.row_id : null
      if (!rowId || !seenInputIds.has(rowId)) return [] // unknown or missing row_id
      if (usedOutputIds.has(rowId)) return []            // duplicate output — first wins
      usedOutputIds.add(rowId)

      // confidence is required and must be a known value; discard the whole entry if invalid
      if (!ALLOWED_CONFIDENCE.has(e.confidence as string)) return []
      const confidence = e.confidence as 'high' | 'medium' | 'low'

      const rawTags = Array.isArray(e.suggested_tags) ? e.suggested_tags : []
      const tags = normalizeTags(rawTags as unknown[], 5)

      const relType = typeof e.suggested_relationship_type === 'string' &&
        ALLOWED_REL_TYPES.has(e.suggested_relationship_type)
        ? e.suggested_relationship_type
        : null

      if (tags.length === 0 && !relType) return []

      return [{ row_id: rowId, suggested_tags: tags, suggested_relationship_type: relType, confidence }]
    })

    return new Response(
      JSON.stringify({ suggestions }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch {
    console.error('[ai-categorize-contacts] unexpected_error')
    return new Response(
      JSON.stringify({ error: 'Something went wrong — please try again' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
