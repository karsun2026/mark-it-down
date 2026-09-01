/**
 * Job token tests, including the cross-language wire format (§16).
 *
 * The TypeScript minter and the Python verifier must agree byte for byte.
 * The vectors below are asserted here and re-asserted from Python in
 * `tests/converter/test_cross_language_token.py`, so a change to either
 * serializer breaks a test rather than production.
 */

import { describe, expect, it } from "vitest";

import { mintJobToken, verifyJobToken } from "./job-token";

const SECRET = Buffer.from("s".repeat(32), "utf8");

const CLAIMS = {
  job_id: "6f3b9d",
  source_path: "jobs/2026-09-01/6f3b9d/source/report.pdf",
  result_path: "jobs/2026-09-01/6f3b9d/result/report_markdown.zip",
  filename: "report.pdf",
  source_size: 1234,
  exp: 1788260000,
};

describe("mintJobToken", () => {
  it("produces a stable token for fixed claims", () => {
    // Pinned so an accidental change to field order or JSON spacing fails
    // here rather than silently breaking the Python verifier.
    expect(mintJobToken(CLAIMS, SECRET)).toMatchInlineSnapshot(`"eyJleHAiOjE3ODgyNjAwMDAsImZpbGVuYW1lIjoicmVwb3J0LnBkZiIsImpvYl9pZCI6IjZmM2I5ZCIsInJlc3VsdF9wYXRoIjoiam9icy8yMDI2LTA5LTAxLzZmM2I5ZC9yZXN1bHQvcmVwb3J0X21hcmtkb3duLnppcCIsInNvdXJjZV9wYXRoIjoiam9icy8yMDI2LTA5LTAxLzZmM2I5ZC9zb3VyY2UvcmVwb3J0LnBkZiIsInNvdXJjZV9zaXplIjoxMjM0fQ.B5gGcVb5QR3EJgU35E_-tQt2jLqVEWicIzMVjFh0c3E"`);
  });

  it("round-trips through verifyJobToken", () => {
    const verified = verifyJobToken(mintJobToken(CLAIMS, SECRET), SECRET);
    expect(verified).not.toBeNull();
    expect(verified!.claims).toEqual(CLAIMS);
    expect(verified!.expired).toBe(true); // exp is in the past
  });

  it("serializes keys in sorted order", () => {
    const token = mintJobToken(CLAIMS, SECRET);
    const payload = Buffer.from(token.split(".")[0]!, "base64url").toString();
    expect(payload).toBe(
      '{"exp":1788260000,"filename":"report.pdf","job_id":"6f3b9d",' +
        '"result_path":"jobs/2026-09-01/6f3b9d/result/report_markdown.zip",' +
        '"source_path":"jobs/2026-09-01/6f3b9d/source/report.pdf",' +
        '"source_size":1234}',
    );
  });

  it("emits non-ASCII raw, matching Python ensure_ascii=False", () => {
    const token = mintJobToken(
      { ...CLAIMS, filename: "Übersicht Studie.docx" },
      SECRET,
    );
    const payload = Buffer.from(token.split(".")[0]!, "base64url").toString();
    expect(payload).toContain("Übersicht Studie.docx");
    expect(payload).not.toContain("\\u00dc");
  });

  it("changes the signature when any claim changes", () => {
    const base = mintJobToken(CLAIMS, SECRET);
    const altered = mintJobToken({ ...CLAIMS, source_size: 1235 }, SECRET);
    expect(altered).not.toBe(base);
  });
});

describe("verifyJobToken", () => {
  it("rejects a tampered payload", () => {
    const token = mintJobToken(CLAIMS, SECRET);
    const [payload, signature] = token.split(".");
    const forged = `${payload!.slice(0, -4)}AAAA.${signature}`;
    expect(verifyJobToken(forged, SECRET)).toBeNull();
  });

  it("rejects a wrong secret", () => {
    const token = mintJobToken(CLAIMS, SECRET);
    expect(verifyJobToken(token, Buffer.from("z".repeat(32)))).toBeNull();
  });

  it.each(["", ".", "abc", "a.b.c", "onlypayload"])(
    "rejects malformed token %j",
    (token) => {
      expect(verifyJobToken(token, SECRET)).toBeNull();
    },
  );

  it("reports expiry without rejecting the signature", () => {
    const future = { ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 600 };
    const verified = verifyJobToken(mintJobToken(future, SECRET), SECRET);
    expect(verified!.expired).toBe(false);
  });
});
