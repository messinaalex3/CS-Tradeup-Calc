"use client";

import { useState, useCallback } from "react";
import type { Rarity } from "@/lib/types";
import { RARITY_LABELS, RARITY_COLORS, WEAR_LABELS } from "@/lib/types";
import type { Wear } from "@/lib/types";

interface InventoryRecommendation {
  rarity: Rarity;
  totalCost: number;
  ev: number;
  roi: number;
  guaranteedProfit: boolean;
  chanceToProfit: number;
  minOutput: number;
  maxOutput: number;
  inputs: Array<{ skinId: string; skinName: string; float: number }>;
  outputs: Array<{
    skinId: string;
    skinName: string;
    collectionName: string;
    probability: number;
    outputFloat: number;
    wear: Wear;
    estimatedPrice: number | null;
  }>;
}

interface InventoryResponse {
  steamId: string;
  totalSteamItems: number;
  matchedItems: number;
  inventorySummary: Record<string, number>;
  recommendations: InventoryRecommendation[];
  floatNote: string;
  error?: string;
}

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "N/A";
  return `$${price.toFixed(2)}`;
}

function RoiBadge({ roi }: { roi: number }) {
  const pct = (roi - 1) * 100;
  const color =
    pct > 10 ? "bg-green-500" : pct > 0 ? "bg-yellow-500" : "bg-red-500";
  return (
    <span
      className={`${color} text-white text-xs font-bold px-2 py-0.5 rounded`}
    >
      {pct > 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

export default function InventoryPage() {
  const [profileUrl, setProfileUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const handleLoad = useCallback(async () => {
    if (!profileUrl.trim()) {
      setError("Please enter your Steam profile URL or SteamID64.");
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);
    setExpandedIndex(null);

    try {
      const res = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileUrl: profileUrl.trim() }),
      });
      const json = (await res.json()) as InventoryResponse;
      if (!res.ok) {
        setError(json.error ?? "An unexpected error occurred.");
      } else {
        setData(json);
      }
    } catch {
      setError("Failed to load inventory. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [profileUrl]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleLoad();
  };

  return (
    <main className="max-w-5xl mx-auto w-full px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-1">
        Inventory Trade-up Recommendations
      </h1>
      <p className="text-zinc-400 text-sm mb-6">
        Paste your Steam profile URL and we&apos;ll recommend the best trade-up
        contracts using items already in your inventory.
      </p>

      {/* Input */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          value={profileUrl}
          onChange={(e) => setProfileUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="https://steamcommunity.com/profiles/76561198XXXXXXXXX"
          className="flex-1 bg-zinc-800 text-zinc-200 text-sm rounded px-4 py-2.5 border border-zinc-700 focus:outline-none focus:border-orange-500 placeholder:text-zinc-600"
        />
        <button
          onClick={handleLoad}
          disabled={loading}
          className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors shrink-0"
        >
          {loading ? "Loading…" : "Load Inventory"}
        </button>
      </div>

      {/* Help text */}
      <p className="text-zinc-500 text-xs mb-6">
        Your Steam inventory must be{" "}
        <strong className="text-zinc-400">public</strong>. Find your SteamID64
        at{" "}
        <a
          href="https://www.steamidfinder.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-orange-400 hover:underline"
        >
          steamidfinder.com
        </a>
        . Vanity URLs (e.g. /id/username) are not supported — use the{" "}
        <code className="bg-zinc-800 px-1 rounded text-zinc-300">/profiles/</code>{" "}
        format instead.
      </p>

      {error && (
        <div className="mb-6 bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-zinc-400 text-sm">
          Fetching your Steam inventory and evaluating trade-ups…
        </div>
      )}

      {data && !loading && (
        <>
          {/* Inventory summary */}
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-5 mb-6">
            <h2 className="text-sm font-semibold text-white mb-3">
              Inventory Summary
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div>
                <div className="text-xs text-zinc-500 mb-0.5">
                  Total CS2 Items
                </div>
                <div className="text-lg font-bold text-white">
                  {data.totalSteamItems.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-0.5">
                  Catalog Matches
                </div>
                <div className="text-lg font-bold text-white">
                  {data.matchedItems.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Items by rarity */}
            <div className="flex flex-wrap gap-3">
              {Object.entries(data.inventorySummary).map(([rarity, count]) => (
                <div key={rarity} className="text-xs">
                  <span className={`font-medium ${RARITY_COLORS[rarity as Rarity]}`}>
                    {RARITY_LABELS[rarity as Rarity]}
                  </span>
                  <span className="text-zinc-500 ml-1">
                    {count} item{count !== 1 ? "s" : ""}
                    {count >= 10 && (
                      <span className="ml-1 text-green-400">✓ trade-up eligible</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Float note */}
          <p className="text-zinc-600 text-xs mb-4 italic">{data.floatNote}</p>

          {/* Recommendations */}
          {data.recommendations.length === 0 ? (
            <div className="bg-zinc-900 rounded-xl p-8 text-center text-zinc-500 border border-zinc-800">
              <p className="mb-2">No profitable trade-up recommendations found.</p>
              <p className="text-xs">
                You need at least 10 items of the same rarity (Industrial Grade
                through Classified) in your inventory for a trade-up.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-white mb-3">
                Recommended Trade-ups ({data.recommendations.length})
              </h2>
              <div className="space-y-3">
                {data.recommendations.map((contract, i) => (
                  <div
                    key={i}
                    className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden"
                  >
                    {/* Header */}
                    <button
                      className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-800/50 transition-colors text-left"
                      onClick={() =>
                        setExpandedIndex(expandedIndex === i ? null : i)
                      }
                    >
                      <div className="flex items-center gap-3 flex-wrap">
                        <RoiBadge roi={contract.roi} />
                        {contract.guaranteedProfit && (
                          <span className="bg-green-700 text-green-100 text-xs px-2 py-0.5 rounded font-semibold">
                            Guaranteed ✅
                          </span>
                        )}
                        <span
                          className={`text-xs font-medium ${RARITY_COLORS[contract.rarity]}`}
                        >
                          {RARITY_LABELS[contract.rarity]}
                        </span>
                        <span className="text-zinc-400 text-sm truncate max-w-xs">
                          {contract.inputs[0]?.skinName}
                          {new Set(contract.inputs.map((i) => i.skinId)).size >
                            1 && " + …"}
                        </span>
                      </div>
                      <div className="flex items-center gap-6 text-sm shrink-0 ml-4">
                        <div className="text-right">
                          <div className="text-zinc-500 text-xs">Cost</div>
                          <div className="text-white font-medium">
                            {formatPrice(contract.totalCost)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-zinc-500 text-xs">EV</div>
                          <div className="text-white font-medium">
                            {formatPrice(contract.ev)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-zinc-500 text-xs">
                            Profit chance
                          </div>
                          <div className="text-white font-medium">
                            {(contract.chanceToProfit * 100).toFixed(1)}%
                          </div>
                        </div>
                        <span className="text-zinc-600">
                          {expandedIndex === i ? "▲" : "▼"}
                        </span>
                      </div>
                    </button>

                    {/* Expanded details */}
                    {expandedIndex === i && (
                      <div className="px-5 pb-5 border-t border-zinc-800">
                        <div className="mt-4">
                          <h3 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                            Inputs (from your inventory)
                          </h3>
                          <div className="flex flex-wrap gap-2">
                            {contract.inputs.map((inp, j) => (
                              <span
                                key={j}
                                className="bg-zinc-800 text-zinc-300 text-xs rounded px-2 py-1"
                              >
                                {inp.skinName} (float ~{inp.float.toFixed(3)})
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="mt-4">
                          <h3 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                            Potential Outputs
                          </h3>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {contract.outputs.map((out, j) => (
                              <div
                                key={j}
                                className="bg-zinc-800/50 rounded p-2 flex items-center justify-between text-xs"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="text-zinc-200 truncate">
                                    {out.skinName}
                                  </div>
                                  <div className="text-zinc-500">
                                    {WEAR_LABELS[out.wear]} ·{" "}
                                    {(out.probability * 100).toFixed(1)}%
                                  </div>
                                </div>
                                <div
                                  className={`font-semibold ml-3 ${out.estimatedPrice !== null &&
                                      out.estimatedPrice > contract.totalCost
                                      ? "text-green-400"
                                      : "text-red-400"
                                    }`}
                                >
                                  {formatPrice(out.estimatedPrice)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
