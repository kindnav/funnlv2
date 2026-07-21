import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// The complete set of Funnl contact fields. Used to sanitize Claude's response
// so a hallucinated field name can never make it into the assignment.
const FUNNL_FIELDS = [
  'name', 'company', 'role', 'email', 'linkedin_url',
  'how_met', 'tags', 'relationship_type', 'relationship_note',
]

Deno.serve(async (req) => {
  // Browsers send a preflight OPTIONS request before the real call
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
    // The service-role key bypasses RLS — the user can't manipulate what we read.
    // It is automatically injected by Supabase and never appears in any file.
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

    // ── 3. Parse and validate input ────────────────────────────────────────────
    const body = await req.json()
    const headers: unknown = body?.headers
    const sampleRows: unknown = body?.sample_rows
    const inferCategories: boolean = body?.infer_categories === true

    if (
      !Array.isArray(headers) ||
      headers.length === 0 ||
      !headers.every((h: unknown) => typeof h === 'string')
    ) {
      return new Response(
        JSON.stringify({ error: 'headers must be a non-empty array of strings' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!Array.isArray(sampleRows)) {
      return new Response(
        JSON.stringify({ error: 'sample_rows must be an array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Build the prompt ────────────────────────────────────────────────────
    // Cost: one call per CSV, not per row. Claude sees headers + up to 3 sample rows,
    // infers the mapping, and that mapping is applied in code to all rows.
    const headersJson = JSON.stringify(headers)
    const samples = sampleRows.slice(0, 3)
    const sampleJson = JSON.stringify(samples, null, 2)

    const categorySection = inferCategories ? `

Additionally, look at the sample row VALUES (not just headers) to suggest tags and a relationship type for these contacts.

Rules for category suggestions:
- suggested_tags: informal relationship labels like "recruiter", "alumni", "target firm", "mentor". Only suggest if clearly inferrable from role/company values. Max 3 tags. Empty array if uncertain.
- suggested_relationship_type: one of: Mentor, Collaborator, Referral path, Potential employer, Connector, Other — or null. Only suggest if the data strongly points to one type for the majority of contacts. Null if mixed or unclear.
- Never infer political views, health status, demographics, or other sensitive personal attributes.
- Conservative: it is better to suggest nothing than to suggest something wrong.

Add to your JSON response:
  "suggested_tags": [...],
  "suggested_relationship_type": null or one of the allowed values` : ''

    const prompt = `You are mapping CSV column headers to fields in a contact management app called Funnl.

The app stores these fields for each contact:
- name: person's full name (required — every contact needs this)
- company: employer or organization they work at
- role: job title or position
- email: email address
- linkedin_url: LinkedIn profile URL
- how_met: context for how the user met this person (e.g. "Career fair", "Coffee chat")
- tags: informal labels for the relationship (e.g. "recruiter", "alumni", "mentor")
- relationship_type: one of: Mentor, Collaborator, Referral path, Potential employer, Connector, Other
- relationship_note: why this person matters or how they can help — also use this for any general notes, comments, or memo columns about the person (freeform)

Given the CSV headers and sample values below, return a JSON object mapping CSV column names to Funnl fields.

Rules:
1. Each CSV column may appear under at most ONE Funnl field — never put the same column in two fields
2. A Funnl field may list more than one column (e.g. "First Name" and "Last Name" both map to "name", in that order)
3. Only include a column if you are confident it belongs to that field — a wrong mapping is worse than leaving a column unassigned
4. If a column is ambiguous or clearly belongs to none of the fields, omit it entirely
5. Return ONLY a raw JSON object — no explanation, no markdown, no code fences
${categorySection}
Return format:
{
  "assignment": {
    "name": [...column names...],
    "company": [...],
    "role": [...],
    "email": [...],
    "linkedin_url": [...],
    "how_met": [...],
    "tags": [...],
    "relationship_type": [...],
    "relationship_note": [...]
  },
  "notes": "optional one-sentence note only if something is genuinely notable (e.g. a column appears to contain combined data that could not be cleanly mapped)"${inferCategories ? `,
  "suggested_tags": [],
  "suggested_relationship_type": null` : ''}
}

Only include fields that have at least one column. Omit "notes" entirely if there is nothing notable to say.

CSV headers: ${headersJson}
Sample rows (first ${samples.length}):
${sampleJson}`

    // ── 5. Call Anthropic ──────────────────────────────────────────────────────
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
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!anthropicRes.ok) {
      console.error('Anthropic API error:', await anthropicRes.text())
      return new Response(
        JSON.stringify({ error: 'AI service error — please try again' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const anthropicData = await anthropicRes.json()
    let rawContent = (anthropicData.content?.[0]?.text ?? '').trim()

    // Strip markdown code fences if the model wraps output despite instructions
    if (rawContent.startsWith('```')) {
      rawContent = rawContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    }

    // ── 6. Parse Claude's response ─────────────────────────────────────────────
    let parsed: {
      assignment?: Record<string, unknown>,
      notes?: unknown,
      suggested_tags?: unknown,
      suggested_relationship_type?: unknown,
    }
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      console.error('Failed to parse Claude output as JSON:', rawContent)
      return new Response(
        JSON.stringify({ error: 'Could not parse AI response — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 7. Sanitize: only valid Funnl fields, only headers that exist in the input ──
    // This ensures a hallucinated field name or column name can never reach the frontend.
    const headerSet = new Set(headers as string[])
    const safeAssignment: Record<string, string[]> = {}

    for (const field of FUNNL_FIELDS) {
      const rawCols = (parsed.assignment?.[field] ?? [])
      if (!Array.isArray(rawCols)) continue
      const validCols = rawCols.filter(
        (c: unknown): c is string => typeof c === 'string' && headerSet.has(c)
      )
      if (validCols.length > 0) safeAssignment[field] = validCols
    }

    // Enforce no-duplicate-column rule across fields (first field in FUNNL_FIELDS order wins)
    const usedCols = new Set<string>()
    for (const field of FUNNL_FIELDS) {
      if (!safeAssignment[field]) continue
      safeAssignment[field] = safeAssignment[field].filter(c => !usedCols.has(c))
      safeAssignment[field].forEach(c => usedCols.add(c))
      if (safeAssignment[field].length === 0) delete safeAssignment[field]
    }

    const notes = typeof parsed.notes === 'string' && parsed.notes.trim()
      ? parsed.notes.trim()
      : undefined

    // ── 8. Sanitize category suggestions (infer_categories path only) ──────────
    const ALLOWED_REL_TYPES = new Set([
      'Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other'
    ])

    let suggestedTags: string[] | undefined
    let suggestedRelType: string | null | undefined

    if (inferCategories) {
      // Tags: array of non-empty strings, max 5 each ≤ 50 chars (stops prompt injection via tag content)
      if (Array.isArray(parsed.suggested_tags)) {
        const rawTags = parsed.suggested_tags.filter(
          (t: unknown): t is string =>
            typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 50
        )
        suggestedTags = rawTags.slice(0, 5).map((t: string) => t.trim().toLowerCase())
      }

      // Relationship type: must be one of the allowed enum values
      if (
        typeof parsed.suggested_relationship_type === 'string' &&
        ALLOWED_REL_TYPES.has(parsed.suggested_relationship_type)
      ) {
        suggestedRelType = parsed.suggested_relationship_type
      } else {
        suggestedRelType = null
      }
    }

    return new Response(
      JSON.stringify({
        assignment: safeAssignment,
        ...(notes ? { notes } : {}),
        ...(inferCategories ? {
          suggested_tags: suggestedTags ?? [],
          suggested_relationship_type: suggestedRelType ?? null,
        } : {}),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(
      JSON.stringify({ error: 'Something went wrong — please try again' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
