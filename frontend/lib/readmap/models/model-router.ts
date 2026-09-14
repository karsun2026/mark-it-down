/**
 * Model routing: which provider and which model id serve each agent role
 * (READMAP_MASTER_BUILD_SPEC §5; ADR-006 update of 2026-09-13 — Gemini only
 * for Phase 1; Perplexity excluded everywhere; Anthropic optional, not built).
 *
 * The router is the ONLY place provider selection lives, so agents never see a
 * provider name. Selection is honest:
 *
 * - `READMAP_MODEL_PROVIDER=gemini` (the default) requires `GEMINI_API_KEY`;
 *   without it the call fails with a config error rather than degrading.
 * - `dev` requires the labelled dev adapter's own gate (`APP_ENV=development`)
 *   and additionally only ever routes to it when explicitly configured.
 * - `anthropic` is a declared-but-unbuilt option: it refuses with a message
 *   that says so, instead of pretending (rule 15; ADR-006).
 */

import {
  ModelCallError,
  type StructuredModelClient,
} from "./client";
import { createDevClient, devAdapterAllowed } from "./dev-adapter";
import { createGeminiClient } from "./gemini";

export type ConfiguredProvider = "gemini" | "dev";

/**
 * Fallback model id when no READMAP_*_MODEL variable is set. Override per role
 * via `READMAP_EXTRACTION_MODEL`, `READMAP_VERIFICATION_MODEL`,
 * `READMAP_COMPRESSION_MODEL` (names staged in `.env.example`).
 */
export const DEFAULT_MODEL = "gemini-2.5-flash";

/** Map an agent role onto its configured model id. */
export function resolveModelForTask(task: string): string {
  const variable =
    task === "compression"
      ? "READMAP_COMPRESSION_MODEL"
      : task === "skeptic" || task === "numeric-check"
        ? "READMAP_VERIFICATION_MODEL"
        : // mapper and signal-extraction are extraction work.
          "READMAP_EXTRACTION_MODEL";
  return process.env[variable]?.trim() || DEFAULT_MODEL;
}

function resolveConfiguredProvider(): ConfiguredProvider {
  const provider = process.env.READMAP_MODEL_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "gemini") return "gemini";
  if (provider === "dev") return "dev";
  // Anthropic, Perplexity, or anything else: refuse loudly and honestly.
  throw new ModelCallError(
    "config",
    provider === "anthropic"
      ? "READMAP_MODEL_PROVIDER=anthropic is declared but the Anthropic adapter is not implemented in Phase 1 (ADR-006); use gemini or dev"
      : `READMAP_MODEL_PROVIDER=${provider} is not a supported provider`,
  );
}

/** Resolve the client that serves `task`, per the environment configuration. */
export function getClientForTask(task: string): StructuredModelClient {
  const provider = resolveConfiguredProvider();
  if (provider === "gemini") {
    return createGeminiClient({ modelForTask: () => resolveModelForTask(task) });
  }
  // provider === "dev": the adapter itself re-checks APP_ENV and refuses to
  // run outside development, so production can never reach it silently.
  if (!devAdapterAllowed()) {
    throw new ModelCallError(
      "config",
      "READMAP_MODEL_PROVIDER=dev requires APP_ENV=development (fail-closed, rule 15)",
    );
  }
  return createDevClient();
}