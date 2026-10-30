// The headline numbers of a report, tinted and coloured in the project's own brand (tint for the card, the
// text-safe shade for the number). Same job as KpiStrip, used on the report pages so a client's report looks like theirs.
export default function BrandTiles({ items = [], brand, loading = false }) {
  const n = items.length || 4;
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${n > 4 ? 140 : 170}px, 1fr))` }}>
      {(loading ? Array.from({ length: n }) : items).map((it, i) => (
        <div key={i} className="rounded-[12px] px-4 py-3 min-w-0" style={{ background: brand?.tint || 'var(--muted)', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
          {loading || !it ? <div className="h-14 animate-pulse" /> : (
            <>
              <div className="text-[13px] text-text truncate">{it.label}</div>
              <div className="mt-0.5 tnum" style={{ color: brand?.text || 'var(--fg)', fontSize: 24, lineHeight: '28px', fontWeight: 600, letterSpacing: '-0.03em' }}>{it.value}</div>
              {it.delta && <div className="mt-0.5 text-xs font-semibold" style={{ color: it.tone === 'good' ? 'var(--green, #1a7f4b)' : it.tone === 'bad' ? '#b42318' : 'var(--text)' }}>{it.delta}</div>}
              {it.sub && <div className="mt-0.5 text-xs text-faint">{it.sub}</div>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
