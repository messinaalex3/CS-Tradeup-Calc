import { NextRequest, NextResponse } from "next/server";
import { WEAR_LABELS, type Wear } from "@/lib/types";
import { updatePriceSnapshot, type PriceSnapshot, type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { loadCatalog } from "@/lib/catalog/dynamic";

const CS2CAP_API_BASE = "https://api.cs2c.app/v1";
const WEARS: Wear[] = ["FN", "MW", "FT", "WW", "BS"];
const DEFAULT_PROVIDER = "skinport";
const DEFAULT_REFRESH_MAX_AGE_SECONDS = 3600;
const PAGE_LIMIT = 100;

interface Cs2CapMarketItem {
    provider: string;
    market_hash_name: string;
    lowest_ask: number;
    lowest_ask_decimal?: string | null;
    quantity: number;
}

interface Cs2CapPaginatedResponse {
    items: Cs2CapMarketItem[];
    pagination: {
        limit: number;
        offset: number;
        has_next: boolean;
    };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) return false;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function getUsdPrice(item: Cs2CapMarketItem): number | null {
    if (typeof item.lowest_ask_decimal === "string") {
        const parsedDecimal = Number.parseFloat(item.lowest_ask_decimal);
        if (Number.isFinite(parsedDecimal) && parsedDecimal > 0) return parsedDecimal;
    }

    const cents = item.lowest_ask;
    if (!Number.isFinite(cents) || cents <= 0) return null;
    return cents / 100;
}

function applyItemToSnapshot(
    snapshot: PriceSnapshot,
    hashToEntry: Map<string, { skinId: string; wear: Wear }>,
    item: Cs2CapMarketItem,
): { matched: boolean; hasPrice: boolean } {
    const entry = hashToEntry.get(item.market_hash_name);
    if (!entry) return { matched: false, hasPrice: false };

    const price = getUsdPrice(item);
    if (price === null) return { matched: true, hasPrice: false };

    if (!snapshot[entry.skinId]) snapshot[entry.skinId] = {};
    const existing = snapshot[entry.skinId]?.[entry.wear];
    const existingMin =
        existing && typeof existing !== "number" && typeof existing.minPrice === "number"
            ? existing.minPrice
            : null;

    if (existingMin === null || price < existingMin) {
        snapshot[entry.skinId]![entry.wear] = {
            minPrice: price,
            maxPrice: price,
            meanPrice: price,
            suggestedPrice: price,
            quantity: Number.isFinite(item.quantity) ? item.quantity : null,
        };
    }

    return { matched: true, hasPrice: true };
}

async function fetchCs2CapSnapshotByStream(apiKey: string, provider: string): Promise<Cs2CapMarketItem[]> {
    const url = new URL(`${CS2CAP_API_BASE}/prices`);
    url.searchParams.set("providers", provider);

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey },
        signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
        throw new Error(`CS2Cap stream returned HTTP ${response.status}`);
    }
    if (!response.body) {
        throw new Error("CS2Cap stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const items: Cs2CapMarketItem[] = [];

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
                items.push(JSON.parse(line) as Cs2CapMarketItem);
            }
            newlineIndex = buffer.indexOf("\n");
        }
    }

    const trailing = buffer.trim();
    if (trailing) {
        items.push(JSON.parse(trailing) as Cs2CapMarketItem);
    }

    return items;
}

async function fetchCs2CapSnapshotByPagination(
    apiKey: string,
    provider: string,
    onItems: (items: Cs2CapMarketItem[]) => Promise<boolean>,
): Promise<{ pages: number; rows: number }> {
    let offset = 0;
    let pages = 0;
    let rows = 0;

    while (true) {
        const url = new URL(`${CS2CAP_API_BASE}/prices`);
        url.searchParams.set("providers", provider);
        url.searchParams.set("currency", "USD");
        url.searchParams.set("limit", String(PAGE_LIMIT));
        url.searchParams.set("offset", String(offset));

        const response = await fetch(url.toString(), {
            headers: { Authorization: "Bearer " + apiKey },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`CS2Cap list returned HTTP ${response.status} at offset ${offset}`);
        }

        const data = (await response.json()) as Cs2CapPaginatedResponse;
        const items = Array.isArray(data.items) ? data.items : [];
        pages++;
        rows += items.length;

        const shouldStop = await onItems(items);
        if (shouldStop || !data.pagination?.has_next || items.length === 0) {
            break;
        }
        offset = data.pagination.offset + data.pagination.limit;
    }

    return { pages, rows };
}

async function getSnapshotAgeSeconds(env: CloudflareEnv): Promise<number | null> {
    const object = await env.PRICE_SNAPSHOTS.head("latest_prices.json");
    if (!object) return null;
    const uploadedMs = object.uploaded?.getTime();
    if (!uploadedMs) return null;
    return Math.max(0, Math.floor((Date.now() - uploadedMs) / 1000));
}

interface RefreshResult {
    matched: number;
    noMatch: number;
    noPrice: number;
}

/**
 * Fetches prices from CS2Cap and saves the snapshot to Cloudflare R2.
 * Uses paginated GET by default (free-tier friendly), with optional NDJSON
 * stream mode for paid tiers.
 */
export async function GET(request: NextRequest) {
    const refreshStart = Date.now();
    console.log("[refresh] GET /api/prices/refresh — request received");

    const authHeader = request.headers.get("Authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        console.warn("[refresh] Unauthorized request blocked — invalid CRON_SECRET");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { env: rawEnv } = await getCloudflareContext();
    const env = rawEnv as unknown as CloudflareEnv;
    const refreshMaxAgeSeconds = parsePositiveInt(env.PRICE_REFRESH_MAX_AGE_SECONDS, DEFAULT_REFRESH_MAX_AGE_SECONDS);
    const provider = (env.CS2C_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
    const forceRefresh = request.nextUrl.searchParams.get("force") === "1";

    if (!forceRefresh) {
        const ageSeconds = await getSnapshotAgeSeconds(env);
        if (ageSeconds !== null && ageSeconds < refreshMaxAgeSeconds) {
            console.log(
                `[refresh] Skipping CS2Cap fetch — existing snapshot age ${ageSeconds}s is below threshold ${refreshMaxAgeSeconds}s.`,
            );
            return NextResponse.json({
                success: true,
                skipped: true,
                reason: "snapshot_fresh",
                ageSeconds,
                maxAgeSeconds: refreshMaxAgeSeconds,
            });
        }
    }

    const apiKey = env.CS2C_API_KEY;
    if (!apiKey) {
        console.error("[refresh] CS2C_API_KEY is not configured — aborting");
        return NextResponse.json(
            { error: "CS2C_API_KEY not configured — set it as a Cloudflare Worker secret" },
            { status: 503 },
        );
    }

    const { skins } = await loadCatalog(env);

    // Build a reverse-lookup: "AK-47 | Redline (Field-Tested)" → { skinId, wear }
    console.log("[refresh] Building reverse-lookup map from catalog...");
    const hashToEntry = new Map<string, { skinId: string; wear: Wear }>();
    for (const skin of skins) {
        for (const wear of WEARS) {
            const key = `${skin.name} (${WEAR_LABELS[wear]})`;
            const existing = hashToEntry.get(key);
            if (existing && existing.skinId !== skin.id) {
                // Two different catalog entries share the same market hash name.
                // The last one wins, so the first skin's ID will never get a price.
                console.warn(
                    `[refresh] Duplicate market hash name: "${key}" maps to both ` +
                    `"${existing.skinId}" and "${skin.id}" — only the latter will receive prices`,
                );
            }
            hashToEntry.set(key, { skinId: skin.id, wear });
        }
    }
    console.log(`[refresh] Map built with ${hashToEntry.size} entries.`);

    const snapshot: PriceSnapshot = {};
    const seenHashes = new Set<string>();
    const refreshStats: RefreshResult = { matched: 0, noMatch: 0, noPrice: 0 };
    let streamedRows = 0;
    let pagedRows = 0;
    let pagedPages = 0;

    const processItems = async (items: Cs2CapMarketItem[]): Promise<boolean> => {
        for (const item of items) {
            const result = applyItemToSnapshot(snapshot, hashToEntry, item);
            if (!result.matched) {
                refreshStats.noMatch++;
                continue;
            }
            seenHashes.add(item.market_hash_name);
            if (!result.hasPrice) {
                refreshStats.noPrice++;
                continue;
            }
            refreshStats.matched++;
        }
        return seenHashes.size >= hashToEntry.size;
    };

    const useStream = parseBoolean(env.CS2C_ENABLE_STREAM);
    console.log(
        `[refresh] Fetching prices from CS2Cap using provider "${provider}" (${useStream ? "stream" : "paginated"} mode).`,
    );

    try {
        const fetchStart = Date.now();
        if (useStream) {
            const streamItems = await fetchCs2CapSnapshotByStream(apiKey, provider);
            streamedRows = streamItems.length;
            await processItems(streamItems);
            console.log(`[refresh] CS2Cap stream responded in ${Date.now() - fetchStart}ms — received ${streamItems.length} row(s).`);
        } else {
            const pageResult = await fetchCs2CapSnapshotByPagination(apiKey, provider, processItems);
            pagedRows = pageResult.rows;
            pagedPages = pageResult.pages;
            console.log(
                `[refresh] CS2Cap paginated fetch completed in ${Date.now() - fetchStart}ms — ` +
                `${pageResult.rows} row(s) across ${pageResult.pages} page(s).`,
            );
        }
    } catch (err) {
        console.error(`[refresh] Failed to fetch from CS2Cap: ${err instanceof Error ? err.message : String(err)}`);
        return NextResponse.json({ error: "Failed to fetch prices from CS2Cap" }, { status: 502 });
    }

    console.log(
        `[refresh] Processing done — ${refreshStats.matched} prices matched, ` +
        `${refreshStats.noMatch} items ignored (no catalog match), ${refreshStats.noPrice} items ignored (missing prices).`,
    );

    try {
        console.log("[refresh] Updating price snapshot in R2 storage...");
        const storageStart = Date.now();
        await updatePriceSnapshot(env, snapshot);
        console.log(`[refresh] R2 storage updated in ${Date.now() - storageStart}ms.`);

        const totalDuration = Date.now() - refreshStart;
        console.log(`[refresh] Successfully completed in ${totalDuration}ms total.`);

        return NextResponse.json({
            success: true,
            source: "cs2cap",
            provider,
            streamMode: useStream,
            matchedCount: refreshStats.matched,
            ignoredNoMatch: refreshStats.noMatch,
            ignoredNoPrice: refreshStats.noPrice,
            rowsFetched: useStream ? streamedRows : pagedRows,
            pagesFetched: useStream ? null : pagedPages,
            matchedHashes: seenHashes.size,
            totalRequiredHashes: hashToEntry.size,
            durationMs: totalDuration
        });
    } catch (err) {
        console.error(`[refresh] Failed to update R2 snapshot: ${err instanceof Error ? err.message : String(err)}`);
        return NextResponse.json({ error: "Storage failure" }, { status: 500 });
    }
}
