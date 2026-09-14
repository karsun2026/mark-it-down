/**
 * Provider-neutral structured-model client contract (READMAP_MASTER_BUILD_SPEC
 * §5 "Model routing"; ADR-006 in docs/readmap/ARCHITECTURE_DECISIONS.md).
 *
 * The spec pins this interface shape. Agents depend only on what is exported
 * here — never on a provider-specific type — so swapping or adding a provider
 * cannot spread provider code through the application (spec §5: "Configuration
 * must permit different models for extraction, verification, vision, and
 * compression without spreading provider-specific code").
 *
 * Contracts enforced by every adapter:
 *
 * - Output is ALWAYS validated against the caller's Zod schema before it is
 *   returned. Invalid output gets exactly one schema-repair attempt (spec §10);
 *   repeated failure ends the unit of work with a `ModelCallError` of kind
 *   "schema" — the agent layer records it, it is never retried silently.
 * - Nothing about the request or response text is ever logged here (rule 16).
 *   Log lines belong to the route/orchestration layer and carry ids and
 *   counters only.
 * - Failures are explicit. No adapter may fall back to mock behaviour outside
 *   an explicitly labelled development mode (rule 15).
 */

import type { ZodType } from "zod";

/** The agent roles that consume model calls. Numeric checking lands in Phase 3. */
export const AGENT_TASKS = [
  "mapper",
  "signal-extraction",
  "skeptic",
  "numeric-check",
  "compression",
] as const;
export type AgentTask = (typeof AGENT_TASKS)[number];

/** A single turn of the conversation sent to the model. */
export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
}

/** Token accounting, in provider-reported units. Used for the cost ledger. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Providers with an implemented adapter. Anthropic is planned, not built. */
export type ModelProvider = "gemini" | "dev";

/**
 * The successful result of one structured model call.
 *
 * `value` is schema-validated output — the only field agents may treat as
 * model-derived content. Everything else is bookkeeping.
 */
export interface ModelResult<T> {
  task: AgentTask;
  provider: ModelProvider;
  /** Model id actually used, e.g. `gemini-2.5-flash` or `dev-fixture`. */
  model: string;
  idempotencyKey: string;
  value: T;
  usage: ModelUsage;
  /** How many schema-repair attempts were needed (0 or 1; spec §10). */
  repairAttempts: number;
}

/**
 * Why a model call failed. The message is shape-only: it must never contain
 * prompt text, evidence text, or the API key (rule 16), so callers can log it.
 */
export type ModelCallErrorKind = "config" | "provider" | "schema";

export class ModelCallError extends Error {
  readonly kind: ModelCallErrorKind;
  /** HTTP status of the provider response, when the failure was a provider call. */
  readonly status?: number;

  constructor(kind: ModelCallErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ModelCallError";
    this.kind = kind;
    this.status = status;
  }
}

/** Input to `StructuredModelClient.generate` — spec §5, verbatim shape. */
export interface ModelGenerateInput<T> {
  task: AgentTask;
  system: string;
  messages: readonly ModelMessage[];
  schema: ZodType<T>;
  temperature?: number;
  maxOutputTokens?: number;
  idempotencyKey: string;
}

/**
 * The one interface every adapter implements, and the only model surface the
 * agents see. Adapters MUST validate `value` against `input.schema`.
 */
export interface StructuredModelClient {
  generate<T>(input: ModelGenerateInput<T>): Promise<ModelResult<T>>;
}