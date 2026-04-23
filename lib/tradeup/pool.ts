import type { Rarity, Skin, TradeupInput, OutputItem } from "../types";
import { RARITY_ORDER } from "../types";
import { SKINS as STATIC_SKINS } from "../catalog";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Get the output rarity for a given input rarity.
 * Returns null if the input is covert (max tier).
 */
export function getOutputRarity(inputRarity: Rarity): Rarity | null {
  const idx = RARITY_ORDER.indexOf(inputRarity);
  if (idx === -1 || idx === RARITY_ORDER.length - 1) return null;
  return RARITY_ORDER[idx + 1];
}

/**
 * Validate trade-up inputs.
 */
export function validateInputs(inputs: TradeupInput[], skins: Skin[] = STATIC_SKINS): ValidationResult {
  if (inputs.length !== 10) {
    return { valid: false, error: "Trade-ups require exactly 10 input items." };
  }

  const rarities = new Set(inputs.map((i) => {
    const skin = skins.find((s) => s.id === i.skinId);
    return skin?.rarity;
  }));

  if (rarities.has(undefined)) {
    return { valid: false, error: "One or more input items were not found in the catalog." };
  }

  if (rarities.size > 1) {
    return { valid: false, error: "All input items must be the same rarity." };
  }

  const [rarity] = rarities;
  if (rarity === "covert") {
    return { valid: false, error: "Covert items cannot be used as trade-up inputs." };
  }

  for (const input of inputs) {
    if (input.float < 0 || input.float > 1) {
      return { valid: false, error: `Float value ${input.float} is out of range [0, 1].` };
    }
  }

  return { valid: true };
}

/**
 * Calculate the output pool for a trade-up contract.
 *
 * Rules:
 * - Output rarity = input rarity + 1 tier
 * - Eligible outputs = all items of the output rarity across the collections
 *   represented by the input items
 * - Probability of each output = (count of inputs from that output item's
 *   collection) / 10
 */
export function calculateOutputPool(inputs: TradeupInput[], skins: Skin[] = STATIC_SKINS): OutputItem[] {
  const validation = validateInputs(inputs, skins);
  if (!validation.valid) return [];

  // Find the input rarity (all inputs have the same rarity)
  const firstSkin = skins.find((s) => s.id === inputs[0].skinId)!;
  const inputRarity = firstSkin.rarity;
  const outputRarity = getOutputRarity(inputRarity);
  if (!outputRarity) return [];

  // Count inputs per collection
  const inputCollectionCounts = new Map<string, number>();
  for (const input of inputs) {
    const skin = skins.find((s) => s.id === input.skinId);
    if (skin) {
      inputCollectionCounts.set(
        skin.collectionId,
        (inputCollectionCounts.get(skin.collectionId) ?? 0) + 1,
      );
    }
  }

  // Find all output-rarity items in the represented collections
  const outputSkins = skins.filter(
    (s) =>
      s.rarity === outputRarity &&
      inputCollectionCounts.has(s.collectionId),
  );

  if (outputSkins.length === 0) return [];

  // For each collection, spread the probability evenly across its output items
  const outputPool: OutputItem[] = [];
  for (const [collectionId, count] of inputCollectionCounts) {
    const collectionOutputSkins = outputSkins.filter(
      (s) => s.collectionId === collectionId,
    );
    if (collectionOutputSkins.length === 0) continue;

    const probPerItem = count / inputs.length / collectionOutputSkins.length;
    for (const skin of collectionOutputSkins) {
      const existing = outputPool.find((o) => o.skinId === skin.id);
      if (existing) {
        existing.probability += probPerItem;
      } else {
        outputPool.push({ skinId: skin.id, probability: probPerItem });
      }
    }
  }

  return outputPool;
}
