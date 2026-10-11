// The scenarios for tests/local/outlook-thread-segments-flow.mjs.
//
// Split out only so the harness plumbing and the behaviour under test stay readable
// separately. Everything here runs against the REAL database functions over real
// PostgREST, with the run module driving controlled Graph and Anthropic fixtures.

export async function run (h) {
  const {
    test, thread, world, newCounts, round, seed, psql, num, refRows,
    pendingInteractions, pendingNewContacts, storedInteractions, RING_V1, RING_V2, draftFor,
    NOTES, applySegments, acceptInteraction, acceptNewContact, http, TOK, shippedRound,
    ME, KNOWN, STRANGER, LEGACY_NEW, MAX_RECOVERY_MESSAGES_PER_FOLDER, assert,
  } = h

  const open = (list) => list.filter((r) => r[1] === 'pending')

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 1a: a GENUINE pre-feature proposal, written by the SHIPPED producer')
  // The segments migration is not applied yet. These rows are what a real pilot account
  // already holds: a candidate_refs row with NO conversation fingerprint and NO coverage,
  // under BOTH anchor forms - `episode:<contactId>` for someone already a contact and
  // `episode:new-contact` for someone who was not.
  // ══════════════════════════════════════════════════════════════════════════
  psql(seed(), { tuplesOnly: false })

  const legacyKnown = thread({ party: KNOWN, conv: 'conv-legacy-known', turns: [
    ['them', '2026-09-01T09:00:00Z', 'FIRST-IN good to meet you at the panel on Tuesday.'],
    ['me', '2026-09-01T15:00:00Z', 'FIRST-OUT thank you, I will send my CV this week.'],
    ['them', '2026-09-08T09:00:00Z', 'LATER-IN the credit desk has a spring opening, Thursday?'],
    ['me', '2026-09-08T15:00:00Z', 'LATER-OUT Thursday at three works, thank you.'],
    ['them', '2026-09-15T09:00:00Z', 'THIRD-IN the desk head passed on some feedback.'],
    ['me', '2026-09-15T15:00:00Z', 'THIRD-OUT thank you, I will write a short note.'],
  ] })
  const legacyNew = thread({ party: LEGACY_NEW, conv: 'conv-legacy-new', turns: [
    ['them', '2026-09-02T09:00:00Z', 'FIRST-IN I can review your application for the cohort.'],
    ['me', '2026-09-02T15:00:00Z', 'FIRST-OUT thank you, sending my CV tomorrow.'],
    ['them', '2026-09-09T09:00:00Z', 'LATER-IN the programme lead would like a short call.'],
    ['me', '2026-09-09T15:00:00Z', 'LATER-OUT happy to - Thursday suits me.'],
    ['them', '2026-09-16T09:00:00Z', 'THIRD-IN one more question about your track preference.'],
    ['me', '2026-09-16T15:00:00Z', 'THIRD-OUT markets, for the modelling work.'],
  ] })

  const legacyWorld = world(legacyKnown, legacyNew)
  const legacyState = {
    schedule: [
      legacyKnown.ids.slice(0, 2).concat(legacyNew.ids.slice(0, 2)),
      legacyKnown.ids.slice(2, 4).concat(legacyNew.ids.slice(2, 4)),
      legacyKnown.ids.slice(4).concat(legacyNew.ids.slice(4)),
    ],
    seen: new Set(), always: new Set(),
  }
  const legacyCounts = newCounts()

  {
    const r = await shippedRound({ world: legacyWorld, counts: legacyCounts,
      state: legacyState, ring: RING_V1, draftFor })
    await test('the SHIPPED worker proposes both, with no coverage columns in existence', () => {
      assert.strictEqual(r.run.outcome, 'committed', JSON.stringify(r.report))
      assert.strictEqual(r.run.accepted, 2, JSON.stringify(r.report))
      assert.strictEqual(open(pendingInteractions()).length, 1, 'the known contact')
      assert.strictEqual(open(pendingNewContacts()).length, 1, 'the unknown person')
      assert.strictEqual(
        num("SELECT count(*) FROM information_schema.columns WHERE table_name='outlook_candidate_refs' AND column_name='covered_message_fingerprints';"),
        0, 'the coverage column must not exist yet, or these are not pre-feature rows')
    })

    // THE REVIEWER DECIDES BOTH, through the REAL acceptance RPCs. The unknown person
    // becomes a contact, which is the second anchor form: the thread is on record under
    // `episode:new-contact` while a worker now computes `episode:<contactId>`.
    const ic = open(pendingInteractions())[0]
    const nc = open(pendingNewContacts())[0]
    const REVIEWED_KNOWN = NOTES.FIRST + '\n\nMy own note: ask about the rotation structure.'
    const REVIEWED_NEW = NOTES.FIRST + '\n\nMy own note: confirm the cohort start date.'
    await acceptInteraction(ic[0], REVIEWED_KNOWN)
    await acceptNewContact(nc[0], { name: 'Noor Haddad', notes: REVIEWED_NEW })

    await test('both are accepted, and the unknown person is NOW A CONTACT', () => {
      assert.strictEqual(storedInteractions().length, 2, 'two interactions exist')
      assert.strictEqual(num(`SELECT count(*) FROM public.contacts WHERE email='${LEGACY_NEW}';`),
        1, 'acceptance created the contact')
    })
  }

  const legacyAccepted = storedInteractions()

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n  applying the segments migration to the database that already holds them')
  applySegments()
  // ══════════════════════════════════════════════════════════════════════════

  await test('the pre-feature rows are genuine legacy rows: no thread, no coverage', () => {
    const refs = refRows()
    assert.strictEqual(refs.length, 2, JSON.stringify(refs))
    for (const r of refs) {
      assert.strictEqual(r[1], '-', 'conversation_fingerprint must be NULL: ' + JSON.stringify(r))
      assert.strictEqual(Number(r[2]), 0, 'no coverage: ' + JSON.stringify(r))
      assert.strictEqual(r[3], '-', 'no coverage_source: ' + JSON.stringify(r))
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 1b: initialization through the HANDLER, not a planted coverage row')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const before = legacyCounts.model
    const r2 = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the legacy threads are BASELINED, and neither produces a suggestion', () => {
      assert.strictEqual(r2.run.outcome, 'committed', JSON.stringify(r2.report))
      assert.strictEqual(r2.report.created, 0,
        'a baseline must not produce a suggestion: ' + JSON.stringify(r2.report))
      assert.strictEqual((r2.report.entry_skipped || {}).coverage_baselined, 2,
        'both threads report the baseline: ' + JSON.stringify(r2.report))
      assert.strictEqual(legacyCounts.model, before, 'and no model call was made')
    })

    await test('the baseline is recorded as such, and absorbs what is visible NOW', () => {
      const refs = refRows()
      for (const r of refs) {
        assert.match(r[1], /^[0-9a-f]{64}$/, 'the thread is now identified: ' + JSON.stringify(r))
        assert.strictEqual(r[3], 'legacy_baseline', JSON.stringify(r))
        assert.strictEqual(Number(r[2]), 4,
          'four messages were visible, so four are absorbed: ' + JSON.stringify(r))
      }
    })

    await test('the accepted interactions and their reviewed notes are untouched', () => {
      assert.deepStrictEqual(storedInteractions(), legacyAccepted)
    })
  }

  {
    const r3 = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('mail arriving AFTER the baseline is captured, once, for both anchor forms', () => {
      assert.strictEqual(r3.run.outcome, 'committed', JSON.stringify(r3.report))
      // BOTH people are contacts by now - acceptance of the proposal created the second
      // one - so both later exchanges take the interaction path. That is the anchor-form
      // transition: the thread is on record under `episode:new-contact` and the worker now
      // computes `episode:<contactId>`.
      const i = open(pendingInteractions())
      const n = open(pendingNewContacts())
      assert.strictEqual(n.length, 0,
        'the proposal was accepted, so no unknown-person path remains: ' + JSON.stringify(n))
      assert.strictEqual(i.length, 2,
        'one new interaction suggestion per thread: ' + JSON.stringify(i))
      for (const row of i) {
        assert.strictEqual(row[2], 'THIRD-NOTE', 'drafted from the third exchange only')
      }
    })

    await test('and the model saw only the third exchange, never the baselined history', () => {
      const last2 = legacyCounts.modelBodies.slice(-2).join('\n')
      assert.ok(last2.indexOf('THIRD-IN') >= 0 && last2.indexOf('THIRD-OUT') >= 0,
        'both halves of the third exchange must be present')
      for (const tag of ['FIRST-IN', 'FIRST-OUT', 'LATER-IN', 'LATER-OUT']) {
        assert.ok(last2.indexOf(tag) < 0, `${tag} is baselined history and must not be sent`)
      }
    })

    await test('the accepted interactions are STILL untouched', () => {
      assert.deepStrictEqual(storedInteractions(), legacyAccepted)
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nREPRODUCTION / FIX: a rotated thread and a later exchange, known contact')
  // ══════════════════════════════════════════════════════════════════════════
  psql(seed(), { tuplesOnly: false })
  {
    const t = thread({ party: KNOWN, conv: 'conv-rot-known', turns: [
      ['them', '2026-09-01T09:00:00Z', 'FIRST-IN good to meet you at the panel on Tuesday.'],
      ['me', '2026-09-01T15:00:00Z', 'FIRST-OUT thank you, I will send my CV this week.'],
      ['them', '2026-09-08T09:00:00Z', 'LATER-IN the credit desk has a spring opening, Thursday?'],
      ['me', '2026-09-08T15:00:00Z', 'LATER-OUT Thursday at three works, thank you.'],
    ] })
    const w = world(t)
    const state = { schedule: [t.ids.slice(0, 2), t.ids.slice(2)], seen: new Set(), always: new Set() }
    const counts = newCounts()

    const r1 = await round({ world: w, counts, state, ring: RING_V1, draftFor })
    await test('round 1 proposes the first exchange (real producer)', () => {
      assert.strictEqual(r1.run.outcome, 'committed', JSON.stringify(r1.report))
      assert.strictEqual(r1.run.accepted, 1, JSON.stringify(r1.report))
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 1, 'one pending suggestion: ' + JSON.stringify(p))
      assert.strictEqual(p[0][2], 'FIRST-NOTE', 'drafted from the first exchange')
    })

    const refsAfter1 = refRows()
    await test('and the real producer recorded coverage for it', () => {
      assert.strictEqual(refsAfter1.length, 1, JSON.stringify(refsAfter1))
      assert.match(refsAfter1[0][1], /^[0-9a-f]{64}$/)
      assert.strictEqual(Number(refsAfter1[0][2]), 2, 'two messages covered')
      assert.strictEqual(refsAfter1[0][3], 'draft')
    })

    const REVIEWED = NOTES.FIRST + '\n\nMy own note: ask about the rotation structure.'
    await acceptInteraction(open(pendingInteractions())[0][0], REVIEWED)
    const accepted = storedInteractions()
    await test('acceptance stores the interaction with the reviewed note', () => {
      assert.strictEqual(accepted.length, 1)
      assert.ok(accepted[0][5].indexOf('My own note') >= 0, 'the reviewer edit is what landed')
    })

    // ROTATE: v2 current, v1 still accepted.
    const r2 = await round({ world: w, counts, state, ring: RING_V2, draftFor })

    await test('the later exchange produces exactly ONE new pending suggestion', () => {
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 1,
        'expected one pending, got ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(r2.report))
      assert.strictEqual(p[0][2], 'LATER-NOTE', 'drafted from the LATER exchange')
    })

    await test('the model request carries the later halves and NOT the settled ones', () => {
      const sent = counts.modelBodies[counts.modelBodies.length - 1]
      assert.ok(sent.indexOf('LATER-IN') >= 0, 'the later inbound half is missing')
      assert.ok(sent.indexOf('LATER-OUT') >= 0, 'the later outbound half is missing')
      assert.ok(sent.indexOf('FIRST-IN') < 0, 'a SETTLED inbound message is in the request')
      assert.ok(sent.indexOf('FIRST-OUT') < 0, 'a SETTLED outbound message is in the request')
      assert.ok(sent.indexOf(KNOWN) < 0, 'no address in the model request')
      assert.ok(sent.indexOf(ME) < 0, 'no self address in the model request')
    })

    await test('the accepted interaction and its reviewed note are unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    await test('the thread carries coverage for FOUR messages after both segments', () => {
      const refs = refRows()
      const total = refs.reduce((n, r) => n + Number(r[2]), 0)
      assert.strictEqual(total, 4, 'settled two plus later two: ' + JSON.stringify(refs))
    })

    const r3 = await round({ world: w, counts, state, ring: RING_V2, draftFor })
    await test('a replay refreshes that one pending suggestion, creating nothing', () => {
      assert.strictEqual(r3.run.outcome, 'committed', JSON.stringify(r3.report))
      assert.strictEqual(open(pendingInteractions()).length, 1)
      assert.strictEqual(r3.run.created, 0, 'nothing new was created')
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nREPRODUCTION / FIX: the same, on the UNKNOWN-PERSON path')
  // ══════════════════════════════════════════════════════════════════════════
  psql(seed(), { tuplesOnly: false })
  {
    const t = thread({ party: STRANGER, conv: 'conv-rot-new', turns: [
      ['them', '2026-09-03T09:00:00Z', 'FIRST-IN I can review your application for the cohort.'],
      ['me', '2026-09-03T15:00:00Z', 'FIRST-OUT thank you, sending my CV tomorrow.'],
      ['them', '2026-09-10T09:00:00Z', 'LATER-IN the programme lead would like a short call.'],
      ['me', '2026-09-10T15:00:00Z', 'LATER-OUT happy to - Thursday suits me.'],
    ] })
    const w = world(t)
    const state = { schedule: [t.ids.slice(0, 2), t.ids.slice(2)], seen: new Set(), always: new Set() }
    const counts = newCounts()

    const r1 = await round({ world: w, counts, state, ring: RING_V1, draftFor })
    await test('round 1 proposes the unknown person (real producer)', () => {
      assert.strictEqual(r1.run.outcome, 'committed', JSON.stringify(r1.report))
      const p = open(pendingNewContacts())
      assert.strictEqual(p.length, 1, JSON.stringify(p))
      assert.strictEqual(p[0][2], 'FIRST-NOTE')
    })

    const REVIEWED = NOTES.FIRST + '\n\nMy own note: confirm the cohort start date.'
    await acceptNewContact(open(pendingNewContacts())[0][0],
      { name: 'Priya Nair', notes: REVIEWED })
    const accepted = storedInteractions()
    await test('acceptance creates the contact and the interaction with the reviewed note', () => {
      assert.strictEqual(accepted.length, 1)
      assert.ok(accepted[0][5].indexOf('My own note') >= 0)
      assert.strictEqual(num(`SELECT count(*) FROM public.contacts WHERE email='${STRANGER}';`), 1)
    })

    // ROTATE, then deliver the later exchange. The person is NOW A CONTACT, so this also
    // exercises the anchor-form transition at the same time as the key change.
    const r2 = await round({ world: w, counts, state, ring: RING_V2, draftFor })

    await test('the later exchange produces exactly ONE new pending suggestion', () => {
      const i = open(pendingInteractions())
      const n = open(pendingNewContacts())
      assert.strictEqual(i.length + n.length, 1,
        'exactly one open suggestion across both paths: '
        + JSON.stringify({ i, n }) + ' | ' + JSON.stringify(r2.report))
      const note = (i[0] ?? n[0])[2]
      assert.strictEqual(note, 'LATER-NOTE', 'drafted from the LATER exchange')
    })

    await test('the model request carries the later halves and NOT the settled ones', () => {
      const sent = counts.modelBodies[counts.modelBodies.length - 1]
      assert.ok(sent.indexOf('LATER-IN') >= 0 && sent.indexOf('LATER-OUT') >= 0)
      assert.ok(sent.indexOf('FIRST-IN') < 0, 'a SETTLED inbound message is in the request')
      assert.ok(sent.indexOf('FIRST-OUT') < 0, 'a SETTLED outbound message is in the request')
      assert.ok(sent.indexOf(STRANGER) < 0, 'no address in the model request')
    })

    await test('the accepted interaction and its reviewed note are unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 2: legacy history LONGER than one bounded recovery page')
  // ══════════════════════════════════════════════════════════════════════════
  psql(seed(), { tuplesOnly: false })
  {
    // 30 inbound messages of history - more than MAX_RECOVERY_MESSAGES_PER_FOLDER - plus a
    // settled exchange, then genuinely new mail. The history is `always` visible: it
    // predates every delta page, exactly as a real mailbox's back-catalogue does.
    const HISTORY = MAX_RECOVERY_MESSAGES_PER_FOLDER + 5
    const turns = []
    for (let i = 0; i < HISTORY; i += 1) {
      const day = String(1 + Math.floor(i / 10)).padStart(2, '0')
      const hour = String(1 + (i % 10)).padStart(2, '0')
      turns.push(['them', `2026-08-${day}T${hour}:00:00Z`, `HIST-${i} earlier message.`])
    }
    turns.push(['me', '2026-09-01T09:00:00Z', 'FIRST-OUT thank you, I will send my CV.'])
    turns.push(['them', '2026-09-01T15:00:00Z', 'FIRST-IN good - the desk would like a call.'])
    turns.push(['them', '2026-09-20T09:00:00Z', 'LATER-IN a spring opening came up, Thursday?'])
    turns.push(['me', '2026-09-20T15:00:00Z', 'LATER-OUT Thursday at three works.'])
    const t = thread({ party: KNOWN, conv: 'conv-long', turns })
    const histIds = t.ids.slice(0, HISTORY)
    const firstIds = t.ids.slice(HISTORY, HISTORY + 2)
    const laterIds = t.ids.slice(HISTORY + 2)
    const w = world(t)
    const state = {
      schedule: [firstIds, laterIds],
      seen: new Set(),
      always: new Set(histIds),     // the back-catalogue, there before any delta page
    }
    const counts = newCounts()

    const r1 = await round({ world: w, counts, state, ring: RING_V1, draftFor })
    await test('a thread with more history than one page still proposes its exchange', () => {
      assert.strictEqual(r1.run.outcome, 'committed', JSON.stringify(r1.report))
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 1, JSON.stringify(p) + ' | ' + JSON.stringify(r1.report))
    })

    await acceptInteraction(open(pendingInteractions())[0][0], NOTES.FIRST + '\n\nMine: ok.')
    const accepted = storedInteractions()

    const r2 = await round({ world: w, counts, state, ring: RING_V1, draftFor })
    await test('the later exchange is captured, bounded by the segment window', () => {
      assert.strictEqual(r2.run.outcome, 'committed', JSON.stringify(r2.report))
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 1,
        'one new suggestion: ' + JSON.stringify(p) + ' | ' + JSON.stringify(r2.report))
      assert.strictEqual(p[0][2], 'LATER-NOTE')
    })

    await test('the window asked for mail at or after the settled instant, not the whole thread', () => {
      const last = counts.lookups.slice(-2)
      assert.strictEqual(last.length, 2, 'one lookup per folder')
      for (const l of last) {
        assert.ok(typeof l.since === 'string' && l.since.length > 0,
          'a floor is required or the page is spent on history: ' + JSON.stringify(l))
        assert.strictEqual(l.hasOrderBy, false, 'no $orderby with $filter on messages')
        assert.ok(l.top <= MAX_RECOVERY_MESSAGES_PER_FOLDER, 'the page stays bounded')
      }
    })

    await test('no history was duplicated and nothing was invented', () => {
      const sent = counts.modelBodies[counts.modelBodies.length - 1]
      assert.ok(sent.indexOf('LATER-IN') >= 0 && sent.indexOf('LATER-OUT') >= 0)
      assert.ok(sent.indexOf('HIST-0') < 0, 'back-catalogue history must not be sent')
      assert.ok(sent.indexOf('FIRST-OUT') < 0, 'the settled exchange must not be sent again')
      assert.deepStrictEqual(storedInteractions(), accepted, 'the accepted interaction changed')
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 3: a reviewer DECISION landing between the coverage read and the write')
  // ══════════════════════════════════════════════════════════════════════════
  for (const [label, decide] of [
    ['ACCEPTANCE', async (id, notes) => { await acceptInteraction(id, notes) }],
    ['DISMISSAL', async (id) => {
      const r = await http('POST', '/rpc/dismiss_interaction_candidate',
        { token: TOK.u1(), body: { p_candidate_id: id } })
      assert.strictEqual(r.status, 200, 'dismiss: ' + r.raw.slice(0, 160))
    }],
  ]) {
    psql(seed(), { tuplesOnly: false })
    const t = thread({ party: KNOWN, conv: 'conv-race-' + label.toLowerCase(), turns: [
      ['them', '2026-09-01T09:00:00Z', 'FIRST-IN good to meet you at the panel.'],
      ['me', '2026-09-01T15:00:00Z', 'FIRST-OUT thank you, sending my CV.'],
      ['them', '2026-09-08T09:00:00Z', 'LATER-IN a spring opening came up, Thursday?'],
      ['me', '2026-09-08T15:00:00Z', 'LATER-OUT Thursday at three works.'],
    ] })
    const w = world(t)
    const state = {
      // Round 1 shows the first exchange. Round 2 shows BOTH, so the draft in hand
      // genuinely spans settled and new mail once the reviewer decides mid-flight.
      schedule: [t.ids.slice(0, 2), t.ids],
      seen: new Set(), always: new Set(),
    }
    const counts = newCounts()

    const r1 = await round({ world: w, counts, state, ring: RING_V1, draftFor })
    const pend = open(pendingInteractions())
    await test(`${label}: round 1 leaves one pending suggestion`, () => {
      assert.strictEqual(r1.run.outcome, 'committed', JSON.stringify(r1.report))
      assert.strictEqual(pend.length, 1, JSON.stringify(pend))
    })

    // THE RACE, staged exactly where it hurts: the coverage read has already answered, the
    // model has been called, and the reviewer decides before the producer write lands.
    let fired = false
    const hooks = {
      upsert_outlook_interaction_candidate: async () => {
        if (fired) return
        fired = true
        await decide(pend[0][0], NOTES.FIRST + '\n\nMine: decided mid-flight.')
      },
    }
    const r2 = await round({ world: w, counts, state, ring: RING_V2, draftFor, hooks })

    await test(`${label}: the partial-overlap write is REFUSED and stays resumable`, () => {
      assert.ok(fired, 'the decision must actually have been staged')
      assert.strictEqual(r2.report.created, 0, 'nothing was created: ' + JSON.stringify(r2.report))
      assert.strictEqual(r2.report.cursors_advanced, 0,
        'a refused write must not commit: ' + JSON.stringify(r2.report))
      assert.strictEqual((r2.report.write_results || {}).coverage_moved, 1,
        'the real producer must answer coverage_moved: ' + JSON.stringify(r2.report))
      assert.strictEqual(r2.report.refusal, 'coverage_moved',
        'and it must be reported as the refusal it is')
    })

    const decided = storedInteractions()

    // THE NEXT ATTEMPT. The same page again - the cursor never moved - and now the
    // genuinely new exchange is the only uncovered part.
    const r3 = await round({ world: w, counts, state, ring: RING_V2, draftFor })

    await test(`${label}: the next attempt captures the new exchange ONCE`, () => {
      assert.strictEqual(r3.run.outcome, 'committed', JSON.stringify(r3.report))
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 1,
        'exactly one new pending suggestion: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(r3.report))
      assert.strictEqual(p[0][2], 'LATER-NOTE', 'and it is the LATER exchange')
    })

    await test(`${label}: the decided exchange is left exactly as the reviewer left it`, () => {
      assert.deepStrictEqual(storedInteractions(), decided)
      const settled = pendingInteractions().filter((r) => r[1] !== 'pending')
      assert.strictEqual(settled.length, 1, 'the decided row is still the decided row')
      assert.strictEqual(settled[0][0], pend[0][0], 'and it is the same row')
    })

    await test(`${label}: and the model was sent only the new exchange`, () => {
      const sent = counts.modelBodies[counts.modelBodies.length - 1]
      assert.ok(sent.indexOf('LATER-IN') >= 0 && sent.indexOf('LATER-OUT') >= 0)
      assert.ok(sent.indexOf('FIRST-IN') < 0, 'the decided exchange must not be sent again')
      assert.ok(sent.indexOf('FIRST-OUT') < 0, 'the decided exchange must not be sent again')
    })
  }
}
