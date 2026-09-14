/**
 * Route-access tests (plan acceptance check 9; rule 15).
 *
 * The critical property: with APP_ENV != development and no provider key,
 * the READMAP start path refuses BEFORE doing any work — the client gets
 * SERVICE_UNAVAILABLE, never a mock result and never a half-run pipeline.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { modelConfigured } from "./route-access";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("modelConfigured — fail-closed pre-flight (plan check 9)", () => {
  it("is false in production with no Gemini key", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "");
    delete process.env.READMAP_MODEL_PROVIDER;
    expect(modelConfigured()).toBe(false);
  });

  it("is true in production with a Gemini key configured", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "configured");
    expect(modelConfigured()).toBe(true);
  });

  it("is false when the provider is dev but the app is not in development", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(modelConfigured()).toBe(false);
  });

  it("is true for the dev adapter in development", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    expect(modelConfigured()).toBe(true);
  });

  it("is false for an unsupported provider instead of guessing", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "perplexity");
    vi.stubEnv("GEMINI_API_KEY", "unused");
    expect(modelConfigured()).toBe(false);
  });

  it("is false for the unimplemented Anthropic adapter (honest refusal)", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "anthropic");
    vi.stubEnv("GEMINI_API_KEY", "unused");
    expect(modelConfigured()).toBe(false);
  });
});