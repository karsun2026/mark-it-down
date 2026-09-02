/**
 * Reproduce the BROWSER client flow against a deployment, from Node.
 *
 *   APP_PASSWORD=... node scripts/repro-client-flow.mjs <baseUrl> <file>
 *
 * The §57 release test drives the steps sequentially. The real client does
 * something the release test never exercises: it RACES the long convert POST
 * against a poll of the status object with `Promise.any`, then asks for a
 * download URL. That race is the only part of the path with no coverage, and
 * it is where a job that has already succeeded appears to stall.
 *
 * This mirrors `lib/convert-client.ts` step for step and prints a timeline, so
 * whichever branch hangs is visible.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { upload } from "@vercel/blob/client";

const [baseUrl, filePath, mediaArg] = process.argv.slice(2);
const includeMedia = mediaArg !== 'no-media';
const password = process.env.APP_PASSWORD ?? "";
const headers = password ? { "x-app-password": password } : {};

const started = Date.now();
const log = (...parts) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);

function jobPaths(name) {
  const id = crypto.randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  const stem = name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
  const ext = name.slice(name.lastIndexOf("."));
  return {
    jobId: id,
    sourcePathname: `jobs/${date}/${id}/source/${stem}${ext}`,
    resultPathname: includeMedia
      ? `jobs/${date}/${id}/result/${stem}_markdown.zip`
      : `jobs/${date}/${id}/result/${stem}.md`,
    statusPathname: `jobs/${date}/${id}/status.json`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mirrors pollStatus in lib/convert-client.ts. */
async function pollStatus(statusGetUrl, pollSignal) {
  const deadline = Date.now() + 720_000;
  let lastStage = "";
  let failures = 0;
  let reads = 0;

  while (Date.now() < deadline) {
    if (pollSignal.aborted) {
      log('  poll CANCELLED (race already settled)');
      return { stage: 'cancelled', done: true, ok: true, warnings: [] };
    }
    try {
      const response = await fetch(statusGetUrl, { cache: "no-store" });
      reads += 1;
      if (response.ok) {
        failures = 0;
        const status = await response.json();
        if (status.stage !== lastStage) {
          lastStage = status.stage;
          log(`  poll -> stage=${status.stage} done=${status.done} ok=${status.ok}`);
        }
        if (status.done) {
          log(`  poll RESOLVED after ${reads} reads`);
          return status;
        }
      } else if (response.status !== 404) {
        failures += 1;
        log(`  poll HTTP ${response.status} (failure ${failures})`);
      }
    } catch (error) {
      failures += 1;
      log(`  poll threw: ${error?.message ?? error} (failure ${failures})`);
    }
    if (failures >= 8) throw new Error("poll: too many consecutive failures");
    await sleep(2000);
  }
  throw new Error("poll: deadline");
}

async function main() {
  const bytes = await readFile(filePath);
  const name = basename(filePath);
  const paths = jobPaths(name);
  const contentType =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";

  log(`uploading ${(bytes.length / 1048576).toFixed(1)} MB`);
  await upload(paths.sourcePathname, new File([bytes], name, { type: contentType }), {
    access: "private",
    handleUploadUrl: new URL("/api/blob/upload", baseUrl).toString(),
    contentType,
    multipart: bytes.length >= 25 * 1024 * 1024,
    headers,
  });
  log("upload done");

  const prepared = await fetch(new URL("/api/blob/prepare-job", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...paths, originalFilename: name, includeMedia }),
  });
  const job = await prepared.json();
  log(`prepare-job HTTP ${prepared.status}`);

  // --- the raced section, exactly as the browser does it -------------------
  const convertRequest = fetch(new URL("/converter/v1/convert", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jobToken: job.jobToken,
      sourceGetUrl: job.sourceGetUrl,
      resultPutUrl: job.resultPutUrl,
      sourceDeleteUrl: job.sourceDeleteUrl,
      statusPutUrl: job.statusPutUrl,
    }),
  }).then(async (response) => {
    log(`  convert POST resolved HTTP ${response.status}`);
    if (!response.ok) throw new Error(`convert HTTP ${response.status}`);
    const body = await response.json();
    return body.warnings ?? [];
  });
  convertRequest.catch((error) => log(`  convert POST rejected: ${error.message}`));

  const pollAbort = new AbortController();
  const polling = pollStatus(job.statusGetUrl, pollAbort.signal).then((status) => {
    if (!status.ok) throw new Error(`status not ok: ${status.code}`);
    return status.warnings ?? [];
  });
  polling.catch((error) => log(`  polling rejected: ${error.message}`));

  log("racing convert POST against status polling...");
  let warnings;
  try {
    warnings = await Promise.any([convertRequest, polling]);
  } finally {
    // THE FIX: cancel the losing branch so it cannot emit a late stage update
    // after the flow has already completed.
    pollAbort.abort();
  }
  log(`RACE RESOLVED (${warnings.length} warnings)`);

  // --- the step that appears to stall --------------------------------------
  log("requesting download url...");
  const downloadResponse = await fetch(new URL("/api/blob/download-url", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jobToken: job.jobToken,
      resultPathname: job.resultPathname,
    }),
  });
  const download = await downloadResponse.json();
  log(`download-url HTTP ${downloadResponse.status} size=${download.sizeBytes}`);
  const head = await fetch(download.downloadUrl);
  const headBytes = new Uint8Array(await head.arrayBuffer());
  const isZip = headBytes[0] === 0x50 && headBytes[1] === 0x4b;
  log(`  deliverable: ${isZip ? "ZIP" : "markdown"} (${headBytes.length} bytes)`);
  log("FLOW COMPLETE");
}

main().catch((error) => {
  log(`FLOW FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
