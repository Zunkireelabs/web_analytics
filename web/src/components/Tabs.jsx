export default function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex items-center gap-1 border-b border-slate-100 mb-5 -mt-1 overflow-x-auto custom-scrollbar">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={`shrink-0 text-[10px] font-black uppercase tracking-wider px-3.5 py-2.5 border-b-2 transition ${
            active === t.value
              ? 'border-[#6C63FF] text-[#6C63FF]'
              : 'border-transparent text-slate-400 hover:text-slate-600'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
