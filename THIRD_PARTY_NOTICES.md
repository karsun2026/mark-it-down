# Third-Party Notices

Per ENGINEERING_SPEC.md §51. No AGPL runtime dependencies. No AI SDKs.

Confirm licensing through the appropriate organisational process before
internal production use.

## Runtime — Python

| Dependency | Version | Purpose | License |
|---|---|---|---|
| fastapi | 0.141.1 | HTTP service | MIT |
| uvicorn | 0.52.4 | ASGI server | BSD-3-Clause |
| httpx | 0.28.1 | Streaming source download (Phase 2) | BSD-3-Clause |
| pydantic | 2.13.5 | Request/response models | MIT |
| python-pptx | 1.0.2 | PPTX parsing (§34) | MIT |
| pypdf | 6.16.2 | PDF structure, encryption, image XObjects (§35) | BSD-3-Clause |
| pdfplumber | 0.11.10 | PDF text layout and tables (DEVIATIONS D-003) | MIT |
| pdfminer.six | (via pdfplumber) | PDF text engine | MIT |
| Pillow | 12.3.0 | Image decoding for pypdf extraction | MIT-CMU |
| cryptography | (via pypdf[crypto]) | Encrypted PDF detection | Apache-2.0 / BSD-3-Clause |

## Runtime — system

| Dependency | Purpose | License | Note |
|---|---|---|---|
| Pandoc | DOCX conversion (§33) | **GPL-2.0-or-later** | See below |

### Pandoc licensing note

Pandoc is GPL-2.0-or-later, not AGPL, so §51's stated constraint is met. It is
invoked as a **separate process** via an argument array and is not linked into
this application, which is the ordinary basis for using GPL tooling alongside
differently-licensed code.

If the no-AGPL rule originates in organisational policy rather than preference,
confirm that GPL-in-container is also acceptable before production use.

## Deliberately excluded

| Package | Reason |
|---|---|
| PyMuPDF / PyMuPDF4LLM | AGPL, and excluded by §35 and §51 outright |
| Any AI/LLM SDK | §1 — AI token usage must remain exactly zero |

## Development only — never imported by runtime code

| Dependency | Purpose | License |
|---|---|---|
| pytest, pytest-asyncio | Test runner | MIT |
| ruff | Lint | MIT |
| python-docx | DOCX fixture generation | MIT |
| fpdf2 | PDF fixture generation | LGPL-3.0 |
