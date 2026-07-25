import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { UUID_V4_RE, MAX_CONTACTS, ALLOWED_REL_TYPES, normalizeTags, sanitizeOutput } from '../shared/categorization-helpers.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    // Minimized categorization context: company, role, how met, existing tags, and existing
    // relationship type. Names, email addresses, LinkedIn URLs, and freeform relationship
    // notes are excluded.
    const seenInputIds = new Set<string>()

    const sanitized: Array<{
      row_id: string
      company: string | null
      role: string | null
      how_met: string | null
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
        existing_tags: existingTags,
        existing_relationship_type: typeof contact.existing_relationship_type === 'string' &&
          ALLOWED_REL_TYPES.has(contact.existing_relationship_type as string)
          ? contact.existing_relationship_type as string
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

    const prompt = `You are categorizing contacts in Funnl, a networking CRM for students recruiting for competitive internships and jobs.

For each contact, suggest tags and a relationship type based ONLY on the company and role fields.

suggested_tags rules:
- Maximum 5 suggestions per contact
- Lowercase, concise networking labels
- Prefer a consistent vocabulary: recruiter, alumni, mentor, founder, investor, hiring manager, target firm, referral source, connector
- Only suggest what the company/role clearly supports — a wrong tag is worse than no tag
- Do not create a company-name tag just because a company exists (unless it has strategic meaning like "target firm")
- Do not duplicate information already in existing_tags or the relationship type
- Avoid near-synonyms: recruiter vs recruiting, founder vs startup founder, alumni vs alumnus
- Never infer sensitive attributes (health, race, religion, politics, sexuality, disability, financial status)

suggested_relationship_type rules:
- Must be one of: Mentor, Collaborator, Referral path, Potential employer, Connector, Other — or null
- Only choose if the company/role strongly indicates it
- Null is better than a speculative guess

confidence rules:
- high: very clear from role/company (e.g. role=Recruiter → ["recruiter"], high)
- medium: probable but not certain
- low: speculative — user must manually confirm before import

Rules:
1. Return the SAME row_id you received — do not modify it
2. Be conservative: a wrong suggestion is worse than no suggestion
3. Do not suggest tags/types already in existing_tags or existing_relationship_type
4. Omit contacts where you have no useful suggestions
5. Return ONLY a valid JSON array — no markdown fences, no explanation

Contacts:
${contactsJson}

Return format (only contacts with at least one suggestion):
[
  { "row_id": "...", "suggested_tags": [...], "suggested_relationship_type": null, "confidence": "high" }
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

    // ── 8. Sanitize and deduplicate output via shared helper ──────────────────
    // - row_id must match one we sent; unknown IDs are discarded
    // - first valid suggestion per row_id wins; later duplicates are ignored
    // - confidence must be valid; invalid → entire suggestion discarded
    // - tags: strings only, trim, lowercase, dedup, max 5, max 50 chars each
    // - relType: must be one of the allowed values
    const suggestions = sanitizeOutput(parsed, seenInputIds)
    if (suggestions === null) {
      console.error('[ai-categorize-contacts] invalid_shape')
      return new Response(
        JSON.stringify({ error: 'Unexpected AI response format — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

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
