import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Browsers send a preflight OPTIONS request before the real call — return OK immediately
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

    // User-scoped client: respects RLS, and verifies the token is real + not expired
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

    // ── 2. Check ai_enabled using the service-role key (authoritative) ─────────
    // The service-role key bypasses RLS so the user can't manipulate what we read.
    // It is automatically injected by Supabase — it never appears in any file we write.
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

    // ── 3. Get the input text ──────────────────────────────────────────────────
    const body = await req.json()
    const text = (body?.text ?? '').trim()
    if (!text) {
      return new Response(
        JSON.stringify({ error: 'No text provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Call the Anthropic API ──────────────────────────────────────────────
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
        messages: [{
          role: 'user',
          content: `Parse the following text about a person into contact fields.
Return ONLY a raw JSON object — no explanation, no markdown, no code fences.
Only extract fields that are explicitly and clearly stated in the text.
Do not infer, guess, complete partial information, or make assumptions about anything not directly stated.
If a detail is ambiguous or only implied, omit that field entirely.

Fields to extract (include only those explicitly present in the text):
- name (string) — full name of the person
- company (string) — company or organization they work at
- role (string) — their job title or role
- email (string) — only if a complete email address is explicitly stated
- linkedin_url (string) — only if a linkedin.com URL is explicitly stated
- how_met (string) — where or how you met them, e.g. "Career fair", "Coffee chat"
- tags (array of strings) — relationship labels e.g. ["recruiter", "alumni", "target firm"]
- skills (array of strings) — technical or professional skills e.g. ["Python", "Excel"]
- follow_up_suggestion (string) — only if a specific timeframe is explicitly mentioned, e.g. "2 weeks", "next Monday"

Text: ${JSON.stringify(text)}`,
        }],
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

    // ── 5. Parse the JSON Claude returned ─────────────────────────────────────
    let contact
    try {
      contact = JSON.parse(rawContent)
    } catch {
      console.error('Failed to parse Claude output as JSON:', rawContent)
      return new Response(
        JSON.stringify({ error: 'Could not parse AI response — please try again' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ contact }),
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
