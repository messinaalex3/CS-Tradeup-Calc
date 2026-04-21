import { NextRequest, NextResponse } from "next/server";
import type { Rarity, TradeupInput, Wear, OutputWithValue } from "@/lib/types";
import { RARITY_ORDER } from "@/lib/types";
import { SKINS } from "@/lib/catalog";
import { parseSteamId, fetchAndMatchInventory } from "@/lib/steam";
import type { MatchedInventoryItem } from "@/lib/steam";
import { evaluateTradeup } from "@/lib/tradeup/ev";
import { getBestPrice } from "@/lib/pricing";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type CloudflareEnv } from "@/lib/storage";

/** Rarities that can be used as trade-up inputs. */
const INPUT_RARITIES: Rarity[] = RARITY_ORDER.filter(
  (r) => r !== "covert" && r !== "consumer_grade",
);

/**
 * Given a list of inventory items of the same rarity, generate a set of
 * 10-item trade-up input combinations to evaluate.
 */
function generateInventoryCandidates(
  items: MatchedInventoryItem[],
): TradeupInput[][] {
  const candidates: TradeupInput[][] = [];

  // Group items by collection
  const byCollection = new Map<string, MatchedInventoryItem[]>();
  for (const item of items) {
    const skin = SKINS.find((s) => s.id === item.catalogSkinId);
    if (!skin) continue;
    const group = byCollection.get(skin.collectionId) ?? [];
    group.push(item);
    byCollection.set(skin.collectionId, group);
  }

  const collections = [...byCollection.values()];

  // Strategy 1: 10 items from the same collection (ideal — full probability concentration)
  for (const collItems of collections) {
    if (collItems.length >= 10) {
      candidates.push(
        collItems.slice(0, 10).map((i) => ({
          skinId: i.catalogSkinId,
          float: i.float,
        })),
      );
    }
  }

  // Strategy 2: All items from one collection + fill from another
  for (let a = 0; a < collections.length; a++) {
    for (let b = 0; b < collections.length; b++) {
      if (a === b) continue;
      const colA = collections[a];
      const colB = collections[b];
      const need = 10 - colA.length;
      if (need <= 0 || need > colB.length) continue;
      candidates.push([
        ...colA.map((i) => ({ skinId: i.catalogSkinId, float: i.float })),
        ...colB.slice(0, need).map((i) => ({
          skinId: i.catalogSkinId,
          float: i.float,
        })),
      ]);
    }
  }

  // Strategy 3: 5+5 split between the two largest collections
  if (collections.length >= 2) {
    const sorted = [...collections].sort((a, b) => b.length - a.length);
    for (let i = 0; i < Math.min(sorted.length, 5); i++) {
      for (let j = i + 1; j < Math.min(sorted.length, 5); j++) {
        if (sorted[i].length >= 5 && sorted[j].length >= 5) {
          candidates.push([
            ...sorted[i]
              .slice(0, 5)
              .map((x) => ({ skinId: x.catalogSkinId, float: x.float })),
            ...sorted[j]
              .slice(0, 5)
              .map((x) => ({ skinId: x.catalogSkinId, float: x.float })),
          ]);
        }
      }
    }
  }

  // Strategy 4: First 10 items regardless of collection (fallback)
  if (items.length >= 10) {
    candidates.push(
      items.slice(0, 10).map((i) => ({ skinId: i.catalogSkinId, float: i.float })),
    );
  }

  // Deduplicate candidates by their sorted skinId+float signature
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c
      .map((i) => `${i.skinId}:${i.float}`)
      .sort()
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function POST(request: NextRequest) {
  const requestStart = Date.now();
  console.log("[inventory] POST /api/inventory — request received");

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  let body: { profileUrl?: string };
  try {
    body = (await request.json()) as { profileUrl?: string };
  } catch {
    console.warn("[inventory] Failed to parse request body as JSON");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileUrl = body.profileUrl?.trim();
  if (!profileUrl) {
    console.warn("[inventory] Missing profileUrl in request body");
    return NextResponse.json(
      { error: "profileUrl is required" },
      { status: 400 },
    );
  }

  console.log(`[inventory] Parsing Steam ID from: ${profileUrl}`);

  // Parse and validate the Steam ID
  const steamId = parseSteamId(profileUrl);
  if (!steamId) {
    console.warn(`[inventory] Could not parse a SteamID64 from: ${profileUrl}`);
    return NextResponse.json(
      {
        error:
          "Could not parse a SteamID64 from the provided URL. Please use your full Steam profile URL (e.g. https://steamcommunity.com/profiles/76561198XXXXXXXXX) or paste your 17-digit SteamID64 directly.",
      },
      { status: 400 },
    );
  }

  console.log(`[inventory] Resolved SteamID64: ${steamId}`);
  console.log(`[inventory] Fetching Steam inventory for ${steamId}…`);

  // Fetch and match the inventory
  let totalSteamItems: number;
  let matched: MatchedInventoryItem[];
  const fetchStart = Date.now();
  try {
    ({ totalSteamItems, matched } = await fetchAndMatchInventory(steamId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[inventory] Failed to fetch inventory for ${steamId}: ${message}`);
    return NextResponse.json(
      { error: message },
      { status: 400 },
    );
  }
  console.log(
    `[inventory] Inventory fetched in ${Date.now() - fetchStart}ms — ` +
    `${totalSteamItems} total Steam items, ${matched.length} matched to catalog`,
  );

  // Group matched items by rarity (skip covert — cannot be inputs)
  const byRarity = new Map<Rarity, MatchedInventoryItem[]>();
  for (const item of matched) {
    const skin = SKINS.find((s) => s.id === item.catalogSkinId);
    if (!skin || !INPUT_RARITIES.includes(skin.rarity)) continue;
    const group = byRarity.get(skin.rarity) ?? [];
    group.push(item);
    byRarity.set(skin.rarity, group);
  }

  // Build inventory summary (all input rarities, even those with < 10 items)
  const inventorySummary: Record<string, number> = {};
  for (const rarity of INPUT_RARITIES) {
    inventorySummary[rarity] = byRarity.get(rarity)?.length ?? 0;
  }
  console.log("[inventory] Items by rarity:", inventorySummary);

  // Evaluate trade-up candidates for rarities with enough items
  const priceGetter = (skinId: string, wear: Wear) =>
    getBestPrice(skinId, wear, env);

  interface RecommendedContract {
    rarity: Rarity;
    totalCost: number;
    ev: number;
    roi: number;
    guaranteedProfit: boolean;
    chanceToProfit: number;
    minOutput: number;
    maxOutput: number;
    inputs: Array<{ skinId: string; skinName: string; float: number }>;
    outputs: OutputWithValue[];
  }

  const recommendations: RecommendedContract[] = [];

  for (const rarity of INPUT_RARITIES) {
    const items = byRarity.get(rarity);
    if (!items || items.length < 10) {
      console.log(
        `[inventory] Skipping rarity "${rarity}" — only ${items?.length ?? 0} item(s), need ≥10`,
      );
      continue;
    }

    const candidates = generateInventoryCandidates(items);
    const capped = candidates.slice(0, 30);
    console.log(
      `[inventory] Rarity "${rarity}": ${items.length} items → ` +
      `${candidates.length} candidate(s) generated, evaluating up to ${capped.length}`,
    );

    let evaluated = 0;
    let profitable = 0;

    // Evaluate up to 30 candidates per rarity to keep response time reasonable
    for (const inputs of capped) {
      evaluated++;
      const result = await evaluateTradeup(inputs, priceGetter);
      if (!result.valid || result.roi < 0) continue;

      profitable++;
      console.log(
        `[inventory]   Candidate ${evaluated}/${capped.length} (${rarity}): ` +
        `ROI=${((result.roi - 1) * 100).toFixed(1)}% EV=$${result.ev.toFixed(2)} cost=$${result.totalCost.toFixed(2)}`,
      );

      recommendations.push({
        rarity,
        totalCost: result.totalCost,
        ev: result.ev,
        roi: result.roi,
        guaranteedProfit: result.guaranteedProfit,
        chanceToProfit: result.chanceToProfit,
        minOutput: result.minOutput,
        maxOutput: result.maxOutput,
        inputs: inputs.map((inp) => {
          const skin = SKINS.find((s) => s.id === inp.skinId);
          return {
            skinId: inp.skinId,
            skinName: skin?.name ?? inp.skinId,
            float: inp.float,
          };
        }),
        outputs: result.outputs,
      });
    }

    console.log(
      `[inventory] Rarity "${rarity}" done — ${profitable}/${evaluated} candidates profitable`,
    );
  }

  // Sort by ROI descending
  recommendations.sort((a, b) => b.roi - a.roi);

  const total = recommendations.length;
  const returned = Math.min(total, 15);
  console.log(
    `[inventory] Returning ${returned} of ${total} recommendation(s) — ` +
    `total elapsed ${Date.now() - requestStart}ms`,
  );

  return NextResponse.json({
    steamId,
    totalSteamItems,
    matchedItems: matched.length,
    inventorySummary,
    recommendations: recommendations.slice(0, 15),
    floatNote:
      "Float values are approximated from the wear category midpoint. Actual floats may differ.",
  });
}
