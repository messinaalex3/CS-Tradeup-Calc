import type { Collection, Skin, Rarity } from "../types";
import type { CloudflareEnv } from "../storage";
import { getCachedCatalog, setCachedCatalog } from "../storage";
import { COLLECTIONS as STATIC_COLLECTIONS, SKINS as STATIC_SKINS } from "../catalog";

const COLLECTIONS_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/collections.json";
const SKINS_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json";

export interface CatalogSnapshot {
  collections: Collection[];
  skins: Skin[];
  cachedAt: string;
}

const RARITY_MAP: Record<string, Rarity> = {
  rarity_common_weapon: "consumer_grade",
  rarity_uncommon_weapon: "industrial_grade",
  rarity_rare_weapon: "mil_spec",
  rarity_mythical_weapon: "restricted",
  rarity_legendary_weapon: "classified",
  rarity_ancient_weapon: "covert",
  "Consumer Grade": "consumer_grade",
  "Industrial Grade": "industrial_grade",
  "Mil-Spec Grade": "mil_spec",
  Restricted: "restricted",
  Classified: "classified",
  Covert: "covert",
};

const VALID_RARITIES = new Set<string>([
  "consumer_grade",
  "industrial_grade",
  "mil_spec",
  "restricted",
  "classified",
  "covert",
]);

const SKIP_NAME_KEYWORDS = [
  "sticker",
  "music kit",
  "patch",
  "pin capsule",
  "autograph",
  "charm",
  "graffiti",
  "souvenir",
];

function toKebab(s: string): string {
  s = s.toLowerCase();
  s = s.replace(/★ /g, "").replace(/★/g, "").replace(/™/g, "");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, "-").trim();
  s = s.replace(/-+/g, "-");
  return s.replace(/^-|-$/g, "");
}

function collectionSlug(name: string): string {
  let slug = name;
  slug = slug.replace(/^The\s+/i, "");
  slug = slug.replace(/\s+Collection$/i, "");
  slug = slug.replace(/\s+Case$/i, "");
  slug = slug.replace(/\s+Package$/i, "");
  slug = slug.replace(/\s+Capsule$/i, "");
  return toKebab(slug);
}

function isKnifeOrGlove(name: string): boolean {
  if (name.includes("★")) return true;
  const lower = name.toLowerCase();
  const keywords = [
    "knife",
    "bayonet",
    "karambit",
    "butterfly",
    "falchion",
    "bowie",
    "flip knife",
    "gut knife",
    "huntsman",
    "shadow daggers",
    "stiletto",
    "talon",
    "ursus",
    "navaja",
    "paracord",
    "skeleton knife",
    "nomad knife",
    "classic knife",
    "gloves",
    "hand wraps",
    "wraps",
  ];
  return keywords.some((kw) => lower.includes(kw));
}

function parseWeaponName(fullName: string): [string, string] {
  if (fullName.includes(" | ")) {
    const [weapon, skin] = fullName.split(" | ", 2);
    return [weapon.trim(), skin.trim()];
  }
  return [fullName.trim(), ""];
}

function getRarity(rarityObj: { id?: string; name?: string } | null): Rarity | null {
  if (!rarityObj) return null;
  const id = rarityObj.id ?? "";
  const name = rarityObj.name ?? "";
  return RARITY_MAP[id] ?? RARITY_MAP[name] ?? null;
}

function makeSkinId(weapon: string, skin: string, collSlug: string, existingIds: Set<string>): string {
  const base = toKebab(`${weapon} ${skin}`);
  if (!existingIds.has(base)) return base;
  const withCol = `${base}-${toKebab(collSlug)}`;
  if (!existingIds.has(withCol)) return withCol;
  let i = 2;
  while (true) {
    const candidate = `${base}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
    i++;
  }
}

interface ApiSkin {
  id?: string;
  name?: string;
  rarity?: { id?: string; name?: string };
  min_float?: number | null;
  max_float?: number | null;
}

interface ApiCollection {
  name?: string;
  contains?: ApiSkin[];
}

async function fetchJson(url: string): Promise<unknown[]> {
  const response = await fetch(url, {
    headers: { "User-Agent": "CS2-TradeUp-Calculator/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown[]>;
}

/**
 * Fetches catalog data from the ByMykel CSGO-API, processes it, stores it in
 * KV, and returns the snapshot.
 */
export async function refreshCatalogFromApi(env: CloudflareEnv): Promise<CatalogSnapshot> {
  const [collectionsRaw, skinsRaw] = await Promise.all([
    fetchJson(COLLECTIONS_URL),
    fetchJson(SKINS_URL),
  ]);

  const collectionsData = collectionsRaw as ApiCollection[];
  const skinsData = skinsRaw as ApiSkin[];

  const skinById = new Map<string, ApiSkin>();
  const skinByName = new Map<string, ApiSkin>();
  for (const s of skinsData) {
    if (s.id) skinById.set(s.id, s);
    if (s.name) skinByName.set(s.name.toLowerCase(), s);
  }

  const outCollections: Collection[] = [];
  const outSkins: Skin[] = [];
  const seenCollSlugs = new Set<string>();
  const seenSkinIds = new Set<string>();

  for (const coll of collectionsData) {
    const collName = coll.name ?? "";

    if (SKIP_NAME_KEYWORDS.some((kw) => collName.toLowerCase().includes(kw))) {
      continue;
    }

    const rawSkins = coll.contains ?? [];
    if (rawSkins.length === 0) continue;

    const validSkins = rawSkins.filter((s) => {
      const skinName = s.name ?? "";
      if (isKnifeOrGlove(skinName)) return false;
      if (!skinName.includes(" | ")) return false;
      const rarity = getRarity(s.rarity ?? null);
      return rarity !== null && VALID_RARITIES.has(rarity);
    });

    if (validSkins.length === 0) continue;

    let slug = collectionSlug(collName);
    if (seenCollSlugs.has(slug)) {
      const base = slug;
      let i = 2;
      while (seenCollSlugs.has(slug)) {
        slug = `${base}-${i}`;
        i++;
      }
    }
    seenCollSlugs.add(slug);
    outCollections.push({ id: slug, name: collName });

    for (const s of validSkins) {
      const skinName = s.name ?? "";
      const [weapon, skinPart] = parseWeaponName(skinName);
      const rarity = getRarity(s.rarity ?? null) as Rarity;

      let minFloat = 0.0;
      let maxFloat = 1.0;

      const detail = (s.id ? skinById.get(s.id) : undefined) ?? skinByName.get(skinName.toLowerCase());
      if (detail) {
        if (detail.min_float != null) minFloat = Math.round(Number(detail.min_float) * 10000) / 10000;
        if (detail.max_float != null) maxFloat = Math.round(Number(detail.max_float) * 10000) / 10000;
      }

      const sid = makeSkinId(weapon, skinPart, slug, seenSkinIds);
      seenSkinIds.add(sid);

      outSkins.push({
        id: sid,
        name: skinName,
        weaponName: weapon,
        skinName: skinPart,
        collectionId: slug,
        rarity,
        minFloat,
        maxFloat,
        stattrak: false,
      });
    }
  }

  const cachedAt = new Date().toISOString();
  const snapshot: CatalogSnapshot = { collections: outCollections, skins: outSkins, cachedAt };

  await setCachedCatalog(env, JSON.stringify(snapshot));

  return snapshot;
}

/**
 * Loads the catalog: tries KV cache first, falls back to API refresh, then
 * falls back to the static catalog if everything fails.
 */
export async function loadCatalog(env: CloudflareEnv): Promise<CatalogSnapshot> {
  // 1. Try KV cache
  try {
    const cached = await getCachedCatalog(env);
    if (cached) {
      const parsed = JSON.parse(cached) as CatalogSnapshot;
      if (
        Array.isArray(parsed.collections) &&
        Array.isArray(parsed.skins) &&
        parsed.skins.length > 0
      ) {
        return parsed;
      }
    }
  } catch {
    // KV unavailable or corrupted — fall through
  }

  // 2. Try live API refresh
  try {
    return await refreshCatalogFromApi(env);
  } catch (err) {
    console.warn(
      `[catalog] Failed to refresh catalog from API, falling back to static catalog: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. Static fallback
  return {
    collections: STATIC_COLLECTIONS,
    skins: STATIC_SKINS,
    cachedAt: new Date().toISOString(),
  };
}
