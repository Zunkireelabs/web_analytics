import { useRef, useEffect, useState } from 'react';
import { PenLine } from 'lucide-react';
import { api } from '../../api.js';
import Drawer from '../Drawer.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import DraftSketch from './DraftSketch.jsx';
import DraftPreview from '../DraftPreview.jsx';
import LivePreview from '../LivePreview.jsx';
import DraftFieldsEditor from './DraftFieldsEditor.jsx';

const WAITING = new Set(['draft', 'edited', 'submitted_for_approval', 'revision_requested']);
const STATUS = { draft: 'New draft', edited: 'Edited', submitted_for_approval: 'Waiting for you', revision_requested: 'Changes requested', approved: 'Approved', branch_pushed: 'Branch pushed', merged_to_stage: 'On stage', pr_opened: 'PR open', awaiting_publish: 'Ready to publish', implemented: 'Live' };

// The side panel for one content draft: the page in the client's own design (Preview), its facts (What changes), and Approve / Skip while
// it is waiting. Approve records the approval only: no PR is opened here. `item` is a draft shaped by content-history.js.
export default function DraftPanel({ item, siteId, onClose, onChanged }) {
  const [tab, setTab] = useState('Preview');
  const seen = useRef(null);
  const [redraw, setRedraw] = useState(0); // bumped after a change so the page is drawn again with the new wording
  const [page, setPage] = useState(null); // null loading, { html } or { none: true }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [content, setContent] = useState(item?.content || null); // follows the draft after an edit, so "What changes" shows the new wording
  useEffect(() => { setContent(item?.content || null); }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!item) return undefined;
    let alive = true;
    if (seen.current !== item.id) { seen.current = item.id; setTab('Preview'); setPage(null); setError(null); }
    if (item.typeId === 'blog-outline') return () => { alive = false; }; // a blog is drawn by the live preview below
    api.actionCenter.designPreview(item.id, siteId).then((r) => { if (alive) setPage({ html: r.html }); }).catch((e) => { if (alive) { setPage({ none: true, reason: e.status === 422 ? null : (e.message || 'The preview could not be drawn.') }); if (e.status === 422) setTab('What changes'); } });
    return () => { alive = false; };
  }, [item?.id, siteId, redraw]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const waiting = WAITING.has(item.status);
  const isBlog = item.typeId === 'blog-outline';
  const tabs = waiting ? ['Preview', 'What changes', 'Edit'] : ['Preview', 'What changes'];
  // A tab that is no longer offered (the draft stopped waiting, for example after a failed approve refreshed it) falls back to the first one, so the shown panel and the marked tab always agree.
  const activeTab = tabs.includes(tab) ? tab : tabs[0];
  const edited = (draft) => { if (draft?.content) setContent(draft.content); onChanged?.(); };
  const act = async (kind) => {
    setBusy(kind); setError(null);
    try {
      if (kind === 'approve') await api.actionCenter.approveDraftOnly(item.id, siteId);
      else await api.actionCenter.rejectDraft(item.id, 'skipped_by_client', siteId);
      await onChanged?.();
      onClose();
    } catch (e) { setError(e.message || 'That did not work. Nothing was changed.'); } finally { setBusy(null); }
  };

  return (
    <Drawer isOpen onClose={onClose} title={item.title} subtitle={item.page || item.typeLabel} icon={PenLine} maxWidth="max-w-[760px]">
      <div className="px-5 pt-3">
        <div className="flex items-center gap-2 mb-3">
          <Badge tone="primary">{item.typeLabel}</Badge>
          <Badge tone={item.status === 'implemented' ? 'green' : waiting ? 'amber' : 'blue'}>{STATUS[item.status] || item.status}</Badge>
        </div>
        <div className="flex gap-1 border-b border-border -mx-5 px-5" role="tablist">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={activeTab === t} onClick={() => setTab(t)}
              className={`px-3.5 pt-2 pb-2.5 text-sm font-medium -mb-px border-b-2 ${activeTab === t ? 'text-fg border-primary' : 'text-text border-transparent'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-5 py-4 flex-1">
        {activeTab === 'Edit' ? (
          <DraftFieldsEditor draftId={item.id} siteId={siteId} onSaved={edited} />
        ) : activeTab === 'Preview' && isBlog ? (
          <LivePreview draftId={item.id} siteId={siteId} onSaved={edited} />
        ) : activeTab === 'Preview' ? (
          page === null ? <div className="h-[560px] rounded-card bg-muted animate-pulse" />
            : page.html ? <DraftSketch draftId={item.id} siteId={siteId} html={page.html} url={item.page} title={item.title} onSaved={edited} onChanged={() => setRedraw((n) => n + 1)} />
            : <div className="rounded-card bg-muted px-5 py-10 text-center text-sm text-text">{page.reason || 'This change is not a page, so there is no page preview. See “What changes”.'}</div>
        ) : (
          <>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-[13px] mb-5">
            <Fact label="Kind">{item.typeLabel}</Fact>
            <Fact label="Page">{item.page ? <span className="font-mono text-xs break-all">{item.page}</span> : '—'}</Fact>
            <Fact label="Status">{STATUS[item.status] || item.status}</Fact>
            <Fact label="Waiting">{item.waitedDays >= 1 ? `${item.waitedDays} days` : 'Since today'}</Fact>
            {item.pr && <Fact label="Pull request">#{item.pr.number}{item.pr.state ? ` · ${item.pr.state}` : ''}</Fact>}
            {item.branch && <Fact label="Branch"><span className="font-mono text-xs break-all">{item.branch}</span></Fact>}
          </dl>
          {content && <div className="border-t border-border pt-4"><DraftPreview actionType={item.typeId || item.type} content={content} /></div>}
          </>
        )}
        {error && <div className="mt-4 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2.5">{error}</div>}
      </div>

      <div className="sticky bottom-0 bg-white border-t border-border px-5 py-3 flex items-center gap-2" style={{ background: '#fcfcfb' }}>
        {waiting ? (
          <>
            <Button variant="light" onClick={() => act('skip')} disabled={Boolean(busy)}>{busy === 'skip' ? 'Skipping…' : 'Skip'}</Button>
            <span className="flex-1 text-[13px] text-faint pl-1">Nothing goes live until you approve.</span>
            <Button variant="primary" onClick={() => act('approve')} disabled={Boolean(busy)}>{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>
          </>
        ) : <span className="flex-1 text-[13px] text-faint">{item.status === 'implemented' ? 'This is live on your site.' : 'Approved. It is on its way to your site.'}</span>}
      </div>
    </Drawer>
  );
}

const Fact = ({ label, children }) => (<div><dt className="text-xs text-faint">{label}</dt><dd className="mt-0.5 text-fg">{children}</dd></div>);
