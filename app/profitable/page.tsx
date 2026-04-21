"use client";

import { useState, useEffect } from "react";
import type { Rarity } from "@/lib/types";
import { RARITY_LABELS, RARITY_COLORS, WEAR_LABELS } from "@/lib/types";
import type { Wear } from "@/lib/types";

interface ProfitableContract {
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

interface ProfitableResponse {
  contracts: ProfitableContract[];
  total: number;
  scannedRarities: string[];
}

function formatPrice(price: number | null): string {
  if (price === null) return "N/A";
  return `$${price.toFixed(2)}`;
}

function RoiBadge({ roi }: { roi: number }) {
  const color =
    roi > 15
      ? "bg-green-500"
      : roi > 0
        ? "bg-yellow-500"
        : "bg-red-500";
  return (
    <span className={`${color} text-white text-xs font-bold px-2 py-0.5 rounded`}>
      {roi > 0 ? "+" : ""}{roi.toFixed(1)}%
    </span>
  );
}

export default function ProfitablePage() {
  const [data, setData] = useState<ProfitableResponse | null>(null);
  const [loading, setLoading] = useState(true); // true on initial load
  const [error, setError] = useState<string | null>(null);
  const [rarityFilter, setRarityFilter] = useState<Rarity | "">("");
  const [maxBudget, setMaxBudget] = useState<string>("");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const scan = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setExpandedIndex(null);
    try {
      const params = new URLSearchParams();
      if (rarityFilter) params.set("rarity", rarityFilter);
      if (maxBudget) params.set("maxBudget", maxBudget);
      const res = await fetch(`/api/tradeups/profitable?${params.toString()}`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const json = (await res.json()) as ProfitableResponse;
      setData(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Kick off a scan on first load — async IIFE avoids synchronous setState in effect
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tradeups/profitable");
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const json = (await res.json()) as ProfitableResponse;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scannableRarities: Rarity[] = [
    "industrial_grade",
    "mil_spec",
    "restricted",
    "classified",
  ];

  return (
    <main className="max-w-5xl mx-auto w-full px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-1">
        Profitable Trade-ups
      </h1>
      <p className="text-zinc-400 text-sm mb-6">
        Automatically scanned trade-up contracts ranked by ROI. Prices are
        sourced from Skinport and refreshed hourly.
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end mb-6">
        <div>
          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Rarity
          </label>
          <select
            value={rarityFilter}
            onChange={(e) => setRarityFilter(e.target.value as Rarity | "")}
            className="bg-zinc-800 text-zinc-200 text-sm rounded px-3 py-2 border border-zinc-700 focus:outline-none focus:border-orange-500"
          >
            <option value="">All rarities</option>
            {scannableRarities.map((r) => (
              <option key={r} value={r}>
                {RARITY_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Max Budget (USD)
          </label>
          <input
            type="number"
            min="0"
            step="1"
            value={maxBudget}
            onChange={(e) => setMaxBudget(e.target.value)}
            placeholder="No limit"
            className="bg-zinc-800 text-zinc-200 text-sm rounded px-3 py-2 border border-zinc-700 focus:outline-none focus:border-orange-500 w-32"
          />
        </div>
        <button
          onClick={() => scan()}
          disabled={loading}
          className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg transition-colors"
        >
          {loading ? "Scanning…" : "Scan Now"}
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-zinc-400 text-sm">
          Scanning trade-up contracts… This may take a moment.
        </div>
      )}

      {data && !loading && (
        <>
          <p className="text-zinc-500 text-xs mb-4">
            Found {data.contracts.length} profitable contract
            {data.contracts.length !== 1 ? "s" : ""} across{" "}
            {data.scannedRarities.join(", ")}.
          </p>

          {data.contracts.length === 0 && (
            <div className="bg-zinc-900 rounded-xl p-8 text-center text-zinc-500 border border-zinc-800">
              No profitable contracts found with current filters.
            </div>
          )}

          <div className="space-y-3">
            {data.contracts.map((contract, i) => (
              <div
                key={i}
                className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden"
              >
                {/* Contract header */}
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
                    <span className="text-zinc-400 text-sm">
                      10×{" "}
                      {contract.inputs[0]?.skinName ??
                        contract.inputs[0]?.skinId}
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
                      <div className="text-zinc-500 text-xs">Profit chance</div>
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
                        Inputs
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {contract.inputs.map((inp, j) => (
                          <span
                            key={j}
                            className="bg-zinc-800 text-zinc-300 text-xs rounded px-2 py-1"
                          >
                            {inp.skinName} ({WEAR_LABELS[inp.wear]},{" "}
                            {inp.float.toFixed(2)})
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
    </main>
  );
}
