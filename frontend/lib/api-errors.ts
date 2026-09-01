/**
 * Server-side error helpers (§45, §46, §47).
 *
 * Routes never return a stack trace or an internal message. They return a
 * stable code and reader-facing text, and log only the shape of the failure.
 *
 * The text and status tables live in `messages.ts` so the browser can reuse
 * them without pulling in `next/server`.
 */

import { NextResponse } from "next/server";

import { ERROR_MESSAGES, ERROR_STATUS, messageForCode } from "./messages";
import type { ErrorCode } from "./types";

export { messageForCode };

/** Build the §46 error response. `internalDetail` is logged, never returned. */
export function errorResponse(
  code: ErrorCode,
  internalDetail?: string,
): NextResponse {
  if (internalDetail) {
    // Shape only. Never document content, filenames, URLs or tokens (§47).
    console.info(`request failed code=${code} detail=${internalDetail}`);
  }
  return NextResponse.json(
    { code, message: ERROR_MESSAGES[code] },
    { status: ERROR_STATUS[code] },
  );
}
