/**
 * Test support for agent tests: a scripted `StructuredModelClient` that
 * validates its scripted response through the SAME schema the agent supplied.
 * This keeps agent tests offline while still exercising the real validation
 * path (no live model call, zero tokens).
 */

import {
  ModelCallError,
  type AgentTask,
  type ModelGenerateInput,
  type ModelResult,
  type StructuredModelClient,
} from "../models/client";

export interface ScriptedCall<T = unknown> {
  task: AgentTask;
  system: string;
  messageText: string;
  input: ModelGenerateInput<T>;
}

/** A client that returns `response` for the first call, validating it. */
export function scriptedClient<T>(
  response: T,
): { client: StructuredModelClient; calls: ScriptedCall<T>[] } {
  const calls: ScriptedCall<T>[] = [];
  const client: StructuredModelClient = {
    async generate<U>(input: ModelGenerateInput<U>): Promise<ModelResult<U>> {
      calls.push({
        task: input.task,
        system: input.system,
        messageText: input.messages[0]?.text ?? "",
        // Cast is safe for tests: each scripted client serves one schema.
        input: input as unknown as ModelGenerateInput<T>,
      });
      const parsed = input.schema.safeParse(response);
      if (!parsed.success) {
        throw new ModelCallError(
          "schema",
          `scripted response failed the agent's schema validation (task=${input.task})`,
        );
      }
      return {
        task: input.task,
        provider: "dev",
        model: "dev-fixture",
        idempotencyKey: input.idempotencyKey,
        value: parsed.data,
        usage: { inputTokens: 1, outputTokens: 1 },
        repairAttempts: 0,
      };
    },
  };
  return { client, calls: calls as ScriptedCall<T>[] };
}