#!/usr/bin/env python3
"""Generate catalog.ts from ByMykel CSGO-API data."""

import json
import os
import re
import urllib.request

COLLECTIONS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/collections.json"
SKINS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json"

RARITY_MAP = {
    "rarity_common_weapon": "consumer_grade",
    "rarity_uncommon_weapon": "industrial_grade",
    "rarity_rare_weapon": "mil_spec",
    "rarity_mythical_weapon": "restricted",
    "rarity_legendary_weapon": "classified",
    "rarity_ancient_weapon": "covert",
    # Handle by display name as fallback
    "Consumer Grade": "consumer_grade",
    "Industrial Grade": "industrial_grade",
    "Mil-Spec Grade": "mil_spec",
    "Restricted": "restricted",
    "Classified": "classified",
    "Covert": "covert",
}

VALID_RARITIES = {
    "consumer_grade", "industrial_grade", "mil_spec",
    "restricted", "classified", "covert"
}


def fetch_json(url):
    print(f"Fetching {url}...")
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = resp.read().decode("utf-8")
    return json.loads(data)


def to_kebab(s):
    """Convert a string to kebab-case slug."""
    s = s.lower()
    s = s.replace("★ ", "")
    s = s.replace("★", "")
    s = s.replace("™", "")
    # Replace non-alphanumeric with space
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    # Collapse whitespace → hyphens
    s = re.sub(r"\s+", "-", s.strip())
    # Collapse multiple hyphens
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def collection_slug(name):
    """Generate a collection ID slug from collection name."""
    slug = name
    slug = re.sub(r"^The\s+", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"\s+Collection$", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"\s+Case$", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"\s+Package$", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"\s+Capsule$", "", slug, flags=re.IGNORECASE)
    return to_kebab(slug)


def is_knife_or_glove(name):
    """Return True if the skin name indicates knife or glove."""
    if "★" in name:
        return True
    name_lower = name.lower()
    knife_words = [
        "knife", "bayonet", "karambit", "butterfly", "falchion",
        "bowie", "flip knife", "gut knife", "huntsman", "shadow daggers",
        "stiletto", "talon", "ursus", "navaja", "paracord",
        "skeleton knife", "nomad knife", "classic knife",
    ]
    glove_words = ["gloves", "hand wraps", "wraps"]
    for kw in knife_words + glove_words:
        if kw in name_lower:
            return True
    return False


def parse_weapon_name(full_name):
    """Parse 'Weapon | Skin' → (weapon, skin)."""
    if " | " in full_name:
        parts = full_name.split(" | ", 1)
        return parts[0].strip(), parts[1].strip()
    return full_name.strip(), ""


def make_skin_id(weapon, skin, coll_slug, existing_ids):
    """Generate a unique skin ID slug."""
    base = to_kebab(f"{weapon} {skin}")
    if base not in existing_ids:
        return base
    with_col = f"{base}-{to_kebab(coll_slug)}"
    if with_col not in existing_ids:
        return with_col
    i = 2
    while True:
        candidate = f"{base}-{i}"
        if candidate not in existing_ids:
            return candidate
        i += 1


def get_rarity(rarity_obj):
    """Extract normalised rarity string from rarity object."""
    if not rarity_obj:
        return None
    rarity_id = rarity_obj.get("id", "")
    rarity_name = rarity_obj.get("name", "")
    return RARITY_MAP.get(rarity_id) or RARITY_MAP.get(rarity_name)


def main():
    collections_data = fetch_json(COLLECTIONS_URL)
    skins_data = fetch_json(SKINS_URL)

    # Build lookup maps from skins.json (has min_float / max_float)
    skins_by_id = {s["id"]: s for s in skins_data}
    skins_by_name = {s.get("name", "").lower(): s for s in skins_data}

    # Debug: show a sample collection structure
    sample = collections_data[0] if collections_data else {}
    print("Sample collection keys:", list(sample.keys()))
    print("Sample contains count:", len(sample.get("contains", [])))

    out_collections = []
    out_skins = []
    seen_coll_slugs = set()
    seen_skin_ids = set()

    # Keywords that mark a collection as non-weapon (skip it)
    skip_name_keywords = [
        "sticker", "music kit", "patch", "pin capsule",
        "autograph", "charm", "graffiti", "souvenir",
    ]

    for coll in collections_data:
        coll_name = coll.get("name", "")

        # Skip non-weapon collections
        skip = any(kw in coll_name.lower() for kw in skip_name_keywords)
        if skip:
            continue

        # 'contains' holds the weapon skins
        raw_skins = coll.get("contains", [])
        if not raw_skins:
            continue

        # Filter to weapon skins (no knives/gloves, must have " | ", valid rarity)
        valid_skins = []
        for s in raw_skins:
            skin_name = s.get("name", "")
            if is_knife_or_glove(skin_name):
                continue
            if " | " not in skin_name:
                continue
            rarity = get_rarity(s.get("rarity", {}))
            if not rarity or rarity not in VALID_RARITIES:
                continue
            valid_skins.append(s)

        if not valid_skins:
            continue

        # Generate unique collection slug
        coll_slug = collection_slug(coll_name)
        if coll_slug in seen_coll_slugs:
            base = coll_slug
            i = 2
            while coll_slug in seen_coll_slugs:
                coll_slug = f"{base}-{i}"
                i += 1
        seen_coll_slugs.add(coll_slug)

        out_collections.append({"id": coll_slug, "name": coll_name})

        for s in valid_skins:
            skin_name = s.get("name", "")
            weapon, skin = parse_weapon_name(skin_name)
            rarity = get_rarity(s.get("rarity", {}))

            # Get float ranges from skins.json
            float_min, float_max = 0.0, 1.0
            skin_id = s.get("id", "")
            detail = skins_by_id.get(skin_id) or skins_by_name.get(skin_name.lower())
            if detail:
                mf = detail.get("min_float")
                xf = detail.get("max_float")
                if mf is not None:
                    float_min = round(float(mf), 4)
                if xf is not None:
                    float_max = round(float(xf), 4)

            sid = make_skin_id(weapon, skin, coll_slug, seen_skin_ids)
            seen_skin_ids.add(sid)

            out_skins.append({
                "id": sid,
                "name": skin_name,
                "weaponName": weapon,
                "skinName": skin,
                "collectionId": coll_slug,
                "rarity": rarity,
                "minFloat": float_min,
                "maxFloat": float_max,
            })

    print(f"Generated {len(out_collections)} collections and {len(out_skins)} skins.")

    # Render TypeScript
    lines = []
    lines.append('import type { Collection, Rarity, Skin } from "./types";')
    lines.append("")
    lines.append("export const COLLECTIONS: Collection[] = [")
    for c in out_collections:
        # Escape any quotes in names
        name = c["name"].replace('"', '\\"')
        lines.append(f'  {{ id: "{c["id"]}", name: "{name}" }},')
    lines.append("];")
    lines.append("")
    lines.append("export const SKINS: Skin[] = [")

    skins_by_coll: dict[str, list] = {}
    for sk in out_skins:
        skins_by_coll.setdefault(sk["collectionId"], []).append(sk)

    for coll in out_collections:
        cid = coll["id"]
        cname = coll["name"].replace('"', '\\"')
        coll_skins = skins_by_coll.get(cid, [])
        if not coll_skins:
            continue
        lines.append(f"  // ─── {cname} ───")
        for sk in coll_skins:
            name_escaped = sk["name"].replace('"', '\\"')
            weapon_escaped = sk["weaponName"].replace('"', '\\"')
            skin_escaped = sk["skinName"].replace('"', '\\"')
            lines.append("  {")
            lines.append(f'    id: "{sk["id"]}",')
            lines.append(f'    name: "{name_escaped}",')
            lines.append(f'    weaponName: "{weapon_escaped}",')
            lines.append(f'    skinName: "{skin_escaped}",')
            lines.append(f'    collectionId: "{sk["collectionId"]}",')
            lines.append(f'    rarity: "{sk["rarity"]}",')
            lines.append(f'    minFloat: {sk["minFloat"]},')
            lines.append(f'    maxFloat: {sk["maxFloat"]},')
            lines.append(f'    stattrak: false,  // StatTrak not differentiated in the catalog')
            lines.append("  },")

    lines.append("];")
    lines.append("")
    lines.append("export function getSkinById(id: string): Skin | undefined {")
    lines.append("  return SKINS.find((s) => s.id === id);")
    lines.append("}")
    lines.append("")
    lines.append("export function getCollectionById(id: string): Collection | undefined {")
    lines.append("  return COLLECTIONS.find((c) => c.id === id);")
    lines.append("}")
    lines.append("")
    lines.append("export function getSkinsByRarity(rarity: Rarity): Skin[] {")
    lines.append("  return SKINS.filter((s) => s.rarity === rarity);")
    lines.append("}")
    lines.append("")
    lines.append("export function getSkinsByCollection(collectionId: string): Skin[] {")
    lines.append("  return SKINS.filter((s) => s.collectionId === collectionId);")
    lines.append("}")
    lines.append("")
    lines.append("export function getSkinsByCollectionAndRarity(")
    lines.append("  collectionId: string,")
    lines.append("  rarity: Rarity,")
    lines.append("): Skin[] {")
    lines.append("  return SKINS.filter(")
    lines.append("    (s) => s.collectionId === collectionId && s.rarity === rarity,")
    lines.append("  );")
    lines.append("}")
    lines.append("")

    output = "\n".join(lines)
    out_path = os.path.join(os.path.dirname(__file__), "..", "lib", "catalog.ts")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(output)
    print(f"Written to {out_path}")


if __name__ == "__main__":
    main()
