// One click from insight to draft — matches the pattern already proven in
// Action Center, just without a separate page visit. `item` is the same
// shape buildRecommendations() returns (routes/action-center.js).
export default function ActionRow({ item, generating, onGenerate }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-800 truncate">{item.tag}</p>
        <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{item.reason}</p>
      </div>
      <button
        type="button"
        onClick={() => onGenerate(item)}
        disabled={generating}
        className="shrink-0 text-xs font-semibold px-3.5 py-2 rounded-lg text-white transition disabled:opacity-60
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
        style={{ background: '#6C63FF' }}
      >
        {generating ? 'Generating…' : 'Generate draft'}
      </button>
    </div>
  );
}
