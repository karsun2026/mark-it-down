# Repository Instructions

Read `ENGINEERING_SPEC.md` before architectural changes.
Read `DEVIATIONS.md` for the approved, documented departures from that spec.

Hard constraints:

- Max source upload 100 MB.
- Source/result binaries never pass through normal Vercel Function request/response bodies.
- Use Private Vercel Blob.
- Direct browser source upload.
- Signed Blob URLs.
- Converter runs on Vercel.
- No AI in the conversion path: the converter calls no AI model, no AI Gateway,
  no OpenAI/Anthropic/Gemini, and every conversion consumes zero AI tokens
  (DEVIATIONS.md D-016). The READMAP analysis agent is the documented
  exception: it runs outside the converter, on converted text only, and
  never alters conversion output. See docs/readmap/ARCHITECTURE_DECISIONS.md.
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
