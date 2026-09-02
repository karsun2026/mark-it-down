# Security

Required by ENGINEERING_SPEC.md §7. The controls below implement §45, with the
error contract in §46 and the logging rules in §47.

## Threat model in one line

Users upload confidential internal documents. The system must not leak them —
to other users, to logs, to third parties, or to anyone who finds a URL — and
must not let a malicious document take the service down.

## Controls in place

### The document never touches a Function

A Vercel Function's request and response bodies are capped at ~4.5 MB. The
browser uploads straight to Private Blob and downloads straight from it; the
app only ever passes small JSON control messages. Verified in production: a
95 MB job moves ~190 MB through Blob while **under 4 KB** crosses a Function
(`RELEASE_TEST.md`). This is asserted by `release_test_e2e.py`, so a future
change that starts proxying bytes fails a test.

### Everything is private and short-lived (§20, §40)

- The Blob store is created with `--access private`. There are no public
  document URLs.
- Access is by signed URL only: source GET 20 min, result PUT 20 min, download
  GET 10 min.
- The source is deleted immediately after a successful conversion. Sources from
  failed jobs are reclaimed by the hourly cleanup cron after 60 minutes;
  results after 120 minutes. Both verified live.

### Requests are bound to their job (§16)

A job token is an HMAC-SHA256 over the job id, both pathnames, the filename and
the actual source size, with a 20-minute expiry. Signature is verified before
expiry, so an expired token with a bad signature reports `JOB_TOKEN_INVALID`
rather than confirming payload contents.

Crucially, **every presigned URL in a convert request is bound to the pathname
its token was signed for**. Without that, a caller holding one valid token
could point the result upload at any pathname they liked and the token would
still verify. Note that Vercel presigns reads and writes differently — see
DEVIATIONS D-011.

### Uploads are constrained before a byte lands

The client upload token restricts pathname, content type and maximum size, all
enforced by Blob rather than by us. `prepare-job` then re-checks the **actual**
size from blob metadata (§14) rather than trusting the client's claim.

### Malicious documents (§29, §30)

- **Format is verified by content, not extension**: PDFs must begin `%PDF-`;
  OOXML files must be real ZIPs containing the parts their type requires.
- **Encrypted Office files are detected** by their OLE2/CFB magic bytes and
  reported as `PASSWORD_PROTECTED` rather than as a corrupt file.
- **ZIP bombs are rejected** on member count, expanded size, compression ratio,
  path traversal and absolute member paths — all read from the central
  directory, before anything is decompressed. The ratio guard is gated on
  *expanded* size, because a compressed-size floor lets 40 MB of zeros through.
- **Macros are never executed.** Macro-enabled formats are refused outright.

### Resource exhaustion (§22, §23, §26, §27)

- Workspace budget is enforced **globally** across in-flight jobs, not per job,
  so concurrency cannot oversubscribe the disk. `/tmp` is 512 MB in production
  (measured); the budget is 425 MB with concurrency 1.
- Output tree and result ZIP each capped at 180 MB.
- The source is deleted before the ZIP is built, which halves peak disk.
- **In-process converters run in a killable child process** with a wall-clock
  timeout. Pandoc gets its own subprocess timeout. A pathological document
  cannot block the worker indefinitely.
- PDF table extraction is a budgeted, degradable feature; it is skipped rather
  than allowed to consume the conversion deadline.

### No shell, no injection

Pandoc is invoked with an argument array. `shell=True` is never used. The
uploaded filename is never used as a filesystem path — it is sanitised to a
stem with traversal sequences, control characters, reserved Windows names and
illegal characters removed.

### Nothing sensitive is logged (§47)

Logged: job id, file type, sizes, duration, outcome, warning count, error code.
Never logged: document text, image content, signed URLs, job tokens, Blob
credentials, or rate-limit bucket keys. Filename logging is off by default
(`LOG_FILENAMES=false`).

The conversion report the user downloads is checked against a deny-list for
paths, URLs and bearer tokens **before it is written**, so §39 cannot be
violated by a later change.

### No stack traces reach the browser (§45)

Every failure funnels through a `ConversionError` carrying a stable §46 code
and reader-facing text. Internal detail is logged, never serialised.

### Access is gated (§43)

The tool is behind a shared password. §43 permits "Microsoft Entra ID **or
another approved SSO/access-control method**"; this is the latter, chosen
because Vercel's own "All Deployments" protection is a paid upgrade.

- The password is verified **server-side only** and never appears in the
  browser bundle.
- On success the server sets an **HttpOnly**, Secure, SameSite cookie signed
  with `JOB_SIGNING_SECRET`, so it cannot be read by scripts or forged.
- Comparison is constant-time over hashed values, so neither the password nor
  its length leaks through response timing.
- Failed attempts are throttled per browser.
- The gate is enforced **on the API routes, not just the page**. A client-side
  check would leave `/api/blob/upload` reachable by anyone who reads the
  JavaScript.

Enforcement is per-route rather than in middleware, because Next.js middleware
compiles to an Edge Function and Vercel rejects Edge Runtime in a
multi-service project - which this must be to run the converter container.
`lib/guard.ts` lists exactly which routes are covered and why two are not.

### Transport and browser (§45)

HTTPS enforced with HSTS. A strict CSP (`default-src 'self'`, no external
origins except the Blob host), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `frame-ancestors 'none'`, and a strict referrer
policy.

### No AI, no external services

No model is called and no document leaves Vercel. Asserted by a repo-wide grep
in CI: zero references to any AI provider, SDK or gateway in application code.

## Known gaps

These are open and tracked, not overlooked.

| Gap | Status |
|---|---|
| **Shared password, not per-person identity** | The app is gated (`AUTH_MODE=password`), but one secret is shared by everyone: no audit trail, no individual revocation, and rotation affects the whole team. Adequate for a pilot; move to Entra before this is the permanent answer for confidential documents at scale. |
| **Rate limiting is not enforcing** | The code is in place and correct, but `@vercel/firewall` needs a dashboard rule with id `conversions` (Fixed Window, 600 s, 5 requests). Until it exists the app logs `rate limiting is NOT in effect` on every request. Set `RATE_LIMIT_REQUIRED=true` to fail closed instead. |
| Pandoc is GPL-2.0-or-later | Invoked as a subprocess, not linked. Flagged for the §51 organisational licensing review rather than assumed to pass — see `THIRD_PARTY_NOTICES.md`. |
| No OCR for scanned PDFs | Out of scope for v1. Scanned pages are detected and flagged, not silently returned empty. |

## Reporting a vulnerability

Report internally through the usual security channel. Do not open a public
issue. Include the stable error code from `§46` if one was shown — it is safe
to share and identifies the failure path without revealing document content.
