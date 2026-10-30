import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Card, { ROW } from './Card.jsx';

// Platform admin only: what the shared model has learned across projects. Hides itself silently on any error
// (a non-admin gets a 403, and the card is never mounted for them anyway).
export default function LearningCard() {
  const [data, setData] = useState(undefined); // undefined = loading, null = hidden
  useEffect(() => {
    let cancelled = false;
    api.analyst.learning().then((d) => { if (!cancelled) setData(d); }).catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, []);
  if (data === null) return null;
  const models = data?.models || [];
  const fixes = data?.fixesThatWorked || [];
  const worst = Math.max(...models.map((m) => m.missPct || 0), 1);
  return (
    <div className="mt-3">
      <div className="px-2.5 pb-1 text-[13px] font-semibold text-fg">Platform admin only · What the system has learned</div>
      <div className="grid gap-3 lg:grid-cols-2 items-start">
        <Card title="Which model predicts best" subtitle={data?.projects ? `Average miss on recent weeks, across ${data.projects} project${data.projects === 1 ? '' : 's'}` : 'Average miss on recent weeks'}
          loading={data === undefined} empty={data && !models.length ? 'Nothing here yet.' : null}
          footer={<><span>{data?.samples ? `Trained on ${data.samples.toLocaleString('en-US')} labelled page-weeks${data.needsRows && data.samples < data.needsRows ? ` (needs about ${data.needsRows} to start learning)` : ''}. ` : ''}Lower is better. A model replaces a project&apos;s forecast only where it beat it</span><span /></>}>
          {models.map((m) => (
            <div key={m.name} className={`${ROW} items-center`}>
              <div className="min-w-0 flex-1">
                <div className="text-fg">{m.name} {m.usedWhereWins && <Badge tone="green" className="ml-1">Used where it wins</Badge>}</div>
                {m.status === 'waiting' && m.note && <div className="text-xs text-faint">{m.note}</div>}
              </div>
              <div className="h-1.5 w-28 rounded-full bg-muted overflow-hidden shrink-0 hidden sm:block"><div className="h-full rounded-full bg-neutral-600" style={{ width: `${((m.missPct || 0) / worst) * 100}%` }} /></div>
              <span className="tnum text-right w-16 shrink-0">{m.missPct != null ? `${(Math.round(m.missPct * 10) / 10)}%` : <span className="text-faint">Waiting</span>}</span>
            </div>
          ))}
        </Card>
        <Card title="Fixes that worked" subtitle="Measured after the agent fixed a predicted problem"
          loading={data === undefined} empty={data && !fixes.length ? 'Nothing here yet. Results appear once fixes have been measured.' : null}
          maxHeight={260} footer={<><span>Each fix teaches the model what to try first</span><span /></>}>
          {fixes.map((f) => (
            <div key={f.label} className={`${ROW} items-center`}>
              <span className="min-w-0 flex-1 text-fg">{f.label}</span>
              <span className="text-text shrink-0">{f.result}</span>
              <span className="text-xs text-faint w-16 text-right shrink-0">{f.times} time{f.times === 1 ? '' : 's'}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
