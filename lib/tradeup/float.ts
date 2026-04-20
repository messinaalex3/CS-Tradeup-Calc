import type { Wear } from "../types";
import { WEAR_FLOAT_RANGES as RANGES } from "../types";

/**
 * Determine the CS2 wear tier from a float value.
 */
export function floatToWear(float: number): Wear {
  if (float < RANGES.FN[1]) return "FN";
  if (float < RANGES.MW[1]) return "MW";
  if (float < RANGES.FT[1]) return "FT";
  if (float < RANGES.WW[1]) return "WW";
  return "BS";
}

/**
 * Compute the normalized float average of the inputs.
 * Each float is normalized relative to its skin's float range.
 *
 * normalizedAvg = average((float - skinMin) / (skinMax - skinMin))
 */
export function averageNormalizedFloats(
  floats: number[],
  minFloats: number[],
  maxFloats: number[],
): number {
  if (floats.length === 0) return 0;

  const normalized = floats.map((f, i) => {
    const range = maxFloats[i] - minFloats[i];
    if (range === 0) return 0;
    return (f - minFloats[i]) / range;
  });

  return normalized.reduce((a, b) => a + b, 0) / normalized.length;
}

/**
 * Compute the output float value.
 *
 * outputFloat = outputMin + normalizedAvg * (outputMax - outputMin)
 */
export function computeOutputFloat(
  normalizedAvg: number,
  outputMin: number,
  outputMax: number,
): number {
  const raw = outputMin + normalizedAvg * (outputMax - outputMin);
  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, raw));
}
