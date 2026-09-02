/**
 * Rate limiting tests (§44).
 *
 * The behaviour that matters most here is the *degraded* path: a missing
 * Firewall rule must be loud, not silent. A limiter that quietly does nothing
 * is worse than none, because the code still reads as protected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkRateLimit = vi.hoisted(() => vi.fn());
vi.mock("@vercel/firewall", () => ({ checkRateLimit }));

import {
  CONVERSION_RATE_LIMIT_ID,
  EXPECTED_LIMIT,
  EXPECTED_WINDOW_SECONDS,
  checkConversionRateLimit,
  warnIfDegraded,
} from "./rate-limit";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  checkRateLimit.mockReset();
  process.env.AUTH_MODE = "none";
  delete process.env.RATE_LIMIT_ENABLED;
  delete process.env.RATE_LIMIT_REQUIRED;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

function req(): Request {
  return new Request("https://example.test/api/blob/upload", { method: "POST" });
}

describe("§44 configuration", () => {
  it("matches the limit the spec states", () => {
    expect(EXPECTED_LIMIT).toBe(5);
    expect(EXPECTED_WINDOW_SECONDS).toBe(600);
  });

  it("has a stable rule id the dashboard rule must match", () => {
    expect(CONVERSION_RATE_LIMIT_ID).toBe("conversions");
  });
});

describe("checkConversionRateLimit", () => {
  it("allows a request under the limit", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false });
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(false);
    expect(outcome.degraded).toBeNull();
  });

  it("blocks a request over the limit", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: true });
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(true);
  });

  it("uses the client-IP bucket when anonymous (§44 fallback)", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false });
    await checkConversionRateLimit(req());
    const [, options] = checkRateLimit.mock.calls[0]!;
    // No explicit key: the SDK default is the client IP.
    expect(options.rateLimitKey).toBeUndefined();
  });

  it("buckets on the user when an identity exists", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false });
    await checkConversionRateLimit(req(), {
      userId: "u-9",
      source: "entra",
    });
    const [, options] = checkRateLimit.mock.calls[0]!;
    expect(options.rateLimitKey).toBe("entra:u-9");
  });

  it("passes the configured rule id", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false });
    await checkConversionRateLimit(req());
    expect(checkRateLimit.mock.calls[0]![0]).toBe(CONVERSION_RATE_LIMIT_ID);
  });
});

describe("the silent-failure signal", () => {
  it("treats a missing dashboard rule as degraded, not as 'allowed'", async () => {
    // The SDK resolves rather than throwing when the rule is absent. Reading
    // only `rateLimited` would report a healthy limiter that limits nothing.
    checkRateLimit.mockResolvedValue({ rateLimited: false, error: "not-found" });
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.degraded).toBe("not-configured");
  });

  it("fails CLOSED on a missing rule when enforcement is required", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false, error: "not-found" });
    process.env.RATE_LIMIT_REQUIRED = "true";
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(true);
    expect(outcome.degraded).toBeNull();
  });

  it("treats a firewall block as limited", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false, error: "blocked" });
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(true);
    expect(outcome.degraded).toBeNull();
  });

  it("a healthy check reports no degradation", async () => {
    checkRateLimit.mockResolvedValue({ rateLimited: false });
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.degraded).toBeNull();
  });
});

describe("degraded behaviour", () => {
  it("fails OPEN by default when the check errors", async () => {
    // A transient Firewall failure must not take the whole app down.
    checkRateLimit.mockRejectedValue(new Error("no such rule"));
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(false);
    expect(outcome.degraded).toBe("error");
  });

  it("fails CLOSED when RATE_LIMIT_REQUIRED=true", async () => {
    checkRateLimit.mockRejectedValue(new Error("no such rule"));
    process.env.RATE_LIMIT_REQUIRED = "true";
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(true);
    expect(outcome.degraded).toBeNull();
  });

  it("never throws, whatever the SDK does", async () => {
    checkRateLimit.mockRejectedValue("not even an Error");
    await expect(checkConversionRateLimit(req())).resolves.toBeDefined();
  });

  it("can be switched off explicitly", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    const outcome = await checkConversionRateLimit(req());
    expect(outcome.limited).toBe(false);
    expect(outcome.degraded).toBe("disabled");
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("does not leak the bucket key into logs (§47)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkRateLimit.mockRejectedValue(new Error("boom"));
    await checkConversionRateLimit(req(), { userId: "secret-user", source: "entra" });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret-user");
  });
});

describe("warnIfDegraded", () => {
  it("shouts when rate limiting is silently not in effect", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfDegraded({ limited: false, degraded: "error" }, "/api/x");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("NOT in effect");
  });

  it("stays quiet when the limiter is working", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfDegraded({ limited: false, degraded: null }, "/api/x");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when deliberately disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfDegraded({ limited: false, degraded: "disabled" }, "/api/x");
    expect(warn).not.toHaveBeenCalled();
  });
});
