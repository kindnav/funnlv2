<#
.SYNOPSIS
  Owner-run helper for the Outlook worker flag (OUTLOOK_IMPORT_WORKER_ENABLED) on the
  Production Supabase project, used ONLY inside an authorized window.

.DESCRIPTION
  The flag is an Edge Function secret read by outlook-import-worker and by the
  outlook-notifications kick. While it is absent, every scheduled tick, every notification
  kick and every manual invocation answers 503 not_enabled and runs nothing.

  Actions:
    status   - verifies the flag's state from the JSON secret inventory and prints
               PRESENT (verified) or ABSENT (verified). Empty, malformed or failed output is
               UNVERIFIED - never reported as absent. Exit 0 when verified, 1 when not.
    enable   - sets the flag, then REQUIRES verification PRESENT. If the set succeeds but
               verification does not, the helper unsets the flag again and reports the
               verified result of that cleanup; if the cleanup cannot be verified either, it
               reports UNKNOWN. Exit 0 = PRESENT (verified); 1 = not enabled, cleanup
               verified ABSENT or the set itself failed; 2 = UNKNOWN (check by hand).
    disable  - unsets the flag (non-interactive), then REQUIRES verification ABSENT.
               Exit 0 = ABSENT (verified); 1 = not verified (the flag may still be present:
               check by hand before assuming the window is closed).

  What it never does: print any secret value or digest (only the one flag NAME and a state
  word are ever displayed), touch OUTLOOK_WORKER_SECRET or any other secret, or change the
  cron job (which stays inactive until its activation is authorized separately;
  docs/outlook-background-activation-packet.md, step 9).

  The two authorized windows (packet steps 7 and 8) are separate: bootstrap is
  `enable` -> ONE invocation (whose run-once pattern unsets the flag in its finally) ->
  `status` expecting ABSENT; listener verification is `enable` -> observe the automatic
  runs -> `disable`.

.PARAMETER Action
  status | enable | disable

.PARAMETER ProjectRef
  The Supabase project ref. Defaults to the Funnl Production ref.

.PARAMETER Cli
  The command that runs the Supabase CLI. Defaults to npx.cmd (Windows). The offline test
  passes a fake that answers with synthetic output; nothing else should ever change this.

.EXAMPLE
  .\scripts\outlook-worker-flag.ps1 status
  .\scripts\outlook-worker-flag.ps1 enable
  .\scripts\outlook-worker-flag.ps1 disable
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'enable', 'disable')]
  [string]$Action,
  [string]$ProjectRef = 'jzybxhvgnksrwxfivdwt',
  [string]$Cli = 'npx.cmd'
)

$ErrorActionPreference = 'Continue'   # native exit codes are checked explicitly below
$FlagName = 'OUTLOOK_IMPORT_WORKER_ENABLED'

# Runs the CLI and returns its exit code and joined stdout. Stderr is left alone (it is not
# captured or echoed by this script beyond what the console shows), and stdout is never
# printed by the callers: only a derived state word is.
function Invoke-Cli {
  param([string[]]$CliArgs)
  $out = @(& $Cli @CliArgs)
  $code = $LASTEXITCODE
  $text = ($out | ForEach-Object { [string]$_ }) -join "`n"
  return @{ Code = $code; Text = $text }
}

# The inventory: `supabase secrets list -o json`, which must be a JSON ARRAY of objects that
# each carry a string `name`. Anything else is a failed verification. Values/digests in the
# inventory are never read beyond parsing and never displayed.
function Get-FlagState {
  $r = Invoke-Cli @('supabase', 'secrets', 'list', '--project-ref', $ProjectRef, '-o', 'json')
  if ($r.Code -ne 0) { return 'UNVERIFIED' }
  $text = $r.Text.Trim()
  if ($text.Length -eq 0 -or -not $text.StartsWith('[')) { return 'UNVERIFIED' }
  try { $parsed = ConvertFrom-Json -InputObject $text } catch { return 'UNVERIFIED' }
  $items = @($parsed)
  $present = $false
  foreach ($item in $items) {
    if ($null -eq $item) { return 'UNVERIFIED' }
    $prop = $item.PSObject.Properties['name']
    if ($null -eq $prop -or -not ($prop.Value -is [string])) { return 'UNVERIFIED' }
    if ($prop.Value -eq $FlagName) { $present = $true }
  }
  if ($present) { return 'PRESENT' } else { return 'ABSENT' }
}

function Show-State([string]$state, [string]$note = '') {
  $label = switch ($state) {
    'PRESENT' { 'PRESENT (verified)' }
    'ABSENT' { 'ABSENT (verified)' }
    'UNKNOWN' { 'UNKNOWN - check the Supabase dashboard (Edge Functions -> Secrets) by hand' }
    default { 'UNVERIFIED - the secret inventory could not be read; nothing is assumed' }
  }
  if ($note) { Write-Host ("{0}: {1} - {2}" -f $FlagName, $label, $note) }
  else { Write-Host ("{0}: {1}" -f $FlagName, $label) }
}

switch ($Action) {
  'status' {
    $state = Get-FlagState
    Show-State $state
    if ($state -eq 'PRESENT' -or $state -eq 'ABSENT') { exit 0 } else { exit 1 }
  }
  'enable' {
    Write-Host "Setting $FlagName=true on project $ProjectRef (an authorized window begins now)."
    $set = Invoke-Cli @('supabase', 'secrets', 'set', "$FlagName=true", '--project-ref', $ProjectRef)
    if ($set.Code -ne 0) {
      $state = Get-FlagState
      Show-State $state 'the set command failed; nothing was enabled unless the state above says PRESENT'
      exit 1
    }
    $state = Get-FlagState
    if ($state -eq 'PRESENT') {
      Show-State $state
      Write-Host "Reminder: run '.\scripts\outlook-worker-flag.ps1 disable' when the window ends or if verification stops."
      exit 0
    }
    # The set command returned success but the inventory does not confirm it. Do not leave
    # an unverified flag behind: unset it and report what the inventory then says.
    Write-Host "The set command succeeded but the inventory did not confirm $FlagName; cleaning up."
    $unset = Invoke-Cli @('supabase', 'secrets', 'unset', $FlagName, '--project-ref', $ProjectRef, '--yes')
    $after = Get-FlagState
    if ($unset.Code -eq 0 -and $after -eq 'ABSENT') {
      Show-State 'ABSENT' 'enable was NOT verified; the flag was removed again (verified). Nothing is enabled.'
      exit 1
    }
    Show-State 'UNKNOWN' 'enable was not verified and the cleanup could not be verified either'
    exit 2
  }
  'disable' {
    Write-Host "Unsetting $FlagName on project $ProjectRef (the window ends now)."
    $unset = Invoke-Cli @('supabase', 'secrets', 'unset', $FlagName, '--project-ref', $ProjectRef, '--yes')
    $state = Get-FlagState
    if ($unset.Code -eq 0 -and $state -eq 'ABSENT') {
      Show-State 'ABSENT'
      exit 0
    }
    if ($state -eq 'PRESENT') {
      Show-State 'PRESENT' 'the unset was NOT verified; the flag is still present - the window is NOT closed'
      exit 1
    }
    Show-State 'UNKNOWN' 'the unset could not be verified; do not assume the window is closed'
    exit 1
  }
}
