import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Returns today's date in YYYY-MM-DD using local time (not UTC) to match
// the same convention used throughout the rest of the app.
function getLocalToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Formats the user's contacts and interactions into a structured, readable
// context block for Claude. Notes are capped at 300 characters so one long
// note can't dominate the token budget. Overdue follow-ups are flagged
// explicitly so the assistant can surface them naturally.
function formatNetworkContext(contacts: any[], interactions: any[], today: string): string {
  if (contacts.length === 0) {
    return 'THE USER\'S NETWORK:\nNo contacts have been logged yet.'
  }

  // Group interactions by contact_id (DB query is already date-ordered ascending)
  const byContact = new Map<string, any[]>()
  for (const ix of interactions) {
    const list = byContact.get(ix.contact_id) ?? []
    list.push(ix)
    byContact.set(ix.contact_id, list)
  }

  const lines: string[] = [`CONTACTS (${contacts.length} total):\n`]

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]
    const cInteractions = byContact.get(c.id) ?? []

    const meta: string[] = []
    if (c.company) meta.push(`Company: ${c.company}`)
    if (c.role)    meta.push(`Role: ${c.role}`)
    if (c.how_met) meta.push(`How met: ${c.how_met}`)

    lines.push(`[${i + 1}] ${c.name}`)
    if (meta.length)        lines.push(`  ${meta.join(' | ')}`)
    if (c.tags?.length)     lines.push(`  Tags: ${c.tags.join(', ')}`)
    if (c.skills?.length)   lines.push(`  Skills: ${c.skills.join(', ')}`)
    if (c.email)            lines.push(`  Email: ${c.email}`)

    if (cInteractions.length === 0) {
      lines.push(`  No interactions logged`)
    } else {
      lines.push(`  Interactions (${cInteractions.length}):`)
      for (const ix of cInteractions) {
        const notes    = ix.notes
          ? ` — ${ix.notes.slice(0, 300)}${ix.notes.length > 300 ? '…' : ''}`
          : ''
        const followUp = ix.follow_up_date
          ? ` [Follow up: ${ix.follow_up_date}${ix.follow_up_date < today ? ' — OVERDUE' : ''}]`
          : ''
        lines.push(`    • ${ix.interaction_date} ${ix.type}${notes}${followUp}`)
      }
    }
    lines.push('') // blank line between contacts for readability
  }

  return lines.join('\n')
}

const SYSTEM_PROMPT = `You are Funnl AI, a thinking partner built into Funnl — a CRM for students managing their networks during internship and job recruiting.

Your primary job is to help the user explore and understand their own network data. When they ask a question, answer it accurately and usefully. Surface patterns, flag things worth their attention, and help them discover what they can learn from what they've logged.

Advice is secondary and offered humbly. You only see what has been logged — not the full human context (the user's read on people, conversations that weren't written down, their own goals and instincts). On genuine judgment calls — who to reach out to, what to say, which opportunity to prioritize — lay out what you observe and what's worth considering, then defer to the user. They know these people; you know the data.

STYLE
Write like a sharp mentor messaging you — not a formatted report. Natural prose is the default: full sentences, flowing paragraphs. Most replies should be two to four sentences. Expand only when the answer genuinely requires it.

Formatting rules:
- No bullet lists unless you're genuinely listing four or more distinct items where a list adds real clarity. Two or three connected thoughts belong in a sentence, not a list.
- Don't bold names, companies, or dates. Names are just names in a sentence. Use bold only when something truly warrants it — rarely.
- No italics for emphasis. Avoid AI-formatting tics in general.

Tone and substance:
- Warm and professional. Knowledgeable and personable, not stiff. Like someone who respects your time.
- Specific and concrete — cite real names, dates, and patterns from the data. Vague observations are useless.
- Observations and suggestions, not directives. "A few contacts have gone quiet — might be worth a check-in" rather than "You should reach out to Priya." "Here's what I notice; you know these people better than I do."
- Honest. If something is worth flagging — a gap, a pattern, a habit — say it clearly and constructively. Say it once; don't be preachy.
- If the user seems unsure what to ask, offer a few starting points in a natural sentence or two — not a bulleted menu.

ACCURACY — CRITICAL
- Answer only from the network data provided below. Do not invent contacts, companies, roles, interactions, or any detail not in the data.
- If something is not in the data, say so clearly: "I don't see that in your Funnl data" or "Nothing's been logged about that yet."
- If the data is sparse or a question can't be answered from what's been logged, say so honestly. Suggest what logging would help next time if relevant.

SCOPE — IMPORTANT
You only discuss topics related to this user's contacts and interactions, networking strategy, job search and recruiting, and how to use Funnl. If asked about anything outside this — trivia, general knowledge, coding, math, news, or anything unrelated — politely decline and redirect. Example: "I'm focused on your network and job search — I'm not set up for general questions. Is there something in your contacts I can help you explore?"

TODAY'S DATE: {today}

{network_data}`

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

    // ── 3. Parse request body ──────────────────────────────────────────────────
    const { messages } = await req.json()
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No messages provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // The Anthropic API requires the first message to have role: 'user'.
    // The UI shows a locally-generated opening assistant message that Claude never
    // said — strip any leading assistant messages before sending to Anthropic.
    const anthropicMessages = messages[0]?.role === 'assistant' ? messages.slice(1) : messages
    if (anthropicMessages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No user message found' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Load this user's contacts + interactions (scoped to user.id only) ──
    // Uses service-role key so RLS doesn't interfere, but all queries are
    // explicitly filtered to user.id — one user's data never reaches another's call.
    const [{ data: contacts }, { data: interactions }] = await Promise.all([
      supabaseAdmin
        .from('contacts')
        .select('id, name, company, role, how_met, email, linkedin_url, tags, skills, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('interactions')
        .select('id, contact_id, type, interaction_date, notes, follow_up_date')
        .eq('user_id', user.id)
        .order('interaction_date', { ascending: true }),
    ])

    // ── 5. Build system prompt with today's date + formatted network context ──
    const today = getLocalToday()
    const networkData = formatNetworkContext(contacts ?? [], interactions ?? [], today)
    const systemPrompt = SYSTEM_PROMPT
      .replace('{today}', today)
      .replace('{network_data}', networkData)

    // ── 6. Call Claude ─────────────────────────────────────────────────────────
    // ANTHROPIC_API_KEY is stored in Supabase secrets — never in any file in this repo.
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: anthropicMessages,
      }),
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text()
      console.error('Anthropic API error status:', anthropicRes.status)
      console.error('Anthropic API error body:', errText)
      return new Response(
        JSON.stringify({ error: 'AI service error — please try again' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const anthropicData = await anthropicRes.json()
    const textBlock = anthropicData.content?.find((block: any) => block.type === 'text')
    const reply = textBlock?.text ?? ''

    return new Response(
      JSON.stringify({ reply }),
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
