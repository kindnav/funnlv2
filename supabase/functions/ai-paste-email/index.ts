// ai-paste-email - Pro only. A pasted email exchange in; a contact-field proposal, an
// interaction-note draft, the addresses found (for matching in the user's own browser) and
// a date decision out. Nothing is saved here: the user reviews and saves in the app.
//
// All logic lives in ../shared/pasteEmail.js (pure, tested). This file only wires the
// request, the caller's identity, the Pro check and the bounded Anthropic transport.
//
// NEVER LOGGED: the pasted text, the masked text, any model output, any address. Log lines
// carry the controlled codes handlePasteEmail emits and nothing else.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { loadProEntitlement, decideEntitlement } from '../shared/pro-entitlement.js'
import { callDraftModel } from '../shared/outlookDraftContract.js'
import { handlePasteEmail, MAX_PASTE_CHARS } from '../shared/pasteEmail.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
// The JSON envelope around at most MAX_PASTE_CHARS of text; anything far larger is refused
// before it is parsed.
const MAX_BODY_CHARS = MAX_PASTE_CHARS * 6 + 1024

function reply (status: number, json: unknown) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function log (event: string, fields: Record<string, unknown>) {
  console.error(event, JSON.stringify(fields))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply(405, { code: 'method_not_allowed' })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return reply(401, { code: 'not_authenticated' })
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) return reply(401, { code: 'not_authenticated' })

    const raw = await req.text()
    if (raw.length > MAX_BODY_CHARS) { log('paste_email', { code: 'too_long' }); return reply(413, { code: 'too_long' }) }
    let body: unknown
    try { body = JSON.parse(raw) } catch { log('paste_email', { code: 'bad_type' }); return reply(400, { code: 'bad_type' }) }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

    const result = await handlePasteEmail(
      { text: (body as { text?: unknown })?.text },
      {
        // The same decision every AI function uses: permanent Pro, an active trial, or a
        // subscription the billing policy grants (active, past_due). 'unknown' - a failed
        // lookup with no proven access - is a retryable error, never a false 403.
        loadEntitlement: async () => {
          const decision = decideEntitlement(await loadProEntitlement(supabaseAdmin, user.id), new Date())
          if (decision.status === 'unknown') return { canUse: false, error: true }
          return { canUse: decision.status === 'allow' }
        },
        callModel: (requestBody: unknown) => callDraftModel({ body: requestBody, apiKey, fetchImpl: fetch }),
        log,
        now: () => new Date(),
      },
    )
    return reply(result.status, result.json)
  } catch (err) {
    // The error's name only: a message can carry fragments of a request or a reply.
    log('paste_email', { code: 'unexpected', name: (err as Error)?.name ?? 'error' })
    return reply(500, { code: 'unexpected' })
  }
})
