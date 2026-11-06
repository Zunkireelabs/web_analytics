import { Target } from 'lucide-react';
import { TrayCard } from '../layout/Tray.jsx';
import BrandTiles from './BrandTiles.jsx';

// What visitors did after they arrived, from the client's own PostHog. Tiles, a short ranked list with each number
// beside its label, and one plain takeaway. The model (report/doc-model.js behaviourModel) decides every figure and
// sentence; this only draws them. Rendered only when the project has PostHog data, so an unconnected project's report
// carries no trace of it.
export default function BehaviourBlock({ model, brand, period }) {
  if (!model) return null;
  const top = Math.max(1, ...model.stops.map((s) => s.n));
  const bar = brand?.color || 'var(--primary)';
  return (
    <div className="tray mt-3">
      <TrayCard title="What visitors did after they arrived" subtitle={`${period ? `${period} · ` : ''}from your own site analytics`}>
        <div className="px-4 pb-4 border-t border-border pt-3">
          <div className="grid gap-5 lg:grid-cols-2 items-start">
            <BrandTiles items={model.tiles} brand={brand} />
            {model.stops.length > 0 && (
              <div>
                <div className="text-[12px] font-semibold text-fg">Where visits ended</div>
                <div className="text-[11.5px] text-faint mb-1">
                  The last page or action before a visit finished.{model.visits ? ` Share is of all ${model.visits.toLocaleString('en-US')} visits.` : ''}
                </div>
                <ol>
                  {model.stops.map((s, i) => (
                    <li key={s.label} className={`grid items-center gap-2.5 py-2.5 ${i ? 'border-t border-border' : ''}`}
                      style={{ gridTemplateColumns: '18px minmax(0,1fr) 72px 56px 38px' }}>
                      <span className="text-[12px] text-faint-2 tnum">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] text-fg">{s.label}</span>
                        {s.raw && <span className="block truncate text-[11.5px] text-faint font-mono">{s.raw}</span>}
                      </span>
                      <span className="h-1.5 rounded-full bg-muted" aria-hidden>
                        <span className="block h-full rounded-full" style={{ width: `${Math.round((s.n / top) * 100)}%`, background: bar, WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }} />
                      </span>
                      <span className="text-right text-[13.5px] text-fg tnum">{s.n.toLocaleString('en-US')}</span>
                      <span className="text-right text-[12.5px] text-faint tnum">{s.share == null ? '' : `${s.share}%`}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
          {model.takeaway && (
            <div className="mt-4 flex items-start gap-2.5 rounded-[10px] px-3.5 py-3 text-[13px] leading-[19px] text-fg" style={{ background: brand?.tint || 'var(--muted)' }}>
              <Target size={15} className="mt-0.5 shrink-0" style={{ color: brand?.text || 'var(--text)' }} />
              <span><b className="font-semibold">Look here first:</b> {model.takeaway}</span>
            </div>
          )}
          {model.note && <p className="mt-2 text-[11px] text-faint">{model.note}</p>}
        </div>
      </TrayCard>
    </div>
  );
}
