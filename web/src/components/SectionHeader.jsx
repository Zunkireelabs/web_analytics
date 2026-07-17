export default function SectionHeader({ title, desc, count, action }) {
  return (
    <div className="mb-3.5">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <h2 className="text-[17px] font-bold tracking-tight text-slate-900 truncate">{title}</h2>
        <div className="flex items-center gap-3 shrink-0">
          {count != null && <span className="text-xs font-mono font-semibold text-slate-400">{count}</span>}
          {action}
        </div>
      </div>
      {desc && <p className="text-[13px] text-slate-500 mt-1 max-w-2xl">{desc}</p>}
    </div>
  );
}
