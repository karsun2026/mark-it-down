/**
 * Claim parsing for the grounding gate (spec §11).
 *
 * The gate needs to iterate every factual entry in a READMAP and know exactly
 * where it lives (field + index) so failures can be located, repaired by
 * omission, and reported. This module is that iteration — pure and
 * deterministic.
 */

import type { OutputClaim, ReadMapV1 } from "../schemas/readmap";

/** A factual claim with its address inside the READMAP result. */
export interface LocatedClaim {
  location: string;
  claim: OutputClaim;
}

/**
 * All factual claim fields, in gate order. `interpretation` is deliberately
 * NOT here — it is a separate output kind and gated separately (spec §11.6).
 */
export const FACTUAL_CLAIM_FIELDS = [
  "thePoint",
  "rememberThese",
  "numbersWorthRemembering",
  "caution",
] as const;

/** Flatten every factual claim of a READMAP into located entries. */
export function locatedFactualClaims(readmap: ReadMapV1): LocatedClaim[] {
  const located: LocatedClaim[] = [];
  located.push({ location: "thePoint", claim: readmap.thePoint });
  readmap.rememberThese.forEach((claim, index) =>
    located.push({ location: `rememberThese[${index}]`, claim }),
  );
  readmap.numbersWorthRemembering.forEach((number, index) =>
    located.push({
      location: `numbersWorthRemembering[${index}]`,
      claim: {
        text: number.text,
        signalIds: number.signalIds,
        kind: "VERIFIED" as const,
      },
    }),
  );
  readmap.caution.forEach((claim, index) =>
    located.push({ location: `caution[${index}]`, claim }),
  );
  return located;
}

/** Claims rendered from compression tiers (each tier entry cites one signal). */
export function locatedTierClaims(
  readmap: ReadMapV1,
  tiers: { tiers: Record<string, { signalId: string; text: string }[]> },
  tierNames: readonly string[],
): LocatedClaim[] {
  const located: LocatedClaim[] = [];
  for (const tierName of tierNames) {
    tiers.tiers[tierName as keyof typeof tiers.tiers]?.forEach((entry, index) =>
      located.push({
        location: `tiers.${tierName}[${index}]`,
        claim: { text: entry.text, signalIds: [entry.signalId], kind: "VERIFIED" as const },
      }),
    );
  }
  return located;
}