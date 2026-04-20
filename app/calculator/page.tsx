"use client";

import { useState, useCallback } from "react";
import type { EvaluationResult, Rarity } from "@/lib/types";
import {
  RARITY_ORDER,
  RARITY_LABELS,
  WEAR_LABELS,
} from "@/lib/types";
import { SKINS, COLLECTIONS } from "@/lib/catalog";

interface InputSlot {
  skinId: string;
  float: string; // string for input control
}

const DEFAULT_FLOAT = "0.20";
const REQUIRED_INPUTS = 10;

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

export default function CalculatorPage() {
  const [selectedRarity, setSelectedRarity] = useState<Rarity>("mil_spec");
  const [inputs, setInputs] = useState<InputSlot[]>(
    Array.from({ length: REQUIRED_INPUTS }, () => ({
      skinId: "",
      float: DEFAULT_FLOAT,
    })),
  );
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableSkins = SKINS.filter(
    (s) =>
      s.rarity === selectedRarity &&
      s.rarity !== "covert",
  ).sort((a, b) => a.name.localeCompare(b.name));

  const handleRarityChange = (rarity: Rarity) => {
    setSelectedRarity(rarity);
    setInputs(
      Array.from({ length: REQUIRED_INPUTS }, () => ({
        skinId: "",
        float: DEFAULT_FLOAT,
      })),
    );
    setResult(null);
    setError(null);
  };

  const updateSlot = (index: number, field: keyof InputSlot, value: string) => {
    setInputs((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setResult(null);
  };

  const fillAll = (skinId: string) => {
    setInputs(
      Array.from({ length: REQUIRED_INPUTS }, () => ({
        skinId,
        float: DEFAULT_FLOAT,
      })),
    );
    setResult(null);
  };

  const handleEvaluate = useCallback(async () => {
    setError(null);
    setResult(null);

    const filled = inputs.filter((s) => s.skinId !== "");
    if (filled.length !== REQUIRED_INPUTS) {
      setError(`Please fill all ${REQUIRED_INPUTS} input slots.`);
      return;
    }

    const parsedInputs = inputs.map((slot) => ({
      skinId: slot.skinId,
      float: parseFloat(slot.float),
    }));

    const invalid = parsedInputs.find(
      (i) => isNaN(i.float) || i.float < 0 || i.float > 1,
    );
    if (invalid) {
      setError("All float values must be between 0 and 1.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/tradeups/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: parsedInputs }),
      });
      const data = (await res.json()) as EvaluationResult;
      setResult(data);
    } catch {
      setError("Failed to evaluate trade-up. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [inputs]);

  const selectableRarities = RARITY_ORDER.filter((r) => r !== "covert");

  return (
    <main className="max-w-6xl mx-auto w-full px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-1">Trade-up Calculator</h1>
      <p className="text-zinc-400 text-sm mb-6">
        Select 10 items of the same rarity, set their float values, and evaluate
        the expected value of your trade-up contract.
      </p>

      {/* Rarity selector */}
      <div className="mb-6">
        <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">
          Input Rarity
        </label>
        <div className="flex flex-wrap gap-2">
          {selectableRarities.map((r) => (
            <button
              key={r}
              onClick={() => handleRarityChange(r)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selectedRarity === r
                  ? "bg-orange-500 text-white"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {RARITY_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {/* Quick-fill */}
      {availableSkins.length > 0 && (
        <div className="mb-6">
          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">
            Quick-fill all slots with:
          </label>
          <div className="flex flex-wrap gap-2">
            {availableSkins.map((s) => (
              <button
                key={s.id}
                onClick={() => fillAll(s.id)}
                className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded transition-colors"
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input slots */}
      <div className="mb-6">
        <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">
          Input Items (10 required)
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          {inputs.map((slot, i) => (
            <div
              key={i}
              className="flex gap-2 items-center bg-zinc-900 rounded-lg p-3 border border-zinc-800"
            >
              <span className="text-zinc-600 text-xs w-4 shrink-0">{i + 1}</span>
              <select
                value={slot.skinId}
                onChange={(e) => updateSlot(i, "skinId", e.target.value)}
                className="flex-1 bg-zinc-800 text-zinc-200 text-sm rounded px-2 py-1.5 border border-zinc-700 focus:outline-none focus:border-orange-500 min-w-0"
              >
                <option value="">— Select skin —</option>
                {COLLECTIONS.map((col) => {
                  const colSkins = availableSkins.filter(
                    (s) => s.collectionId === col.id,
                  );
                  if (colSkins.length === 0) return null;
                  return (
                    <optgroup key={col.id} label={col.name}>
                      {colSkins.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={slot.float}
                onChange={(e) => updateSlot(i, "float", e.target.value)}
                className="w-20 shrink-0 bg-zinc-800 text-zinc-200 text-sm rounded px-2 py-1.5 border border-zinc-700 focus:outline-none focus:border-orange-500"
                placeholder="Float"
              />
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      <button
        onClick={handleEvaluate}
        disabled={loading}
        className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-lg transition-colors mb-8"
      >
        {loading ? "Evaluating…" : "Evaluate Trade-up"}
      </button>

      {/* Results */}
      {result && (
        <div>
          {!result.valid ? (
            <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-3">
              {result.error}
            </div>
          ) : (
            <div>
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                  <div className="text-xs text-zinc-500 mb-1">Total Cost</div>
                  <div className="text-xl font-bold text-white">
                    {formatPrice(result.totalCost)}
                  </div>
                </div>
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                  <div className="text-xs text-zinc-500 mb-1">Expected Value</div>
                  <div className="text-xl font-bold text-white">
                    {formatPrice(result.ev)}
                  </div>
                </div>
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                  <div className="text-xs text-zinc-500 mb-1">ROI</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <RoiBadge roi={result.roi} />
                  </div>
                </div>
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                  <div className="text-xs text-zinc-500 mb-1">Chance to Profit</div>
                  <div className="text-xl font-bold text-white">
                    {(result.chanceToProfit * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              {result.guaranteedProfit && (
                <div className="mb-4 bg-green-900/40 border border-green-700 text-green-300 text-sm rounded-lg px-4 py-3 font-semibold">
                  ✅ Guaranteed profit — every possible output is worth more than the input cost!
                </div>
              )}

              <div className="mb-2 flex items-center gap-4 text-xs text-zinc-500">
                <span>Min output: {formatPrice(result.minOutput)}</span>
                <span>Max output: {formatPrice(result.maxOutput)}</span>
              </div>

              {/* Output pool table */}
              <h2 className="text-lg font-semibold text-white mb-3">
                Possible Outputs
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-zinc-500 text-xs uppercase border-b border-zinc-800">
                      <th className="pb-2 pr-4">Item</th>
                      <th className="pb-2 pr-4">Collection</th>
                      <th className="pb-2 pr-4">Float</th>
                      <th className="pb-2 pr-4">Wear</th>
                      <th className="pb-2 pr-4">Probability</th>
                      <th className="pb-2">Est. Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.outputs.map((out, i) => (
                      <tr
                        key={i}
                        className="border-b border-zinc-800/50 hover:bg-zinc-900/50"
                      >
                        <td className="py-2 pr-4 font-medium text-zinc-200">
                          {out.skinName}
                        </td>
                        <td className="py-2 pr-4 text-zinc-400">
                          {out.collectionName}
                        </td>
                        <td className="py-2 pr-4 text-zinc-400 font-mono text-xs">
                          {out.outputFloat.toFixed(4)}
                        </td>
                        <td className="py-2 pr-4 text-zinc-400">{WEAR_LABELS[out.wear]}</td>
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <div className="w-16 bg-zinc-800 rounded-full h-1.5">
                              <div
                                className="bg-orange-500 h-1.5 rounded-full"
                                style={{
                                  width: `${(out.probability * 100).toFixed(1)}%`,
                                }}
                              />
                            </div>
                            <span className="text-zinc-300 text-xs">
                              {(out.probability * 100).toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td className="py-2 text-zinc-200 font-medium">
                          {formatPrice(out.estimatedPrice)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
