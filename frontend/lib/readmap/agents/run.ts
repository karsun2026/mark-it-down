/**
 * The result envelope every agent returns: the validated model result plus
 * the prompt version that produced it (prompts are versioned per spec §24;
 * the pipeline records the pairing for idempotency and evaluation).
 */

import type { ModelResult } from "../models/client";

export interface AgentRun<T> {
  result: ModelResult<T>;
  promptVersion: string;
}