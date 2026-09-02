/**
 * Content-Security-Policy regression guard.
 *
 * This exists because of a real production failure. The CSP allowed
 * `https://*.blob.vercel-storage.com` but not `https://vercel.com`, and the
 * Blob SDK uploads to `https://vercel.com/api/blob`. Every browser upload was
 * blocked before it left the page: the progress bar sat at 0% with no error a
 * user could see, and no server-side log to find, because the request was
 * never made.
 *
 * Nothing else caught it. The §57 release test drives the upload from Node,
 * which has no CSP at all, so it passed against the same broken deployment.
 * These assertions read the real config so a future edit that drops a host
 * fails here instead of in someone's browser.
 */

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

async function connectSrc(): Promise<string> {
  const headerGroups = await nextConfig.headers!();
  const headers = headerGroups.flatMap((group) => group.headers);
  const csp = headers.find((h) => h.key === "Content-Security-Policy");
  expect(csp, "a CSP header must be set").toBeDefined();
  const directive = csp!.value
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src"));
  expect(directive, "connect-src must be present").toBeDefined();
  return directive!;
}

describe("connect-src", () => {
  it("allows the Blob upload API host", async () => {
    // The regression: uploads go here, and omitting it breaks every upload.
    expect(await connectSrc()).toContain("https://vercel.com");
  });

  it("allows the private store host used for reads", async () => {
    // Source download, status polling and the result download.
    expect(await connectSrc()).toContain("https://*.blob.vercel-storage.com");
  });

  it("allows the bare blob host as well as the wildcard", async () => {
    // `*.example.com` does NOT match `example.com` in CSP, so relying on the
    // wildcard alone would leave the bare host blocked.
    expect(await connectSrc()).toContain("https://blob.vercel-storage.com");
  });

  it("allows same-origin calls to our own API routes", async () => {
    expect(await connectSrc()).toContain("'self'");
  });
});

describe("the rest of the policy stays strict", () => {
  it("does not open connect-src to everything", async () => {
    const directive = await connectSrc();
    expect(directive).not.toContain("*;");
    expect(directive.split(/\s+/)).not.toContain("*");
  });

  it("keeps framing and base-uri locked down", async () => {
    const headerGroups = await nextConfig.headers!();
    const csp = headerGroups
      .flatMap((group) => group.headers)
      .find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
  });

  it("still sends the other security headers (§45)", async () => {
    const headerGroups = await nextConfig.headers!();
    const keys = headerGroups.flatMap((group) =>
      group.headers.map((h) => h.key),
    );
    expect(keys).toContain("X-Content-Type-Options");
    expect(keys).toContain("X-Frame-Options");
    expect(keys).toContain("Strict-Transport-Security");
    expect(keys).toContain("Referrer-Policy");
  });
});
