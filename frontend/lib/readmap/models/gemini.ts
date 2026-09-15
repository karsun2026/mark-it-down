/**
 * Gemini adapter over plain `fetch` (ADR-006: no provider SDK — the dependency
 * surface stays minimal and `--ignore-scripts`-safe).
 *
 * Design points that matter:
 *
 * - Structured output is requested with `responseMimeType: "application/json"`
 *   plus a `responseSchema` pruned to the subset Gemini actually supports
 *   (lowercase JSON-Schema types, null via type arrays; see
 *   https://ai.google.dev/gemini-api/docs/structured-output). The Zod schema
 *   remains the authority: whatever Gemini returns is validated against it,
 *   and one repair attempt is made on failure (spec §10) before the unit fails.
 * - NOTHING is logged here. Not the prompt, not the response, not the key
 *   (rule 16). Errors carry shape only: an HTTP status and a stable message.
 * - Per-role model ids are resolved by the caller-supplied `modelForTask`
 *   (wired from `READMAP_*_MODEL` by `model-router.ts`), so provider code never
 *   spreads into agent code.
 */

import { z, type ZodType } from "zod";

import {
  ModelCallError,
  type ModelGenerateInput,
  type ModelResult,
  type ModelUsage,
  type StructuredModelClient,
} from "./client";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 120_000;

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export interface GeminiClientOptions {
  apiKey?: string;
  /** Override only in tests. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-role model id resolver (defaults to the extraction-model variable). */
  modelForTask?: (task: ModelGenerateInput<never>["task"]) => string;
}

function defaultModelForTask(): string {
  return process.env.READMAP_EXTRACTION_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

// ---------------------------------------------------------------------------
// Zod JSON-Schema -> Gemini responseSchema conversion
// ---------------------------------------------------------------------------

/**
 * Keys Gemini's structured-output subset supports. Everything else is pruned
 * rather than sent, because unsupported keywords risk a whole-request
 * rejection, and the Zod schema re-validates the response anyway.
 */
// `additionalProperties` and `prefixItems` are intentionally absent: the live
// Gemini structured-output endpoint rejects both with HTTP 400 ("Unknown name
// ... Cannot find field"), and Zod v4 emits `additionalProperties: false` on
// every object, so keeping it would 400 every request (verified 2026-09-15).
// `title` IS accepted by Gemini and is kept.
const GEMINI_SCHEMA_KEYS = [
  "type",
  "format",
  "description",
  "title",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "properties",
  "required",
] as const;

function pruneForGemini(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pruneForGemini);
  if (node === null || typeof node !== "object") return node;

  const source = node as Record<string, unknown>;
  // `reused: "inline"` should prevent these; if one appears, refusing is safer
  // than sending a schema Gemini cannot interpret. Callers fall back to
  // mime-type-only mode below.
  if ("$ref" in source || "$defs" in source) {
    throw new Error("unresolved schema reference");
  }

  const pruned: Record<string, unknown> = {};
  for (const key of GEMINI_SCHEMA_KEYS) {
    if (!(key in source)) continue;
    // `properties` is a NAME -> schema map, not a schema itself: prune each
    // value while keeping the property names intact.
    if (key === "properties" && source.properties !== null && typeof source.properties === "object" && !Array.isArray(source.properties)) {
      const entries: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(source.properties as Record<string, unknown>)) {
        entries[name] = pruneForGemini(value);
      }
      pruned.properties = entries;
      continue;
    }
    pruned[key] = pruneForGemini(source[key]);
  }
  // JSON-Schema `const` -> Gemini-supported `enum` with one value.
  if ("const" in source && !("enum" in pruned)) {
    pruned.enum = [source["const"]];
  }
  // Fill the structural types Gemini expects.
  if ("properties" in pruned && !("type" in pruned)) {
    pruned.type = "object";
  }
  if ("items" in pruned && !("type" in pruned)) {
    pruned.type = "array";
  }
  return pruned;
}

/**
 * Best-effort Gemini `responseSchema` for a Zod schema, or null when the
 * schema cannot be represented — in which case the request still asks for
 * JSON (`responseMimeType`) and relies on Zod validation plus the one
 * permitted repair attempt. Deterministic, pure, and unit-tested.
 */
export function toGeminiResponseSchema(
  schema: ZodType<unknown>,
): Record<string, unknown> | null {
  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(schema, {
      io: "output",
      reused: "inline",
      unrepresentable: "any",
    });
    return pruneForGemini(jsonSchema) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wire types (request/response shapes actually used)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}
interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
}
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}
interface GeminiGenerateResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  usageMetadata?: GeminiUsageMetadata;
  error?: { status?: string };
}

function contentsFor(messages: ModelGenerateInput<never>["messages"]): GeminiContent[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.text }],
  }));
}

/**
 * Parse model text without letting a raw SyntaxError escape: a non-JSON
 * response is a validation failure that feeds the repair attempt, not a crash.
 */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createGeminiClient(
  options: GeminiClientOptions = {},
): StructuredModelClient {
  const apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    // Fail closed: a missing key is a deployment fault, not an empty result.
    throw new ModelCallError("config", "GEMINI_API_KEY is not configured");
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch.bind(globalThis);
  const modelForTask = options.modelForTask ?? defaultModelForTask;

  async function callOnce(
    model: string,
    request: GeminiGenerateRequest,
  ): Promise<{ text: string; usage: ModelUsage }> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Key goes in a header, never in the URL or a log line.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Shape only: a timeout/abort or network fault, without the URL.
      throw new ModelCallError(
        "provider",
        "gemini request failed before a response arrived",
      );
    }

    if (!response.ok) {
      // Log-safe shape only; never echo the provider message body.
      let statusName = "";
      try {
        const body = (await response.json()) as GeminiGenerateResponse;
        statusName = body.error?.status ?? "";
      } catch {
        // A non-JSON error body is fine; the HTTP status still tells the story.
      }
      throw new ModelCallError(
        "provider",
        `gemini request failed with HTTP ${response.status}${statusName ? ` (${statusName})` : ""}`,
        response.status,
      );
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason ?? "STOP";
    if (finishReason !== "STOP") {
      // Truncated or safety-blocked output is a provider failure, never a
      // validated result — even if the text happens to parse.
      throw new ModelCallError(
        "provider",
        `gemini did not finish (finishReason=${finishReason})`,
      );
    }
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
    if (text.trim().length === 0) {
      throw new ModelCallError("provider", "gemini returned an empty response");
    }
    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  return {
    async generate<T>(input: ModelGenerateInput<T>): Promise<ModelResult<T>> {
      const model = modelForTask(input.task);
      const responseSchema = toGeminiResponseSchema(input.schema);
      const baseRequest: GeminiGenerateRequest = {
        contents: contentsFor(input.messages),
        systemInstruction: { parts: [{ text: input.system }] },
        generationConfig: {
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
          ...(input.maxOutputTokens !== undefined
            ? { maxOutputTokens: input.maxOutputTokens }
            : {}),
          responseMimeType: "application/json",
          ...(responseSchema ? { responseSchema } : {}),
        },
      };

      // A built-but-unsupported responseSchema is rejected by Gemini with an
      // HTTP 400 (e.g. a JSON-Schema keyword outside Gemini's subset). Rather
      // than fail the unit, retry once in mime-type-only mode; the Zod schema
      // still validates the output and the one repair attempt still applies.
      let first: { text: string; usage: ModelUsage };
      try {
        first = await callOnce(model, baseRequest);
      } catch (error) {
        if (
          error instanceof ModelCallError &&
          error.status === 400 &&
          baseRequest.generationConfig?.responseSchema
        ) {
          const { responseSchema: _dropped, ...configWithoutSchema } =
            baseRequest.generationConfig;
          first = await callOnce(model, {
            ...baseRequest,
            generationConfig: configWithoutSchema,
          });
        } else {
          throw error;
        }
      }
      const firstJson = tryParseJson(first.text);
      let attempt = firstJson.ok
        ? input.schema.safeParse(firstJson.value)
        : ({ success: false, error: undefined } as const);
      if (attempt.success) {
        return {
          task: input.task,
          provider: "gemini",
          model,
          idempotencyKey: input.idempotencyKey,
          value: attempt.data,
          usage: first.usage,
          repairAttempts: 0,
        };
      }

      // Spec §10: exactly one schema-repair attempt. The repair conversation
      // includes the invalid output as a model turn — content the model
      // already produced, never new evidence.
      const issueSummary = attempt.error
        ? z.prettifyError(attempt.error)
        : "the response was not valid JSON";
      const repairRequest: GeminiGenerateRequest = {
        ...baseRequest,
        contents: [
          ...baseRequest.contents,
          { role: "model", parts: [{ text: first.text }] },
          {
            role: "user",
            parts: [
              {
                text:
                  "Your previous response did not satisfy the required JSON schema. " +
                  `Validation issue: ${issueSummary}\n` +
                  "Respond again with corrected JSON only, matching the schema exactly. " +
                  "Do not add or remove information while repairing.",
              },
            ],
          },
        ],
      };
      const second = await callOnce(model, repairRequest);
      const secondJson = tryParseJson(second.text);
      attempt = secondJson.ok
        ? input.schema.safeParse(secondJson.value)
        : ({ success: false, error: undefined } as const);
      if (!attempt.success) {
        throw new ModelCallError(
          "schema",
          `gemini output did not match the required schema after one repair attempt (task=${input.task})`,
        );
      }
      return {
        task: input.task,
        provider: "gemini",
        model,
        idempotencyKey: input.idempotencyKey,
        value: attempt.data,
        usage: {
          inputTokens: first.usage.inputTokens + second.usage.inputTokens,
          outputTokens: first.usage.outputTokens + second.usage.outputTokens,
        },
        repairAttempts: 1,
      };
    },
  };
}