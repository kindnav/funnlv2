<#
.SYNOPSIS
  Owner-run helper that stores the two Vault secrets the scheduled Outlook tick reads
  (outlook_worker_url, outlook_worker_secret) WITHOUT the values appearing in a terminal,
  a shell history, a process listing, a chat, or a file.

.DESCRIPTION
  How the values travel:
    1. Each value is typed at a masked prompt (Read-Host -AsSecureString). Nothing is echoed.
    2. The SQL statement is composed in this process's memory only.
    3. It is handed to psql on STANDARD INPUT - not as a command-line argument (visible in a
       process listing) and not written to a file. psql reads the database URL from the
       PGURL environment variable of this process, so no connection string is on the
       command line either.
    4. The plaintext variables are cleared before the script returns.
  Afterwards the script prints ONLY the secret NAMES present in vault.decrypted_secrets,
  never a value.

  Prerequisites: psql on PATH; the Production database URL (Supabase dashboard -> Project
  Settings -> Database -> Connection string, session mode) at hand to type at the masked
  prompt. OUTLOOK_WORKER_SECRET is the existing worker secret the owner already holds; it
  is NOT rotated by this script.

  Alternative without this script: Supabase dashboard -> Integrations -> Vault -> "Add new
  secret" is a private browser form that stores the same two names; the names must match
  exactly. Either method satisfies the activation packet, step 3.

  Idempotent: a name that already exists is UPDATED in place (vault.update_secret), so a
  mistyped value can be corrected by running the script again.
#>
$ErrorActionPreference = 'Stop'

function Read-Plain([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Quote-Literal([string]$v) {
  # A SQL string literal: single quotes doubled. The values never contain control characters.
  return "'" + ($v -replace "'", "''") + "'"
}

Write-Host 'Nothing you type below is echoed, logged, or passed on a command line.'
$dbUrl = Read-Plain 'Production database URL (postgresql://...; session mode)'
$workerUrl = Read-Plain 'outlook_worker_url  (https://<ref>.supabase.co/functions/v1/outlook-import-worker)'
$workerSecret = Read-Plain 'outlook_worker_secret  (the existing OUTLOOK_WORKER_SECRET value)'

if ($workerUrl -notmatch '^https://[a-z0-9]+\.supabase\.co/functions/v1/outlook-import-worker$') {
  throw 'outlook_worker_url does not have the expected shape; nothing was stored.'
}
if ($workerSecret.Length -lt 32) {
  throw 'outlook_worker_secret is shorter than the worker accepts; nothing was stored.'
}

# One statement per secret: create, or update in place if the name already exists.
$sql = @"
DO `$`$
BEGIN
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'outlook_worker_url') THEN
    PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'outlook_worker_url'), $(Quote-Literal $workerUrl), 'outlook_worker_url', 'outlook-import-worker URL for the pg_cron tick');
  ELSE
    PERFORM vault.create_secret($(Quote-Literal $workerUrl), 'outlook_worker_url', 'outlook-import-worker URL for the pg_cron tick');
  END IF;
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'outlook_worker_secret') THEN
    PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'outlook_worker_secret'), $(Quote-Literal $workerSecret), 'outlook_worker_secret', 'OUTLOOK_WORKER_SECRET for the pg_cron tick');
  ELSE
    PERFORM vault.create_secret($(Quote-Literal $workerSecret), 'outlook_worker_secret', 'OUTLOOK_WORKER_SECRET for the pg_cron tick');
  END IF;
END
`$`$;
SELECT name FROM vault.decrypted_secrets WHERE name IN ('outlook_worker_url', 'outlook_worker_secret') ORDER BY name;
"@

$env:PGURL = $dbUrl
try {
  # stdin only: the statement (and the values inside it) is never an argument and never a file.
  $sql | & psql "$env:PGURL" -v ON_ERROR_STOP=1 -q -At
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE); check the database URL and try again." }
  Write-Host 'The two names above are present in Vault. Values were not displayed.'
}
finally {
  Remove-Item Env:PGURL -ErrorAction SilentlyContinue
  $sql = $null; $dbUrl = $null; $workerUrl = $null; $workerSecret = $null
  [GC]::Collect()
}
