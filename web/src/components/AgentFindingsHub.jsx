import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';
import Badge from './Badge.jsx';

export default function AgentFindingsHub({ findings = [] }) {
  const [selectedIdx, setSelectedIdx] = useState(0);

  if (!findings || findings.length === 0) return null;

  const current = findings[selectedIdx] || findings[0];
  const cat = CATEGORY[current.category] || CATEGORY.seo;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr] items-start">
      {/* Left Navigation: List of findings/agents */}
      <div className="card overflow-hidden max-h-[480px] overflow-y-auto custom-scrollbar min-w-0">
        {findings.map((f, i) => {
          const itemCat = CATEGORY[f.category] || CATEGORY.seo;
          const isSelected = i === selectedIdx;

          return (
            <button
              key={f.agentId || f.name || i}
              type="button"
              onClick={() => setSelectedIdx(i)}
              aria-current={isSelected ? 'true' : undefined}
              className={`w-full flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 text-left hover:bg-[#fafafa] ${isSelected ? 'bg-primary-tint' : ''}`}
              style={isSelected ? { boxShadow: 'inset 2px 0 0 var(--primary)' } : undefined}
            >
              <span className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[6px] text-xs font-medium text-text bg-white shrink-0"
                style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: itemCat.color }} />
                {itemCat.label}
              </span>
              <span className={`text-sm truncate min-w-0 flex-1 ${isSelected ? 'font-medium text-fg' : 'text-fg'}`} title={f.name}>
                {f.name}
              </span>
              {f.stat && <span className="text-xs text-faint shrink-0">{f.stat}</span>}
            </button>
          );
        })}
      </div>

      {/* Right Content: Expanded details */}
      <div className="card overflow-hidden min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <div className="text-[15px] font-medium text-fg">{current.name}</div>
            <div className="text-[13px] text-faint">Agent audit report</div>
          </div>
          <Badge tone="green">Active analysis</Badge>
        </div>

        <div className="px-5 py-4 border-b border-border">
          <div className="text-[13px] text-faint">Steepest trend finding</div>
          <blockquote className="text-[15px] text-fg mt-1 break-words">“{current.headline}”</blockquote>
        </div>

        <div className="px-5 py-4">
          <div className="text-[13px] text-faint">Diagnostic breakdown</div>
          {current.narrative ? (
            <ul className="list-disc pl-5 mt-2 space-y-2 text-sm text-text break-words">
              {current.narrative.split('\n').filter(Boolean).map((para, pIdx) => (
                <li key={pIdx}>{para}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-text">No further diagnostic text was logged for this agent.</p>
          )}
        </div>

        {/* Footer/Action links */}
        <div className="tbl-foot">
          <span>Auto-audited via {cat.label} engine</span>
          <a
            href="#recommendations-section"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('recommendations-section')?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="btn btn--ghost btn--sm"
          >
            Go to action plans
          </a>
        </div>
      </div>
    </div>
  );
}
