import { Avatar, CountChip, StatusPill } from './RequestsParts.jsx';
import { requestStatus, setupChips } from '../../lib/requests-view.js';

// The Requests table: one row per Get Started request. Rows stack on a phone. `renderPanel(row)` draws the inline Approve choice under a row.
export default function RequestsList({ rows, selectable, selected, onToggle, onTogglePage, busy, approvingId, renderPanel, actions }) {
  const cols = `${selectable ? '20px ' : ''}minmax(0,1.5fr) minmax(0,1fr) 175px 300px`;
  const allOn = selectable && rows.length > 0 && rows.every((r) => selected.has(r.siteId));
  return (
    <div>
      <div className="hidden lg:grid items-center gap-x-4 px-4 sm:px-5 h-10 border-t border-border text-[12.5px] text-faint" style={{ gridTemplateColumns: cols }}>
        {selectable && <input type="checkbox" aria-label="Select this page" checked={allOn} onChange={() => onTogglePage(!allOn)} />}
        <span>Who</span><span>What they set up</span><span>Asked</span><span />
      </div>
      {rows.map((r) => {
        const st = requestStatus(r);
        const chips = setupChips(r.setup);
        const on = selectable && selected.has(r.siteId);
        const b = busy === r.siteId;
        return (
          <div key={r.siteId} className="border-t border-border" style={on ? { background: '#fff9f4' } : undefined}>
            <div className="grid lg:[grid-template-columns:var(--cols)] items-center gap-x-4 gap-y-2.5 px-4 sm:px-5 py-3" style={{ '--cols': cols }}>
              {selectable && <input type="checkbox" aria-label={`Select ${r.name}`} checked={on} onChange={() => onToggle(r.siteId)} className="hidden lg:block" />}
              <div className="flex items-center gap-3 min-w-0">
                {selectable && <input type="checkbox" aria-label={`Select ${r.name}`} checked={on} onChange={() => onToggle(r.siteId)} className="lg:hidden shrink-0" />}
                <Avatar name={r.setup?.brand || r.name} />
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-fg truncate">{r.setup?.brand || r.name}</p>
                  <p className="text-xs text-faint truncate">{r.owner?.email || 'No owner email'}{r.websiteDomain ? ` · ${r.websiteDomain}` : ''}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 min-w-0">
                {chips.length ? chips.map((c) => <CountChip key={c}>{c}</CountChip>) : <span className="text-xs text-faint-2">Nothing set up</span>}
              </div>
              <div><StatusPill tone={st.tone}>{st.text}</StatusPill></div>
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions(r, b)}</div>
            </div>
            {approvingId === r.siteId && <div className="px-4 sm:px-5 pb-3">{renderPanel(r)}</div>}
          </div>
        );
      })}
    </div>
  );
}
