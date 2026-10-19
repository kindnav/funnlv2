// The Google cleanup helper the DEPLOYED delete-account (v69) still runs, loaded from git history.
//
// Stage F removed supabase/functions/shared/googleCleanup.js from the working tree, but until the
// new delete-account is deployed, Production keeps calling the old helper. The local harnesses
// exercise that old behaviour by loading the file exactly as it was at the Stage F base revision
// (identical to what v69 bundles). The module has no imports, so it loads as a data: URL without
// writing anything to disk.
import { execFileSync } from 'node:child_process'

export const RETIRED_HELPER_REV = 'e41719213425271234855c05bf4f2e61dbcc3060'

export async function loadRetiredGoogleCleanup (root) {
  const src = execFileSync('git', ['show', `${RETIRED_HELPER_REV}:supabase/functions/shared/googleCleanup.js`], { cwd: root, encoding: 'utf8' })
  return import('data:text/javascript,' + encodeURIComponent(src))
}
