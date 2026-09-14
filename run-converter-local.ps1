# Starts the Python converter service locally on port 8000.
#
# Why this exists: `next dev` has no /converter/* route, and the browser POSTs
# conversions to /converter/v1/convert on its own origin. In production,
# vercel.json routes that path to the converter container. Locally, run this
# script in a SECOND terminal (keep `npm run dev` running in the first), and
# make sure MARK_IT_DOWN_BASE_URL=http://localhost:8000 is set in
# frontend/.env.local so next.config.ts proxies the path here.
#
# The converter verifies the HMAC job token the frontend mints, so it MUST run
# with the same JOB_SIGNING_SECRET the frontend uses. This script reads it
# from frontend/.env.local and injects it into the converter process env —
# the secret is never printed or written anywhere else.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $repoRoot "frontend\.env.local"

if (-not (Test-Path $envFile)) {
    Write-Error "frontend\.env.local not found next to this script."
}

# Pull JOB_SIGNING_SECRET out of frontend/.env.local without echoing it.
$secret = $null
foreach ($line in Get-Content $envFile) {
    if ($line -match '^JOB_SIGNING_SECRET=(.+)$') {
        $secret = $Matches[1].Trim()
        break
    }
}
if (-not $secret -or $secret.Length -lt 32) {
    Write-Error "JOB_SIGNING_SECRET missing or too short in frontend\.env.local."
}

# DOCX conversion shells out to pandoc; PDF and PPTX do not. Warn only —
# a missing pandoc must not block PDF-only testing.
if (-not (Get-Command pandoc -ErrorAction SilentlyContinue)) {
    Write-Warning "pandoc not found on PATH - DOCX conversions will fail. PDF and PPTX work without it."
}

Write-Host "Starting converter on http://localhost:8000 (signing secret loaded from frontend\.env.local)"
Push-Location (Join-Path $repoRoot "converter")
try {
    $env:JOB_SIGNING_SECRET = $secret
    & .\.venv\Scripts\python.exe -m uvicorn app.api:app --host 127.0.0.1 --port 8000
} finally {
    Pop-Location
}