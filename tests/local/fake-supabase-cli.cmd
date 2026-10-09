@echo off
rem A stand-in for `npx.cmd supabase ...` used ONLY by tests/local/outlook-worker-flag-helper.test.ps1.
rem It answers with synthetic output chosen by the FAKE_SCENARIO environment variable and
rem never contacts anything. The state file (FAKE_STATE) lets set/unset change later list answers.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-supabase-cli.ps1" %*
exit /b %ERRORLEVEL%
