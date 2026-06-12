// AI Daily Summary — styled as an AI-assistant card with a gradient accent + avatar.
export default function NarrativePanel({ date, text }) {
  return (
    <div className="relative card overflow-hidden fade-up">
      {/* top gradient accent */}
      <div className="absolute inset-x-0 top-0 h-1"
        style={{ background: 'linear-gradient(90deg,#6C63FF,#8b5cf6,#0ea5e9)' }} />
      <div className="p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-xl grid place-items-center text-white shrink-0 shadow-md shadow-indigo-500/30"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            <SparkIcon />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-slate-800">AI Daily Summary</div>
            <div className="text-[11px] text-slate-400">{date ? `${date} · ` : ''}written by your analytics agent</div>
          </div>
          <span className="ml-auto text-[10px] font-bold tracking-wide px-2 py-1 rounded-full"
            style={{ background: 'rgba(108,99,255,0.1)', color: '#6C63FF' }}>AI</span>
        </div>
        <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-line">
          {text || 'No summary yet for this date. It is generated automatically after the daily data is ingested.'}
        </p>
      </div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" fill="currentColor" stroke="none" />
      <path d="M19 14l.7 1.8L21.5 17l-1.8.7L19 19.5l-.7-1.8L16.5 17l1.8-.7z" fill="currentColor" stroke="none" opacity="0.8" />
    </svg>
  );
}
