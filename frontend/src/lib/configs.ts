/**
 * Sandbox config helpers shared by the editor and the upload page (§8).
 *
 * Kept out of the component file so React Fast Refresh sees that module as
 * components-only. Bounds mirror `app/models.py` — the client validates for
 * instant feedback, but the server stays the source of truth.
 */

import type { ConfigSpec } from "../types";

export const MIN_CHUNK_SIZE = 100;
export const MAX_CHUNK_SIZE = 2000;
export const MIN_TOP_K = 1;
export const MAX_TOP_K = 20;

/** A stable identity for a config, used to detect duplicates. */
export function keyOf(config: ConfigSpec): string {
  return `${config.chunk_size}/${config.strategy}/${config.top_k}`;
}

/** Indices of configs whose (size, strategy, top-k) collides with another. */
export function duplicateIndices(configs: ConfigSpec[]): Set<number> {
  const seen = new Map<string, number>();
  const dupes = new Set<number>();
  configs.forEach((config, index) => {
    const key = keyOf(config);
    const first = seen.get(key);
    if (first !== undefined) {
      dupes.add(first);
      dupes.add(index);
    } else {
      seen.set(key, index);
    }
  });
  return dupes;
}

/** Whether a config set has any duplicate — callers block the run if so. */
export function hasDuplicateConfigs(configs: ConfigSpec[]): boolean {
  return duplicateIndices(configs).size > 0;
}

/** Clamp a number into an inclusive range, rounding; NaN falls back to the min. */
export function clampConfigValue(
  value: number,
  min: number,
  max: number,
): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
