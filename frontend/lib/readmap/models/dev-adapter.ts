/**
 * Labelled development adapter (rule 15; ADR-006).
 *
 * This adapter never calls a model. It returns ONLY responses that were
 * explicitly registered under an idempotency key — fixtures written by the
 * developer or the test that needs them. If no response is registered for a
 * key, it fails closed rather than inventing output, because a placeholder
 * that fabricates plausible-looking analysis is precisely the "silent mock"
 * the rules forbid.
 *
 * It is enabled only by BOTH:
 *
 *   READMAP_MODEL_PROVIDER=dev   AND   APP_ENV=development
 *
 * and it re-checks that gate on every call, so it can never run in a
 * production deployment even if the router were misconfigured. Every result it
 * returns is labelled `provider: "dev"` and `model: "dev-fixture"` so no
 * fixture output can be mistaken for real model output downstream.
 */

import {
  ModelCallError,
  type AgentTask,
  type ModelGenerateInput,
  type ModelResult,
  type StructuredModelClient,
} from "./client";

export type DevResponseResolver = (
  idempotencyKey: string,
  task: AgentTask,
) => unknown;

/** Shared registry so routes/tests can stage fixture responses in one place. */
const registry = new Map<string, unknown>();

export function registerDevResponse(idempotencyKey: string, value: unknown): void {
  registry.set(idempotencyKey, value);
}

export function clearDevResponses(): void {
  registry.clear();
}

/**
 * The double gate from ADR-006. Both conditions are checked at call time, not
 * import time, so environment changes are always honoured.
 */
export function devAdapterAllowed(): boolean {
  return (
    process.env.READMAP_MODEL_PROVIDER?.trim().toLowerCase() === "dev" &&
    process.env.APP_ENV === "development"
  );
}

export function createDevClient(
  options: { resolve?: DevResponseResolver } = {},
): StructuredModelClient {
  const resolve = options.resolve ?? ((key) => registry.get(key));

  return {
    async generate<T>(input: ModelGenerateInput<T>): Promise<ModelResult<T>> {
      if (!devAdapterAllowed()) {
        throw new ModelCallError(
          "config",
          "dev model adapter refused: requires READMAP_MODEL_PROVIDER=dev AND APP_ENV=development",
        );
      }

      const registered = resolve(input.idempotencyKey, input.task);
      if (registered === undefined) {
        // Fail closed. The dev adapter must never produce content nobody wrote.
        throw new ModelCallError(
          "config",
          `dev model adapter has no registered response for idempotencyKey=${input.idempotencyKey}`,
        );
      }

      const candidate =
        typeof registered === "string" ? JSON.parse(registered) : registered;
      const parsed = input.schema.safeParse(candidate);
      if (!parsed.success) {
        // A bad fixture is a developer error; surface it, never repair it.
        throw new ModelCallError(
          "schema",
          `dev fixture for idempotencyKey=${input.idempotencyKey} failed schema validation (task=${input.task})`,
        );
      }

      return {
        task: input.task,
        provider: "dev",
        model: "dev-fixture",
        idempotencyKey: input.idempotencyKey,
        value: parsed.data,
        usage: { inputTokens: 0, outputTokens: 0 },
        repairAttempts: 0,
      };
    },
  };
}