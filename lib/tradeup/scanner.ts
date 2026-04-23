import type { Rarity, Skin, TradeupInput, Wear } from "../types";
import { WEAR_FLOAT_RANGES } from "../types";
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
  "restricted",
  "mil_spec",
  "industrial_grade",
  "classified",
];

/** Minimum ROI to consider a trade-up profitable (1.0 = break even, 1.05 = 5% profit). */
export const MIN_ROI = 1.0;

function clampToSkinRange(value: number, minFloat: number, maxFloat: number): number {
  return Math.max(minFloat, Math.min(maxFloat, value));
}

function pickRepresentativeSkins(skins: Skin[], maxCount: number): Skin[] {
  if (skins.length <= maxCount) return skins;

  const reps: Skin[] = [];
  const seen = new Set<string>();
  const lastIndex = skins.length - 1;

  for (let i = 0; i < maxCount; i++) {
    const ratio = maxCount === 1 ? 0 : i / (maxCount - 1);
    const idx = Math.round(ratio * lastIndex);
    const skin = skins[idx];
    if (seen.has(skin.id)) continue;
    seen.add(skin.id);
    reps.push(skin);
  }

  if (reps.length < maxCount) {
    for (const skin of skins) {
      if (seen.has(skin.id)) continue;
      seen.add(skin.id);
      reps.push(skin);
      if (reps.length >= maxCount) break;
    }
  }

  return reps;
}

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
 * It generates candidates for multiple target wears (FN, MW, FT) to find
 * profitable contracts across different price points.
 *
 * Strategy 1 – 10× the same skin at a mid-range float for the target wear.
 * Strategy 2 – 5 + 5 split across two skins from different collections.
 * Strategy 3 – 1 Target + 9 Cheap Fillers (High ROI gamble).
 */
export function generateCandidates(rarity: Rarity): TradeupInput[][] {
  const skinsOfRarity = SKINS.filter((s) => s.rarity === rarity);
  const candidates: TradeupInput[][] = [];
  const seen = new Set<string>();
  const MAX_COLLECTION_REPRESENTATIVES = 3;
  const MAX_PAIR_MIX_CANDIDATES = 240;
  const MAX_TRIPLE_MIX_CANDIDATES = 200;

  const addCandidate = (inputs: TradeupInput[]) => {
    const key = getContractKey(inputs);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(inputs);
  };

  // Identify "fillers" for Strategy 3: any skin of this rarity
  // (In a real scan, we'd pick the absolute cheapest from the price DB,
  // but for candidate generation we'll pick a few common ones)
  const fillerCandidates = skinsOfRarity.slice(0, 8);
  const strategySkins = skinsOfRarity.slice(0, Math.min(12, skinsOfRarity.length));
  const skinsByCollection = new Map<string, Skin[]>();
  for (const skin of skinsOfRarity) {
    const bucket = skinsByCollection.get(skin.collectionId) ?? [];
    bucket.push(skin);
    skinsByCollection.set(skin.collectionId, bucket);
  }

  const collectionGroups = [...skinsByCollection.entries()].map(([collectionId, skins]) => ({
    collectionId,
    skins,
    reps: pickRepresentativeSkins(skins, MAX_COLLECTION_REPRESENTATIVES),
  }));

  // Target midpoints of wear bands to align with mean-by-wear pricing.
  // Using edge-biased floats (e.g. low FT) can overstate value when prices are averaged.
  const targetWears: Wear[] = ["FN", "MW", "FT"];

  for (const targetWear of targetWears) {
    const [wearMin, wearMax] = WEAR_FLOAT_RANGES[targetWear];
    const targetFloat = (wearMin + wearMax) / 2;

    // Strategy 1: 10× the same item
    for (const skin of skinsOfRarity) {
      // Ensure the target float is within the skin's possible range
      const midFloat = clampToSkinRange(targetFloat, skin.minFloat, skin.maxFloat);

      addCandidate(
        Array.from({ length: 10 }, () => ({ skinId: skin.id, float: midFloat })),
      );
    }

    // Strategy 2: Mix two skins from different collections (5 + 5), now with representative sampling.
    let pairMixCount = 0;
    for (let i = 0; i < collectionGroups.length; i++) {
      for (let j = i + 1; j < collectionGroups.length; j++) {
        const groupA = collectionGroups[i];
        const groupB = collectionGroups[j];

        for (const skinA of groupA.reps) {
          for (const skinB of groupB.reps) {
            const floatA = clampToSkinRange(targetFloat, skinA.minFloat, skinA.maxFloat);
            const floatB = clampToSkinRange(targetFloat, skinB.minFloat, skinB.maxFloat);
            addCandidate([
              ...Array.from({ length: 5 }, () => ({ skinId: skinA.id, float: floatA })),
              ...Array.from({ length: 5 }, () => ({ skinId: skinB.id, float: floatB })),
            ]);

            // Extra pair split patterns increase diversity while still keeping pair collections.
            addCandidate([
              ...Array.from({ length: 6 }, () => ({ skinId: skinA.id, float: floatA })),
              ...Array.from({ length: 4 }, () => ({ skinId: skinB.id, float: floatB })),
            ]);

            addCandidate([
              ...Array.from({ length: 7 }, () => ({ skinId: skinA.id, float: floatA })),
              ...Array.from({ length: 3 }, () => ({ skinId: skinB.id, float: floatB })),
            ]);

            pairMixCount += 3;
            if (pairMixCount >= MAX_PAIR_MIX_CANDIDATES) break;
          }
          if (pairMixCount >= MAX_PAIR_MIX_CANDIDATES) break;
        }
        if (pairMixCount >= MAX_PAIR_MIX_CANDIDATES) break;
      }
      if (pairMixCount >= MAX_PAIR_MIX_CANDIDATES) break;
    }

    // Strategy 2b: Three-way cross-collection blends (4 + 3 + 3) to avoid single-output concentration.
    let tripleMixCount = 0;
    for (let i = 0; i < collectionGroups.length; i++) {
      for (let j = i + 1; j < collectionGroups.length; j++) {
        for (let k = j + 1; k < collectionGroups.length; k++) {
          const groupA = collectionGroups[i];
          const groupB = collectionGroups[j];
          const groupC = collectionGroups[k];

          const skinA = groupA.reps[0];
          const skinB = groupB.reps[0];
          const skinC = groupC.reps[0];

          if (!skinA || !skinB || !skinC) continue;

          const floatA = clampToSkinRange(targetFloat, skinA.minFloat, skinA.maxFloat);
          const floatB = clampToSkinRange(targetFloat, skinB.minFloat, skinB.maxFloat);
          const floatC = clampToSkinRange(targetFloat, skinC.minFloat, skinC.maxFloat);

          addCandidate([
            ...Array.from({ length: 4 }, () => ({ skinId: skinA.id, float: floatA })),
            ...Array.from({ length: 3 }, () => ({ skinId: skinB.id, float: floatB })),
            ...Array.from({ length: 3 }, () => ({ skinId: skinC.id, float: floatC })),
          ]);

          tripleMixCount++;
          if (tripleMixCount >= MAX_TRIPLE_MIX_CANDIDATES) break;
        }
        if (tripleMixCount >= MAX_TRIPLE_MIX_CANDIDATES) break;
      }
      if (tripleMixCount >= MAX_TRIPLE_MIX_CANDIDATES) break;
    }

    // Strategy 3: 1 Target + 9 Fillers
    for (const targetSkin of skinsOfRarity) {
      const crossCollectionFillers = fillerCandidates.filter(
        (f) => f.collectionId !== targetSkin.collectionId,
      );
      const fillerPool = crossCollectionFillers.length > 0 ? crossCollectionFillers : fillerCandidates;

      for (const fillerSkin of fillerPool) {
        if (targetSkin.id === fillerSkin.id) continue;

        const floatT = clampToSkinRange(targetFloat, targetSkin.minFloat, targetSkin.maxFloat);
        const floatF = clampToSkinRange(targetFloat, fillerSkin.minFloat, fillerSkin.maxFloat);

        addCandidate([
          { skinId: targetSkin.id, float: floatT },
          ...Array.from({ length: 9 }, () => ({ skinId: fillerSkin.id, float: floatF })),
        ]);
      }
    }

    // Strategy 4: 7 + 3 split for slightly safer weighted concentration.
    for (let i = 0; i < strategySkins.length; i++) {
      for (let j = i + 1; j < strategySkins.length; j++) {
        const skinA = strategySkins[i];
        const skinB = strategySkins[j];
        const floatA = clampToSkinRange(targetFloat, skinA.minFloat, skinA.maxFloat);
        const floatB = clampToSkinRange(targetFloat, skinB.minFloat, skinB.maxFloat);

        addCandidate([
          ...Array.from({ length: 7 }, () => ({ skinId: skinA.id, float: floatA })),
          ...Array.from({ length: 3 }, () => ({ skinId: skinB.id, float: floatB })),
        ]);
      }
    }

    // Strategy 5: 8 + 2 split for target-plus-support style contracts.
    for (const targetSkin of strategySkins) {
      for (const supportSkin of strategySkins) {
        if (targetSkin.id === supportSkin.id) continue;

        const floatTarget = clampToSkinRange(targetFloat, targetSkin.minFloat, targetSkin.maxFloat);
        const floatSupport = clampToSkinRange(targetFloat, supportSkin.minFloat, supportSkin.maxFloat);

        addCandidate([
          ...Array.from({ length: 8 }, () => ({ skinId: targetSkin.id, float: floatTarget })),
          ...Array.from({ length: 2 }, () => ({ skinId: supportSkin.id, float: floatSupport })),
        ]);
      }
    }

    // Strategy 6: 4 + 3 + 3 triple mix to diversify output distribution.
    for (let i = 0; i < strategySkins.length; i++) {
      for (let j = i + 1; j < strategySkins.length; j++) {
        for (let k = j + 1; k < strategySkins.length; k++) {
          const skinA = strategySkins[i];
          const skinB = strategySkins[j];
          const skinC = strategySkins[k];

          const floatA = clampToSkinRange(targetFloat, skinA.minFloat, skinA.maxFloat);
          const floatB = clampToSkinRange(targetFloat, skinB.minFloat, skinB.maxFloat);
          const floatC = clampToSkinRange(targetFloat, skinC.minFloat, skinC.maxFloat);

          addCandidate([
            ...Array.from({ length: 4 }, () => ({ skinId: skinA.id, float: floatA })),
            ...Array.from({ length: 3 }, () => ({ skinId: skinB.id, float: floatB })),
            ...Array.from({ length: 3 }, () => ({ skinId: skinC.id, float: floatC })),
          ]);
        }
      }
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
  const priceMemo = new Map<string, Promise<number | null>>();
  const memoizedPriceGetter = (skinId: string, wear: Wear): Promise<number | null> => {
    const key = `${skinId}:${wear}`;
    const cached = priceMemo.get(key);
    if (cached) return cached;

    const pending = priceGetter(skinId, wear).catch((err) => {
      priceMemo.delete(key);
      throw err;
    });
    priceMemo.set(key, pending);
    return pending;
  };

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

    // Process candidates in chunks to parallelize API requests (prices)
    // while keeping the logs readable and not overwhelming the runtime.
    const CHUNK_SIZE = 10;
    const UPDATE_EVERY_CHUNKS = 25;
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);

      const results = await Promise.all(chunk.map(async (inputs) => {
        try {
          const outputPool = calculateOutputPool(inputs);
          if (outputPool.length === 0) return { type: "no-pool" as const };

          const result = await evaluateTradeup(inputs, memoizedPriceGetter);
          if (!result.valid || result.totalCost <= 0) return { type: "invalid" as const };
          if (result.roi < MIN_ROI) return { type: "below-roi" as const };

          // Look up prices again for input metadata; they are guaranteed cached by evaluateTradeup
          const inputsWithPrices = await Promise.all(inputs.map(async (inp) => {
            const skin = SKINS.find((s) => s.id === inp.skinId);
            const wear = floatToWear(inp.float);
            const price = await memoizedPriceGetter(inp.skinId, wear);
            return {
              skinId: inp.skinId,
              skinName: skin?.name ?? inp.skinId,
              float: inp.float,
              wear,
              price,
            };
          }));

          return { type: "profitable" as const, result, inputs: inputsWithPrices };
        } catch (err) {
          console.error(`[scanner] Error evaluating candidate: ${err instanceof Error ? err.message : String(err)}`);
          return { type: "invalid" as const };
        }
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

        const contract: ProfitableContract = {
          inputs,
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
      if (onUpdate && i > 0 && Math.floor(i / CHUNK_SIZE) % UPDATE_EVERY_CHUNKS === 0) {
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
