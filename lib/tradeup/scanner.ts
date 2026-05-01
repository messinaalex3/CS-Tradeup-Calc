import type { Rarity, Skin, TradeupInput, Wear } from "../types";
import { WEAR_FLOAT_RANGES } from "../types";
import { SKINS as STATIC_SKINS } from "../catalog";
import { evaluateTradeup } from "./ev";
import { calculateOutputPool, getOutputRarity } from "./pool";
import { floatToWear } from "./float";
import { MIN_SELL_QUANTITY } from "../storage";

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
  /** ROI after Skinport's 12% seller fee — contracts need netRoi > 1.0 to be truly profitable. */
  netRoi: number;
  guaranteedProfit: boolean;
  chanceToProfit: number;
}

/** Shape stored in / returned from TRADEUP_CACHE KV. */
export interface TradeupCachePayload {
  contracts: ProfitableContract[];
  cachedAt: string;
}

/** Rarities eligible for trade-up scanning (excludes consumer_grade and extraordinary). */
export const SCANNABLE_RARITIES: Rarity[] = [
  "restricted",
  "mil_spec",
  "industrial_grade",
  "classified",
  "covert",
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


function pickCheapestSkinsByWear(
  skins: Skin[],
  wear: Wear,
  priceBySkinWear: Map<string, number>,
  maxCount: number,
): Skin[] {
  return [...skins]
    .sort((a, b) => {
      const pa = priceBySkinWear.get(`${a.id}:${wear}`) ?? Number.POSITIVE_INFINITY;
      const pb = priceBySkinWear.get(`${b.id}:${wear}`) ?? Number.POSITIVE_INFINITY;
      return pa - pb;
    })
    .slice(0, maxCount);
}

/**
 * Compute the maximum input float value that, when used for all 10 inputs of
 * the given skin, still results in an output float ≤ targetWearMax for the
 * specified output skin. Returns null when no valid range exists.
 *
 * This is used by the float-boundary strategy (D) to source the cheapest
 * float that still achieves the desired output wear tier (e.g., FN).
 */
function computeMaxInputFloatForOutputWear(
  inputSkin: Skin,
  outputSkin: Skin,
  targetWearMax: number,
): number | null {
  const outputRange = outputSkin.maxFloat - outputSkin.minFloat;
  if (outputRange <= 0) return null;

  // outputFloat = outputMin + normalizedAvg * outputRange
  // For outputFloat < targetWearMax:
  //   normalizedAvg < (targetWearMax - outputMin) / outputRange
  const maxNormalizedAvg = (targetWearMax - outputSkin.minFloat) / outputRange;
  if (maxNormalizedAvg <= 0) return null; // Output skin can't reach this wear tier
  if (maxNormalizedAvg >= 1) return inputSkin.maxFloat; // Any input float works

  const inputRange = inputSkin.maxFloat - inputSkin.minFloat;
  const maxInputFloat = inputSkin.minFloat + maxNormalizedAvg * inputRange;
  const clamped = Math.min(maxInputFloat, inputSkin.maxFloat);
  return clamped > inputSkin.minFloat ? clamped : null;
}

async function generateOutputAwareCandidates(
  rarity: Rarity,
  getInputPrice: (skinId: string, wear: Wear) => Promise<number | null>,
  getOutputPrice: (skinId: string, wear: Wear) => Promise<number | null>,
  skins: Skin[] = STATIC_SKINS,
): Promise<TradeupInput[][]> {
  console.log(`[scanner:candidates:output-aware] start rarity=${rarity}`);
  const outputRarity = getOutputRarity(rarity);
  if (!outputRarity) {
    console.warn(`[scanner:candidates:output-aware] no output rarity mapping for input rarity=${rarity}`);
    return [];
  }

  // Covert 5-item contracts vs standard 10-item contracts
  const CONTRACT_SIZE = rarity === "covert" ? 5 : 10;

  const inputSkins = skins.filter((s) => s.rarity === rarity);
  const outputSkins = skins.filter((s) => s.rarity === outputRarity);
  console.log(
    `[scanner:candidates:output-aware] rarity=${rarity} outputRarity=${outputRarity} ` +
    `inputSkins=${inputSkins.length} outputSkins=${outputSkins.length}`,
  );
  if (inputSkins.length === 0 || outputSkins.length === 0) {
    console.warn(
      `[scanner:candidates:output-aware] abort rarity=${rarity} due to empty skin pools ` +
      `(inputSkins=${inputSkins.length}, outputSkins=${outputSkins.length})`,
    );
    return [];
  }

  const targetWears: Wear[] = ["FN", "MW", "FT", "WW", "BS"];
  // Multiple float targets per tier so the scanner finds contracts using
  // commonly-available items across the full price spectrum of each wear tier.
  // High-end FT floats (0.29–0.33) are much easier to source than the
  // theoretical midpoint; low-end FT floats (0.16–0.20) are rarer but cheaper.
  const WEAR_TARGET_FLOATS: Record<Wear, number[]> = {
    FN: [0.02, 0.04, 0.06],
    MW: [0.08, 0.11, 0.14],
    FT: [0.16, 0.20, 0.25, 0.29, 0.33],
    WW: [0.39, 0.42],
    BS: [0.47, 0.55, 0.70],
  };
  const candidates: TradeupInput[][] = [];
  const seen = new Set<string>();
  const addCandidate = (inputs: TradeupInput[]) => {
    const key = getContractKey(inputs);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(inputs);
  };

  const inputByCollection = new Map<string, Skin[]>();
  for (const skin of inputSkins) {
    const list = inputByCollection.get(skin.collectionId) ?? [];
    list.push(skin);
    inputByCollection.set(skin.collectionId, list);
  }

  const outputByCollection = new Map<string, Skin[]>();
  for (const skin of outputSkins) {
    const list = outputByCollection.get(skin.collectionId) ?? [];
    list.push(skin);
    outputByCollection.set(skin.collectionId, list);
  }

  const candidateCollectionIds = [...inputByCollection.keys()].filter((cid) => outputByCollection.has(cid));
  console.log(
    `[scanner:candidates:output-aware] rarity=${rarity} ` +
    `inputCollections=${inputByCollection.size} outputCollections=${outputByCollection.size} ` +
    `overlapCollections=${candidateCollectionIds.length}`,
  );
  if (candidateCollectionIds.length === 0) {
    console.warn(`[scanner:candidates:output-aware] no overlapping collections for rarity=${rarity}`);
    return [];
  }

  const inputPriceBySkinWear = new Map<string, number>();
  const outputPriceBySkinWear = new Map<string, number>();

  // Use allSettled so a single failed KV/R2 read does not abort the entire
  // prefetch batch — missing prices are simply omitted from scoring.
  await Promise.allSettled(
    inputSkins.flatMap((skin) =>
      targetWears.map(async (wear) => {
        try {
          const price = await getInputPrice(skin.id, wear);
          if (price != null && price > 0) {
            inputPriceBySkinWear.set(`${skin.id}:${wear}`, price);
          }
        } catch {
          // Transient failure — skip this skin/wear; scoring will omit it.
        }
      }),
    ),
  );

  await Promise.allSettled(
    outputSkins.flatMap((skin) =>
      targetWears.map(async (wear) => {
        try {
          const price = await getOutputPrice(skin.id, wear);
          if (price != null && price > 0) {
            outputPriceBySkinWear.set(`${skin.id}:${wear}`, price);
          }
        } catch {
          // Transient failure — skip this skin/wear; scoring will omit it.
        }
      }),
    ),
  );

  const COLLECTIONS_PER_WEAR = 12;
  // Per-float cap — keeps total search space bounded even with many float targets.
  // Total max ≈ (3+3+5+2+3) floats × 60 = ~960 candidates.
  const MAX_CANDIDATES_PER_FLOAT = 60;
  console.log(
    `[scanner:candidates:output-aware] prefetch complete rarity=${rarity} ` +
    `inputPricePoints=${inputPriceBySkinWear.size} outputPricePoints=${outputPriceBySkinWear.size}`,
  );
  for (const wear of targetWears) {
    const wearStartCount = candidates.length;

    const scoredCollections = candidateCollectionIds
      .map((collectionId) => {
        const inputs = inputByCollection.get(collectionId) ?? [];
        const outputs = outputByCollection.get(collectionId) ?? [];
        if (inputs.length === 0 || outputs.length === 0) return null;

        const cheapestInput = pickCheapestSkinsByWear(inputs, wear, inputPriceBySkinWear, 1)[0];
        if (!cheapestInput) return null;

        const cheapestInputPrice = inputPriceBySkinWear.get(`${cheapestInput.id}:${wear}`);
        if (!cheapestInputPrice || cheapestInputPrice <= 0) return null;

        const outputPrices = outputs
          .map((s) => outputPriceBySkinWear.get(`${s.id}:${wear}`))
          .filter((p): p is number => p != null && p > 0)
          .sort((a, b) => b - a);
        if (outputPrices.length === 0) return null;

        const topSlice = outputPrices.slice(0, Math.min(3, outputPrices.length));
        const outputScore = topSlice.reduce((sum, p) => sum + p, 0) / topSlice.length;
        const quality = outputScore / cheapestInputPrice;

        return {
          collectionId,
          quality,
          cheapestInput,
          inputPool: pickCheapestSkinsByWear(inputs, wear, inputPriceBySkinWear, 2),
        };
      })
      .filter((v): v is {
        collectionId: string;
        quality: number;
        cheapestInput: Skin;
        inputPool: Skin[];
      } => v !== null)
      .sort((a, b) => b.quality - a.quality)
      .slice(0, COLLECTIONS_PER_WEAR);

    if (scoredCollections.length === 0) {
      console.warn(
        `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} ` +
        `no scored collections (likely missing/invalid prices)`,
      );
      continue;
    }
    console.log(
      `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} ` +
      `scoredCollections=${scoredCollections.length} floatTargets=${WEAR_TARGET_FLOATS[wear].length}`,
    );

    let wearTotal = 0;

    for (const targetFloat of WEAR_TARGET_FLOATS[wear]) {
      let addedForFloat = 0;
      const addAndCount = (inputs: TradeupInput[]) => {
        const before = candidates.length;
        addCandidate(inputs);
        if (candidates.length > before) { addedForFloat++; wearTotal++; }
      };

      // A) Pure focused contracts from strongest collections.
      const beforeA = addedForFloat;
      for (const coll of scoredCollections.slice(0, 8)) {
        const input = coll.cheapestInput;
        const inputFloat = clampToSkinRange(targetFloat, input.minFloat, input.maxFloat);
        addAndCount(Array.from({ length: CONTRACT_SIZE }, () => ({ skinId: input.id, float: inputFloat })));
        if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
      }
      console.log(
        `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} float=${targetFloat} strategy=A added=${addedForFloat - beforeA}`,
      );

      // B) Pair splits from top collections.
      const beforeB = addedForFloat;
      const pairSplits: Array<[number, number]> = CONTRACT_SIZE === 5
        ? [[4, 1], [3, 2]]
        : [[9, 1], [8, 2], [7, 3], [6, 4], [5, 5]];
      for (let i = 0; i < scoredCollections.length; i++) {
        for (let j = i + 1; j < scoredCollections.length; j++) {
          const a = scoredCollections[i];
          const b = scoredCollections[j];

          for (const skinA of a.inputPool) {
            for (const skinB of b.inputPool) {
              const floatA = clampToSkinRange(targetFloat, skinA.minFloat, skinA.maxFloat);
              const floatB = clampToSkinRange(targetFloat, skinB.minFloat, skinB.maxFloat);

              for (const [countA, countB] of pairSplits) {
                addAndCount([
                  ...Array.from({ length: countA }, () => ({ skinId: skinA.id, float: floatA })),
                  ...Array.from({ length: countB }, () => ({ skinId: skinB.id, float: floatB })),
                ]);
                if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
              }

              if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
            }
            if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
          }
          if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
        }
        if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
      }
      console.log(
        `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} float=${targetFloat} strategy=B added=${addedForFloat - beforeB}`,
      );

      // C) Tri-collection contracts to spread output odds while preserving quality.
      const beforeC = addedForFloat;
      const tripleSplits: Array<[number, number, number]> = CONTRACT_SIZE === 5
        ? [[3, 1, 1], [2, 2, 1]]
        : [[6, 2, 2], [5, 3, 2], [4, 3, 3]];
      for (let i = 0; i < scoredCollections.length; i++) {
        for (let j = i + 1; j < scoredCollections.length; j++) {
          for (let k = j + 1; k < scoredCollections.length; k++) {
            const a = scoredCollections[i].cheapestInput;
            const b = scoredCollections[j].cheapestInput;
            const c = scoredCollections[k].cheapestInput;

            const floatA = clampToSkinRange(targetFloat, a.minFloat, a.maxFloat);
            const floatB = clampToSkinRange(targetFloat, b.minFloat, b.maxFloat);
            const floatC = clampToSkinRange(targetFloat, c.minFloat, c.maxFloat);

            for (const [countA, countB, countC] of tripleSplits) {
              addAndCount([
                ...Array.from({ length: countA }, () => ({ skinId: a.id, float: floatA })),
                ...Array.from({ length: countB }, () => ({ skinId: b.id, float: floatB })),
                ...Array.from({ length: countC }, () => ({ skinId: c.id, float: floatC })),
              ]);
              if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
            }

            if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
          }
          if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
        }
        if (addedForFloat >= MAX_CANDIDATES_PER_FLOAT) break;
      }
      console.log(
        `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} float=${targetFloat} strategy=C added=${addedForFloat - beforeC} floatTotal=${addedForFloat}`,
      );
    }

    // Strategy D: Float-boundary contracts — for FN and MW targets, compute the
    // highest valid input float that still keeps the output within the target
    // wear tier. These boundary floats are often cheaper to source than the
    // tier midpoints while still capturing the same output wear premium.
    if (wear === "FN" || wear === "MW") {
      const wearUpperBound = WEAR_FLOAT_RANGES[wear][1];
      let addedD = 0;
      for (const coll of scoredCollections) {
        const inputSkin = coll.cheapestInput;
        const outputSkins = outputByCollection.get(coll.collectionId) ?? [];
        for (const outputSkin of outputSkins) {
          const maxFloat = computeMaxInputFloatForOutputWear(
            inputSkin, outputSkin, wearUpperBound,
          );
          if (maxFloat === null) continue;
          // Use 98% of max to stay safely within the wear-tier boundary
          const boundaryFloat = clampToSkinRange(
            maxFloat * 0.98,
            inputSkin.minFloat,
            inputSkin.maxFloat,
          );
          const before = candidates.length;
          addCandidate(
            Array.from({ length: CONTRACT_SIZE }, () => ({ skinId: inputSkin.id, float: boundaryFloat })),
          );
          if (candidates.length > before) { addedD++; wearTotal++; }
          break; // One boundary float per input skin
        }
      }
      console.log(
        `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} strategy=D added=${addedD}`,
      );
    }

    console.log(
      `[scanner:candidates:output-aware] rarity=${rarity} wear=${wear} ` +
      `wearTotal=${wearTotal} globalTotal=${candidates.length} wearDelta=${candidates.length - wearStartCount}`,
    );
  }

  console.log(`[scanner:candidates:output-aware] done rarity=${rarity} totalCandidates=${candidates.length}`);
  return candidates;
}

/** Utility to generate a unique key for a contract based on its inputs. */
export function getContractKey(inputs: TradeupInput[]): string {
  return [...inputs]
    .sort((a, b) => a.skinId.localeCompare(b.skinId) || a.float - b.float)
    .map((i) => `${i.skinId}:${i.float.toFixed(4)}`)
    .join("|");
}

/**
 * Generate 5-item covert contract candidates. These contracts use exactly 5
 * covert inputs and output a knife or glove from the same case (Oct 2025 update).
 */
function generateCovertCandidates(skins: Skin[]): TradeupInput[][] {
  const covertSkins = skins.filter((s) => s.rarity === "covert");
  if (covertSkins.length === 0) return [];

  const candidates: TradeupInput[][] = [];
  const seen = new Set<string>();
  const addCandidate = (inputs: TradeupInput[]) => {
    const key = getContractKey(inputs);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(inputs);
  };

  // Group covert skins by collection so we can build cross-collection splits
  const byCollection = new Map<string, Skin[]>();
  for (const skin of covertSkins) {
    const list = byCollection.get(skin.collectionId) ?? [];
    list.push(skin);
    byCollection.set(skin.collectionId, list);
  }
  const collGroups = [...byCollection.values()];

  const targetWears: Wear[] = ["FN", "MW", "FT", "WW", "BS"];
  for (const targetWear of targetWears) {
    const [wearMin, wearMax] = WEAR_FLOAT_RANGES[targetWear];
    const targetFloat = (wearMin + wearMax) / 2;

    // Strategy: 5× same skin
    for (const skin of covertSkins) {
      const f = clampToSkinRange(targetFloat, skin.minFloat, skin.maxFloat);
      addCandidate(Array.from({ length: 5 }, () => ({ skinId: skin.id, float: f })));
    }

    // Strategy: 4+1 and 3+2 splits across two collections
    for (let i = 0; i < collGroups.length; i++) {
      for (let j = i + 1; j < collGroups.length; j++) {
        const skinA = collGroups[i][0];
        const skinB = collGroups[j][0];
        if (!skinA || !skinB) continue;
        const fA = clampToSkinRange(targetFloat, skinA.minFloat, skinA.maxFloat);
        const fB = clampToSkinRange(targetFloat, skinB.minFloat, skinB.maxFloat);
        addCandidate([
          ...Array.from({ length: 4 }, () => ({ skinId: skinA.id, float: fA })),
          { skinId: skinB.id, float: fB },
        ]);
        addCandidate([
          ...Array.from({ length: 3 }, () => ({ skinId: skinA.id, float: fA })),
          ...Array.from({ length: 2 }, () => ({ skinId: skinB.id, float: fB })),
        ]);
      }
    }
  }

  console.log(`[scanner:candidates:covert] generated ${candidates.length} covert 5-item candidates`);
  return candidates;
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
export function generateCandidates(rarity: Rarity, skins: Skin[] = STATIC_SKINS): TradeupInput[][] {
  // Covert contracts use 5 items and have a different candidate shape
  if (rarity === "covert") return generateCovertCandidates(skins);

  const skinsOfRarity = skins.filter((s) => s.rarity === rarity);
  console.log(`[scanner:candidates:base] start rarity=${rarity} skinsOfRarity=${skinsOfRarity.length}`);
  if (skinsOfRarity.length === 0) {
    console.warn(`[scanner:candidates:base] no skins found for rarity=${rarity}`);
    return [];
  }

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
  console.log(
    `[scanner:candidates:base] rarity=${rarity} collectionGroups=${collectionGroups.length} ` +
    `fillerCandidates=${fillerCandidates.length} strategySkins=${strategySkins.length}`,
  );

  // Target midpoints of wear bands to align with mean-by-wear pricing.
  // Using edge-biased floats (e.g. low FT) can overstate value when prices are averaged.
  const targetWears: Wear[] = ["FN", "MW", "FT"];

  for (const targetWear of targetWears) {
    const [wearMin, wearMax] = WEAR_FLOAT_RANGES[targetWear];
    const targetFloat = (wearMin + wearMax) / 2;
    const wearStartCount = candidates.length;

    // Strategy 1: 10× the same item
    const beforeS1 = candidates.length;
    for (const skin of skinsOfRarity) {
      // Ensure the target float is within the skin's possible range
      const midFloat = clampToSkinRange(targetFloat, skin.minFloat, skin.maxFloat);

      addCandidate(
        Array.from({ length: 10 }, () => ({ skinId: skin.id, float: midFloat })),
      );
    }
    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=1 added=${candidates.length - beforeS1}`,
    );

    // Strategy 2: Mix two skins from different collections (5 + 5), now with representative sampling.
    const beforeS2 = candidates.length;
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
    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=2 added=${candidates.length - beforeS2} ` +
      `attemptedPatterns=${pairMixCount}`,
    );

    // Strategy 2b: Three-way cross-collection blends (4 + 3 + 3) to avoid single-output concentration.
    const beforeS2b = candidates.length;
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
    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=2b added=${candidates.length - beforeS2b} ` +
      `attemptedPatterns=${tripleMixCount}`,
    );

    // Strategy 3: 1 Target + 9 Fillers
    const beforeS3 = candidates.length;
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
    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=3 added=${candidates.length - beforeS3}`,
    );

    // Strategy 4: 7 + 3 split for slightly safer weighted concentration.
    const beforeS4 = candidates.length;
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
    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=4 added=${candidates.length - beforeS4}`,
    );

    // Strategy 5: 8 + 2 split for target-plus-support style contracts.
    const beforeS5 = candidates.length;
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
    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=5 added=${candidates.length - beforeS5}`,
    );

    // Strategy 6: 4 + 3 + 3 triple mix to diversify output distribution.
    const beforeS6 = candidates.length;
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

    console.log(
      `[scanner:candidates:base] rarity=${rarity} wear=${targetWear} strategy=6 added=${candidates.length - beforeS6} ` +
      `wearTotal=${candidates.length - wearStartCount} globalTotal=${candidates.length}`,
    );
  }

  console.log(`[scanner:candidates:base] done rarity=${rarity} totalCandidates=${candidates.length}`);
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
  getInputPrice: (skinId: string, wear: Wear) => Promise<number | null>,

  getOutputPrice: (skinId: string, wear: Wear) => Promise<number | null>,
  onUpdate?: (contracts: ProfitableContract[]) => Promise<void>,
  skins: Skin[] = STATIC_SKINS,
  rarities: Rarity[] = SCANNABLE_RARITIES,
  getOutputPriceByFloat?: (skinId: string, float: number) => Promise<number | null>,
  /** Optional liquidity getter: if an output skin with ≥5% probability has fewer than
   * MIN_SELL_QUANTITY listings, the contract is skipped as unsellable. */
  getOutputQuantity?: (skinId: string, wear: Wear) => number | null,
): Promise<ProfitableContract[]> {
  const inputPriceMemo = new Map<string, Promise<number | null>>();
  const outputPriceMemo = new Map<string, Promise<number | null>>();

  const memoizedInputPriceGetter = (skinId: string, wear: Wear): Promise<number | null> => {
    const key = `${skinId}:${wear}`;
    const cached = inputPriceMemo.get(key);
    if (cached) return cached;

    // On error return null (price unavailable) — do NOT evict the key so a
    // second caller for the same skin/wear reuses this settled null instead of
    // firing another KV read and multiplying connection pressure.
    const pending = getInputPrice(skinId, wear).catch((err) => {
      console.warn(`[scanner] Input price fetch failed for ${skinId}:${wear} — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    inputPriceMemo.set(key, pending);
    return pending;
  };

  const memoizedOutputPriceGetter = (skinId: string, wear: Wear): Promise<number | null> => {
    const key = `${skinId}:${wear}`;
    const cached = outputPriceMemo.get(key);
    if (cached) return cached;

    const pending = getOutputPrice(skinId, wear).catch((err) => {
      console.warn(`[scanner] Output price fetch failed for ${skinId}:${wear} — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    outputPriceMemo.set(key, pending);
    return pending;
  };

  const scanStart = Date.now();
  console.log(
    `[scanner] Starting scan — rarities: [${rarities.join(", ")}]`,
  );

  const allProfitable: ProfitableContract[] = [];

  for (const rarity of rarities) {
    console.log("evaluating rarity", rarity);
    const baseCandidates = generateCandidates(rarity, skins);
    console.log(`[scanner] Rarity "${rarity}": Generated ${baseCandidates.length} base candidates`);
    const outputAwareCandidates = await generateOutputAwareCandidates(
      rarity,
      memoizedInputPriceGetter,
      memoizedOutputPriceGetter,
      skins,
    );
    console.log(`[scanner] Rarity "${rarity}": Generated ${outputAwareCandidates.length} output-aware candidates`);
    const mergedByKey = new Map<string, TradeupInput[]>();
    for (const candidate of [...baseCandidates, ...outputAwareCandidates]) {
      mergedByKey.set(getContractKey(candidate), candidate);
    }
    const candidates = [...mergedByKey.values()];

    console.log(
      `[scanner] Rarity "${rarity}": ${candidates.length} candidate(s) to evaluate ` +
      `(base=${baseCandidates.length}, output-aware=${outputAwareCandidates.length})`,
    );

    let evaluated = 0;
    let skippedNoPool = 0;
    let skippedInvalid = 0;
    let skippedROI = 0;
    let skippedIlliquid = 0;
    let profitable = 0;
    const rarityStart = Date.now();

    // Process candidates in chunks to parallelize API requests (prices)
    // while keeping the logs readable and not overwhelming the runtime.
    const CHUNK_SIZE = 25;
    const UPDATE_EVERY_CHUNKS = 25;
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);

      const results = await Promise.all(chunk.map(async (inputs) => {
        try {
          const outputPool = calculateOutputPool(inputs, skins);
          if (outputPool.length === 0) return { type: "no-pool" as const };

          const result = await evaluateTradeup(
            inputs,
            memoizedInputPriceGetter,
            memoizedOutputPriceGetter,
            skins,
            undefined, // use default STATIC_COLLECTIONS
            getOutputPriceByFloat,
          );
          if (!result.valid || result.totalCost <= 0) return { type: "invalid" as const };
          if (result.roi < MIN_ROI) return { type: "below-roi" as const };

          // Liquidity check: skip contracts where a significant output (≥5% probability)
          // has fewer Skinport listings than the minimum threshold — such skins can't be
          // sold quickly at the quoted price, making the EV inflated.
          if (getOutputQuantity) {
            const hasIlliquidOutput = result.outputs.some(
              (o) => o.probability >= 0.05 &&
                (getOutputQuantity(o.skinId, o.wear) ?? Infinity) < MIN_SELL_QUANTITY,
            );
            if (hasIlliquidOutput) return { type: "illiquid" as const };
          }

          // Look up buy prices again for input metadata; they are guaranteed cached by evaluateTradeup
          const inputsWithPrices = await Promise.all(inputs.map(async (inp) => {
            const skin = skins.find((s) => s.id === inp.skinId);
            const wear = floatToWear(inp.float);
            const price = await memoizedInputPriceGetter(inp.skinId, wear);
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
        if (res.type === "illiquid") {
          skippedIlliquid++;
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
          netRoi: result.netRoi,
          guaranteedProfit: result.guaranteedProfit,
          chanceToProfit: result.chanceToProfit,
        };

        allProfitable.push(contract);
      }

      // Periodically update cache if we found new contracts
      if (onUpdate && i > 0 && Math.floor(i / CHUNK_SIZE) % UPDATE_EVERY_CHUNKS === 0) {
        try {
          await onUpdate([...allProfitable].sort((a, b) => b.roi - a.roi));
        } catch (err) {
          console.error(`[scanner] onUpdate (periodic) failed — continuing scan: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    console.log(
      `[scanner] Rarity "${rarity}" done in ${Date.now() - rarityStart}ms — ` +
      `${evaluated} evaluated, ${profitable} profitable ` +
      `(skipped: ${skippedNoPool} no-pool, ${skippedInvalid} invalid, ${skippedROI} below min ROI, ${skippedIlliquid} illiquid)`,
    );

    // Final update for this rarity
    if (onUpdate) {
      try {
        await onUpdate([...allProfitable].sort((a, b) => b.roi - a.roi));
      } catch (err) {
        console.error(`[scanner] onUpdate (rarity boundary) failed — continuing scan: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  allProfitable.sort((a, b) => b.roi - a.roi);
  console.log(
    `[scanner] Scan complete in ${Date.now() - scanStart}ms — ` +
    `${allProfitable.length} profitable contract(s) total`,
  );
  return allProfitable;
}
