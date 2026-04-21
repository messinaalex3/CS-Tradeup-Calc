import { NextRequest, NextResponse } from "next/server";
import type { Rarity, TradeupInput, Wear } from "@/lib/types";
import { RARITY_LABELS } from "@/lib/types";
import { SKINS } from "@/lib/catalog";
import { evaluateTradeup } from "@/lib/tradeup/ev";
import { getBestPrice } from "@/lib/pricing";
import { calculateOutputPool } from "@/lib/tradeup/pool";
import { floatToWear } from "@/lib/tradeup/float";
import { type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Maximum number of profitable contracts to return
const MAX_RESULTS = 20;
// Minimum ROI threshold to consider "profitable"
const MIN_ROI = 0;

interface ProfitableContract {
  inputs: Array<{ skinId: string; skinName: string; float: number; wear: Wear; price: number | null }>;
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

/**
 * Generate a list of candidate trade-up contracts by using sets of the same
 * item 10 times (simplest strategy) for each mil-spec skin in the catalog.
 *
 * This gives a deterministic, fast-to-compute set of trade-ups to evaluate.
 * A real scanner would be more exhaustive.
 */
function generateCandidates(rarity: Rarity): TradeupInput[][] {
  const skinsOfRarity = SKINS.filter((s) => s.rarity === rarity);
  const candidates: TradeupInput[][] = [];

  // Strategy 1: 10× the same item at a mid-range float (0.20 = FT)
  const targetFloat = 0.20;
  for (const skin of skinsOfRarity) {
    // Use a float in the middle of the skin's range
    const midFloat = Math.max(
      skin.minFloat,
      Math.min(skin.maxFloat, targetFloat),
    );
    candidates.push(
      Array.from({ length: 10 }, () => ({ skinId: skin.id, float: midFloat })),
    );
  }

  // Strategy 2: Mix two skins from different collections (5 + 5) at FT float
  // This creates cross-collection trade-ups which may hit more profitable outputs
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

export async function GET(request: NextRequest) {
  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  const { searchParams } = request.nextUrl;
  const rarityParam = searchParams.get("rarity") as Rarity | null;
  const maxBudget = searchParams.get("maxBudget")
    ? parseFloat(searchParams.get("maxBudget")!)
    : undefined;

  // Determine which rarities to scan (skip consumer_grade and covert)
  const scannableRarities: Rarity[] = rarityParam
    ? [rarityParam]
    : (["industrial_grade", "mil_spec", "restricted", "classified"] as Rarity[]);

  const priceGetter = (skinId: string, wear: Wear) => getBestPrice(skinId, wear, env);
  const profitable: ProfitableContract[] = [];

  for (const rarity of scannableRarities) {
    const candidates = generateCandidates(rarity);

    for (const inputs of candidates) {
      if (profitable.length >= MAX_RESULTS) break;

      // Quick budget check: if a budget is set, skip if estimated cost exceeds it
      // (We just check if the skin has a pool first)
      const outputPool = calculateOutputPool(inputs);
      if (outputPool.length === 0) continue;

      const result = await evaluateTradeup(inputs, priceGetter);
      if (!result.valid || result.totalCost === 0) continue;
      if (maxBudget !== undefined && result.totalCost > maxBudget) continue;
      if (result.roi < MIN_ROI) continue;

      const contractInputs = inputs.map((inp) => {
        const skin = SKINS.find((s) => s.id === inp.skinId);
        const wear = floatToWear(inp.float);
        return {
          skinId: inp.skinId,
          skinName: skin?.name ?? inp.skinId,
          float: inp.float,
          wear,
          price: null as number | null,
        };
      });

      profitable.push({
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

  // Sort by ROI descending
  profitable.sort((a, b) => b.roi - a.roi);

  return NextResponse.json({
    contracts: profitable.slice(0, MAX_RESULTS),
    total: profitable.length,
    scannedRarities: scannableRarities.map((r) => RARITY_LABELS[r]),
  });
}
