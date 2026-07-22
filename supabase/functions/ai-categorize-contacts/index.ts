import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ALLOWED_REL_TYPES = new Set([
  'Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other',
])

// Cap at 200 contacts per call to keep prompt size manageable
const MAX_CONTACTS = 200

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

    // ── 3. Parse and validate input ────────────────────────────────────────────
    const body = await req.json()
    const rawContacts: unknown = body?.contacts

    if (!Array.isArray(rawContacts) || rawContacts.length === 0) {
      return new Response(
        JSON.stringify({ error: 'contacts must be a non-empty array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Sanitize input ─────────────────────────────────────────────────────
    // Only non-PII fields go to Claude. Names, emails, and LinkedIn URLs are
    // intentionally excluded — they are not needed for category inference.
    const validRowIds = new Set<string>()
    const sanitized = (rawContacts as unknown[]).slice(0, MAX_CONTACTS).flatMap((c: unknown) => {
      if (typeof c !== 'object' || c === null) return []
      const contact = c as Record<string, unknown>
      const rowId = typeof contact.row_id === 'string' ? contact.row_id.slice(0, 64) : null
      if (!rowId) return []
      validRowIds.add(rowId)
      return [{
        row_id: rowId,
        company: typeof contact.company === 'string' ? contact.company.slice(0, 200) : null,
        role: typeof contact.role === 'string' ? contact.role.slice(0, 200) : null,
        how_met: typeof contact.how_met === 'string' ? contact.how_met.slice(0, 200) : null,
        relationship_note: typeof contact.relationship_note === 'string'
          ? contact.relationship_note.slice(0, 400)
          : null,
        existing_tags: Array.isArray(contact.existing_tags)
          ? (contact.existing_tags as unknown[])
              .filter((t): t is string => typeof t === 'string')
              .slice(0, 10)
          : [],
        existing_relationship_type: typeof contact.existing_relationship_type === 'string'
          ? contact.existing_relationship_type
          : null,
      }]
    })

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
- suggested_tags: informal relationship labels like "recruiter", "alumni", "mentor", "founder", "target firm". Max 3 per contact, lowercased. Only suggest if clearly inferable from the contact's role and company. Use [] if uncertain.
- suggested_relationship_type: one of Mentor, Collaborator, Referral path, Potential employer, Connector, Other — or null. Only if the role/company strongly suggests one type.

Rules:
1. Return the SAME row_id you received — do not modify it
2. Be conservative: a wrong suggestion is worse than no suggestion
3. Do not suggest tags or types already listed in existing_tags or existing_relationship_type
4. Never infer sensitive attributes (health, politics, religion, demographics)
5. Return ONLY a valid JSON array — no markdown fences, no explanation

Contacts to categorize:
${contactsJson}

Return format — one entry per contact, in the same order:
[
  { "row_id": "...", "suggested_tags": [...], "suggested_relationship_type": null },
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
      console.error('Anthropic API error:', await anthropicRes.text())
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
      console.error('Failed to parse Claude output as JSON:', rawContent)
      return new Response(
        JSON.stringify({ error: 'Could not parse AI response — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!Array.isArray(parsed)) {
      console.error('Claude returned non-array:', rawContent)
      return new Response(
        JSON.stringify({ error: 'Unexpected AI response format — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 8. Sanitize output ─────────────────────────────────────────────────────
    // row_id must match one we sent; tags must be safe strings; relType must be
    // one of the allowed enum values. Entries with nothing actionable are dropped.
    const suggestions = (parsed as unknown[]).flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return []
      const e = entry as Record<string, unknown>

      const rowId = typeof e.row_id === 'string' ? e.row_id : null
      if (!rowId || !validRowIds.has(rowId)) return []

      const rawTags = Array.isArray(e.suggested_tags) ? e.suggested_tags : []
      const tags = (rawTags as unknown[])
        .filter((t): t is string =>
          typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 50
        )
        .slice(0, 3)
        .map(t => t.trim().toLowerCase())

      const relType = typeof e.suggested_relationship_type === 'string' &&
        ALLOWED_REL_TYPES.has(e.suggested_relationship_type)
        ? e.suggested_relationship_type
        : null

      if (tags.length === 0 && !relType) return []

      return [{ row_id: rowId, suggested_tags: tags, suggested_relationship_type: relType }]
    })

    return new Response(
      JSON.stringify({ suggestions }),
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
