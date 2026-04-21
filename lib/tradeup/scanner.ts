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
  "classified",
  "restricted",
  "mil_spec",
  "industrial_grade",
];

/** Minimum ROI to consider a trade-up profitable (1.0 = break even, 1.05 = 5% profit). */
export const MIN_ROI = 1.0;

/** Utility to generate a unique key for a contract based on its inputs. */
export function getContractKey(inputs: TradeupInput[]): string {
  return [...inputs]
    .sort((a, b) => a.skinId.localeCompare(b.skinId) || a.float - b.float)
    .map((i) => `${i.skinId}:${i.float.toFixed(4)}`)
    .join("|");
}

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
 * @param onUpdate    Optional callback for incremental KV updates.
 * @param rarities    Subset of rarities to scan (defaults to SCANNABLE_RARITIES).
 */
export async function computeProfitableContracts(
  priceGetter: (skinId: string, wear: Wear) => Promise<number | null>,
  onUpdate?: (contracts: ProfitableContract[]) => Promise<void>,
  rarities: Rarity[] = SCANNABLE_RARITIES,
): Promise<ProfitableContract[]> {
  const scanStart = Date.now();
  console.log(
    `[scanner] Starting scan — rarities: [${rarities.join(", ")}]`,
  );

  const allProfitable: ProfitableContract[] = [];

  for (const rarity of rarities) {
    const candidates = generateCandidates(rarity);
    console.log(
      `[scanner] Rarity "${rarity}": ${candidates.length} candidate(s) to evaluate`,
    );

    let evaluated = 0;
    let skippedNoPool = 0;
    let skippedInvalid = 0;
    let skippedROI = 0;
    let profitable = 0;
    const rarityStart = Date.now();

    // Process candidates in chunks of 5 to parallelize API requests (prices)
    // while keeping the logs readable and not overwhelming the runtime.
    const CHUNK_SIZE = 10;
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);

      const results = await Promise.all(chunk.map(async (inputs) => {
        const outputPool = calculateOutputPool(inputs);
        if (outputPool.length === 0) return { type: "no-pool" as const };

        const result = await evaluateTradeup(inputs, priceGetter);
        if (!result.valid || result.totalCost === 0) return { type: "invalid" as const };
        if (result.roi < MIN_ROI) return { type: "below-roi" as const };

        return { type: "profitable" as const, result, inputs };
      }));

      for (const res of results) {
        evaluated++;

        // Heartbeat logging every 10 candidates
        if (evaluated % 10 === 0) {
          console.log(
            `[scanner]   ...processed ${evaluated}/${candidates.length} candidates for "${rarity}" ` +
            `(${profitable} profitable so far, elapsed ${Date.now() - rarityStart}ms)`,
          );
        }

        if (res.type === "no-pool") {
          skippedNoPool++;
          continue;
        }
        if (res.type === "invalid") {
          skippedInvalid++;
          continue;
        }
        if (res.type === "below-roi") {
          skippedROI++;
          continue;
        }

        const { result, inputs } = res;
        profitable++;
        console.log(
          `[scanner]   *** (${rarity}) Profitable contract found! — ` +
          `ROI=${((result.roi - 1) * 100).toFixed(1)}% EV=$${result.ev.toFixed(2)} cost=$${result.totalCost.toFixed(2)} ` +
          `inputs: ${inputs.map((i) => i.skinId).join(", ")}`,
        );

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

        const contract: ProfitableContract = {
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
        };

        allProfitable.push(contract);
      }

      // Periodically update cache if we found new contracts
      if (onUpdate && i % (CHUNK_SIZE * 2) === 0) {
        await onUpdate([...allProfitable].sort((a, b) => b.roi - a.roi));
      }
    }

    console.log(
      `[scanner] Rarity "${rarity}" done in ${Date.now() - rarityStart}ms — ` +
      `${evaluated} evaluated, ${profitable} profitable ` +
      `(skipped: ${skippedNoPool} no-pool, ${skippedInvalid} invalid, ${skippedROI} below min ROI)`,
    );

    // Final update for this rarity
    if (onUpdate) {
      await onUpdate([...allProfitable].sort((a, b) => b.roi - a.roi));
    }
  }

  allProfitable.sort((a, b) => b.roi - a.roi);
  console.log(
    `[scanner] Scan complete in ${Date.now() - scanStart}ms — ` +
    `${allProfitable.length} profitable contract(s) total`,
  );
  return allProfitable;
}
