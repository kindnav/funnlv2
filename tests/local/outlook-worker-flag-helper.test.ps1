# Offline behaviour test for scripts/outlook-worker-flag.ps1.
#
# The helper is RUN (not merely parsed) against the synthetic CLI in fake-supabase-cli.cmd,
# which answers with canned inventories and exit codes chosen per scenario. No credential,
# no network, no Production project is involved: the project ref passed is a dummy and the
# fake ignores it.
#
# Run with:  powershell -NoProfile -ExecutionPolicy Bypass -File tests/local/outlook-worker-flag-helper.test.ps1
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$helper = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'scripts\outlook-worker-flag.ps1'
$fake = Join-Path $here 'fake-supabase-cli.cmd'
$DIGEST = 'd1g3st-must-never-be-shown-0123456789abcdef'

$passed = 0; $failed = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "  OK   $name"; $script:passed++ }
  else { Write-Host "  FAIL $name"; if ($detail) { Write-Host "       $detail" }; $script:failed++ }
}

function Run([string]$scenario, [string]$action, [bool]$flagInitiallySet = $false) {
  $state = Join-Path $env:TEMP ("flag-helper-state-" + [guid]::NewGuid().ToString('n'))
  $log = Join-Path $env:TEMP ("flag-helper-log-" + [guid]::NewGuid().ToString('n'))
  if ($flagInitiallySet) { Set-Content -Path $state -Value 'set' }
  $env:FAKE_SCENARIO = $scenario; $env:FAKE_STATE = $state; $env:FAKE_LOG = $log
  $out = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $helper $action -ProjectRef 'dummy-ref' -Cli $fake 2>&1 | ForEach-Object { [string]$_ })
  $code = $LASTEXITCODE
  $calls = if (Test-Path $log) { @(Get-Content $log) } else { @() }
  Remove-Item $state, $log -ErrorAction SilentlyContinue
  return @{ Code = $code; Text = ($out -join "`n"); Calls = $calls }
}

Write-Host ''
Write-Host 'status: the inventory decides, and only a verified inventory counts'
$r = Run 'present' 'status'
Check 'present -> PRESENT (verified), exit 0' ($r.Code -eq 0 -and $r.Text -match 'PRESENT \(verified\)') $r.Text
Check 'the inventory values/digests never appear in the output' (-not $r.Text.Contains($DIGEST) -and -not $r.Text.Contains('OUTLOOK_WORKER_SECRET')) $r.Text
Check 'the list request asked for JSON' (($r.Calls -join ' ') -match 'secrets list .* -o json') ($r.Calls -join ' | ')
$r = Run 'absent' 'status'
Check 'absent -> ABSENT (verified), exit 0' ($r.Code -eq 0 -and $r.Text -match 'ABSENT \(verified\)') $r.Text
foreach ($bad in 'empty', 'malformed', 'object', 'noname', 'fail') {
  $r = Run $bad 'status'
  Check "$bad output -> UNVERIFIED, exit 1, never ABSENT" ($r.Code -eq 1 -and $r.Text -match 'UNVERIFIED' -and $r.Text -notmatch 'ABSENT' -and $r.Text -notmatch 'PRESENT \(verified\)') $r.Text
}

Write-Host ''
Write-Host 'enable: requires verified PRESENT; otherwise cleans up and reports the verified result'
$r = Run 'enable_ok' 'enable'
Check 'set then inventory shows it -> PRESENT (verified), exit 0' ($r.Code -eq 0 -and $r.Text -match 'PRESENT \(verified\)') $r.Text
Check 'no unset was attempted on success' (-not (($r.Calls -join ' ') -match 'secrets unset')) ($r.Calls -join ' | ')
$r = Run 'enable_verify_fails' 'enable'
Check 'set succeeds, inventory never confirms -> cleanup, verified ABSENT, exit 1' ($r.Code -eq 1 -and $r.Text -match 'ABSENT \(verified\)' -and $r.Text -match 'NOT verified') $r.Text
Check 'the cleanup unset was non-interactive (--yes) and happened once' ((@($r.Calls | Where-Object { $_ -match 'secrets unset .* --yes' })).Count -eq 1) ($r.Calls -join ' | ')
$r = Run 'enable_cleanup_unknown' 'enable'
Check 'set succeeds, inventory never confirms, cleanup cannot be verified -> UNKNOWN, exit 2' ($r.Code -eq 2 -and $r.Text -match 'UNKNOWN') $r.Text
$r = Run 'set_fails' 'enable'
Check 'the set command fails -> exit 1 and the state is re-read, not assumed' ($r.Code -eq 1 -and $r.Text -match 'set command failed') $r.Text

Write-Host ''
Write-Host 'disable: non-interactive unset, then requires verified ABSENT'
$r = Run 'disable_ok' 'disable' $true
Check 'unset then inventory confirms -> ABSENT (verified), exit 0' ($r.Code -eq 0 -and $r.Text -match 'ABSENT \(verified\)') $r.Text
Check 'the unset carried --yes' ((($r.Calls -join ' ') -match 'secrets unset OUTLOOK_IMPORT_WORKER_ENABLED --project-ref dummy-ref --yes')) ($r.Calls -join ' | ')
$r = Run 'disable_verify_fails' 'disable' $true
Check 'unset returns success but the flag is still listed -> PRESENT, NOT closed, exit 1' ($r.Code -eq 1 -and $r.Text -match 'PRESENT' -and $r.Text -match 'NOT closed') $r.Text
$r = Run 'disable_list_fails' 'disable' $true
Check 'unset then the inventory cannot be read -> UNKNOWN, exit 1' ($r.Code -eq 1 -and $r.Text -match 'UNKNOWN') $r.Text
$r = Run 'unset_fails' 'disable' $true
Check 'the unset command fails -> exit 1, not reported closed' ($r.Code -eq 1 -and $r.Text -notmatch 'ABSENT \(verified\)') $r.Text

Write-Host ''
Write-Host 'nothing else is touched'
$r = Run 'present' 'status'
Check 'only secrets list/set/unset of the one flag name are ever requested' ((@($r.Calls | Where-Object { $_ -notmatch '^supabase secrets (list|set OUTLOOK_IMPORT_WORKER_ENABLED=true|unset OUTLOOK_IMPORT_WORKER_ENABLED)' })).Count -eq 0) ($r.Calls -join ' | ')

Write-Host ''
Write-Host ("{0} checks: {1} passed, {2} failed" -f ($passed + $failed), $passed, $failed)
if ($failed -gt 0) { exit 1 } else { exit 0 }
