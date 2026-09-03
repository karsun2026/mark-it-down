# Handoff — 2 September 2026

State of this repo at the end of the session that took Mark it Down from a
standalone app to a tool inside the market intelligence suite, and then made it
survive more than one user at a time.

`ENGINEERING_SPEC.md` is what was intended, `DEVIATIONS.md` is where reality
differs and why. This file is neither: it is what a person picking the repo up
needs to know that is not obvious from the code.

---

## Where it runs

Two Vercel projects, two repos, one product.

| Piece | Lives in | Deployed as | URL |
| --- | --- | --- | --- |
| Converter (Python/FastAPI, container) | **this repo**, `converter/` | Vercel project `mark-it-down` | `https://mark-it-down-blue.vercel.app` |
| The user interface | `market-intel-site` repo, `app/toolkit/markdown/` | suite deployment | `/toolkit/markdown` |

`frontend/` in this repo is the **original standalone app**. It still works and
still deploys, but it is no longer the front door — the suite is. Treat it as a
reference implementation and a place to run the release harness, not as the
thing users see. Anything changed in one should be considered for the other;
they have already drifted once.

The browser calls the converter **directly, cross-origin**. Documents never pass
through a Vercel Function — that is the entire architectural point, and why a
100 MB upload is possible at all. `CORS_ALLOWED_ORIGINS` on the converter is
what lets the suite origin talk to it.

### Deployment changed at the end of this session

This project is now connected to GitHub. **Pushing to `main` deploys the
converter to production.** `vercel deploy --prod` still works, but the repo is
the source of truth now.

That connection exists because of a real defect: `converter/app/api.py` — the
CORS allow-list — ran in production for days while never being committed. The
Vercel CLI deploys the *working directory*, not `git HEAD`, so code can be live
and absent from version control at the same time. If you deploy by CLI, check
`git status` first.

Consequence of the new setup: a broken commit on `main` goes straight to
production. Branch and merge.

---

## What changed this session, and why

### The silent hang (the important one)

A user watched an unmoving screen for four minutes with no stage and no error.
Three things combined:

1. The status object was only written **after** the concurrency slot was
   acquired, so a queued job published nothing at all.
2. A missing status object is deliberately read by the client as "not written
   yet" rather than as a failure — correct in isolation.
3. The client races the convert POST against the status poll with
   `Promise.any`, which only rejects once **every** branch rejects. The poll
   never rejected on 404s, so a converter-side refusal waited out the client's
   full twelve-minute poll timeout in silence.

Fixed on both sides. Here: `Stage.ACCEPTED` is published **before** the
semaphore, and the slot-wait timeout now publishes `FAILED` — that `raise` sits
outside the `try`, so the handler that publishes `FAILED` never saw it, making
queue exhaustion the one failure that wrote no terminal status at all.

**If you add an early exit to `run_job`, make sure it publishes a terminal
status.** Anything that returns or raises before the first publish is invisible
to the client by construction.

### The queue that could never succeed

`SLOT_WAIT_SECONDS` was 30. Conversions take ~60s. So a queued job could not
succeed by waiting — it was guaranteed to time out while a slot was seconds from
freeing. Now 240 and overridable by env.

### Stages that do not exist

`Stage.VALIDATING` and `Stage.PACKAGING` are **never published**. They appear
only in the `_STAGE_PROGRESS` weight table in `app/services/status.py`. The
stages that actually fire are:

    accepted → downloading → converting → uploading → complete   (or failed)

A UI built on the full enum will show steps that never arrive. This already
happened once. Either publish them or do not present them as steps.

---

## Measured capacity — numbers, not estimates

All against production, via `market-intel-site/scripts/markdown-concurrency-test.mjs`.

| Load | Result |
| --- | --- |
| 8 × 59 KB PDF, words-only, **before** the slot fix | 5/8 — three rejected at ~33s |
| 8 × 59 KB PDF, words-only, after | **8/8** |
| 4 × 39.6 MB PDF, words-only | **4/4** |
| 4 × 39.6 MB PDF, media → 41.6 MB ZIP | **4/4** |

Every deliverable was **byte-identical** across concurrent runs. Quality does not
degrade under load.

**How the concurrency actually works:** one conversion per container instance
(`MAX_LOCAL_CONCURRENT_CONVERSIONS = 1`), and Vercel scales instances out.
Observed roughly five instances within 30 seconds of an 8-job burst. Jobs beyond
that queue and drain as slots free.

**Do not raise the per-instance concurrency to "support more users".** It is 1
on purpose (D-001). Two 40 MB jobs sharing a 425 MB disk turns a clean queue into
a real failure. Horizontal scaling plus a real queue is the safer shape, and it
is measured to work. `/tmp` is **512 MB** on the container — measured, not
documented anywhere by Vercel.

---

## PDF performance — where the time actually goes

Profiled on a 120-page dense PDF, words-only: **31.2s total**.

    pdfplumber extract_text()   24.9s   ← 80%
    table extraction             5.1s
    len(page.images)             0.2s

Two conclusions worth not re-deriving:

- **The words-only image skip is not a bottleneck.** `len(page.images)` in
  `_extract_images` costs ~2 ms/page, about 0.2% of the job. It reads like waste
  — it feeds `skipped_media`, which nothing consumes since the conversion report
  was removed (D-014) — but deleting it buys nothing measurable.
- **The cost is layout-aware text extraction**, and that is what makes
  multi-column pages come out in the right order. `pypdf.extract_text()` is
  **9× faster** (6 ms/page vs 57) but drops layout analysis, which is precisely
  the failure the UI already warns users about. It was deliberately not swapped.

If speed ever becomes the priority, the sensible design is not a swap but a
fallback: try pypdf, re-run a page through pdfplumber when the fast pass looks
suspicious. That is real work, not a one-liner.

---

## Running it locally

    # tests live at the ROOT, not under converter/
    PYTHONPATH=converter ./converter/.venv/Scripts/python.exe -m pytest tests/converter -q

336 tests, ~26s. Python 3.14.7, pypdf 6.16.2, pdfplumber 0.11.10.

**Always install with `--only-binary=:all:`.** `converter/.venv/pip.ini` enforces
it. A source build of `pydantic-core` pulls `rustup-init.exe`, which Check Point
EDR kills along with the whole process tree — this crashed the editor
repeatedly before it was diagnosed. The pip.ini is not decoration.

Secrets live in `.env.deploy.local`, gitignored. `.env.example` lists every
variable name with placeholder values.

---

## Known issues

**`/converter/ready` returns 500 intermittently.** Roughly 1 in 4 calls; the body
is correct when it succeeds, and `/converter/health` is solid. Pre-existing, and
confirmed not caused by the GitHub connection (that made no deployment).
Impact is nil — nothing in the conversion path calls `/ready` and it is not
wired to a Vercel health check. Suspect a cold-start filesystem probe in
`_tmp_writable` or `probe_disk`. Not yet diagnosed.

**Still on `*.vercel.app`.** Check Point Harmony's Zero Phishing engine blocked
the suite page as a "deceptive website" — a false positive driven by a
credential form on a shared, heavily-abused domain suffix. Worked around by
moving the route and naming the owner in the page title. A custom domain is the
durable fix; expect recurrence on other corporate networks until then.

**Retention sweep unobserved.** The hourly blob cleanup lives in the *suite*
repo (`app/api/toolkit/markdown/cleanup`), not here. It is deployed and
correctly returns 401 to unauthorised callers, but has never been seen to run
successfully — the `CRON_SECRET` pulled locally does not authenticate against
production, which is itself unexplained. Roughly 1 GB of load-test blobs is
waiting on its first successful run.

---

## Things that will bite you

- **The Vercel CLI deploys the working tree, not `git HEAD`.** See above.
- **Vercel presigns reads by path and writes by query** (D-011). URL-binding
  code must handle both forms or it rejects every valid result upload.
- **An expired signed link returns a 10-byte "Forbidden" body with HTTP 200-ish
  handling in the browser**, which a download saves as a corrupt `.zip`. Result
  links are therefore minted **on click**, never in advance.
- **Cancel does not stop a running conversion.** The browser aborts its request;
  the server finishes the job and keeps the slot. Repeated retries queue behind
  abandoned work.
- **`Resource provisioning timed out`** from Vercel is transient and has hit this
  project several times. Retry before investigating.
