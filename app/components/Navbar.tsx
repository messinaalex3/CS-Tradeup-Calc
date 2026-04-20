import Link from "next/link";

export default function Navbar() {
  return (
    <nav className="bg-zinc-900 border-b border-zinc-700 px-4 py-3">
      <div className="max-w-6xl mx-auto flex items-center gap-6">
        <Link href="/" className="text-orange-400 font-bold text-lg tracking-tight">
          CS2 Trade-up Calc
        </Link>
        <Link
          href="/calculator"
          className="text-zinc-300 hover:text-white text-sm transition-colors"
        >
          Calculator
        </Link>
        <Link
          href="/profitable"
          className="text-zinc-300 hover:text-white text-sm transition-colors"
        >
          Profitable Trade-ups
        </Link>
      </div>
    </nav>
  );
}
