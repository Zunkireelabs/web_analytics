// AI Executive Summary
export default function ExecutiveSummaryPanel({ text, source, generatedAt }) {
  const label = source === 'executive-report' ? 'AI Executive Summary' : 'AI Summary';
  const sub = generatedAt
    ? `Generated ${new Date(generatedAt).toLocaleDateString()}`
    : 'written by your analytics agent';

  return (
    <div className="relative card overflow-hidden bg-gradient-to-br from-white via-white to-violet-50/15 border border-slate-200 shadow-md rounded-3xl text-slate-700">
      {/* Top AI Gradient Bar */}
      <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: 'linear-gradient(90deg, #6C63FF 0%, #8b5cf6 50%, #ec4899 100%)' }} />
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4 border-b border-slate-100 pb-3">
          <div className="w-10 h-10 rounded-xl grid place-items-center text-white shrink-0 shadow-md shadow-indigo-500/20"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            <SparkIcon />
          </div>
          <div className="leading-tight">
            <div className="text-xs font-black text-slate-800 uppercase tracking-widest leading-none">{label}</div>
            <div className="text-[10.5px] text-slate-400 font-bold mt-1.5">{sub}</div>
          </div>
          <span className="ml-auto text-[9.5px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full bg-gradient-to-r from-[#6C63FF]/10 to-[#8b5cf6]/10 text-indigo-700 border border-indigo-200/30">AI Insight</span>
        </div>
        <p className="text-[13.5px] leading-relaxed text-slate-705 font-medium bg-slate-50/50 p-4.5 rounded-2xl border border-violet-100/50 whitespace-pre-line shadow-inner">
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
