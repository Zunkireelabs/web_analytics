import { timeAgo } from '../api.js';
import { Target, Globe, FileText, BrainCircuit, Activity, AlertCircle } from 'lucide-react';
import { CATEGORY } from './AgentCard.jsx';
import { STATUS } from '../lib/palette.js';

const CATEGORY_META = {
  seo: { label: 'SEO', icon: Target, color: CATEGORY.seo.color },
  geo: { label: 'Audience', icon: Globe, color: CATEGORY.geo.color },
  content: { label: 'Content', icon: FileText, color: CATEGORY.content.color },
  meta: { label: 'Overview', icon: BrainCircuit, color: CATEGORY.meta.color },
};

export default function ActivityFeed({ items }) {
  if (!items?.length) {
    return <div className="border-t border-border py-10 text-center text-sm text-faint">No activity logged yet.</div>;
  }

  return (
    <div className="border-t border-border">
      {items.map((a, i) => {
        const attempted = a.status !== 'ok';
        const cat = CATEGORY_META[a.category || 'seo'] || { label: 'Audit', icon: Activity, color: STATUS.neutral.color };
        const IconComponent = cat.icon;

        return (
          <div key={i} className="flex gap-3 px-4 py-3 border-b border-border last:border-0">
            <span className="w-7 h-7 rounded-control bg-muted text-text grid place-items-center shrink-0">
              <IconComponent size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs text-faint">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: attempted ? STATUS.neutral.color : cat.color }} />
                <span>{attempted ? 'Attempted' : cat.label}</span>
              </div>
              <p className={`text-sm mt-0.5 ${attempted ? 'text-text' : 'text-fg'}`}>
                {attempted ? (
                  <span className="flex items-center gap-1.5">
                    <AlertCircle size={13} className="shrink-0" style={{ color: STATUS.critical.color }} />
                    <span>Failed: {a.label}</span>
                  </span>
                ) : a.label}
              </p>
            </div>
            <span className="text-xs text-faint shrink-0">{timeAgo(a.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
