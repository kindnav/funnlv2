// The scenarios for tests/local/outlook-thread-segments-flow.mjs.
//
// Split out only so the harness plumbing and the behaviour under test stay readable
// separately. Everything here runs against the REAL database functions over real
// PostgREST, with the run module driving controlled Graph and Anthropic fixtures.

export async function run (h) {
  const {
    test, thread, world, newCounts, round, seed, psql, num, rows, refRows, U1,
    conversationFingerprintOf,
    pendingInteractions, pendingNewContacts, storedInteractions, RING_V1, RING_V2, draftFor,
    NOTES, applySegments, acceptInteraction, acceptNewContact, http, TOK, shippedRound,
    ME, KNOWN, STRANGER, LEGACY_NEW, LONG_NEW, LONG_SLOW, BOUNDARY,
    MAX_RECOVERY_MESSAGES_PER_FOLDER, assert,
  } = h

  let boundaryCfpValue = null
  const open = (list) => list.filter((r) => r[1] === 'pending')
  // How many THREAD-LEVEL baselines exist. Thread state, not candidate state: it is
  // what a thread whose history cannot be located has instead of a coverage row.
  const baselineRows = () => num(`SELECT count(*) FROM public.outlook_thread_recovery
                                   WHERE user_id='${U1}'
                                     AND baseline_fingerprints IS NOT NULL;`)

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 1a: a GENUINE pre-feature proposal, written by the SHIPPED producer')
  // The segments migration is not applied yet. These rows are what a real pilot account
  // already holds: a candidate_refs row with NO conversation fingerprint and NO coverage,
  // under BOTH anchor forms - `episode:<contactId>` for someone already a contact and
  // `episode:new-contact` for someone who was not.
  // ══════════════════════════════════════════════════════════════════════════
  psql(seed(), { tuplesOnly: false })
  // Computed with the REAL builders, so a test addresses the same row the worker writes.
  boundaryCfpValue = await conversationFingerprintOf('conv-long-boundary')

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

  // A THIRD legacy thread, and the one Gate 2 is about: more than one bounded recovery page
  // of history in a single folder, sitting behind the exchange the reviewer accepted.
  //
  // The history is `always` visible - it predates every delta page, as a real mailbox's
  // back-catalogue does - and it is INBOUND ONLY, so it is not an exchange in its own right.
  // The pre-migration round delivers only the first exchange, so the shipped worker anchors
  // the legacy row on that exchange's first message and never sees the back-catalogue: that
  // is precisely why the anchor is unreachable from a later round, and why the thread could
  // never be identified again.
  const HISTORY = MAX_RECOVERY_MESSAGES_PER_FOLDER + 5
  const longTurns = []
  for (let i = 0; i < HISTORY; i += 1) {
    const day = String(1 + Math.floor(i / 10)).padStart(2, '0')
    const hour = String(1 + (i % 10)).padStart(2, '0')
    longTurns.push(['them', `2026-08-${day}T${hour}:00:00Z`, `HIST-${i} earlier message.`])
  }
  longTurns.push(['me', '2026-09-01T09:00:00Z', 'FIRST-OUT thank you, I will send my CV.'])
  longTurns.push(['them', '2026-09-01T15:00:00Z', 'FIRST-IN good - the desk would like a call.'])
  longTurns.push(['them', '2026-09-20T09:00:00Z', 'LATER-IN a spring opening came up, Thursday?'])
  longTurns.push(['me', '2026-09-20T15:00:00Z', 'LATER-OUT Thursday at three works.'])
  longTurns.push(['them', '2026-09-27T09:00:00Z', 'THIRD-IN the desk head sent feedback.'])
  longTurns.push(['me', '2026-09-27T15:00:00Z', 'THIRD-OUT thank you, noting it down.'])
  longTurns.push(['them', '2026-10-04T09:00:00Z', 'FOURTH-IN the panel date is confirmed.'])
  longTurns.push(['me', '2026-10-04T15:00:00Z', 'FOURTH-OUT thank you, I will be there.'])
  longTurns.push(['them', '2026-10-18T09:00:00Z', 'SIXTH-IN one last question about the start date.'])
  longTurns.push(['me', '2026-10-18T15:00:00Z', 'SIXTH-OUT September, if that still works.'])
  // THE GAP PAIR, for the baseline-only hint gate: the unanswered half is AFTER baseline
  // initialization (2026-09-20) and BEFORE the latest settled segment (2026-09-27), which is
  // exactly the interval a lost hint makes unreachable.
  longTurns.push(['me', '2026-09-24T09:00:00Z', 'GAP-OUT did the panel feedback come back?'])
  longTurns.push(['them', '2026-09-25T09:00:00Z', 'GAP-IN it did - one note on the modelling.'])
  const longThread = thread({ party: KNOWN, conv: 'conv-long-legacy', turns: longTurns })
  // THE SAME SHAPE for someone who was a STRANGER when the proposal was accepted, so the
  // long-history case is composed with the anchor-form transition.
  const longNewThread = thread({ party: LONG_NEW, conv: 'conv-long-newc', turns: longTurns })
  // AND one more, reserved for the budget-starvation gate: a long legacy thread that has
  // never been completed, so its first listing still overflows and there is a retry to starve.
  const longSlowThread = thread({ party: LONG_SLOW, conv: 'conv-long-slow', turns: longTurns })
  // AND the boundary thread: the same back-catalogue, but a pre-feature accepted exchange of
  // FOUR messages at four instants, so one can be hidden and a different, earlier one
  // re-delivered. Its baseline is initialized by a window at 2026-09-20.
  const bTurns = longTurns.slice(0, HISTORY).concat([
    ['me', '2026-09-01T09:00:00Z', 'ACC-A0 thank you for the introduction.'],
    ['them', '2026-09-02T09:00:00Z', 'ACC-A1 glad to help - here is the team contact.'],
    ['them', '2026-09-03T09:00:00Z', 'ACC-A2 one more name you should speak to.'],
    ['me', '2026-09-04T09:00:00Z', 'ACC-A3 noted, I will write to them both.'],
    ['them', '2026-09-20T09:00:00Z', 'BASE-IN the panel is being scheduled now.'],
    ['me', '2026-09-20T15:00:00Z', 'BASE-OUT thank you, I will keep the week free.'],
    ['them', '2026-10-01T09:00:00Z', 'FRESH1-IN the referral went in, can you send a transcript?'],
    ['me', '2026-10-01T15:00:00Z', 'FRESH1-OUT yes, this week.'],
    ['them', '2026-10-08T09:00:00Z', 'FRESH2-IN which office would you prefer?'],
    ['me', '2026-10-08T15:00:00Z', 'FRESH2-OUT the city desk, if there is room.'],
  ])
  const boundaryThread = thread({ party: BOUNDARY, conv: 'conv-long-boundary', turns: bTurns })
  const longHist = longThread.ids.slice(0, HISTORY)
  const longFirst = longThread.ids.slice(HISTORY, HISTORY + 2)
  const longCont1 = longThread.ids.slice(HISTORY + 2, HISTORY + 4)   // LATER pair
  const longCont2 = longThread.ids.slice(HISTORY + 4, HISTORY + 6)   // THIRD pair
  const longCont4 = longThread.ids.slice(HISTORY + 8, HISTORY + 10)  // SIXTH pair
  // THE ACCEPTED EXCHANGE'S LAST INBOUND, for the re-delivery gate. Its anchor - the
  // exchange's first message, FIRST-OUT at 09:00 - deliberately stays OUTSIDE any window
  // floored at this message's own instant.
  const longAcceptedInbound = longThread.ids[HISTORY + 1]
  const nHist = longNewThread.ids.slice(0, HISTORY)
  const nFirst = longNewThread.ids.slice(HISTORY, HISTORY + 2)
  const nCont1 = longNewThread.ids.slice(HISTORY + 2, HISTORY + 4)
  const nCont2 = longNewThread.ids.slice(HISTORY + 4, HISTORY + 6)
  const sHist = longSlowThread.ids.slice(0, HISTORY)
  const sFirst = longSlowThread.ids.slice(HISTORY, HISTORY + 2)
  const sCont1 = longSlowThread.ids.slice(HISTORY + 2, HISTORY + 4)
  const sCont2 = longSlowThread.ids.slice(HISTORY + 4, HISTORY + 6)
  const nGapOut = [longNewThread.ids[HISTORY + 10]]
  const nGapIn = [longNewThread.ids[HISTORY + 11]]
  const bHist = boundaryThread.ids.slice(0, HISTORY)
  const bAccepted = boundaryThread.ids.slice(HISTORY, HISTORY + 4)
  const bInit = boundaryThread.ids.slice(HISTORY + 4, HISTORY + 6)
  const bFresh1 = boundaryThread.ids.slice(HISTORY + 6, HISTORY + 8)
  const bFresh2 = boundaryThread.ids.slice(HISTORY + 8, HISTORY + 10)
  const reDelivered = boundaryThread.ids[HISTORY + 1]   // ACC-A1, the EARLIER one
  const hiddenAccepted = boundaryThread.ids[HISTORY + 2] // ACC-A2, temporarily out of folders
  let boundaryAt = null
  const boundaryCfp = () => boundaryCfpValue

  const legacyWorld = world(legacyKnown, legacyNew, longThread, longNewThread,
    longSlowThread, boundaryThread)
  const legacyState = {
    schedule: [
      // pre-migration: the original exchange of all three threads
      legacyKnown.ids.slice(0, 2).concat(legacyNew.ids.slice(0, 2))
        .concat(longFirst).concat(nFirst).concat(sFirst).concat(bAccepted),
      legacyKnown.ids.slice(2, 4).concat(legacyNew.ids.slice(2, 4)),
      legacyKnown.ids.slice(4).concat(legacyNew.ids.slice(4)),
      longCont1.concat(nCont1),
      longCont1.concat(nCont1),   // a replay of the same page: already absorbed
      longCont2.concat(nCont2),   // the next exchange, captured against the baseline
      // Gate 2b: starved of budget. That round commits NOTHING, so the cursor does not move
      // and the next invocation is served this very page again - which is the point.
      sCont1,
      sCont2,                     //          and then the exchange after it, suggested
      [longAcceptedInbound, ...longCont4],  // Gate 2c: an accepted message RE-DELIVERED
      nGapOut,                    // Gate 2d: one unanswered half on a BASELINE-ONLY row
      nGapIn,                     //          its reply, in the next completed round
      bInit,                      // Gate 2e: initialize the boundary thread's baseline
      [reDelivered, ...bFresh1],  //          an EARLIER accepted message + a fresh exchange
      [hiddenAccepted, ...bFresh2], //        the absent accepted message returns + a pair
    ],
    seen: new Set(),
    always: new Set([...longHist, ...nHist, ...sHist, ...bHist]),
    // ACC-A2 is temporarily out of the tracked folders; Gate 2e puts it back.
    hidden: new Set([hiddenAccepted]),
  }
  const legacyCounts = newCounts()

  {
    const r = await shippedRound({ world: legacyWorld, counts: legacyCounts,
      state: legacyState, ring: RING_V1, draftFor })
    await test('the SHIPPED worker proposes all four, with no coverage columns in existence', () => {
      assert.strictEqual(r.run.outcome, 'committed', JSON.stringify(r.report))
      assert.strictEqual(r.run.accepted, 6, JSON.stringify(r.report))
      assert.strictEqual(open(pendingInteractions()).length, 2,
        'the known contact, and the long thread which is also a known contact')
      assert.strictEqual(open(pendingNewContacts()).length, 4,
        'the unknown person, and three on long threads')
      assert.strictEqual(
        num("SELECT count(*) FROM information_schema.columns WHERE table_name='outlook_candidate_refs' AND column_name='covered_message_fingerprints';"),
        0, 'the coverage column must not exist yet, or these are not pre-feature rows')
    })

    // THE REVIEWER DECIDES BOTH, through the REAL acceptance RPCs. The unknown person
    // becomes a contact, which is the second anchor form: the thread is on record under
    // `episode:new-contact` while a worker now computes `episode:<contactId>`.
    const ics = open(pendingInteractions())
    const ncs = open(pendingNewContacts())
    const REVIEWED_KNOWN = NOTES.FIRST + '\n\nMy own note: ask about the rotation structure.'
    const REVIEWED_NEW = NOTES.FIRST + '\n\nMy own note: confirm the cohort start date.'
    for (const ic of ics) await acceptInteraction(ic[0], REVIEWED_KNOWN)
    for (const nc of ncs) {
      await acceptNewContact(nc[0], { name: 'Reviewed Person', notes: REVIEWED_NEW })
    }

    await test('all four are accepted, and BOTH unknown people are NOW CONTACTS', () => {
      assert.strictEqual(storedInteractions().length, 6, 'six interactions exist')
      for (const addr of [LEGACY_NEW, LONG_NEW, LONG_SLOW, BOUNDARY]) {
        assert.strictEqual(num(`SELECT count(*) FROM public.contacts WHERE email='${addr}';`),
          1, 'acceptance created the contact for ' + addr)
      }
    })
  }

  const legacyAccepted = storedInteractions()

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n  applying the segments migration to the database that already holds them')
  applySegments()
  // ══════════════════════════════════════════════════════════════════════════

  await test('the pre-feature rows are genuine legacy rows: no thread, no coverage', () => {
    const refs = refRows()
    assert.strictEqual(refs.length, 6, JSON.stringify(refs))
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
        'both SHORT legacy threads report the baseline: ' + JSON.stringify(r2.report))
      assert.strictEqual(legacyCounts.model, before, 'and no model call was made')
    })

    await test('the baseline is recorded as such, and absorbs what is visible NOW', () => {
      // The long thread had no mail in this round, so it is untouched and still legacy.
      const refs = refRows().filter((r) => r[1] !== '-')
      assert.strictEqual(refs.length, 2, 'the two short legacy threads: ' + JSON.stringify(refs))
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

    // The reviewer decides both, so Gate 2 below starts from a thread-clean slate and its
    // counts are about the long thread alone.
    for (const row of open(pendingInteractions())) {
      await acceptInteraction(row[0], NOTES.THIRD + '\n\nMine: noted.')
    }
  }

  console.log('\nGATE 2: a GENUINE long legacy thread - more history than one bounded page')
  // ══════════════════════════════════════════════════════════════════════════
  // The original candidate for these threads was written by the SHIPPED worker before the
  // migration existed and accepted through the real acceptance RPC, above. Each refs row
  // carries NO conversation fingerprint, and its episode anchor is the first message of an
  // exchange the back-catalogue hides, so it cannot be located by either key.
  //
  // REPRODUCED before the bounded retry: with no settled instant there was no floor, the
  // single bounded page per folder was spent on 30 back-catalogue messages, the page came
  // back carrying @odata.nextLink, recovery settled `recovery_truncated` and the round
  // COMMITTED - for every continuation, for ever.
  //
  // REPRODUCED again after it: the narrowed window is NOT provably new. The next delta page
  // may re-deliver an already-accepted message beside a genuinely new pair, and drafting the
  // window put the accepted message back in front of the model. So an unlocatable thread's
  // window is ABSORBED, forward-only, and the next exchange is what gets captured.
  {
    const accepted = storedInteractions()
    const before = legacyCounts.model
    const refsBefore = new Set(refRows().map((r) => r[1] + '|' + r[4]))

    // ── ROUND A: the window is absorbed, nothing is drafted ─────────────────
    const c1 = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the long thread is completed by ONE bounded retry, not abandoned', () => {
      assert.strictEqual(c1.run.outcome, 'committed', JSON.stringify(c1.report))
      // TWO long legacy threads: the known contact, and the person who became a contact when
      // their proposal was accepted. One windowed retry each, and a retry is NOT charged
      // against the per-invocation recovery cap as a fresh attempt.
      assert.strictEqual(c1.report.content.recovery_retries, 2,
        'one windowed retry per long thread: ' + JSON.stringify(c1.report.content))
      assert.strictEqual(c1.report.content.recoveries_attempted, 2,
        'two recoveries, one per thread, retries not counted again')
      assert.deepStrictEqual({ ...c1.report.content.recovery_outcomes }, { recovered: 2 },
        'both retries recovered their thread: ' + JSON.stringify(c1.report.content))
    })

    await test('the retry was WINDOWED, and every listing stayed inside the page bound', () => {
      for (const conv of [longThread.conv, longNewThread.conv]) {
        const mine = legacyCounts.lookups.filter((l) => l.conv === conv)
        const unwindowed = mine.filter((l) => l.since === null)
        const windowed = mine.filter((l) => l.since !== null)
        // The FIRST attempt asks unwindowed and returns at the first folder that overflows -
        // it does not keep listing - so one unwindowed listing is all it takes.
        assert.strictEqual(unwindowed.length, 1,
          'one unwindowed listing, then the truncation: ' + JSON.stringify(mine))
        assert.strictEqual(windowed.length, 2, 'the retry lists BOTH folders windowed')
        for (const l of windowed) {
          assert.ok(l.since >= '2026-09-20', 'the floor is what THIS ROUND saw, not a '
            + 'reviewer date: ' + JSON.stringify(l))
        }
        for (const l of mine) {
          assert.strictEqual(l.hasOrderBy, false, 'no $orderby with $filter on messages')
          assert.ok(l.top <= MAX_RECOVERY_MESSAGES_PER_FOLDER, 'the page stays bounded')
        }
      }
    })

    await test('the window is ABSORBED, not drafted: no suggestion and NO model call', () => {
      assert.strictEqual((c1.report.entry_skipped || {}).coverage_baselined, 2,
        'both long threads report the baseline: ' + JSON.stringify(c1.report))
      assert.strictEqual(c1.report.created, 0, 'nothing was created')
      assert.strictEqual(legacyCounts.model, before,
        'and the model was never called, so no accepted message could reach it')
      assert.strictEqual(open(pendingInteractions()).length, 0, 'no pending suggestion')
      assert.strictEqual(open(pendingNewContacts()).length, 0)
    })

    await test('the absorption is RECORDED against the thread, so it never repeats', () => {
      assert.strictEqual(baselineRows(), 2, 'one thread baseline per long thread')
      const sizes = rows(`SELECT array_length(baseline_fingerprints, 1)
                            FROM public.outlook_thread_recovery
                           WHERE user_id='${U1}' AND baseline_fingerprints IS NOT NULL
                           ORDER BY 1;`).map((r) => Number(r[0]))
      for (const sz of sizes) {
        assert.strictEqual(sz, 2,
          'exactly the two messages the window returned, nothing older: ' + JSON.stringify(sizes))
      }
    })

    await test('THE LIMIT, stated: the pre-feature rows themselves stay uninitialized', () => {
      // A long legacy row cannot be LOCATED: no conversation fingerprint, and its episode
      // anchor is the first message of an exchange the back-catalogue hides, so no bounded
      // window reaches it. Nothing pretends otherwise - it is left exactly as the shipped
      // worker wrote it. What makes the thread work again is the THREAD-level baseline above,
      // which later segments are decided against.
      // THREE: the two long threads this gate drove, and the one Gate 2b has not reached yet.
      const stillLegacy = refRows().filter((r) => r[1] === '-' && Number(r[2]) === 0)
      assert.strictEqual(stillLegacy.length, 4,
        'every long legacy row is untouched: ' + JSON.stringify(refRows()))
      const unchanged = refRows().filter((r) => !refsBefore.has(r[1] + '|' + r[4]))
      assert.strictEqual(unchanged.length, 0, 'and no candidate refs row was written at all')
    })

    await test('the accepted interactions and their reviewed notes are unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    // ── ROUND B: a REPLAY of the same page. Already absorbed, so nothing new ─
    const replay = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })
    await test('a replay of an absorbed window produces nothing, and no second baseline', () => {
      assert.strictEqual(replay.run.outcome, 'committed', JSON.stringify(replay.report))
      assert.strictEqual(replay.report.created, 0, 'nothing created')
      assert.strictEqual(open(pendingInteractions()).length, 0, 'still no pending suggestion')
      assert.strictEqual((replay.report.entry_skipped || {}).nothing_new, 2,
        'the baseline already covers it: ' + JSON.stringify(replay.report))
      assert.strictEqual(baselineRows(), 2, 'and no extra baseline row')
    })

    // ── ROUND C: a genuinely NEW exchange, decided against the baseline ─────
    const c2 = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the NEXT exchange is captured EXACTLY ONCE, on both paths', () => {
      assert.strictEqual(c2.run.outcome, 'committed', JSON.stringify(c2.report))
      const i = open(pendingInteractions())
      const n = open(pendingNewContacts())
      assert.strictEqual(n.length, 0,
        'both people are contacts now, so no unknown-person path remains')
      assert.strictEqual(i.length, 2,
        'exactly one new suggestion per long thread: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(c2.report))
      for (const row of i) assert.strictEqual(row[2], 'THIRD-NOTE', 'the THIRD exchange')
    })

    await test('its draft carries both new halves and excludes everything absorbed', () => {
      for (const sent of legacyCounts.modelBodies.slice(-2)) {
        assert.ok(sent.indexOf('THIRD-IN') >= 0 && sent.indexOf('THIRD-OUT') >= 0,
          'both halves of the new exchange must be present')
        for (const tag of ['HIST-0', 'FIRST-OUT', 'FIRST-IN', 'LATER-IN', 'LATER-OUT']) {
          assert.ok(sent.indexOf(tag) < 0, tag + ' is absorbed or settled and must not be sent')
        }
      }
    })

    await test('and the accepted interactions, with their reviewed notes, are STILL unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    // Decide them, so the scenarios below start from a clean pending slate.
    for (const row of open(pendingInteractions())) {
      await acceptInteraction(row[0], NOTES.THIRD + '\n\nMine: noted.')
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 2b: the narrowed retry CANNOT BE ADMITTED - the exchange is preserved')
  // ══════════════════════════════════════════════════════════════════════════
  // INVOCATION_BUDGET_MS is 120,000 and the retry is admitted on 85,000 ms of remaining
  // budget, so a retry needs the invocation to be under 35,000 ms old. Nineteen seconds on
  // the envelope GET and nineteen on the first, truncated listing puts it at 38,000: each
  // request well inside its own deadline, the invocation unable to admit the narrowed retry.
  //
  // REPRODUCED: this committed BOTH cursors with `recovery_truncated`, zero retries and no
  // suggestion. A floor existed, so the work was possible - it was simply thrown away.
  {
    const accepted = storedInteractions()
    const baselinesBefore = baselineRows()
    const SLOW = { start: 0, cost: { envelope: 19000, truncatedLookup: 19000 } }

    const starved = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor, clock: SLOW })

    await test('an unadmittable retry is a RETRYABLE budget result, not a settlement', () => {
      assert.deepStrictEqual({ ...starved.report.content.recovery_outcomes },
        { budget_exhausted: 1 },
        'reported as the retryable budget outcome it is: '
        + JSON.stringify(starved.report.content))
      assert.strictEqual(starved.report.content.recovery_retries, 0,
        'the retry was never made')
      assert.strictEqual((starved.report.entry_skipped || {}).recovery_truncated, undefined,
        'and the truncation is NOT reported as a decision: ' + JSON.stringify(starved.report))
    })

    await test('no cursor advances and the conversation is left unpassed', () => {
      assert.strictEqual(starved.report.cursors_advanced, 0,
        'a possible exchange must not be committed away: ' + JSON.stringify(starved.report))
      assert.strictEqual(starved.report.finalize.processed, 0, 'the conversation is unpassed')
      assert.strictEqual(starved.report.created, 0)
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    // THE NEXT INVOCATION, with the ordinary clock: the same page, since nothing committed.
    const recovered = await round({ world: legacyWorld, counts: legacyCounts,
      state: legacyState, ring: RING_V1, draftFor })

    await test('the NEXT invocation processes that same exchange, exactly once', () => {
      assert.strictEqual(recovered.run.outcome, 'committed', JSON.stringify(recovered.report))
      assert.ok(recovered.report.content.recovery_retries >= 1,
        'it makes the retry it could not afford before: '
        + JSON.stringify(recovered.report.content))
      // This thread had NO coverage, so the window is of unknown membership and is ABSORBED -
      // the same forward-only step Gate 2 establishes. Processed once, recorded, and never
      // read again; it is the exchange AFTER it that becomes a suggestion.
      assert.strictEqual((recovered.report.entry_skipped || {}).coverage_baselined, 1,
        'absorbed exactly once: ' + JSON.stringify(recovered.report))
      assert.strictEqual(recovered.report.cursors_advanced, 2, 'and now the round commits')
      assert.strictEqual(baselineRows() - baselinesBefore, 1,
        'exactly one new thread baseline: the starved thread\'s')
    })

    await test('and the accepted notes are untouched throughout', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    // AND THE THREAD WORKS: the next exchange becomes a suggestion, once.
    const afterStarve = await round({ world: legacyWorld, counts: legacyCounts,
      state: legacyState, ring: RING_V1, draftFor })
    await test('the exchange after it is suggested, exactly once', () => {
      assert.strictEqual(afterStarve.run.outcome, 'committed',
        JSON.stringify(afterStarve.report))
      const i = open(pendingInteractions())
      assert.strictEqual(i.length, 1,
        'one suggestion: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(afterStarve.report))
      assert.strictEqual(i[0][2], 'THIRD-NOTE')
      const sent = legacyCounts.modelBodies[legacyCounts.modelBodies.length - 1]
      assert.ok(sent.indexOf('THIRD-IN') >= 0 && sent.indexOf('THIRD-OUT') >= 0)
      for (const tag of ['HIST-0', 'FIRST-OUT', 'FIRST-IN', 'LATER-IN', 'LATER-OUT']) {
        assert.ok(sent.indexOf(tag) < 0, tag + ' is absorbed or accepted and must not be sent')
      }
    })

    for (const row of open(pendingInteractions())) {
      await acceptInteraction(row[0], NOTES.THIRD + '\n\nMine: noted.')
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 2c: delta RE-DELIVERS an accepted message inside the narrowed window')
  // ══════════════════════════════════════════════════════════════════════════
  // The claim that the narrowed window "cannot reach the accepted exchange" was WRONG: the
  // window starts at the earliest message THIS ROUND saw, and delta re-delivers old mail
  // after a resync. REPRODUCED: the worker drafted a window containing an already-accepted
  // inbound message, and claimed coverage for all three messages.
  {
    const accepted = storedInteractions()
    const before = legacyCounts.model

    const mixed = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the re-delivered accepted message is inside the window the retry asked for', () => {
      const mine = legacyCounts.lookups
        .filter((l) => l.conv === longThread.conv && l.since !== null).slice(-2)
      assert.ok(mine.length > 0, 'a windowed listing was made')
      for (const l of mine) {
        assert.ok(l.since <= '2026-09-16T00:00:00Z',
          'the floor reaches back to the re-delivered message, which is the whole problem: '
          + JSON.stringify(l))
      }
    })

    await test('the accepted message is ABSORBED, never drafted', () => {
      assert.strictEqual(mixed.run.outcome, 'committed', JSON.stringify(mixed.report))
      assert.ok((mixed.report.entry_skipped || {}).coverage_baselined === undefined,
        'the round is not skipped wholesale: ' + JSON.stringify(mixed.report))
      assert.ok(legacyCounts.model > before, 'the genuinely new pair WAS drafted')
      const sent = legacyCounts.modelBodies[legacyCounts.modelBodies.length - 1]
      assert.ok(sent.indexOf('SIXTH-IN') >= 0 && sent.indexOf('SIXTH-OUT') >= 0,
        'both halves of the genuinely new pair must be present')
      assert.ok(sent.indexOf('FIRST-IN') < 0,
        'the RE-DELIVERED accepted message must NOT reach the model')
      for (const tag of ['HIST-0', 'FIRST-OUT', 'LATER-IN', 'LATER-OUT', 'THIRD-IN',
        'THIRD-OUT', 'FOURTH-IN', 'FOURTH-OUT']) {
        assert.ok(sent.indexOf(tag) < 0, tag + ' must not be sent again')
      }
    })

    await test('and it is absorbed against the thread, so it cannot come back', () => {
      const n = num(`SELECT count(*) FROM public.outlook_thread_recovery
                      WHERE user_id='${U1}'
                        AND baseline_fingerprints IS NOT NULL
                        AND array_length(baseline_fingerprints, 1) > 2;`)
      assert.ok(n >= 1, 'the thread baseline grew to take the re-delivered message in')
    })

    await test('the genuinely new exchange is captured EXACTLY ONCE', () => {
      const i = open(pendingInteractions())
      assert.strictEqual(i.length, 1,
        'one suggestion: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(mixed.report))
      assert.strictEqual(i[0][2], 'SIXTH-NOTE')
    })

    await test('its coverage claims the new pair ONLY, never the re-delivered message', () => {
      const fresh = refRows().filter((r) => Number(r[2]) === 2 && r[3] === 'draft')
      assert.ok(fresh.length >= 1, JSON.stringify(refRows()))
    })

    await test('and the accepted interactions and their notes are unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    // Decided, so the gates below start from a clean pending slate.
    for (const row of open(pendingInteractions())) {
      await acceptInteraction(row[0], NOTES.SIXTH + '\n\nMine: noted.')
    }
  }

  console.log('\nGATE 2d: the first hint on a BASELINE-ONLY row must survive')
  // ══════════════════════════════════════════════════════════════════════════
  // REPRODUCED against the real function: record_outlook_thread_recovery merged
  // `unpaired || EXCLUDED.unpaired`, and on a baseline-only row the left side is NULL. In
  // jsonb `NULL || x` is NULL, so the aggregate came back NULL, the function answered `ok`,
  // and both hint columns stayed NULL. The first unpaired half on such a thread was dropped
  // silently - recovery never reached back for it, both rounds committed, and no suggestion
  // was ever produced.
  {
    const accepted = storedInteractions()

    // ── the unanswered half: AFTER baseline initialization, BEFORE the latest settled
    //    segment. Exactly the interval where a missing hint loses the exchange.
    const half = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the unanswered half is RECORDED on the baseline-only row', () => {
      assert.strictEqual(half.run.outcome, 'committed', JSON.stringify(half.report))
      assert.strictEqual(half.report.created, 0, 'one side is not an exchange')
      const got = rows(`SELECT array_length(baseline_fingerprints, 1),
                               coalesce(jsonb_array_length(unpaired), 0),
                               coalesce(earliest_unpaired_at::text, '-')
                          FROM public.outlook_thread_recovery
                         WHERE user_id='${U1}' AND conversation_fingerprint = (
                           SELECT conversation_fingerprint FROM public.outlook_thread_recovery
                            WHERE user_id='${U1}' AND baseline_fingerprints IS NOT NULL
                              AND unpaired IS NOT NULL LIMIT 1);`)
      assert.strictEqual(got.length, 1,
        'a row carrying BOTH a baseline and a hint must exist: '
        + JSON.stringify(rows(`SELECT coalesce(array_length(baseline_fingerprints,1),0),
                                      coalesce(jsonb_array_length(unpaired),0)
                                 FROM public.outlook_thread_recovery
                                WHERE user_id='${U1}';`)))
      assert.ok(Number(got[0][0]) >= 1, 'the baseline is preserved: ' + JSON.stringify(got[0]))
      assert.strictEqual(Number(got[0][1]), 1, 'and the hint holds the one unpaired message')
      assert.notStrictEqual(got[0][2], '-', 'with its derived instant')
    })

    // ── the reply, in the next COMPLETED round ──────────────────────────────
    const pair = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('both halves reach ONE draft, exactly once', () => {
      assert.strictEqual(pair.run.outcome, 'committed', JSON.stringify(pair.report))
      const i = open(pendingInteractions())
      assert.strictEqual(i.length, 1,
        'one suggestion: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(pair.report))
      assert.strictEqual(i[0][2], 'GAP-NOTE')
      const sent = legacyCounts.modelBodies[legacyCounts.modelBodies.length - 1]
      assert.ok(sent.indexOf('GAP-OUT') >= 0,
        'the half from the EARLIER round must be present - this is what the hint is for')
      assert.ok(sent.indexOf('GAP-IN') >= 0, 'and the reply from this round')
      for (const tag of ['HIST-0', 'FIRST-OUT', 'FIRST-IN', 'LATER-IN', 'LATER-OUT',
        'THIRD-IN', 'THIRD-OUT']) {
        assert.ok(sent.indexOf(tag) < 0, tag + ' is settled or absorbed and must not be sent')
      }
    })

    await test('the hint is then RESOLVED back to a baseline-only row', () => {
      const n = num(`SELECT count(*) FROM public.outlook_thread_recovery
                      WHERE user_id='${U1}' AND unpaired IS NOT NULL;`)
      assert.strictEqual(n, 0, 'no hint survives its own resolution')
      const b = num(`SELECT count(*) FROM public.outlook_thread_recovery
                      WHERE user_id='${U1}' AND baseline_fingerprints IS NOT NULL;`)
      assert.ok(b >= 1, 'and the baseline rows are still there, not deleted with the hints')
    })

    await test('the accepted interactions and their reviewed notes are unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted)
    })

    for (const row of open(pendingInteractions())) {
      await acceptInteraction(row[0], NOTES.GAP + '\n\nMine: noted.')
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nGATE 2e: the suppression boundary is fixed at INITIALIZATION')
  // ══════════════════════════════════════════════════════════════════════════
  // A genuine pre-feature accepted exchange of FOUR messages. One of them is temporarily out
  // of the tracked folders; a different, EARLIER one is re-delivered beside a fresh exchange;
  // then the absent one comes back beside another fresh pair.
  //
  // REPRODUCED: the first absorption lowered `baseline_from_at`, the worker used that
  // minimum as its cutoff, and the returned accepted message - which sits between the new
  // minimum and the initialization instant - counted as new and entered the model request.
  {
    const accepted = storedInteractions()

    // ── 1. initialize this thread's forward-only baseline ───────────────────
    const init = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })
    await test('the long thread initializes its baseline, and the boundary is recorded', () => {
      assert.strictEqual(init.run.outcome, 'committed', JSON.stringify(init.report))
      assert.ok((init.report.entry_skipped || {}).coverage_baselined >= 1,
        'the window is absorbed: ' + JSON.stringify(init.report))
      const got = rows(`SELECT baseline_boundary_at::text, baseline_from_at::text
                          FROM public.outlook_thread_recovery
                         WHERE user_id='${U1}' AND conversation_fingerprint='${boundaryCfp()}';`)
      assert.strictEqual(got.length, 1, 'a baseline row exists for this thread')
      assert.strictEqual(got[0][0], got[0][1],
        'at initialization the boundary IS the span start: ' + JSON.stringify(got[0]))
      boundaryAt = got[0][0]
      assert.ok(boundaryAt.indexOf('2026-09-20') === 0,
        'and it is the initializing window, not any accepted message: ' + boundaryAt)
    })

    // ── 2. an EARLIER accepted message is re-delivered beside a fresh exchange ─
    const first = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the re-delivered accepted message is absorbed, and the fresh pair drafted', () => {
      assert.strictEqual(first.run.outcome, 'committed', JSON.stringify(first.report))
      const i = open(pendingInteractions())
      assert.strictEqual(i.length, 1,
        'one suggestion: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(first.report))
      assert.strictEqual(i[0][2], 'FRESH1-NOTE')
      const sent = legacyCounts.modelBodies[legacyCounts.modelBodies.length - 1]
      assert.ok(sent.indexOf('FRESH1-IN') >= 0 && sent.indexOf('FRESH1-OUT') >= 0)
      for (const tag of ['ACC-A0', 'ACC-A1', 'ACC-A2', 'ACC-A3', 'BASE-IN', 'BASE-OUT']) {
        assert.ok(sent.indexOf(tag) < 0, tag + ' is accepted or absorbed and must not be sent')
      }
    })

    await test('the SPAN expanded but the BOUNDARY did not move', () => {
      const got = rows(`SELECT baseline_boundary_at::text, baseline_from_at::text
                          FROM public.outlook_thread_recovery
                         WHERE user_id='${U1}' AND conversation_fingerprint='${boundaryCfp()}';`)
      assert.strictEqual(got[0][0], boundaryAt,
        'the boundary is set ONCE, at initialization: ' + JSON.stringify(got[0]))
      assert.ok(got[0][1] < got[0][0],
        'while the measured span now reaches further back: ' + JSON.stringify(got[0]))
    })

    await acceptInteraction(open(pendingInteractions())[0][0],
      NOTES.FRESH1 + '\n\nMine: noted.')
    const accepted2 = storedInteractions()

    // ── 3. the temporarily absent accepted message RETURNS, beside another pair ─
    legacyState.hidden.delete(hiddenAccepted)
    const back = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the RETURNED accepted message never reaches the model', () => {
      assert.strictEqual(back.run.outcome, 'committed', JSON.stringify(back.report))
      const sent = legacyCounts.modelBodies[legacyCounts.modelBodies.length - 1]
      // THE DEFECT, precisely: ACC-A2 sits between the lowered span minimum and the
      // initialization boundary. With the span's minimum as the cutoff it was drafted.
      assert.ok(sent.indexOf('ACC-A2') < 0,
        'the returned accepted message must NOT be drafted again')
      for (const tag of ['ACC-A0', 'ACC-A1', 'ACC-A3', 'BASE-IN', 'BASE-OUT',
        'FRESH1-IN', 'FRESH1-OUT']) {
        assert.ok(sent.indexOf(tag) < 0, tag + ' must not be sent again')
      }
      assert.ok(sent.indexOf('FRESH2-IN') >= 0 && sent.indexOf('FRESH2-OUT') >= 0,
        'and the genuinely fresh pair IS drafted')
    })

    await test('the fresh exchange is captured once, claiming only its own messages', () => {
      const i = open(pendingInteractions())
      assert.strictEqual(i.length, 1,
        'one suggestion: ' + JSON.stringify(pendingInteractions()))
      assert.strictEqual(i[0][2], 'FRESH2-NOTE')
      const fresh = refRows().filter((r) => Number(r[2]) === 2 && r[3] === 'draft')
      assert.ok(fresh.length >= 1, 'its coverage names two messages: ' + JSON.stringify(fresh))
    })

    await test('the returned message is absorbed, and the boundary STILL has not moved', () => {
      const got = rows(`SELECT baseline_boundary_at::text,
                               array_length(baseline_fingerprints, 1)
                          FROM public.outlook_thread_recovery
                         WHERE user_id='${U1}' AND conversation_fingerprint='${boundaryCfp()}';`)
      assert.strictEqual(got[0][0], boundaryAt, 'fixed at initialization, for good')
      assert.ok(Number(got[0][1]) >= 4,
        'and the absorbed set grew to take it in: ' + JSON.stringify(got[0]))
    })

    await test('every accepted interaction and reviewed note is unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted2)
      assert.strictEqual(accepted2.length, accepted.length + 1,
        'only the one the reviewer accepted in this gate was added')
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════════
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
