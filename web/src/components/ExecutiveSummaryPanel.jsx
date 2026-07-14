// AI Executive Summary — upgrade of NarrativePanel styling. `text` is always
// the narrative generated specifically for the selected Daily/Weekly/Monthly
// period (never a different period's narrative relabeled), or blank if that
// period's report hasn't been generated yet.
export default function ExecutiveSummaryPanel({ text, source, generatedAt }) {
  const label = source === 'executive-report' ? 'AI Executive Summary' : 'AI Summary';
  const sub = generatedAt
    ? `Generated ${new Date(generatedAt).toLocaleDateString()}`
    : 'written by your analytics agent';

  return (
    <div className="relative card overflow-hidden fade-up">
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: '#6C63FF' }} />
      <div className="p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl grid place-items-center text-white shrink-0 shadow-md shadow-indigo-500/30"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            <SparkIcon />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-slate-800">{label}</div>
            <div className="text-[11px] text-slate-400">{sub}</div>
          </div>
          <span className="ml-auto text-[10px] font-bold tracking-wide px-2 py-1 rounded-full"
            style={{ background: 'rgba(108,99,255,0.1)', color: '#6C63FF' }}>AI</span>
        </div>
        <p className="text-[15px] leading-relaxed text-slate-700 whitespace-pre-line">
          {text || 'Report generating — check back after today\'s update.'}
        </p>
      </div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" fill="currentColor" stroke="none" />
      <path d="M19 14l.7 1.8L21.5 17l-1.8.7L19 19.5l-.7-1.8L16.5 17l1.8-.7z" fill="currentColor" stroke="none" opacity="0.8" />
    </svg>
  );
}
