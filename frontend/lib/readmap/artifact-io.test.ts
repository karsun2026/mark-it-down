/**
 * Artifact I/O tests for the CDN-cache and overwrite semantics fixed in the
 * Phase-1 review (§6-H1, §6-M4). The pure path/retention helpers are covered
 * in artifacts.test.ts; these tests mock @vercel/blob and fetch so the
 * presign/write options can be asserted exactly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getReadmapArtifact,
  putReadmapArtifact,
} from "./artifacts";

const presignCalls: { useCache?: boolean }[] = [];
const putCalls: { allowOverwrite?: boolean }[] = [];

vi.mock("@vercel/blob", () => ({
  issueSignedToken: vi.fn().mockResolvedValue("signed-token"),
  presignUrl: vi.fn().mockImplementation(async (_token: unknown, options: { useCache?: boolean }) => {
    presignCalls.push(options);
    return { presignedUrl: "https://blob.test/artifact" };
  }),
  put: vi.fn().mockImplementation(async (_pathname: string, _body: string, options: { allowOverwrite?: boolean }) => {
    putCalls.push(options);
  }),
}));

beforeEach(() => {
  presignCalls.length = 0;
  putCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ stage: "READY" }), { status: 200 })),
  );
});

describe("presigned reads (§6-H1: fresh must bypass the CDN cache)", () => {
  it("passes useCache:false for a fresh status read", async () => {
    await getReadmapArtifact("jobs/x/readmap/status.v1.json", { fresh: true });
    expect(presignCalls).toHaveLength(1);
    expect(presignCalls[0]?.useCache).toBe(false);
  });

  it("keeps the CDN cache on for ordinary (non-fresh) reads", async () => {
    await getReadmapArtifact("jobs/x/readmap/readmap.v1.json");
    expect(presignCalls).toHaveLength(1);
    expect(presignCalls[0]?.useCache).toBe(true);
  });
});

describe("artifact writes (§6-M4: immutability is enforced, not conventional)", () => {
  it("writes immutable artifacts with allowOverwrite:false", async () => {
    await putReadmapArtifact("jobs/x/readmap/evidence.v1.json", {}, { immutable: true });
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.allowOverwrite).toBe(false);
  });

  it("defaults to allowOverwrite:true for the status object (D-002)", async () => {
    await putReadmapArtifact("jobs/x/readmap/status.v1.json", {});
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.allowOverwrite).toBe(true);
  });
});