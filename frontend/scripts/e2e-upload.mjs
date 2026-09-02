/**
 * Upload one file through the REAL client SDK, for the §57 deployed test.
 *
 *   node scripts/e2e-upload.mjs <baseUrl> <pathname> <filePath> <contentType>
 *
 * The Python harness owns the §57 checks and the reporting, but the upload
 * itself must use `@vercel/blob/client`'s `upload()` — the exact function the
 * browser runs. Reimplementing the Blob upload protocol in another language
 * would be testing my reimplementation, not the app.
 *
 * Prints one line of JSON to stdout so the caller can parse the outcome.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { upload } from "@vercel/blob/client";

const [baseUrl, pathname, filePath, contentType] = process.argv.slice(2);

if (!baseUrl || !pathname || !filePath || !contentType) {
  console.log(
    JSON.stringify({
      ok: false,
      error: "usage: e2e-upload.mjs <baseUrl> <pathname> <filePath> <contentType>",
    }),
  );
  process.exit(2);
}

try {
  // Node 24 has File. Reading a ~97 MB fixture into memory here is fine: this
  // is the test client, not the app, and it stands in for a browser that would
  // hold the user's selected file anyway.
  const bytes = await readFile(filePath);
  const file = new File([bytes], basename(filePath), { type: contentType });

  const started = Date.now();
  const result = await upload(pathname, file, {
    access: "private",
    handleUploadUrl: new URL("/api/blob/upload", baseUrl).toString(),
    contentType,
    // §12 - multipart above 25 MB, exactly as the app configures it.
    multipart: file.size >= 25 * 1024 * 1024,
  });

  console.log(
    JSON.stringify({
      ok: true,
      url: result.url,
      pathname: result.pathname,
      contentType: result.contentType,
      bytes: file.size,
      elapsedMs: Date.now() - started,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
