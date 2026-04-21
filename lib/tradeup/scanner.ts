import type { Rarity, TradeupInput, Wear } from "../types";
import { SKINS } from "../catalog";
import { evaluateTradeup } from "./ev";
import { calculateOutputPool } from "./pool";
import { floatToWear } from "./float";

/**
 * A fully-evaluated, profitable trade-up contract ready to be returned to a
 * client or stored in the KV cache.
 */
export interface ProfitableContract {
  inputs: Array<{
    skinId: string;
    skinName: string;
    float: number;
    wear: Wear;
    price: number | null;
  }>;
  outputs: Array<{
    skinId: string;
    skinName: string;
    probability: number;
    wear: Wear;
    estimatedPrice: number | null;
  }>;
  rarity: Rarity;
  totalCost: number;
  ev: number;
  roi: number;
  guaranteedProfit: boolean;
  chanceToProfit: number;
}

/** Shape stored in / returned from TRADEUP_CACHE KV. */
export interface TradeupCachePayload {
  contracts: ProfitableContract[];
  cachedAt: string;
}

/** Rarities eligible for trade-up scanning (excludes consumer_grade and covert). */
export const SCANNABLE_RARITIES: Rarity[] = [
  "industrial_grade",
  "mil_spec",
  "restricted",
  "classified",
];

/** Minimum ROI (%) to consider a trade-up profitable. */
export const MIN_ROI = 0;

/**
 * Generate a list of candidate trade-up contracts for a given rarity.
 *
 * Strategy 1 – 10× the same skin at a mid-range float (0.20, Field-Tested).
 * Strategy 2 – 5 + 5 split across two skins from different collections.
 *
 * This gives a deterministic, fast-to-compute set of candidates.
 * A real scanner would be more exhaustive.
 */
export function generateCandidates(rarity: Rarity): TradeupInput[][] {
  const skinsOfRarity = SKINS.filter((s) => s.rarity === rarity);
  const candidates: TradeupInput[][] = [];

  // Strategy 1: 10× the same item at a mid-range float (0.20 = FT)
  const targetFloat = 0.20;
  for (const skin of skinsOfRarity) {
    const midFloat = Math.max(
      skin.minFloat,
      Math.min(skin.maxFloat, targetFloat),
    );
    candidates.push(
      Array.from({ length: 10 }, () => ({ skinId: skin.id, float: midFloat })),
    );
  }

  // Strategy 2: Mix two skins from different collections (5 + 5) at FT float
  const collectionGroups = new Map<string, typeof skinsOfRarity>();
  for (const skin of skinsOfRarity) {
    const group = collectionGroups.get(skin.collectionId) ?? [];
    group.push(skin);
    collectionGroups.set(skin.collectionId, group);
  }
  const groups = [...collectionGroups.values()];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const skinA = groups[i][0];
      const skinB = groups[j][0];
      const floatA = Math.max(skinA.minFloat, Math.min(skinA.maxFloat, 0.20));
      const floatB = Math.max(skinB.minFloat, Math.min(skinB.maxFloat, 0.20));
      candidates.push([
        ...Array.from({ length: 5 }, () => ({ skinId: skinA.id, float: floatA })),
        ...Array.from({ length: 5 }, () => ({ skinId: skinB.id, float: floatB })),
      ]);
    }
  }

  return candidates;
}

/**
 * Scan all scannable rarities and return every profitable contract found.
 *
 * @param priceGetter Async function that resolves a price for a skin+wear combo.
 * @param rarities    Subset of rarities to scan (defaults to SCANNABLE_RARITIES).
 */
export async function computeProfitableContracts(
  priceGetter: (skinId: string, wear: Wear) => Promise<number | null>,
  rarities: Rarity[] = SCANNABLE_RARITIES,
): Promise<ProfitableContract[]> {
  const allProfitable: ProfitableContract[] = [];

  for (const rarity of rarities) {
    const candidates = generateCandidates(rarity);

    for (const inputs of candidates) {
      const outputPool = calculateOutputPool(inputs);
      if (outputPool.length === 0) continue;

      const result = await evaluateTradeup(inputs, priceGetter);
      if (!result.valid || result.totalCost === 0) continue;
      if (result.roi < MIN_ROI) continue;

      const contractInputs = inputs.map((inp) => {
        const skin = SKINS.find((s) => s.id === inp.skinId);
        const wear = floatToWear(inp.float);
        return {
          skinId: inp.skinId,
          skinName: skin?.name ?? inp.skinId,
          float: inp.float,
          wear,
          price: null,
        };
      });

      allProfitable.push({
        inputs: contractInputs,
        outputs: result.outputs.map((o) => ({
          skinId: o.skinId,
          skinName: o.skinName,
          probability: o.probability,
          wear: o.wear,
          estimatedPrice: o.estimatedPrice,
        })),
        rarity,
        totalCost: result.totalCost,
        ev: result.ev,
        roi: result.roi,
        guaranteedProfit: result.guaranteedProfit,
        chanceToProfit: result.chanceToProfit,
      });
    }
  }

  allProfitable.sort((a, b) => b.roi - a.roi);
  return allProfitable;
}
