<#
.SYNOPSIS
  Owner-run helper for the Outlook worker flag (OUTLOOK_IMPORT_WORKER_ENABLED) on the
  Production Supabase project, used ONLY inside an authorized window.

.DESCRIPTION
  The flag is an Edge Function secret read by outlook-import-worker and by the
  outlook-notifications kick. While it is absent, every scheduled tick, every notification
  kick and every manual invocation answers 503 not_enabled and runs nothing.

  Three actions, nothing else:
    status   - prints whether the flag is PRESENT or ABSENT. Only that one name is examined;
               no other secret name, value or digest is printed.
    enable   - sets OUTLOOK_IMPORT_WORKER_ENABLED=true (begins the window). Prints status.
    disable  - unsets it (ends the window, or aborts it). Prints status.

  It never touches OUTLOOK_WORKER_SECRET or any other secret, never prints a value, and
  never changes the cron job (which stays inactive until its activation is authorized
  separately; see docs/outlook-background-activation-packet.md, step 9).

.PARAMETER Action
  status | enable | disable

.PARAMETER ProjectRef
  The Supabase project ref. Defaults to the Funnl Production ref.

.EXAMPLE
  .\scripts\outlook-worker-flag.ps1 status
  .\scripts\outlook-worker-flag.ps1 enable
  .\scripts\outlook-worker-flag.ps1 disable
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'enable', 'disable')]
  [string]$Action,
  [string]$ProjectRef = 'jzybxhvgnksrwxfivdwt'
)

$ErrorActionPreference = 'Stop'
$FlagName = 'OUTLOOK_IMPORT_WORKER_ENABLED'

function Get-FlagState {
  # `supabase secrets list` prints one row per secret: NAME and a DIGEST of the value.
  # Only the presence of the one flag name is reported here; the raw listing is never shown.
  $rows = & npx supabase secrets list --project-ref $ProjectRef 2>&1
  if ($LASTEXITCODE -ne 0) { throw "supabase secrets list failed (exit $LASTEXITCODE)" }
  $present = $false
  foreach ($line in $rows) {
    if ($line -match ('^\s*' + [regex]::Escape($FlagName) + '\s')) { $present = $true }
  }
  if ($present) { return 'PRESENT' } else { return 'ABSENT' }
}

switch ($Action) {
  'status' {
    Write-Host ("{0}: {1}" -f $FlagName, (Get-FlagState))
  }
  'enable' {
    Write-Host "Setting $FlagName=true on project $ProjectRef (the authorized window begins now)."
    & npx supabase secrets set "$FlagName=true" --project-ref $ProjectRef | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "supabase secrets set failed (exit $LASTEXITCODE)" }
    Write-Host ("{0}: {1}" -f $FlagName, (Get-FlagState))
    Write-Host "Reminder: run '.\scripts\outlook-worker-flag.ps1 disable' when the window ends or if verification stops."
  }
  'disable' {
    Write-Host "Unsetting $FlagName on project $ProjectRef (the window ends now)."
    & npx supabase secrets unset $FlagName --project-ref $ProjectRef | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "supabase secrets unset failed (exit $LASTEXITCODE)" }
    Write-Host ("{0}: {1}" -f $FlagName, (Get-FlagState))
  }
}
