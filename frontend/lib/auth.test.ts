/**
 * Auth and rate-limit-key tests (§43, §44).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  AuthNotConfiguredError,
  authMode,
  authenticate,
  isAnonymousMode,
  rateLimitKeyFor,
} from "./auth";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/blob/upload", {
    method: "POST",
    headers,
  });
}

describe("authMode", () => {
  it("defaults to none", () => {
    delete process.env.AUTH_MODE;
    expect(authMode()).toBe("none");
    expect(isAnonymousMode()).toBe(true);
  });

  it("recognises entra", () => {
    process.env.AUTH_MODE = "entra";
    expect(authMode()).toBe("entra");
    expect(isAnonymousMode()).toBe(false);
  });

  it("treats an unknown mode as none rather than crashing", () => {
    process.env.AUTH_MODE = "saml";
    expect(authMode()).toBe("none");
  });

  it("is case and whitespace tolerant", () => {
    process.env.AUTH_MODE = "  Entra  ";
    expect(authMode()).toBe("entra");
  });
});

describe("authenticate", () => {
  it("returns an anonymous identity in none mode", async () => {
    process.env.AUTH_MODE = "none";
    const identity = await authenticate(req());
    expect(identity.userId).toBeNull();
    expect(identity.source).toBe("anonymous");
  });

  it("fails CLOSED when entra is selected but unconfigured", async () => {
    // §43: a deployment that intends to require auth must not quietly serve
    // everyone because its configuration is missing.
    process.env.AUTH_MODE = "entra";
    delete process.env.ENTRA_TENANT_ID;
    delete process.env.ENTRA_CLIENT_ID;
    await expect(authenticate(req())).rejects.toBeInstanceOf(
      AuthNotConfiguredError,
    );
  });

  it("fails closed when configured but no user header is present", async () => {
    process.env.AUTH_MODE = "entra";
    process.env.ENTRA_TENANT_ID = "tenant";
    process.env.ENTRA_CLIENT_ID = "client";
    await expect(authenticate(req())).rejects.toBeInstanceOf(
      AuthNotConfiguredError,
    );
  });

  it("accepts a verified platform user header", async () => {
    process.env.AUTH_MODE = "entra";
    process.env.ENTRA_TENANT_ID = "tenant";
    process.env.ENTRA_CLIENT_ID = "client";
    const identity = await authenticate(req({ "x-vercel-user-id": "u-123" }));
    expect(identity.userId).toBe("u-123");
    expect(identity.source).toBe("entra");
  });
});

describe("rateLimitKeyFor", () => {
  it("returns null when anonymous, so the IP bucket is used (§44)", () => {
    expect(rateLimitKeyFor({ userId: null, source: "anonymous" })).toBeNull();
  });

  it("namespaces by source so buckets cannot collide", () => {
    expect(rateLimitKeyFor({ userId: "u-1", source: "entra" })).toBe(
      "entra:u-1",
    );
  });

  it("gives different users different buckets", () => {
    const a = rateLimitKeyFor({ userId: "u-1", source: "entra" });
    const b = rateLimitKeyFor({ userId: "u-2", source: "entra" });
    expect(a).not.toBe(b);
  });
});
