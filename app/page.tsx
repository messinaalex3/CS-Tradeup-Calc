import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <h1 className="text-4xl font-bold text-white mb-4">
        CS2 Trade-up Calculator
      </h1>
      <p className="text-zinc-400 text-lg max-w-xl mb-10">
        Look up real-time Steam Market prices for CS2 skins and find the most
        profitable trade-up contracts.
      </p>
      <div className="flex flex-col sm:flex-row gap-4">
        <Link
          href="/calculator"
          className="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
        >
          Open Calculator
        </Link>
        <Link
          href="/profitable"
          className="bg-zinc-700 hover:bg-zinc-600 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
        >
          Browse Profitable Trade-ups
        </Link>
      </div>
      <div className="mt-16 grid sm:grid-cols-3 gap-6 max-w-3xl w-full text-left">
        <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
          <div className="text-2xl mb-2">🔍</div>
          <h3 className="font-semibold text-white mb-1">Live Price Lookup</h3>
          <p className="text-zinc-400 text-sm">
            Fetches current lowest listing prices directly from the Steam
            Community Market.
          </p>
        </div>
        <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
          <div className="text-2xl mb-2">🧮</div>
          <h3 className="font-semibold text-white mb-1">EV &amp; ROI</h3>
          <p className="text-zinc-400 text-sm">
            Calculates Expected Value, Return on Investment, and chance to
            profit for any 10-item trade-up.
          </p>
        </div>
        <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
          <div className="text-2xl mb-2">📈</div>
          <h3 className="font-semibold text-white mb-1">Top Contracts</h3>
          <p className="text-zinc-400 text-sm">
            Automatically scans the catalog to surface the highest-ROI
            trade-up contracts available right now.
          </p>
        </div>
      </div>
    </main>
  );
}
