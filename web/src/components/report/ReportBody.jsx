import { TrayCard } from '../layout/Tray.jsx';
import BrandTiles from './BrandTiles.jsx';

// The body of a weekly / monthly report: a one-line verdict, the plain summary, tiles with how each moved, the bars,
// what went live, then the tables (day or week breakdown, since baseline, page scores, top searches). Everything
// arrives from the server (report/inapp-model.js), the same model the Google Doc and PDF are written from.
const toneColor = (t) => (t === 'good' ? '#1a7f4b' : t === 'bad' ? '#b42318' : undefined);
const cell = (c) => (c && typeof c === 'object' ? { text: c.t, color: toneColor(c.tone) } : { text: c, color: undefined });

function Bars({ bars, brand }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const top = bars.reduce((a, b, i) => (b.value > bars[a].value ? i : a), 0);
  const accent = brand?.color || '#171717';
  return (
    <div className="px-4 pb-4">
      <div className="flex items-end gap-1.5" style={{ height: 96 }}>
        {bars.map((b, i) => (
          <div key={i} className="flex-1 h-full flex flex-col justify-end" title={`${b.label}: ${b.valueText}`}>
            <div style={{ height: `${Math.max(2, Math.round((b.value / max) * 100))}%`, borderRadius: '4px 4px 0 0', background: i === top ? accent : `color-mix(in srgb, ${accent} 26%, white)`, WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 mt-1.5">{bars.map((b, i) => <div key={i} className="flex-1 min-w-0 text-center text-[11px] text-faint truncate">{b.label}</div>)}</div>
    </div>
  );
}

function Table({ head, rows }) {
  const cols = `${head.length > 3 ? 1.5 : 2}fr repeat(${head.length - 1}, 1fr)`;
  return (
    <div className="overflow-x-auto"><div style={{ minWidth: head.length * 92 }}>
      <div className="grid gap-2 px-4 py-2 border-t border-border text-[11px] font-semibold text-faint uppercase tracking-[.04em]" style={{ gridTemplateColumns: cols }}>
        {head.map((h, i) => <span key={i} className={i ? 'text-right' : ''}>{h}</span>)}
      </div>
      {rows.map((r, ri) => (
        <div key={ri} className="grid gap-2 px-4 py-2.5 border-t border-border text-[13px]" style={{ gridTemplateColumns: cols }}>
          {r.map((c, i) => { const v = cell(c); return <span key={i} className={`tnum ${i ? 'text-right text-text' : 'text-fg truncate'} ${v.color ? 'font-semibold' : ''}`} style={v.color ? { color: v.color } : undefined}>{v.text}</span>; })}
        </div>
      ))}
    </div></div>
  );
}

export default function ReportBody({ body, brand, narrative }) {
  if (!body) return null;
  const tiles = body.tiles.map((t) => ({ label: t.label, value: t.value, delta: t.delta?.trim() ? t.delta : null, tone: t.tone }));
  return (
    <>
      <div className="tray"><div className="tray-card px-5 py-4">
        <h2 className="text-fg" style={{ fontSize: 21, lineHeight: '26px', fontWeight: 600, letterSpacing: '-0.025em' }}>{body.headline}</h2>
        {narrative && <p className="mt-1.5 text-[13px] leading-[19px] text-text">{narrative}</p>}
      </div></div>
      <div className="mt-3"><BrandTiles items={tiles} brand={brand} /></div>
      {body.bars?.length > 0 && <div className="tray mt-3"><TrayCard title={body.barsTitle}><Bars bars={body.bars} brand={brand} /></TrayCard></div>}
      {body.did?.length > 0 && (
        <div className="tray mt-3"><TrayCard title="What we did" subtitle="Went live in this period">
          <ul className="border-t border-border">
            {body.did.map((d, i) => (
              <li key={i} className="px-4 py-2.5 border-b border-border last:border-b-0 text-[13px]">
                <div className="flex items-start gap-2.5"><span className="mt-0.5 w-4 h-4 rounded-full grid place-items-center shrink-0 text-[9px] font-extrabold" style={{ background: 'var(--green-tint, #e8f5ee)', color: '#1a7f4b' }}>✓</span>
                  <span className="min-w-0"><span className="block text-fg font-medium">{d.title}</span><span className="block text-text">{d.did}</span><span className="block text-xs text-faint">{d.why}</span></span></div>
              </li>
            ))}
          </ul>
        </TrayCard></div>
      )}
      {body.sections.map((s) => (
        <div key={s.title} className="tray mt-3"><TrayCard title={s.title} subtitle={s.sub}><Table head={s.head} rows={s.rows} /></TrayCard></div>
      ))}
    </>
  );
}
