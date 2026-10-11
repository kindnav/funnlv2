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
    ME, KNOWN, STRANGER, LEGACY_NEW, LONG_NEW, MAX_RECOVERY_MESSAGES_PER_FOLDER, assert,
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
  const longThread = thread({ party: KNOWN, conv: 'conv-long-legacy', turns: longTurns })
  // THE SAME SHAPE for someone who was a STRANGER when the proposal was accepted, so the
  // long-history case is composed with the anchor-form transition.
  const longNewThread = thread({ party: LONG_NEW, conv: 'conv-long-newc', turns: longTurns })
  const longHist = longThread.ids.slice(0, HISTORY)
  const longFirst = longThread.ids.slice(HISTORY, HISTORY + 2)
  const longCont1 = longThread.ids.slice(HISTORY + 2, HISTORY + 4)
  const longCont2 = longThread.ids.slice(HISTORY + 4)
  const nHist = longNewThread.ids.slice(0, HISTORY)
  const nFirst = longNewThread.ids.slice(HISTORY, HISTORY + 2)
  const nCont1 = longNewThread.ids.slice(HISTORY + 2, HISTORY + 4)
  const nCont2 = longNewThread.ids.slice(HISTORY + 4)

  const legacyWorld = world(legacyKnown, legacyNew, longThread, longNewThread)
  const legacyState = {
    schedule: [
      // pre-migration: the original exchange of all three threads
      legacyKnown.ids.slice(0, 2).concat(legacyNew.ids.slice(0, 2))
        .concat(longFirst).concat(nFirst),
      legacyKnown.ids.slice(2, 4).concat(legacyNew.ids.slice(2, 4)),
      legacyKnown.ids.slice(4).concat(legacyNew.ids.slice(4)),
      longCont1.concat(nCont1),
      longCont1.concat(nCont1),   // a replay of the same page, before the reviewer decides
      longCont2.concat(nCont2),
    ],
    seen: new Set(),
    always: new Set([...longHist, ...nHist]),
  }
  const legacyCounts = newCounts()

  {
    const r = await shippedRound({ world: legacyWorld, counts: legacyCounts,
      state: legacyState, ring: RING_V1, draftFor })
    await test('the SHIPPED worker proposes all four, with no coverage columns in existence', () => {
      assert.strictEqual(r.run.outcome, 'committed', JSON.stringify(r.report))
      assert.strictEqual(r.run.accepted, 4, JSON.stringify(r.report))
      assert.strictEqual(open(pendingInteractions()).length, 2,
        'the known contact, and the long thread which is also a known contact')
      assert.strictEqual(open(pendingNewContacts()).length, 2,
        'the unknown person, and the unknown person on the long thread')
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
      assert.strictEqual(storedInteractions().length, 4, 'four interactions exist')
      for (const addr of [LEGACY_NEW, LONG_NEW]) {
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
    assert.strictEqual(refs.length, 4, JSON.stringify(refs))
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
  // The original candidate for this thread was written by the SHIPPED worker before the
  // migration existed and accepted through the real acceptance RPC, above. Its refs row
  // carries NO conversation fingerprint, so the coverage read cannot find it; its episode
  // anchor is the first message of an exchange the back-catalogue hides, so it cannot be
  // found that way either.
  //
  // REPRODUCED at the previous head: with no settled instant there was no floor, the single
  // bounded page per folder was spent on 30 back-catalogue messages, the page came back
  // carrying @odata.nextLink, recovery settled `recovery_truncated` and the round COMMITTED -
  // for continuation 1 and again for continuation 2. The thread was permanently unable to log
  // another interaction.
  {
    const accepted = storedInteractions()
    const before = legacyCounts.model
    // Gate 1b's own suggestions were accepted and carry coverage too, so the absorption
    // claim below is about the rows THIS round creates, not every row in the table.
    const refsBefore = new Set(refRows().map((r) => r[1] + '|' + r[4]))

    // ── CONTINUATION 1 ──────────────────────────────────────────────────────
    const c1 = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('the long thread is completed by ONE bounded retry, not abandoned', () => {
      assert.strictEqual(c1.run.outcome, 'committed', JSON.stringify(c1.report))
      // TWO long legacy threads this round: the known contact, and the person who became a
      // contact when their proposal was accepted. One windowed retry each, and a retry is
      // NOT charged against the per-invocation recovery cap as a fresh attempt.
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

    await test('continuation 1 is absorbed EXPLICITLY: coverage names those messages only', () => {
      const fresh = refRows().filter((r) => !refsBefore.has(r[1] + '|' + r[4]))
      assert.strictEqual(fresh.length, 2,
        'one new coverage row per long thread: ' + JSON.stringify(fresh))
      for (const r of fresh) {
        assert.strictEqual(Number(r[2]), 2,
          'exactly the two messages the window returned, nothing older: ' + JSON.stringify(r))
        assert.strictEqual(r[3], 'draft', 'and a draft describes them')
        assert.match(r[1], /^[0-9a-f]{64}$/, 'the thread is identified')
      }
    })

    await test('THE LIMIT, stated: the pre-feature rows themselves stay uninitialized', () => {
      // A long legacy row cannot be LOCATED: it has no conversation fingerprint, and its
      // episode anchor is the first message of an exchange the back-catalogue hides, so no
      // bounded window can reach it. Nothing pretends otherwise - it is left exactly as the
      // shipped worker wrote it. What makes the thread work again is that the continuation
      // gets its own coverage row, under the thread's conversation fingerprint, from which
      // every later segment is decided.
      const stillLegacy = refRows().filter((r) => r[1] === '-' && Number(r[2]) === 0)
      assert.strictEqual(stillLegacy.length, 2,
        'both long legacy rows are untouched: ' + JSON.stringify(refRows()))
    })

    await test('and the model saw continuation 1 only, never the back-catalogue or the accepted exchange', () => {
      assert.ok(legacyCounts.model > before, 'a draft was made')
      for (const sent of legacyCounts.modelBodies.slice(-2)) {
        assert.ok(sent.indexOf('LATER-IN') >= 0 && sent.indexOf('LATER-OUT') >= 0,
          'both halves of the continuation must be present')
        assert.ok(sent.indexOf('HIST-0') < 0, 'back-catalogue history must not be sent')
        assert.ok(sent.indexOf('HIST-' + (HISTORY - 1)) < 0, 'nor the newest of it')
        assert.ok(sent.indexOf('FIRST-OUT') < 0, 'the accepted exchange must not be sent again')
        assert.ok(sent.indexOf('FIRST-IN') < 0, 'the accepted exchange must not be sent again')
      }
    })

    const cont1 = open(pendingInteractions())
    await test('exactly ONE new suggestion per long thread, accepted notes unchanged', () => {
      // BOTH take the interaction path now: the second person became a contact when their
      // proposal was accepted, so this is the anchor-form transition on a long thread.
      assert.strictEqual(cont1.length, 2,
        'one per long thread: ' + JSON.stringify(pendingInteractions()))
      assert.strictEqual(open(pendingNewContacts()).length, 0,
        'and no unknown-person path remains for either')
      for (const row of cont1) assert.strictEqual(row[2], 'LATER-NOTE')
      assert.deepStrictEqual(storedInteractions(), accepted, 'an accepted note changed')
    })

    // ── REPLAY: the same page again, before the reviewer decides ────────────
    const replay = await round({ world: legacyWorld, counts: legacyCounts,
      state: legacyState, ring: RING_V1, draftFor })
    await test('a replay REFRESHES that one suggestion and creates nothing', () => {
      assert.strictEqual(replay.run.outcome, 'committed', JSON.stringify(replay.report))
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 2, 'still two: ' + JSON.stringify(p))
      assert.deepStrictEqual(p.map((r) => r[0]).sort(), cont1.map((r) => r[0]).sort(),
        'and they are the SAME rows')
      assert.strictEqual(replay.report.created, 0, 'nothing new was created')
    })

    for (const row of cont1) {
      await acceptInteraction(row[0], NOTES.LATER + '\n\nMine: Thursday 3pm confirmed.')
    }
    const accepted2 = storedInteractions()
    await test('continuation 1 is accepted, so both threads now have settled coverage', () => {
      assert.strictEqual(accepted2.length, accepted.length + 2)
      const refs = refRows().filter((r) => Number(r[2]) > 0)
      assert.ok(refs.length >= 4, JSON.stringify(refs))
    })

    // ── CONTINUATION 2, in a later COMPLETED round ─────────────────────────
    const c2 = await round({ world: legacyWorld, counts: legacyCounts, state: legacyState,
      ring: RING_V1, draftFor })

    await test('continuation 2 is captured EXACTLY ONCE', () => {
      assert.strictEqual(c2.run.outcome, 'committed', JSON.stringify(c2.report))
      const p = open(pendingInteractions())
      assert.strictEqual(p.length, 2,
        'exactly one new suggestion per long thread: ' + JSON.stringify(pendingInteractions())
        + ' | ' + JSON.stringify(c2.report))
      for (const row of p) assert.strictEqual(row[2], 'THIRD-NOTE', 'the THIRD exchange')
    })

    await test('its draft carries both new halves and excludes everything settled', () => {
      for (const sent of legacyCounts.modelBodies.slice(-2)) {
        assert.ok(sent.indexOf('THIRD-IN') >= 0 && sent.indexOf('THIRD-OUT') >= 0,
          'both halves of continuation 2 must be present')
        for (const tag of ['HIST-0', 'FIRST-OUT', 'FIRST-IN', 'LATER-IN', 'LATER-OUT']) {
          assert.ok(sent.indexOf(tag) < 0, tag + ' is settled and must not be sent')
        }
      }
    })

    await test('and both accepted interactions, with their reviewed notes, are unchanged', () => {
      assert.deepStrictEqual(storedInteractions(), accepted2)
    })
  }

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
