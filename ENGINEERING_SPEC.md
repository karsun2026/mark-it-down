# Document-to-Markdown Web App
## Vercel-First Engineering Specification (100 MB)

**Target builder:** Claude Code  
**Deployment:** Vercel Pro  
**Supported inputs:** DOCX, PPTX, PDF  
**Maximum source file size:** 100 MB  
**AI/LLM usage:** None  
**AI tokens per conversion:** 0  
**Storage model:** Temporary Vercel Private Blob only  
**Primary objective:** Convert office documents into Markdown + extracted media and return a downloadable ZIP.

---

# 1. Claude Code directive

Treat this file as the source-of-truth build specification.

Do not silently change the architecture. If a Vercel API has changed, verify current official documentation, preserve the intent, and document the deviation.

Hard constraints:

- Maximum accepted source file: `100 * 1024 * 1024` bytes.
- Large file binaries must never pass through normal Vercel Function request or response bodies.
- Source files upload directly from the browser to Vercel Private Blob.
- Result ZIP files download directly from Vercel Private Blob through short-lived signed URLs.
- Conversion runs on Vercel.
- DOCX uses Pandoc.
- PPTX uses `python-pptx`.
- PDF uses `pypdf`.
- Do not use PyMuPDF or PyMuPDF4LLM in production.
- Avoid AGPL runtime dependencies.
- Do not call OpenAI, Anthropic, Gemini, Vercel AI Gateway, or any LLM.
- Do not install an AI SDK.
- AI token usage must remain exactly zero.
- Uploaded source files must be deleted after conversion or by recovery cleanup.
- Result ZIPs must be deleted automatically after a short retention window.
- The converter must live in a dedicated Vercel project, separate from unrelated agents.
- Do not log document text, images, signed URLs, access tokens, or secrets.

---

# 2. Product experience

A non-technical colleague must be able to:

1. Open the web app.
2. Drag/drop or choose a `.docx`, `.pptx`, or `.pdf`.
3. See filename, type, and size.
4. Click **Convert to Markdown**.
5. Confirm conversion.
6. See real upload progress.
7. See a conversion state.
8. Download `<filename>_markdown.zip`.
9. Click **Convert another file**.

The user must not need Python, Pandoc, Command Prompt, API keys, or a developer environment.

Initial UI:

```text
Document to Markdown Converter

Convert Word, PowerPoint, and PDF documents into Markdown.

[ Drop a file here ]
or
[ Choose File ]

DOCX · PPTX · PDF
Maximum size: 100 MB

Files are processed temporarily and automatically deleted.
No AI model is used.
```

After file selection:

```text
Venture Building Methodology.pptx
PowerPoint presentation
42.8 MB

[Change file]     [Convert to Markdown]
```

Confirmation:

```text
Convert this file?

Venture Building Methodology.pptx
PowerPoint presentation
42.8 MB

Output:
• Markdown
• extracted media
• conversion report

[Cancel] [Convert]
```

Completion:

```text
Conversion complete

Venture Building Methodology_markdown.zip

[Download ZIP]
[Convert another file]
```

---

# 3. Why Blob is mandatory

Normal Vercel Functions have request and response payload limits around 4.5 MB. Therefore a 100 MB document must not be proxied through a Function.

Prohibited:

```text
Browser -> Function with 100 MB file -> converter -> Function returns ZIP
```

Required:

```text
Browser
  |
  | direct private upload
  v
Vercel Private Blob
  |
  | signed GET
  v
Converter
  |
  | signed PUT
  v
Vercel Private Blob
  |
  | signed GET
  v
Browser
```

Functions are used only for small control messages and signed-token generation.

---

# 4. Verified Vercel assumptions

Re-check these in official Vercel documentation while implementing.

- Function request payload limit: approximately 4.5 MB.
- Function response payload limit: approximately 4.5 MB.
- Vercel Blob supports files much larger than 100 MB.
- Client uploads can send files directly from the browser to Blob.
- Private Blob supports signed scoped URLs.
- Vercel Functions provide writable `/tmp` scratch space up to approximately 500 MB.
- Vercel Pro with Fluid Compute currently supports long-running Python/Node functions; configure this app below the platform maximum.
- Vercel supports containerized HTTP services/functions through `Dockerfile.vercel`, allowing system dependencies such as Pandoc.

The application architecture must remain valid even if exact platform values change.

---

# 5. Deployment isolation

Deploy as a dedicated project:

```text
Vercel Pro Team
|
|-- Other Agent A
|-- Other Agent B
|-- Other Agent C
|
`-- Document-to-Markdown Converter
```

The converter must not share application code, databases, queues, AI keys, or environment secrets with unrelated agents.

It will still contribute to team-level Vercel infrastructure usage/billing, but application execution and deployment should be isolated.

---

# 6. Primary architecture

Use one dedicated Vercel project with two services when Vercel Services is available:

```text
                       Browser
                          |
                          v
                  Next.js Frontend
                          |
               upload authorization
                          |
                          v
                 Private Vercel Blob
                    source document
                          |
                    signed GET
                          |
                          v
              Python Converter Service
                 FastAPI container
                Pandoc / pptx / pypdf
                          |
                    signed PUT
                          |
                          v
                 Private Vercel Blob
                     result ZIP
                          |
                    signed GET
                          |
                          v
                       Browser
```

If Vercel Services is unavailable, deploy the same monorepo as:

```text
doc2md-web
doc2md-converter
```

Do not change the Blob architecture.

---

# 7. Repository structure

```text
document-to-markdown/
|
|-- ENGINEERING_SPEC.md
|-- AGENTS.md
|-- README.md
|-- SECURITY.md
|-- THIRD_PARTY_NOTICES.md
|-- .env.example
|-- .gitignore
|-- vercel.json
|
|-- frontend/
|   |-- package.json
|   |-- package-lock.json
|   |-- next.config.ts
|   |-- tsconfig.json
|   |
|   |-- app/
|   |   |-- layout.tsx
|   |   |-- page.tsx
|   |   |-- globals.css
|   |   |
|   |   `-- api/
|   |       `-- blob/
|   |           |-- upload/route.ts
|   |           |-- prepare-job/route.ts
|   |           |-- download-url/route.ts
|   |           `-- cleanup/route.ts
|   |
|   |-- components/
|   |   |-- FileDropzone.tsx
|   |   |-- FileSummary.tsx
|   |   |-- ConfirmationDialog.tsx
|   |   |-- UploadProgress.tsx
|   |   |-- ConversionStatus.tsx
|   |   |-- ConversionResult.tsx
|   |   `-- ErrorPanel.tsx
|   |
|   `-- lib/
|       |-- blob.ts
|       |-- file-validation.ts
|       |-- filename.ts
|       |-- job-token.ts
|       `-- types.ts
|
|-- converter/
|   |-- Dockerfile.vercel
|   |-- requirements.txt
|   |-- pyproject.toml
|   |-- main.py
|   |
|   `-- app/
|       |-- config.py
|       |-- api.py
|       |-- errors.py
|       |-- models.py
|       |
|       |-- converters/
|       |   |-- base.py
|       |   |-- router.py
|       |   |-- docx.py
|       |   |-- pptx.py
|       |   `-- pdf.py
|       |
|       |-- services/
|       |   |-- downloader.py
|       |   |-- uploader.py
|       |   |-- workspace.py
|       |   |-- packager.py
|       |   |-- report.py
|       |   `-- cleanup.py
|       |
|       `-- security/
|           |-- validation.py
|           `-- job_token.py
|
`-- tests/
    |-- frontend/
    `-- converter/
        |-- fixtures/
        |-- test_validation.py
        |-- test_docx.py
        |-- test_pptx.py
        |-- test_pdf.py
        |-- test_workspace.py
        `-- test_api.py
```

---

# 8. Vercel Services configuration

When Services is available, use a structure equivalent to:

```json
{
  "services": {
    "frontend": {
      "root": "frontend/",
      "framework": "nextjs"
    },
    "converter": {
      "root": "converter/",
      "runtime": "container",
      "entrypoint": "Dockerfile.vercel"
    }
  },
  "rewrites": [
    {
      "source": "/converter/(.*)",
      "destination": {
        "service": "converter"
      }
    },
    {
      "source": "/(.*)",
      "destination": {
        "service": "frontend"
      }
    }
  ]
}
```

Verify the current Vercel schema before committing this file.

---

# 9. Supported inputs

Supported:

```text
.docx
.pptx
.pdf
```

Reject:

```text
.doc
.docm
.dotm
.ppt
.pptm
.potm
.xls
.xlsx
.xlsm
.rtf
.pages
.key
```

Do not execute macros.

---

# 10. Client validation

```ts
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
```

Validate before upload:

- extension;
- non-zero size;
- <=100 MB.

Client checks are UX only. Backend validation remains mandatory.

---

# 11. Blob paths

Use job-scoped paths:

```text
jobs/<yyyy-mm-dd>/<job-id>/source/<safe-filename>
jobs/<yyyy-mm-dd>/<job-id>/result/<safe-stem>_markdown.zip
```

Example:

```text
jobs/2026-09-01/6f3b9d/source/market-study.pdf
jobs/2026-09-01/6f3b9d/result/market-study_markdown.zip
```

Never use the raw user filename as a trusted path.

---

# 12. Source upload flow

Use Vercel Blob client uploads.

Required data path:

```text
Browser -> Private Blob
```

not:

```text
Browser -> Next.js request body -> Blob
```

Use the current `@vercel/blob/client` upload mechanism.

Configuration:

```text
access: private
```

Use multipart upload for reliability when appropriate. It is acceptable to enable it for all larger files (for example >=25 MB).

Expose real upload progress with the SDK upload-progress callback.

---

# 13. Upload authorization route

Route:

```text
POST /api/blob/upload
```

Responsibilities:

1. Authenticate user if auth is enabled.
2. Validate declared filename.
3. Validate declared extension.
4. Validate declared size <=100 MB.
5. Restrict destination to generated job path.
6. Issue client upload authorization.
7. Restrict allowed content types where supported.
8. Restrict maximum size in the signed/client token where supported.

Never return store credentials to the browser.

---

# 14. Server-side size enforcement

After upload, verify actual Blob metadata.

Maximum:

```text
104857600 bytes
```

If larger:

1. reject;
2. delete Blob;
3. return:

```json
{
  "code": "FILE_TOO_LARGE",
  "message": "The maximum supported file size is 100 MB."
}
```

---

# 15. Prepare conversion job

Route:

```text
POST /api/blob/prepare-job
```

Input:

```json
{
  "jobId": "...",
  "sourcePathname": "...",
  "originalFilename": "Market Study.pdf"
}
```

Responsibilities:

1. Authenticate caller if enabled.
2. Verify job/path relationship.
3. Verify Blob exists.
4. Verify actual size <=100 MB.
5. Verify supported extension.
6. Generate signed source GET URL.
7. Generate signed result PUT URL.
8. Generate signed source DELETE URL if useful.
9. Create signed job token.

Suggested expiry:

```text
source GET: 20 minutes
result PUT: 20 minutes
job token: 20 minutes
```

---

# 16. Job token

Use HMAC-SHA256 or a small JWT implementation.

Payload:

```json
{
  "job_id": "uuid",
  "source_path": "jobs/.../source/report.pdf",
  "result_path": "jobs/.../result/report_markdown.zip",
  "filename": "report.pdf",
  "source_size": 42781234,
  "exp": 1788260000
}
```

Environment:

```text
JOB_SIGNING_SECRET
```

Minimum 32 random bytes.

Converter must validate:

- signature;
- expiry;
- job ID;
- filename;
- source path;
- result path.

Unsigned request fields are not trusted.

---

# 17. Converter request

Browser calls:

```text
POST /converter/v1/convert
```

Small JSON only:

```json
{
  "jobToken": "...",
  "sourceGetUrl": "https://...signed...",
  "sourceDeleteUrl": "https://...signed...",
  "resultPutUrl": "https://...signed..."
}
```

Never send the actual file in this request.

---

# 18. Converter response

Success:

```json
{
  "status": "success",
  "jobId": "...",
  "resultPathname": "jobs/.../result/report_markdown.zip",
  "resultBytes": 18455729,
  "warnings": []
}
```

The response must remain small.

Never return ZIP bytes from the converter endpoint.

---

# 19. Result download

Frontend route:

```text
POST /api/blob/download-url
```

It:

1. verifies the job token;
2. verifies result pathname;
3. confirms result exists;
4. generates a signed GET URL.

Suggested signed GET lifetime:

```text
10 minutes
```

Browser downloads directly from Blob.

Do not proxy result through Next.js/FastAPI.

---

# 20. Vercel Private Blob

Source and result must both use:

```text
private
```

Prefer Vercel's current OIDC Blob authentication from server-side code.

Use short-lived signed URLs for client access.

No public document URLs.

---

# 21. Converter workspace

Use:

```text
/tmp/doc2md/<job-id>/
```

Layout:

```text
/tmp/doc2md/<job-id>/
|-- source/
|   `-- input.ext
|-- output/
|   |-- output.md
|   |-- conversion-report.json
|   `-- media/
`-- result/
    `-- output_markdown.zip
```

No writes outside the job workspace.

---

# 22. Scratch-space limits

Vercel `/tmp` is finite. Use conservative budgets:

```text
MAX_UPLOAD_MB=100
MAX_OUTPUT_TREE_MB=180
MAX_RESULT_ZIP_MB=180
MAX_TMP_WORKSPACE_MB=425
```

Sequence:

```text
download source
-> convert
-> verify output size
-> delete local source
-> create ZIP
-> verify ZIP size
-> upload ZIP
-> delete workspace
```

Delete the local source before ZIP generation to reduce simultaneous disk use.

---

# 23. Large-expansion failure

A 100 MB source may expand into far more data.

If safe workspace budget is exceeded:

```json
{
  "code": "DOCUMENT_EXPANDS_TOO_LARGE",
  "message": "This document expands beyond the safe processing limit during conversion."
}
```

Do not allow the function to fail because `/tmp` is full.

---

# 24. Streaming source download

Do not buffer the whole source file in RAM.

Concept:

```python
with httpx.stream("GET", signed_url) as response:
    with open(source_path, "wb") as output:
        for chunk in response.iter_bytes():
            output.write(chunk)
```

Track total bytes and abort if >100 MB.

---

# 25. Streaming result upload

Do not read the entire result ZIP into memory.

Upload the ZIP file as a stream using the signed Blob PUT URL or current Blob Python SDK streaming support.

Test memory behavior with a near-limit source file.

---

# 26. Conversion duration

Use Vercel Pro with Fluid Compute.

Target converter function configuration:

```text
maxDuration: 720 seconds
```

Internal conversion deadline:

```text
690 seconds
```

Keep cleanup time in reserve.

Pandoc subprocess must have its own timeout.

---

# 27. Concurrency

Default local concurrency:

```text
MAX_LOCAL_CONCURRENT_CONVERSIONS=2
```

Use a process-level semaphore.

Vercel can scale additional instances.

Do not add Redis/queue infrastructure in v1.

---

# 28. FastAPI endpoints

```text
GET  /converter/health
GET  /converter/ready
POST /converter/v1/convert
```

Health:

```json
{"status":"ok"}
```

Readiness verifies:

- Pandoc present;
- python-pptx import;
- pypdf import;
- `/tmp` writable.

Do not reveal filesystem paths or secrets.

---

# 29. File format validation

Do not trust extension alone.

PDF:

```text
extension = .pdf
signature begins %PDF-
```

DOCX:

```text
extension = .docx
valid ZIP/OOXML
[Content_Types].xml
word/document.xml
```

PPTX:

```text
extension = .pptx
valid ZIP/OOXML
[Content_Types].xml
ppt/presentation.xml
```

Reject mismatches.

---

# 30. Office ZIP safety

Before Office conversion inspect archive metadata.

Defaults:

```text
MAX_ARCHIVE_MEMBERS=10000
MAX_OFFICE_UNCOMPRESSED_MB=350
MAX_COMPRESSION_RATIO=100
```

Reject:

- traversal members;
- absolute paths;
- extreme compression ratios;
- excessive member counts;
- excessive expanded size.

---

# 31. Filename sanitization

Rules:

- strip directory portions;
- remove null/control characters;
- remove traversal sequences;
- replace invalid filesystem characters;
- limit length;
- avoid reserved Windows names;
- preserve useful Unicode where safe.

Never use a raw uploaded filename as a trusted filesystem path.

---

# 32. Common converter interface

```python
@dataclass
class ConversionResult:
    markdown_path: Path
    media_dir: Path
    pages_or_slides: int | None
    media_count: int
    warnings: list[str]
```

Converters:

```text
DocxConverter
PptxConverter
PdfConverter
```

Router selects by validated type.

---

# 33. DOCX conversion

Use Pandoc as a subprocess.

Conceptual command:

```text
pandoc input.docx
--from=docx
--to=gfm
--wrap=none
--extract-media=<output>
--output=<output.md>
```

Use argument arrays.

Never use:

```python
shell=True
```

with user input.

Normalize Pandoc media paths to relative forward-slash paths.

Preserve where practical:

- headings;
- paragraphs;
- bold/italic;
- lists;
- links;
- tables;
- footnotes;
- embedded raster images.

Limitations:

- SmartArt;
- charts;
- floating text boxes;
- exact page layout;
- tracked changes;
- comments.

---

# 34. PPTX conversion

Use:

```text
python-pptx
```

No Microsoft PowerPoint dependency.

Per slide:

```markdown
## Slide 1 — Title
```

or:

```markdown
## Slide 1
```

Separate slides with:

```markdown
---
```

Approximate reading order:

```text
top coordinate
then left coordinate
```

Recursively process grouped shapes where feasible.

Extract:

- slide title;
- text;
- bullet paragraphs;
- pictures;
- native tables.

Native tables become GitHub-style Markdown tables.

Images:

```text
media/slide-001-image-001.png
media/slide-001-image-002.jpeg
```

Unsupported objects should create warnings instead of crashing the whole job.

Examples:

- SmartArt;
- charts;
- connectors;
- animations;
- audio/video;
- OLE objects.

---

# 35. PDF conversion

Use:

```text
pypdf
```

Do not use PyMuPDF/PyMuPDF4LLM.

Per page:

```markdown
## Page 1
```

Then text and extractable images.

Separate pages with:

```markdown
---
```

Use native text extraction and layout-aware mode when stable.

Do not rewrite or summarize text.

Images:

```text
media/page-001-image-001.png
```

If one image fails, add a warning and continue.

---

# 36. Scanned PDF behavior

OCR is not required in v1.

Detect likely scanned/image-based pages using a heuristic such as:

```text
very low extracted character count
+
large image content
```

Warning:

```text
Page 4 may be scanned or image-based. Text extraction may be incomplete.
```

Future OCR may use Tesseract, but is out of scope now.

---

# 37. Markdown output contract

Generated Markdown must:

- be UTF-8;
- use LF line endings;
- use ATX headings;
- use relative image paths;
- use forward slashes;
- contain no `/tmp` paths;
- contain no `C:\...` paths;
- be suitable for GitHub, Claude Code, and Codex.

---

# 38. Output package

Before ZIP:

```text
Market Study_markdown/
|-- Market Study.md
|-- conversion-report.json
`-- media/
    |-- ...
    `-- ...
```

ZIP:

```text
Market Study_markdown.zip
```

Do not include original source document.

---

# 39. Conversion report

Example:

```json
{
  "source_filename": "Market Study.pdf",
  "source_type": "pdf",
  "source_size_bytes": 42781234,
  "markdown_filename": "Market Study.md",
  "media_count": 18,
  "pages_or_slides": 67,
  "warnings": [],
  "conversion_status": "success"
}
```

May include:

```text
elapsed_ms
converter_version
```

Must not include:

- absolute paths;
- signed URLs;
- tokens;
- document contents.

---

# 40. Retention and cleanup

Successful job:

1. result safely uploaded;
2. source Blob deleted;
3. local workspace deleted;
4. result Blob retained temporarily.

Defaults:

```text
SOURCE_BLOB_MAX_AGE_MINUTES=60
RESULT_BLOB_MAX_AGE_MINUTES=120
```

Source should normally be deleted immediately. The 60-minute source age is crash recovery.

Result signed URL:

```text
10 minutes
```

Result Blob:

```text
maximum ~2 hours
```

---

# 41. Cleanup cron

Protected route:

```text
/api/blob/cleanup
```

Run hourly.

Responsibilities:

- list `jobs/`;
- delete abandoned source blobs older than source retention;
- delete result blobs older than result retention;
- limit operations per invocation;
- log counts only.

Do not rely only on browser cleanup.

---

# 42. Environment variables

```dotenv
APP_ENV=development

MAX_UPLOAD_MB=100
MAX_OUTPUT_TREE_MB=180
MAX_RESULT_ZIP_MB=180
MAX_TMP_WORKSPACE_MB=425

CONVERSION_TIMEOUT_SECONDS=690
MAX_LOCAL_CONCURRENT_CONVERSIONS=2

SIGNED_SOURCE_URL_MINUTES=20
SIGNED_RESULT_PUT_URL_MINUTES=20
SIGNED_DOWNLOAD_URL_MINUTES=10

SOURCE_BLOB_MAX_AGE_MINUTES=60
RESULT_BLOB_MAX_AGE_MINUTES=120

JOB_SIGNING_SECRET=replace-with-long-random-secret

AUTH_MODE=none
LOG_FILENAMES=false
```

Use Vercel OIDC for Blob where supported instead of long-lived Blob credentials.

---

# 43. Authentication

Keep auth modular.

Modes:

```text
none
entra
```

Local development:

```text
AUTH_MODE=none
```

Production with confidential corporate documents should use Microsoft Entra ID or another approved SSO/access-control method.

Do not expose internal conversion capability anonymously on the internet.

---

# 44. Rate limiting

Initial recommendation:

```text
5 conversions per user / 10 minutes
```

If no identity is available, use IP-level Vercel Firewall/rate limiting.

Do not add Redis solely for MVP.

---

# 45. Security requirements

Mandatory:

- HTTPS;
- Private Blob;
- short-lived signed URLs;
- HMAC job token;
- file-size validation;
- true file-format validation;
- filename sanitization;
- Office ZIP bomb checks;
- path traversal prevention;
- workspace size limits;
- conversion timeout;
- concurrency limit;
- no macro execution;
- no shell interpolation;
- no document content logging;
- no public Blob documents;
- automatic cleanup;
- no external converter service;
- no LLM calls;
- no stack traces returned to browser.

---

# 46. Error codes

Use stable codes:

```text
UNSUPPORTED_FILE_TYPE
FILE_TOO_LARGE
INVALID_FILE_FORMAT
PASSWORD_PROTECTED
OFFICE_ARCHIVE_UNSAFE
DOCUMENT_TOO_COMPLEX
DOCUMENT_EXPANDS_TOO_LARGE
DOWNLOAD_FAILED
CONVERSION_TIMEOUT
CONVERSION_FAILED
RESULT_TOO_LARGE
RESULT_UPLOAD_FAILED
JOB_TOKEN_INVALID
JOB_TOKEN_EXPIRED
BLOB_NOT_FOUND
RATE_LIMITED
SERVICE_UNAVAILABLE
```

Examples:

```text
This file is larger than the 100 MB limit.
```

```text
This document contains too much expanded media to process safely.
```

```text
The conversion took too long to complete.
```

---

# 47. Logging

Allowed:

- job ID;
- file type;
- input size;
- result size;
- duration;
- success/failure;
- warning count;
- error code.

Do not log:

- extracted text;
- image content;
- signed URLs;
- job tokens;
- Blob credentials;
- source binary;
- result binary.

Filename logging disabled by default.

---

# 48. Converter container

Use:

```text
Dockerfile.vercel
```

Conceptual:

```dockerfile
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends pandoc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-80}"]
```

Pin dependencies.

Run non-root where practical.

---

# 49. Python dependencies

Minimum:

```text
fastapi
uvicorn
httpx
python-pptx
pypdf
python-multipart
```

Testing:

```text
pytest
pytest-asyncio
```

Do not add PyMuPDF/PyMuPDF4LLM.

---

# 50. Frontend dependencies

Minimum:

```text
next
react
react-dom
@vercel/blob
```

Optional:

```text
lucide-react
```

Avoid a large UI framework for a single-page utility.

---

# 51. Licensing

Use open-source dependencies.

Avoid AGPL runtime dependencies.

Create:

```text
THIRD_PARTY_NOTICES.md
```

Record:

- dependency;
- purpose;
- version;
- license;
- source.

Before internal production use, confirm licensing with the appropriate organizational process.

---

# 52. Frontend state machine

```text
idle
selected
confirming
uploading
converting
preparing-download
complete
error
```

Do not invent fake conversion percentages.

Upload progress should be real.

Conversion can be an indeterminate spinner/status.

---

# 53. Browser cancellation

Use `AbortController` for upload cancellation.

If upload completed but conversion has not started, attempt source deletion.

If browser disappears, scheduled cleanup must recover abandoned files.

Server-side conversion cancellation is best-effort only.

---

# 54. Accessibility

Required:

- keyboard-accessible file picker;
- drag/drop button alternative;
- visible focus;
- modal focus trap;
- ESC close;
- `aria-live` status;
- errors not communicated only by color;
- sufficient contrast.

---

# 55. Testing

Frontend:

```text
Vitest
React Testing Library
Playwright
```

Converter:

```text
pytest
```

Fixtures:

DOCX:

```text
simple.docx
headings.docx
table.docx
images.docx
```

PPTX:

```text
text-only.pptx
images.pptx
tables.pptx
grouped-shapes.pptx
```

PDF:

```text
text.pdf
images.pdf
multipage.pdf
scanned-like.pdf
```

Security:

```text
fake-pdf.pdf
renamed-zip.docx
unsafe-office-archive.docx
```

---

# 56. Required conversion assertions

For every format:

- `.md` exists;
- UTF-8;
- relative media links;
- no `/tmp`;
- no `C:\`;
- ZIP opens;
- conversion report exists;
- source file not included in ZIP.

---

# 57. Near-100-MB release test

This is mandatory.

Create or use a test file around:

```text
95–100 MB
```

Validate:

1. browser direct upload succeeds;
2. binary never passes through normal Function request body;
3. converter streams source;
4. memory remains bounded;
5. `/tmp` remains below guard;
6. result uploads directly to Blob;
7. converter response is small JSON;
8. result downloads via signed Blob URL.

The feature is not production-ready until this passes.

---

# 58. Resource-failure tests

Test:

- source >100 MB;
- Office expanded archive too large;
- output tree >180 MB;
- result ZIP >180 MB;
- conversion timeout;
- network interruption;
- Blob result upload failure;
- corrupt file.

Verify cleanup.

---

# 59. Privacy tests

Verify:

- successful source deleted;
- failed source eventually deleted by cron;
- result deleted after TTL;
- no extracted content in logs;
- no signed URLs in logs;
- no AI/LLM request exists.

---

# 60. CI

Pull request pipeline:

Frontend:

```text
npm ci
lint
typecheck
unit tests
build
```

Converter:

```text
install
lint
pytest
docker build
```

Also run small DOCX/PPTX/PDF smoke conversions.

---

# 61. README requirements

Explain:

- app purpose;
- supported formats;
- 100 MB limit;
- Blob architecture;
- zero-AI design;
- local development;
- Vercel deployment;
- privacy/retention;
- environment variables;
- tests;
- limitations;
- license notices.

Include:

```text
AI tokens consumed per conversion: 0
```

---

# 62. AGENTS.md

Create:

```markdown
# Repository Instructions

Read ENGINEERING_SPEC.md before architectural changes.

Hard constraints:

- Max source upload 100 MB.
- Source/result binaries never pass through normal Vercel Function request/response bodies.
- Use Private Vercel Blob.
- Direct browser source upload.
- Signed Blob URLs.
- Converter runs on Vercel.
- No AI model.
- No AI Gateway.
- No OpenAI/Anthropic/Gemini.
- AI token usage must remain zero.
- Do not use PyMuPDF or PyMuPDF4LLM.
- Avoid AGPL runtime dependencies.
- Do not log document contents.
- Uploaded files are temporary.
- Media paths must be relative.
- Do not use shell=True with user input.
- Respect /tmp workspace limits.
- Keep the converter isolated from unrelated agents.

Before completion:
- run frontend tests;
- run backend tests;
- build container;
- run DOCX smoke test;
- run PPTX smoke test;
- run PDF smoke test.

Never claim a test passed unless executed.
```

---

# 63. Build phases

## Phase 1 — Converter core

Build:

- repository structure;
- FastAPI;
- converters;
- validation;
- output package;
- Dockerfile with Pandoc;
- tests.

Success: local fixtures convert.

## Phase 2 — Blob data path

Build:

- private Blob;
- client upload;
- job tokens;
- signed source GET;
- signed result PUT;
- signed result GET;
- cleanup.

Success:

```text
browser -> Blob -> converter -> Blob -> browser
```

with no large Function payload.

## Phase 3 — UI

Build:

- upload zone;
- file summary;
- confirmation;
- progress;
- result;
- errors;
- reset.

## Phase 4 — 100 MB hardening

Build/test:

- streaming;
- workspace quotas;
- timeouts;
- concurrency;
- 95–100 MB test;
- security.

## Phase 5 — Production

Add:

- auth;
- rate limiting;
- security headers;
- logging;
- monitoring;
- cron cleanup;
- deployment configuration.

---

# 64. Acceptance criteria

Product:

- [ ] DOCX/PPTX/PDF selectable.
- [ ] >100 MB rejected.
- [ ] confirmation required.
- [ ] real upload progress.
- [ ] conversion status.
- [ ] ZIP downloadable.
- [ ] reset works.

Architecture:

- [ ] browser -> Private Blob direct upload.
- [ ] no 100 MB request through Function.
- [ ] converter -> Blob result upload.
- [ ] no large result response through Function.
- [ ] signed private result download.
- [ ] dedicated Vercel project.

Conversion:

- [ ] DOCX text/images.
- [ ] PPTX slide text/images/tables.
- [ ] PDF text/images.
- [ ] Markdown relative media paths.
- [ ] conversion report.

Resource safety:

- [ ] streamed source.
- [ ] output quota.
- [ ] source deleted before ZIP.
- [ ] streamed result.
- [ ] timeout.
- [ ] concurrency guard.

Privacy:

- [ ] private source.
- [ ] private result.
- [ ] source deleted.
- [ ] result cleanup.
- [ ] no content logs.

Zero AI:

- [ ] no AI SDK.
- [ ] no model provider.
- [ ] no AI Gateway.
- [ ] 0 AI tokens.

---

# 65. Vercel settings

Recommended:

```text
Plan: Vercel Pro
Project: dedicated doc2md project
Fluid Compute: enabled
Converter memory: prefer 4 GB if available/cost-approved
Converter max duration: 720 seconds
Blob: Private
Blob authentication: OIDC where available
```

Choose deployment/storage region according to organizational data policy.

---

# 66. Complete data flow

```text
1. User selects file
2. Browser validates <=100 MB and extension
3. User confirms
4. Browser requests upload authorization
5. Browser uploads source directly to Private Blob
6. Frontend verifies actual Blob size
7. Frontend creates:
      signed source GET
      signed result PUT
      job token
8. Browser sends small JSON to converter
9. Converter streams source into /tmp
10. Converter validates actual document structure
11. Converter routes:
      DOCX -> Pandoc
      PPTX -> python-pptx
      PDF  -> pypdf
12. Converter generates Markdown + media
13. Converter checks output quota
14. Converter deletes local source
15. Converter creates ZIP
16. Converter checks ZIP quota
17. Converter streams ZIP to Private Blob
18. Converter returns small JSON
19. Source Blob is deleted
20. Frontend creates signed result GET
21. Browser downloads ZIP directly from Blob
22. Hourly cleanup removes stale leftovers/results
```

---

# 67. Platform fallback

If Vercel Services is not available:

```text
Project A: doc2md-web
Project B: doc2md-converter
```

Keep all other architecture unchanged.

Never fall back to:

```text
browser -> 100 MB Next.js POST
```

---

# 68. First Claude Code task

Execute in this order:

```text
1. Read ENGINEERING_SPEC.md completely.
2. Create AGENTS.md.
3. Create monorepo.
4. Build converter locally.
5. Implement DOCX.
6. Implement PPTX.
7. Implement PDF.
8. Add tests.
9. Build Dockerfile.vercel with Pandoc.
10. Add workspace quotas and ZIP.
11. Implement Private Blob direct upload.
12. Implement job signing.
13. Implement signed source GET.
14. Implement signed result PUT.
15. Implement signed result GET.
16. Prove end-to-end binary data path.
17. Build UI.
18. Add cleanup.
19. Run near-100-MB test.
20. Add production auth/security.
21. Deploy dedicated Vercel project.
```

Do not start with visual polish.

First prove the large-file architecture.

---

# 69. Phase report format

At the end of each phase:

```markdown
## Phase Completed

## Implemented

## Files Added/Changed

## Tests Run

## Results

## Known Limitations

## Deviations from ENGINEERING_SPEC.md

## Next Phase
```

Do not claim unexecuted tests.

---

# 70. Release blockers

Do not call production-ready unless:

- near-100-MB direct upload passes;
- no large binary crosses Function request/response body;
- Private Blob source/result confirmed;
- signed download confirmed;
- workspace guards tested;
- cleanup confirmed;
- DOCX/PPTX/PDF smoke tests pass;
- Pandoc present in production container;
- no AI dependency exists;
- no AGPL PDF runtime exists;
- no document contents appear in logs.

---

# 71. Known conversion limitations

DOCX may not perfectly preserve:

- SmartArt;
- charts;
- complex page layout;
- floating text boxes.

PPTX may not perfectly preserve:

- charts;
- diagrams;
- SmartArt;
- connectors;
- spatial relationships;
- animations.

PDF may not perfectly preserve:

- multi-column reading order;
- complex tables;
- scanned text;
- chart text.

Files up to 100 MB are accepted, but an unusually compressed document may be rejected if expanded conversion output exceeds safe `/tmp` limits.

---

# 72. Official Vercel references

Verify current implementation APIs using official documentation:

Function request payload:
https://vercel.com/docs/errors/function_payload_too_large

Function response payload:
https://vercel.com/docs/errors/function_response_payload_too_large

Vercel Blob:
https://vercel.com/docs/vercel-blob

Client uploads:
https://vercel.com/docs/vercel-blob/client-upload

Blob SDK:
https://vercel.com/docs/vercel-blob/using-blob-sdk

Private Blob:
https://vercel.com/docs/vercel-blob/private-storage

Signed Blob URLs:
https://vercel.com/changelog/signed-urls-are-now-available-for-vercel-blob

Private Blob GA:
https://vercel.com/changelog/vercel-private-blob-is-now-generally-available

Function runtimes and `/tmp`:
https://vercel.com/docs/functions/runtimes

Function limits:
https://vercel.com/docs/functions/limitations

Function duration:
https://vercel.com/docs/functions/configuring-functions/duration

Vercel Services:
https://vercel.com/docs/services

Docker/container support:
https://vercel.com/kb/guide/does-vercel-support-docker-deployments

---

# 73. Definition of done

A colleague can open the Vercel-hosted app, upload a DOCX/PPTX/PDF up to 100 MB, confirm conversion, and download a private temporary ZIP containing usable Markdown and extracted media.

The source and result binaries never pass through normal Vercel Function payload bodies.

The converter runs entirely on Vercel using deterministic document-processing tools.

Source and result artifacts are private and automatically deleted.

AI token consumption per conversion is:

```text
0
```

Save this file at repository root as:

```text
ENGINEERING_SPEC.md
```
