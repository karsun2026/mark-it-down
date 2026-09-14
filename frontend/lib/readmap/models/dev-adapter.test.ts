/**
 * Dev adapter tests (rule 15; ADR-006).
 *
 * The critical property: the labelled dev adapter FAILS CLOSED outside
 * `APP_ENV=development` + `READMAP_MODEL_PROVIDER=dev`, and never invents
 * output when no fixture was registered. A mock that quietly produces
 * plausible-looking analysis is exactly what the rules forbid.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clearDevResponses,
  createDevClient,
  devAdapterAllowed,
  registerDevResponse,
} from "./dev-adapter";

const SCHEMA = z.object({ ok: z.boolean() });

const INPUT = {
  task: "mapper" as const,
  system: "system rules",
  messages: [{ role: "user" as const, text: "map the document" }],
  schema: SCHEMA,
  idempotencyKey: "doc1:mapper:whole",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  clearDevResponses();
});

describe("devAdapterAllowed — the double gate", () => {
  it("is false in production even when the provider is dev", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    expect(devAdapterAllowed()).toBe(false);
  });

  it("is false in development when the provider is not dev", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "gemini");
    expect(devAdapterAllowed()).toBe(false);
  });

  it("is true only when both conditions hold", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    expect(devAdapterAllowed()).toBe(true);
  });
});

describe("createDevClient — fail-closed behaviour", () => {
  it("refuses every call outside development, regardless of registration", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    registerDevResponse(INPUT.idempotencyKey, { ok: true });

    const client = createDevClient();
    await expect(client.generate(INPUT)).rejects.toMatchObject({
      kind: "config",
      message: expect.stringContaining("refused"),
    });
  });

  it("refuses when no response was registered for the key, instead of inventing one", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");

    const client = createDevClient();
    await expect(client.generate(INPUT)).rejects.toMatchObject({
      kind: "config",
      message: expect.stringContaining("no registered response"),
    });
  });

  it("refuses a fixture that does not satisfy the caller's schema", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    registerDevResponse(INPUT.idempotencyKey, { ok: "yes" });

    const client = createDevClient();
    await expect(client.generate(INPUT)).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("devAdapterLabelledOutput", () => {
  it("serves registered fixtures in development and labels them as dev output", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    registerDevResponse(INPUT.idempotencyKey, { ok: true });

    const client = createDevClient();
    const result = await client.generate(INPUT);

    // The label is the point: fixture output must never be mistaken for real
    // model output downstream.
    expect(result.provider).toBe("dev");
    expect(result.model).toBe("dev-fixture");
    expect(result.value).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("accepts a JSON-string fixture and validates it like any other source", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");
    registerDevResponse(INPUT.idempotencyKey, '{"ok":true}');

    const client = createDevClient();
    const result = await client.generate(INPUT);
    expect(result.value).toEqual({ ok: true });
  });

  it("honours a custom resolver over the shared registry", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("READMAP_MODEL_PROVIDER", "dev");

    const client = createDevClient({
      resolve: (key, task) =>
        key === INPUT.idempotencyKey && task === "mapper" ? { ok: true } : undefined,
    });
    const result = await client.generate(INPUT);
    expect(result.value).toEqual({ ok: true });
  });
});