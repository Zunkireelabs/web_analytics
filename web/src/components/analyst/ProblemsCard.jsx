import { useState } from 'react';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import Card from './Card.jsx';
import { STATUS } from '../../lib/palette.js';
import { STAGE_FILTERS, filterCounts, filterProblems, stepperFor } from '../../lib/analyst-view.js';

const STAGE_BADGE = {
  predicted: <Badge tone="red">Predicted</Badge>,
  fixing: <Badge tone="amber">Agent fixing · 07:00</Badge>,
  fixed: <Badge tone="green">Fixed automatically</Badge>,
  'needs-ok': <Badge tone="red">Waiting for your OK</Badge>,
};
const DOT = { done: STATUS.good.color, current: STATUS.warning.color, todo: '#c9c9c9' };

function Stepper({ problem }) {
  const steps = stepperFor(problem);
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-2">
      {steps.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.alert ? STATUS.critical.color : DOT[s.state] }} />
          <span className={`text-[11px] ${s.state === 'todo' ? 'text-faint' : 'text-text'}`}>{s.label}</span>
          {i < steps.length - 1 && <span className="hidden sm:block w-3.5 h-px bg-border-2" style={{ background: 'var(--border-2)' }} />}
        </span>
      ))}
    </div>
  );
}

export default function ProblemsCard({ problems, loading, onApprove, approving }) {
  const [filter, setFilter] = useState('all');
  const counts = filterCounts(problems);
  const shown = filterProblems(problems, filter);
  const waiting = (problems || []).filter((p) => p.stage === 'needs-ok');
  const options = STAGE_FILTERS.map((f) => ({ value: f.value, label: `${f.label}${f.value === 'all' || counts[f.value] ? ` ${counts[f.value]}` : ''}` }));
  return (
    <Card
      title="Problems, from predicted to fixed" subtitle="The agent fixes these before they cost you visits"
      action={counts.all > 0 && <SegmentedTabs options={options} value={filter} onChange={setFilter} />}
      loading={loading} empty={!loading && !counts.all ? 'No problems expected next week.' : null}
      maxHeight={560}
      footer={<><span className="min-w-0 truncate">Design-changing fixes wait for your OK</span>{waiting.length > 0 && <Button size="sm" variant="light" disabled={approving} onClick={() => onApprove(waiting[0].id)}>Approve waiting fix</Button>}</>}
    >
      {shown.length === 0 && <div className="px-4 py-5 text-[13px] text-text border-t border-border">Nothing in this stage.</div>}
      {shown.map((p) => (
        <div key={p.id} className="px-4 py-3 border-t border-border first:border-t-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg">{p.title}</div>
              <div className="text-xs text-faint mt-0.5">{[p.where, p.fix].filter(Boolean).join(' · ')}</div>
              {p.reason && <div className="text-xs text-text mt-1">{p.reason}</div>}
            </div>
            <div className="shrink-0 text-right">
              {p.likelihoodPct != null && <div className="text-[13px] tnum text-fg mb-0.5">{Math.round(p.likelihoodPct)}% likely</div>}
              {STAGE_BADGE[p.stage]}
            </div>
          </div>
          <Stepper problem={p} />
          {p.stage === 'needs-ok' && (
            <div className="mt-2"><Button write size="sm" variant="primary" disabled={approving} onClick={() => onApprove(p.id)}>Approve this fix</Button></div>
          )}
        </div>
      ))}
    </Card>
  );
}
