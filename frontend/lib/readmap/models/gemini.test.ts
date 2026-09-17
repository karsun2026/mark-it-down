/**
 * Gemini adapter contract tests (Phase 1 acceptance check, ADR-006).
 *
 * All provider traffic is faked at the `fetch` seam — no network access, no
 * real key, no live model call. These tests pin the wire contract, the
 * one-repair-attempt rule (spec §10), the fail-closed config behaviour, and
 * the log-safety of error messages.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DEFAULT_GEMINI_MODEL,
  createGeminiClient,
  toGeminiResponseSchema,
} from "./gemini";

const SCHEMA = z.object({ label: z.string(), score: z.number().int() });

function geminiOk(text: string, usage?: { in?: number; out?: number }): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
      ],
      usageMetadata: {
        promptTokenCount: usage?.in ?? 11,
        candidatesTokenCount: usage?.out ?? 7,
      },
    }),
    { status: 200 },
  );
}

/** Stub fetch, capturing every request; `responses` are consumed in order. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    return next;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const INPUT = {
  task: "signal-extraction" as const,
  system: "SYSTEM RULES (not asserted into logs)",
  messages: [
    { role: "user" as const, text: "extract signals" },
    { role: "assistant" as const, text: "acknowledged" },
    { role: "user" as const, text: "continue" },
  ],
  schema: SCHEMA,
  temperature: 0.2,
  maxOutputTokens: 512,
  idempotencyKey: "doc1:stage:unit1",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createGeminiClient — request shape", () => {
  it("posts to generateContent with the key in a header and JSON mode on", async () => {
    const { fetchImpl, calls } = stubFetch([
      geminiOk('{"label":"growth","score":12}'),
    ]);
    const client = createGeminiClient({ apiKey: "test-key", fetchImpl });
    await client.generate(INPUT);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.systemInstruction.parts[0].text).toBe(INPUT.system);
    // "assistant" turns must map onto Gemini's "model" role.
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.temperature).toBe(0.2);
    expect(body.generationConfig.maxOutputTokens).toBe(512);
    expect(body.generationConfig.responseSchema).toBeTruthy();
    expect(JSON.stringify(body.generationConfig.responseSchema)).not.toContain(
      "$schema",
    );
  });

  it("validates and returns schema-conformant output with provider usage", async () => {
    const { fetchImpl } = stubFetch([
      geminiOk('{"label":"growth","score":12}', { in: 30, out: 9 }),
    ]);
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    const result = await client.generate(INPUT);

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(result.value).toEqual({ label: "growth", score: 12 });
    expect(result.repairAttempts).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 9 });
    expect(result.idempotencyKey).toBe("doc1:stage:unit1");
  });
});

describe("createGeminiClient — schema repair (spec §10)", () => {
  it("makes exactly one repair attempt and returns the repaired output", async () => {
    const { fetchImpl, calls } = stubFetch([
      geminiOk('{"label":"growth"'), // invalid JSON, triggers the repair
      geminiOk('{"label":"growth","score":3}'),
    ]);
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    const result = await client.generate(INPUT);

    expect(result.repairAttempts).toBe(1);
    expect(result.value).toEqual({ label: "growth", score: 3 });
    // Both calls count against the job's token budget.
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 14 });
    expect(calls).toHaveLength(2);
    const repairBody = JSON.parse(String(calls[1]?.init.body));
    // The repair conversation keeps the original turns and adds the invalid
    // output as a model turn plus one repair instruction.
    expect(repairBody.contents).toHaveLength(5);
    expect(repairBody.contents[3].role).toBe("model");
    expect(repairBody.contents[4].role).toBe("user");
  });

  it("fails the unit with kind=schema after the repair still violates the schema", async () => {
    const { fetchImpl } = stubFetch([
      geminiOk('{"label":"growth","score":"not-a-number"}'),
      geminiOk('{"label":"growth"}'),
    ]);
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    await expect(client.generate(INPUT)).rejects.toMatchObject({
      name: "ModelCallError",
      kind: "schema",
    });
  });

  it("fails the unit with kind=schema when both responses are invalid JSON", async () => {
    const { fetchImpl } = stubFetch([
      geminiOk("not json at all"),
      geminiOk("still not json"),
    ]);
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    await expect(client.generate(INPUT)).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("createGeminiClient — provider failures", () => {
  it("maps HTTP provider errors to kind=provider with shape-only messages", async () => {
    // §6-L1: a 429 is retried once after a short backoff — so the failure must
    // be scripted twice (retry, then the same 429) before the unit fails.
    const { fetchImpl, calls } = stubFetch([
      new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
        status: 429,
      }),
      new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
        status: 429,
      }),
    ]);
    const client = createGeminiClient({
      apiKey: "k",
      fetchImpl,
      transientRetryBackoffMs: 1,
    });

    await expect(client.generate(INPUT)).rejects.toMatchObject({
      kind: "provider",
      status: 429,
      // Shape only: no provider message body, no URL, no key in the message.
      message: "gemini request failed with HTTP 429 (RESOURCE_EXHAUSTED)",
    });
    // Exactly one retry — never a hammering loop.
    expect(calls).toHaveLength(2);
  });

  it("recovers when a single 429 is followed by a successful response (§6-L1)", async () => {
    const { fetchImpl } = stubFetch([
      new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
        status: 429,
      }),
      geminiOk('{"label":"growth","score":8}'),
    ]);
    const client = createGeminiClient({
      apiKey: "k",
      fetchImpl,
      transientRetryBackoffMs: 1,
    });

    const result = await client.generate(INPUT);
    expect(result.value).toEqual({ label: "growth", score: 8 });
  });

  it("rejects a truncated response even when the text would parse", async () => {
    const truncated = new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: '{"label":"growth","score":12}' }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      }),
      { status: 200 },
    );
    const { fetchImpl } = stubFetch([truncated]);
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    await expect(client.generate(INPUT)).rejects.toMatchObject({
      kind: "provider",
      message: "gemini did not finish (finishReason=MAX_TOKENS)",
    });
  });

  it("throws a config error when no API key is available (fail closed)", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => createGeminiClient()).toThrowError(
      "GEMINI_API_KEY is not configured",
    );
  });

  it("throws a provider error when the network call itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    await expect(client.generate(INPUT)).rejects.toMatchObject({
      kind: "provider",
      message: "gemini request failed before a response arrived",
    });
  });
});

describe("createGeminiClient — responseSchema 400 fallback", () => {
  it("retries once without responseSchema when the built schema is rejected (HTTP 400)", async () => {
    // Verified 2026-09-15: the live endpoint 400s on some JSON-Schema keywords.
    // The adapter must recover by dropping the schema, not fail the whole unit.
    const { fetchImpl, calls } = stubFetch([
      new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), {
        status: 400,
      }),
      geminiOk('{"label":"growth","score":5}'),
    ]);
    const client = createGeminiClient({ apiKey: "k", fetchImpl });

    const result = await client.generate(INPUT);

    expect(result.value).toEqual({ label: "growth", score: 5 });
    expect(result.repairAttempts).toBe(0);
    expect(calls).toHaveLength(2);
    // First attempt carries a responseSchema; the retry drops it but keeps JSON mode.
    const firstBody = JSON.parse(String(calls[0]?.init.body));
    const retryBody = JSON.parse(String(calls[1]?.init.body));
    expect(firstBody.generationConfig.responseSchema).toBeTruthy();
    expect(retryBody.generationConfig.responseSchema).toBeUndefined();
    expect(retryBody.generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("toGeminiResponseSchema — Gemini-subset conversion", () => {
  it("maps literal consts onto supported enums and drops unsupported keywords", () => {
    const schema = z.object({
      version: z.literal("1.0"),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      kind: z.enum(["PDF", "DOCX"]),
    });
    const converted = toGeminiResponseSchema(schema);
    expect(converted).not.toBeNull();
    // `const` -> single-value `enum` (Gemini supports enum, not const).
    expect(converted?.properties).toHaveProperty("version.enum", ["1.0"]);
    // Unsupported string keywords are pruned; Zod still validates them.
    expect(JSON.stringify(converted)).not.toContain("pattern");
    expect(converted?.properties).toHaveProperty("kind.enum", ["PDF", "DOCX"]);
    expect(converted?.required).toEqual(["version", "hash", "kind"]);
  });

  it("prunes keys the live Gemini API rejects, and keeps title", () => {
    // Zod v4 emits `additionalProperties: false` on every object and
    // `prefixItems` for tuples; the live endpoint 400s on both (verified
    // 2026-09-15). `title` is accepted (HTTP 200) and must survive.
    const schema = z
      .object({ name: z.string(), pair: z.tuple([z.string(), z.number()]) })
      .meta({ title: "Person" });
    const converted = toGeminiResponseSchema(schema);
    expect(converted).not.toBeNull();
    const json = JSON.stringify(converted);
    expect(json).not.toContain("additionalProperties");
    expect(json).not.toContain("prefixItems");
    expect(converted?.title).toBe("Person");
  });

  it("inlines reused object schemas instead of emitting $defs/$ref", () => {
    const inner = z.object({ flag: z.boolean() });
    const schema = z.object({
      a: inner,
      b: z.object({ nested: inner }),
    });
    const converted = toGeminiResponseSchema(schema);
    expect(converted).not.toBeNull();
    expect(JSON.stringify(converted)).not.toContain("$ref");
    expect(JSON.stringify(converted)).not.toContain("$defs");
  });
});