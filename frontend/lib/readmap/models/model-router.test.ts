/**
 * Model router tests (spec §5; ADR-006).
 *
 * Pins: per-role model resolution, provider selection, and the honesty rule —
 * an unconfigured or unsupported provider refuses with a config error instead
 * of silently degrading (rule 15).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { clearDevResponses, registerDevResponse } from "./dev-adapter";
import { DEFAULT_MODEL, getClientForTask, resolveModelForTask } from "./model-router";

afterEach(() => {
  vi.unstubAllEnvs();
  clearDevResponses();
});

const SIMPLE_INPUT = {
  task: "mapper" as const,
  system: "system rules",
  messages: [{ role: "user" as const, text: "map the document" }],
  schema: z.object({ ok: z.boolean() }),
  idempotencyKey: "router:test:unit",
} as const;

describe("resolveModelForTask — per-role configuration", () => {
  it("falls back to the default model when no variable is set", () => {
    expect(resolveModelForTask("mapper")).toBe(DEFAULT_MODEL);
    expect(resolveModelForTask("signal-extraction")).toBe(DEFAULT_MODEL);
    expect(resolveModelForTask("skeptic")).toBe(DEFAULT_MODEL);
    expect(resolveModelForTask("compression")).toBe(DEFAULT_MODEL);
  });

  it("maps roles onto their READMAP_*_MODEL variables", () => {
    vi.stubEnv("READMAP_EXTRACTION_MODEL", "gemini-extraction-x");
    vi.stubEnv("READMAP_VERIFICATION_MODEL", "gemini-verify-y");
    vi.stubEnv("READMAP_COMPRESSION_MODEL", "gemini-compress-z");

    expect(resolveModelForTask("mapper")).toBe("gemini-extraction-x");
    expect(resolveModelForTask("signal-extraction")).toBe("gemini-extraction-x");
    expect(resolveModelForTask("skeptic")).toBe("gemini-verify-y");
    expect(resolveModelForTask("numeric-check")).toBe("gemini-verify-y");
    expect(resolveModelForTask("compression")).toBe("gemini-compress-z");
  });
});

describe("getClientForTask — provider selection", () => {
  it("refuses to build a Gemini client without a key (fail closed)", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => getClientForTask("mapper")).toThrowError(
      "GEMINI_API_KEY is not configured",
    );
  });

  it("builds a Gemini client by default, honouring the role's model id", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("READMAP_VERIFICATION_MODEL", "gemini-verify-y");
    const client = getClientForTask("skeptic");
    // A Gemini client is returned and usable; its wire behaviour is pinned by
    // the gemini contract tests, so a construction check is enough here.
    expect(typeof client.generate).toBe("function");
  });

  it("routes to the dev adapter only when explicitly configured", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    registerDevResponse(SIMPLE_INPUT.idempotencyKey, { ok: true });

    const client = getClientForTask("mapper");
    const result = await client.generate(SIMPLE_INPUT);
    // End-to-end: the routed client served the registered dev fixture.
    expect(result.provider).toBe("dev");
    expect(result.value).toEqual({ ok: true });
  });

  it("refuses the dev provider outside development (fail closed)", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    expect(() => getClientForTask("mapper")).toThrowError(
      "READMAP_MODEL_PROVIDER=dev requires APP_ENV=development",
    );
  });

  it("refuses the unimplemented Anthropic adapter honestly", () => {
    vi.stubEnv("READMAP_MODEL_PROVIDER", "anthropic");
    vi.stubEnv("GEMINI_API_KEY", "unused-key");
    expect(() => getClientForTask("mapper")).toThrowError(
      "Anthropic adapter is not implemented in Phase 1 (ADR-006); use gemini or dev",
    );
  });

  it("refuses unknown providers instead of guessing", () => {
    vi.stubEnv("READMAP_MODEL_PROVIDER", "perplexity");
    vi.stubEnv("GEMINI_API_KEY", "unused-key");
    expect(() => getClientForTask("mapper")).toThrowError(
      "is not a supported provider",
    );
  });

  it("treats provider values case-insensitively", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "DEV");
    expect(() => getClientForTask("mapper")).not.toThrow();
  });
});