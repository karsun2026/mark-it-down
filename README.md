# Mark it Down

Convert Word, PowerPoint and PDF documents into Markdown plus extracted media,
and download the result as a ZIP.

```
AI tokens consumed per conversion: 0
```

No model is called at any point. Every conversion is deterministic: Pandoc for
DOCX, python-pptx for PPTX, pdfplumber and pypdf for PDF. The same document
always produces the same Markdown.

- **Supported inputs:** `.docx`, `.pptx`, `.pdf`
- **Maximum source size:** 100 MB
- **Storage:** temporary Private Vercel Blob only, automatically deleted

`ENGINEERING_SPEC.md` is the source of truth for the build.
`DEVIATIONS.md` records the five documented departures from it.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Converter core, validation, packaging, tests | **Complete** |
| 2 | Private Blob data path, job tokens, signed URLs | **Complete** |
| 3 | Web UI | **Complete** |
| 4 | 100 MB hardening, near-limit release test | Not started |
| 5 | Auth, rate limiting, cron cleanup, deployment | Not started |

The conversion core is local and network-free by design, so it is testable
without Vercel, Blob credentials, or any platform dependency. The Blob layer
is tested against a mocked store, so the whole suite runs offline.

**Not production-ready.** §70 makes the near-100 MB test a release blocker and
it has not been run. Auth and rate limiting are Phase 5.

## Why the architecture looks like this

A Vercel Function's request and response bodies are capped at about 4.5 MB, so
a 100 MB document can never be proxied through one. Instead:

```
Browser -> Private Blob -> Converter -> Private Blob -> Browser
```

The browser uploads straight to Blob, the converter reads and writes Blob via
short-lived signed URLs, and Functions only ever carry small JSON control
messages. This is the constraint the whole design is built around, and it is
verified against Vercel's current documented limits.

## Local development

Requires Python 3.14, Node 24 and Pandoc.

```bash
cd converter && py -3 -m venv .venv && ./.venv/Scripts/python.exe -m pip install --only-binary=:all: -r requirements-dev.txt
```

Generate the test fixtures (they are built, not committed, so the repository
holds no opaque binaries):

```bash
cd converter && ./.venv/Scripts/python.exe ../tests/converter/fixtures/build_fixtures.py
```

Run the suite and the linter:

```bash
cd converter && ./.venv/Scripts/python.exe -m pytest ../tests/converter -q && ./.venv/Scripts/python.exe -m ruff check app ../tests scripts
```

Check the environment resolves:

```bash
cd converter && ./.venv/Scripts/python.exe scripts/verify_env.py
```

### `--only-binary=:all:` is not optional

Every pip invocation in this project must pass `--only-binary=:all:`, and
`converter/.venv/pip.ini` enforces it for that virtualenv.

On 2026-09-01 an install without it fell back to compiling `pydantic-core` from
source, because the pinned version had no wheel for Python 3.14. The build
backend downloaded `rustup-init.exe` into `AppData` and executed it; the
endpoint security agent killed that binary and swept the spawning process tree,
taking the editor's GPU, network, renderer and pty-host processes with it.

Binary-only makes that class of failure impossible: pip fails loudly on a
missing wheel instead of reaching for a compiler. Dependency pins are therefore
only ever set to versions with prebuilt wheels for the target interpreter.

## Privacy and retention

- Source and result blobs are private; no public document URLs exist.
- The source is deleted immediately after a successful conversion, with an
  hourly cleanup job as crash recovery.
- Results are deleted automatically after a short retention window.
- Document text, image content, signed URLs and tokens are never logged.
  Filename logging is disabled by default (`LOG_FILENAMES=false`).
- The conversion report is checked against a deny-list before it is written, so
  paths, URLs and tokens cannot leak into a file the user downloads.

## Known limitations

Deterministic conversion is faithful but not lossless. Expect these:

- **DOCX** — SmartArt, charts, floating text boxes, exact page layout, tracked
  changes and comments are not preserved.
- **PPTX** — charts, SmartArt, connectors, animations and spatial relationships
  are not preserved. Slide order is approximated top-then-left. Unsupported
  objects produce a warning rather than failing the job.
- **PDF** — multi-column reading order, complex tables and chart text may be
  imperfect. Scanned pages are detected and flagged, not OCR'd; OCR is out of
  scope for v1.

A file within the 100 MB limit may still be rejected if its converted output
expands past the safe processing ceiling.

## Licensing

See `THIRD_PARTY_NOTICES.md`. No AGPL runtime dependencies. Pandoc is
GPL-2.0-or-later and runs as a separate process; confirm that is acceptable
under your organisation's policy before production use.

## Running the web app locally

```bash
cd frontend && npm install --ignore-scripts && npm run dev
```

`--ignore-scripts` prevents package postinstall hooks from executing anything,
for the same reason `--only-binary=:all:` exists on the Python side.

Build and test the frontend:

```bash
cd frontend && npm run typecheck && npm run test && npm run build
```

The Blob routes need a Blob store and the environment variables in
`.env.example`; the page itself renders without them.
