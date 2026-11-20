import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import { groupWords, shipIds, MAX_SHIP } from '../../lib/ai-visibility-view.js';

// "Words to add to your pages": the phrases buyers use that a page does not say yet, grouped by the page they would go on. Each
// group has its own Draft button, and there is one for all of them. A draft only goes into Action Center to be approved.
export default function WordsByPage({ words, loading, onDraft, busy }) {
  const groups = groupWords(words);
  const all = shipIds(groups.flatMap((g) => g.promptIds));
  return (
    <div className="tray">
      <div className="px-2.5 pt-1.5 pb-1 flex items-end gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-fg">Words to add to your pages</h2>
          <p className="text-xs text-faint">Phrases buyers use that your pages do not say yet, grouped by page.</p>
        </div>
      </div>
      {loading ? <div className="tray-card px-4 py-6 text-[13px] text-text">Loading…</div> : !groups.length ? (
        <div className="tray-card px-4 py-6 text-[13px] text-text">Nothing to add yet. Phrases show up here once there are questions you are missing.</div>
      ) : (
        <div className="tray-card">
          <div className="flex items-center gap-3 px-4 pt-3.5 pb-1">
            <Badge tone="primary">Nothing changes on your site until you approve it in Action Center</Badge>
            <span className="flex-1" />
            <Button size="sm" variant="primary" disabled={busy || !all.ids.length} onClick={() => onDraft(all.ids)}>Draft all {all.ids.length}{all.left ? ` (of ${all.left + all.ids.length})` : ''}</Button>
          </div>
          <div className="grid gap-2.5 p-3.5 sm:grid-cols-2">
            {groups.map((g) => {
              const ids = shipIds(g.promptIds).ids;
              return (
                <div key={g.page || 'new'} className="rounded-[10px] p-3.5" style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
                  <div className="flex items-center gap-2">
                    <b className="text-sm font-medium text-fg truncate">{g.page ? g.page.replace(/\/$/, '').split('/').pop().replace(/-/g, ' ') || 'Home page' : 'A new page'}</b>
                    <Badge tone="grey" className="ml-auto shrink-0">{g.count} {g.count === 1 ? 'phrase' : 'phrases'}</Badge>
                  </div>
                  <code className="mt-1.5 block truncate rounded-[5px] bg-muted px-1.5 py-0.5 text-xs font-mono text-text">{g.page || 'No existing page covers these yet'}</code>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {g.phrases.slice(0, 3).map((p) => <span key={p} className="rounded-full bg-primary-tint px-2.5 py-0.5 text-[12.5px] font-medium text-primary-strong">{p}</span>)}
                    {g.count > 3 && <span className="rounded-full bg-primary-tint px-2.5 py-0.5 text-[12.5px] font-medium text-primary-strong">+{g.count - 3}</span>}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-faint">Becomes a draft you approve</span>
                    <span className="flex-1" />
                    <Button size="sm" variant="light" disabled={busy || !ids.length} onClick={() => onDraft(ids)}>Draft these {g.count}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
