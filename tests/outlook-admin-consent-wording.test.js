// THE ADMINISTRATOR-CONSENT CORRECTION - one sentence, two documents, nothing else.
//
// The notice's paragraph 4 and the /privacy Outlook section said the permissions need no
// administrator consent "by default". That is true of Microsoft's per-permission metadata, but
// Microsoft's recommended organisational consent policy - the default for new tenants - does not
// let users approve Mail.Read, so the claim misled. Both are corrected to the owner-reviewed
// sentence below. This file pins that:
//   * the sentence appears, character for character, in the notice and in /privacy;
//   * the old claim appears in neither;
//   * the other 23 notice paragraphs are byte-identical to the published cohort text, and
//     paragraph 4 changes only after "is connected. ";
//   * the version is DERIVED from the paragraphs by the existing algorithm, and the three worker
//     requirements carry that same derived value.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OUTLOOK_DISCLOSURE_PARAGRAPHS as P } from '../src/lib/outlookDisclosure.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EM = String.fromCharCode(0x2014)
const SENTENCE = 'With a personal Microsoft account you approve them yourself. A work or school ' +
  'organisation can require an administrator to approve an app that reads mail ' + EM +
  " Microsoft's recommended setting for organisations does " + EM + ' and then you cannot ' +
  'connect it until an administrator approves Funnl.'
// sha256 of the other 23 paragraphs joined by LF, measured on main dd7eb04 (the published
// cohort notice, ol-disc-6f904c3f7313353acbbc39e1edf2e278).
const OTHERS_SHA256 = 'cf003a8a385e9f9819809d01ce92d0e20e8470b43f7f06e74a9b4e499d79e6fc'
const P4_PREFIX_END = 'is connected. '

let passed = 0
let failed = 0
function test (name, fn) {
  try { fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  }
}

/** /privacy as a reader sees it: markup removed, whitespace collapsed. */
function privacyText () {
  const src = readFileSync(join(ROOT, 'src/pages/PrivacyPage.jsx'), 'utf8')
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

test('the notice carries the corrected sentence exactly, ending paragraph 4', () => {
  assert.strictEqual(P.length, 24)
  assert.ok(P[3].endsWith(P4_PREFIX_END + SENTENCE), P[3].slice(-260))
  assert.ok(!/administrator consent by default/i.test(P.join(' ')))
})

test('every other paragraph, and paragraph 4 before the sentence, is unchanged', () => {
  const others = P.filter((_, i) => i !== 3).join(String.fromCharCode(10))
  assert.strictEqual(createHash('sha256').update(others, 'utf8').digest('hex'), OTHERS_SHA256)
  assert.ok(P[3].startsWith('Microsoft grants those two more broadly than Funnl uses them. Mail.Read is granted at the mailbox level'))
})

test('/privacy carries the same sentence, character for character', () => {
  const t = privacyText()
  assert.ok(t.includes(SENTENCE), 'sentence missing from /privacy')
  assert.ok(!/administrator consent by default/i.test(t), 'the old claim survives in /privacy')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
