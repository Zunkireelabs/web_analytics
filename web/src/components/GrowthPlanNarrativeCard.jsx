import Badge from './Badge.jsx';
import { TrayCard } from './layout/Tray.jsx';
import { timeAgo } from '../api.js';

const STEPS = [
  { key: 'currentStateSummary', number: '01', label: 'Where you stand', badge: 'Baseline status' },
  { key: 'growthPlan', number: '02', label: 'How our agents grow you', badge: 'Active AI strategy' },
  { key: 'twoMonthOutlook', number: '03', label: 'In ~2 months', badge: 'Projected target' },
];

export default function GrowthPlanNarrativeCard({ growthPlan, loading }) {
  if (loading) {
    return (
      <div className="tray-card px-4 py-4 space-y-2">
        <div className="h-4 bg-muted rounded-control animate-pulse w-1/4" />
        <div className="h-16 bg-muted rounded-control animate-pulse" />
      </div>
    );
  }

  if (!growthPlan?.available) {
    return null;
  }

  return (
    <TrayCard className="fade-up" title="Your growth roadmap"
      subtitle="Grounded in your real onboarding baseline and site audit findings"
      action={(
        <div className="flex items-center gap-2">
          <Badge tone="primary">AI agent active</Badge>
          {growthPlan.generatedAt && <Badge tone="grey" className="shrink-0">Updated {timeAgo(growthPlan.generatedAt)}</Badge>}
        </div>
      )}>
      {/* 3 step roadmap */}
      <div className="grid md:grid-cols-3 gap-px bg-border border-t border-border">
        {STEPS.map(({ key, number, label, badge }) => (
          <div key={key} className="bg-white px-4 py-3.5">
            <div className="text-xs text-faint tnum">{number} · {badge}</div>
            <h4 className="mt-1 text-sm font-medium text-fg">{label}</h4>
            <p className="mt-1 text-[13px] leading-5 text-text">{growthPlan[key]}</p>
          </div>
        ))}
      </div>
    </TrayCard>
  );
}
