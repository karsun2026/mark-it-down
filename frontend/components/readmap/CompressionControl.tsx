"use client";

/**
 * Reading-depth control (spec §1).
 *
 * Moving the slider changes ONLY client state: every tier is precomputed, so
 * a depth change must never trigger a model call or a network request
 * (plan acceptance check 11). Presets are listed shortest first so the
 * control reads as "less time → more time".
 */

import { COMPRESSION_TIERS, type CompressionPreset } from "@/lib/readmap/schemas/signal";

const PRESET_LABEL: Record<CompressionPreset, string> = {
  ONE_THING: "One thing · 5s",
  BRUTAL: "Brutal · 10s",
  QUICK_SCAN: "Quick scan · 30s",
  BRIEF: "Brief · 2 min",
  READMAP: "ReadMap · 5 min",
  DEEP_DIVE: "Deep dive · 10 min",
};

interface CompressionControlProps {
  preset: CompressionPreset;
  onChange: (preset: CompressionPreset) => void;
}

export function CompressionControl({ preset, onChange }: CompressionControlProps) {
  const index = COMPRESSION_TIERS.indexOf(preset);
  return (
    <section className="compression-control">
      <label className="muted" htmlFor="readmap-depth">
        Reading depth
      </label>
      <input
        id="readmap-depth"
        type="range"
        min={0}
        max={COMPRESSION_TIERS.length - 1}
        step={1}
        value={index}
        onChange={(event) => {
          const next = COMPRESSION_TIERS[Number(event.target.value)];
          if (next) onChange(next);
        }}
      />
      <span className="depth-label">{PRESET_LABEL[preset]}</span>
    </section>
  );
}