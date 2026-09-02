/**
 * Password-gate session tests (§43).
 *
 * The cookie is the only thing standing between a public URL and the tool, so
 * the properties that matter are: it cannot be forged, it cannot be replayed
 * after expiry, and a wrong password is not distinguishable by timing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_TTL_SECONDS,
  configuredPassword,
  createSession,
  isValidSession,
  sessionCookieOptions,
  timingSafeMatch,
} from "./session";

const ORIGINAL = { ...process.env };
const SECRET = "s".repeat(48);

beforeEach(() => {
  process.env.JOB_SIGNING_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("createSession / isValidSession", () => {
  it("accepts a freshly minted session", async () => {
    expect(await isValidSession((await createSession()))).toBe(true);
  });

  it("rejects a missing or empty cookie", async () => {
    expect(await isValidSession(undefined)).toBe(false);
    expect(await isValidSession(null)).toBe(false);
    expect(await isValidSession("")).toBe(false);
  });

  it("rejects a forged signature", async () => {
    const session = await createSession();
    const [payload] = session.split(".");
    expect(await isValidSession(`${payload}.forged`)).toBe(false);
  });

  it("rejects a tampered expiry", async () => {
    // The attack this stops: extend your own session by editing the cookie.
    const session = await createSession();
    const [, signature] = session.split(".");
    const farFuture = Math.floor(Date.now() / 1000) + 999_999;
    expect(await isValidSession(`${farFuture}.${signature}`)).toBe(false);
  });

  it("rejects a session signed with a different secret", async () => {
    const session = await createSession();
    process.env.JOB_SIGNING_SECRET = "d".repeat(48);
    expect(await isValidSession(session)).toBe(false);
  });

  it("rejects an expired session", async () => {
    const issuedAt = Date.now() - (SESSION_TTL_SECONDS + 60) * 1000;
    expect(await isValidSession((await createSession(issuedAt)))).toBe(false);
  });

  it("accepts a session that has not quite expired", async () => {
    const issuedAt = Date.now() - (SESSION_TTL_SECONDS - 60) * 1000;
    expect(await isValidSession((await createSession(issuedAt)))).toBe(true);
  });

  it.each(["", "abc", "a.b.c", "12345", ".", "..", "1700000000."])(
    "rejects malformed cookie %j",
    async (value) => {
      expect(await isValidSession(value)).toBe(false);
    },
  );

  it("refuses everything when the secret is unusable", async () => {
    const session = await createSession();
    process.env.JOB_SIGNING_SECRET = "tooshort";
    // Fail closed: a misconfigured server must not accept arbitrary cookies.
    expect(await isValidSession(session)).toBe(false);
  });
});

describe("timingSafeMatch", () => {
  it("matches identical strings", async () => {
    expect(await timingSafeMatch("hunter2", "hunter2")).toBe(true);
  });

  it("rejects different strings", async () => {
    expect(await timingSafeMatch("hunter2", "hunter3")).toBe(false);
  });

  it("handles different lengths without throwing", async () => {
    // node's timingSafeEqual throws on length mismatch; hashing first avoids
    // both the exception and the length oracle.
    expect(await timingSafeMatch("short", "a much longer password")).toBe(false);
  });

  it("rejects an empty candidate", async () => {
    expect(await timingSafeMatch("", "real-password")).toBe(false);
  });

  it("handles unicode", async () => {
    expect(await timingSafeMatch("pässwörd", "pässwörd")).toBe(true);
    expect(await timingSafeMatch("pässwörd", "password")).toBe(false);
  });
});

describe("configuredPassword", () => {
  it("is null when unset, which leaves the gate off", () => {
    delete process.env.APP_PASSWORD;
    expect(configuredPassword()).toBeNull();
  });

  it("is null when blank", () => {
    process.env.APP_PASSWORD = "   ";
    expect(configuredPassword()).toBeNull();
  });

  it("returns the trimmed password", () => {
    process.env.APP_PASSWORD = "  letmein  ";
    expect(configuredPassword()).toBe("letmein");
  });
});

describe("cookie options", () => {
  it("is HttpOnly so scripts cannot read it", () => {
    expect(sessionCookieOptions().httpOnly).toBe(true);
  });

  it("is SameSite to blunt cross-site submission", () => {
    expect(sessionCookieOptions().sameSite).toBe("lax");
  });

  it("is Secure in production", () => {
    const previous = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    expect(sessionCookieOptions().secure).toBe(true);
    Object.defineProperty(process.env, "NODE_ENV", {
      value: previous,
      configurable: true,
    });
  });
});
