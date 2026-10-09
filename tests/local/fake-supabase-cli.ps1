# The synthetic Supabase CLI behind fake-supabase-cli.cmd. Arguments arrive exactly as the
# helper passes them: supabase secrets <list|set|unset> ... . Behaviour is chosen by
# FAKE_SCENARIO; FAKE_STATE names a file whose presence means "the flag is set".
#
# The inventory it emits carries a second, unrelated secret with a value that looks like a
# digest, so the test can assert that nothing of the kind ever reaches the helper's output.
param()
$scenario = $env:FAKE_SCENARIO
$stateFile = $env:FAKE_STATE
$sub = if ($args.Count -ge 3) { $args[2] } else { '' }
$log = $env:FAKE_LOG
if ($log) { Add-Content -Path $log -Value (($args | ForEach-Object { [string]$_ }) -join ' ') }

$DIGEST = 'd1g3st-must-never-be-shown-0123456789abcdef'
function Inventory([bool]$withFlag) {
  $items = @("{`"name`":`"OUTLOOK_WORKER_SECRET`",`"value`":`"$DIGEST`"}")
  if ($withFlag) { $items += "{`"name`":`"OUTLOOK_IMPORT_WORKER_ENABLED`",`"value`":`"$DIGEST`"}" }
  return '[' + ($items -join ',') + ']'
}
function FlagSet { return ($stateFile -and (Test-Path $stateFile)) }

switch ($sub) {
  'list' {
    switch ($scenario) {
      'present'   { Write-Output (Inventory $true); exit 0 }
      'absent'    { Write-Output (Inventory $false); exit 0 }
      'empty'     { exit 0 }
      'malformed' { Write-Output 'Error: unexpected output that is not JSON'; exit 0 }
      'object'    { Write-Output '{"name":"OUTLOOK_IMPORT_WORKER_ENABLED"}'; exit 0 }
      'noname'    { Write-Output '[{"value":"x"}]'; exit 0 }
      'fail'      { [Console]::Error.WriteLine('fake: network failure'); exit 1 }
      'enable_verify_fails'   { Write-Output (Inventory $false); exit 0 }   # the set never shows up
      'enable_cleanup_unknown' { if (FlagSet) { Write-Output (Inventory $false); exit 0 } else { Write-Output 'garbage'; exit 0 } }
      'disable_verify_fails'  { Write-Output (Inventory $true); exit 0 }    # the unset never shows up
      'disable_list_fails'    { exit 1 }
      default     { Write-Output (Inventory (FlagSet)); exit 0 }          # stateful: enable_ok / disable_ok
    }
  }
  'set' {
    if ($scenario -eq 'set_fails') { [Console]::Error.WriteLine('fake: set refused'); exit 1 }
    if ($stateFile) { Set-Content -Path $stateFile -Value 'set' }
    Write-Output 'Finished supabase secrets set.'; exit 0
  }
  'unset' {
    if ($args -notcontains '--yes') { [Console]::Error.WriteLine('fake: unset would PROMPT without --yes'); exit 3 }
    if ($scenario -eq 'enable_cleanup_unknown') { if ($stateFile) { Remove-Item $stateFile -ErrorAction SilentlyContinue }; Write-Output 'Finished.'; exit 0 }
    if ($scenario -eq 'unset_fails') { [Console]::Error.WriteLine('fake: unset refused'); exit 1 }
    if ($stateFile) { Remove-Item $stateFile -ErrorAction SilentlyContinue }
    Write-Output 'Finished supabase secrets unset.'; exit 0
  }
  default { [Console]::Error.WriteLine("fake: unexpected arguments: $($args -join ' ')"); exit 9 }
}
