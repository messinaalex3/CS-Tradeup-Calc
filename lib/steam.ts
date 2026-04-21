import type { Wear } from "./types";
import { WEAR_LABELS } from "./types";
import { SKINS } from "./catalog";

/** Default float values by wear (midpoint of each float range). */
export const WEAR_DEFAULT_FLOATS: Record<Wear, number> = {
  FN: 0.035,
  MW: 0.11,
  FT: 0.265,
  WW: 0.415,
  BS: 0.725,
};

/** Map Steam's internal wear tag names to our Wear type. */
const STEAM_WEAR_MAP: Record<string, Wear> = {
  WearCategory0: "FN",
  WearCategory1: "MW",
  WearCategory2: "FT",
  WearCategory3: "WW",
  WearCategory4: "BS",
};

/** An inventory item after matching against our skin catalog. */
export interface MatchedInventoryItem {
  assetId: string;
  marketHashName: string;
  catalogSkinId: string;
  wear: Wear;
  /** Approximate float derived from the wear category midpoint. */
  float: number;
}

// ---------- URL / ID Parsing ----------

/**
 * Extract a SteamID64 (17-digit number) from a Steam profile URL or a raw ID.
 *
 * Supported inputs:
 *   - `76561198XXXXXXXXX`  (raw SteamID64)
 *   - `https://steamcommunity.com/profiles/76561198XXXXXXXXX`
 *   - `https://steamcommunity.com/profiles/76561198XXXXXXXXX/`
 *
 * Vanity URLs (`/id/username`) are NOT supported without a Steam Web API key.
 * Returns `null` when the input cannot be parsed as a SteamID64.
 */
export function parseSteamId(input: string): string | null {
  const trimmed = input.trim();

  // Raw SteamID64 (exactly 17 digits, starts with 7656119)
  if (/^\d{17}$/.test(trimmed)) {
    return trimmed;
  }

  // Profile URL containing a SteamID64
  const match = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (match) {
    return match[1];
  }

  return null;
}

// ---------- Steam Inventory API ----------

/** Raw shape returned by the Steam inventory endpoint. */
interface SteamInventoryResponse {
  success: number;
  total_inventory_count?: number;
  assets?: SteamAsset[];
  descriptions?: SteamDescription[];
  error?: string;
}

interface SteamAsset {
  assetid: string;
  classid: string;
  instanceid: string;
  amount: string;
}

interface SteamDescription {
  classid: string;
  instanceid: string;
  market_hash_name: string;
  tags?: Array<{
    category: string;
    internal_name: string;
    localized_tag_name: string;
  }>;
}

/**
 * Fetch a user's public CS2 weapon-skin inventory from the Steam Community API
 * and return only the items that are present in our skin catalog.
 *
 * @throws Error with a human-readable message when the inventory is
 *   private, the profile doesn't exist, or Steam returns an error.
 */
export async function fetchAndMatchInventory(
  steamId: string,
): Promise<{ matched: MatchedInventoryItem[]; totalSteamItems: number }> {
  const url =
    `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=5000`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "CS2-TradeUp-Calculator/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      "Could not reach the Steam API. Please try again in a moment.",
    );
  }

  if (response.status === 403) {
    throw new Error(
      "This Steam inventory is private. Go to Steam → Edit Profile → Privacy Settings and set Game details / Inventory to Public.",
    );
  }
  if (response.status === 404) {
    throw new Error("Steam profile not found. Double-check your SteamID64.");
  }
  if (!response.ok) {
    throw new Error(
      `Steam API returned HTTP ${response.status}. Please try again later.`,
    );
  }

  let data: SteamInventoryResponse;
  try {
    data = (await response.json()) as SteamInventoryResponse;
  } catch {
    throw new Error("Unexpected response from Steam. Please try again later.");
  }

  if (!data.success || !data.descriptions || !data.assets) {
    const detail = data.error ? ` (${data.error})` : "";
    throw new Error(`Steam returned an error${detail}. The inventory may be private or empty.`);
  }

  // Build a lookup: "classid:instanceid" → description
  const descByKey = new Map<string, SteamDescription>();
  for (const desc of data.descriptions) {
    descByKey.set(`${desc.classid}:${desc.instanceid}`, desc);
  }

  // Build a reverse-lookup for catalog matching:
  // "AK-47 | Redline (Field-Tested)" → { skinId, wear }
  const hashToEntry = new Map<string, { skinId: string; wear: Wear }>();
  for (const skin of SKINS) {
    for (const [wear, label] of Object.entries(WEAR_LABELS) as [Wear, string][]) {
      hashToEntry.set(`${skin.name} (${label})`, { skinId: skin.id, wear });
    }
  }

  const matched: MatchedInventoryItem[] = [];

  for (const asset of data.assets) {
    const desc = descByKey.get(`${asset.classid}:${asset.instanceid}`);
    if (!desc) continue;

    // Only process items that have an exterior (weapon skins)
    const wearTag = desc.tags?.find((t) => t.category === "Exterior");
    if (!wearTag) continue;

    const wear = STEAM_WEAR_MAP[wearTag.internal_name];
    if (!wear) continue;

    // Match market_hash_name against the catalog
    const entry = hashToEntry.get(desc.market_hash_name);
    if (!entry) continue;

    matched.push({
      assetId: asset.assetid,
      marketHashName: desc.market_hash_name,
      catalogSkinId: entry.skinId,
      wear,
      float: WEAR_DEFAULT_FLOATS[wear],
    });
  }

  return {
    matched,
    totalSteamItems: data.total_inventory_count ?? data.assets.length,
  };
}
