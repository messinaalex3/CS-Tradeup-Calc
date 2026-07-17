export interface ContractInputLike {
    skinName?: string | null;
    skinId?: string | null;
}

export function summarizeContractInputs(inputs: ContractInputLike[]): string {
    const counts = new Map<string, { name: string; count: number }>();

    for (const input of inputs) {
        const name = input.skinName?.trim() || input.skinId?.trim() || "Unknown skin";
        const existing = counts.get(name);
        if (existing) {
            existing.count += 1;
        } else {
            counts.set(name, { name, count: 1 });
        }
    }

    const entries = [...counts.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );

    if (entries.length === 0) return "No inputs";
    if (entries.length === 1) {
        const entry = entries[0];
        return `${entry.count}× ${entry.name}`;
    }

    return entries.map(({ count, name }) => `${count}× ${name}`).join(" + ");
}
