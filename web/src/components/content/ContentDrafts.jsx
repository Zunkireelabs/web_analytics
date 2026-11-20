import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DraftPanel from './DraftPanel.jsx';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { timeAgo } from '../../api.js';
import Badge from '../Badge.jsx';
import { draftsOfType, CONTENT_TYPES } from '../../lib/content-types.js';
import { reviewLists, historyByMonth, shape } from '../../lib/content-history.js';

const STATUS_TEXT = { approved: 'Approved', branch_pushed: 'Branch pushed', merged_to_stage: 'On stage', pr_opened: 'PR open', awaiting_publish: 'Ready to publish', draft: 'New draft', edited: 'Edited', submitted_for_approval: 'Waiting for you', revision_requested: 'Changes requested' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// Content's "To review" and "Live history" shown on the Content page itself: no second page to go to. History is read-only and
// expands in place to show what merged (when, which pull request, which branch).
export default function ContentDrafts({ view, drafts, error, type = 'all', siteId, onChanged, openId }) {
  const [open, setOpen] = useState(null); // the draft whose side panel is open
  const [, setParams] = useSearchParams();
  // A link to one draft (a notification, an old bookmark) opens its panel once the drafts are loaded, then drops ?openDraft=.
  useEffect(() => {
    if (!openId || !drafts) return;
    const d = drafts.find((x) => String(x.id) === String(openId));
    if (d) setOpen(shape(d));
    setParams((p) => { p.delete('openDraft'); return p; }, { replace: true });
  }, [openId, drafts]);
  if (drafts === null) return <div className="py-12 text-center text-sm text-faint">Loading…</div>;
  const mine = draftsOfType(drafts, type);
  const label = CONTENT_TYPES.find((t) => t.key === type)?.label.toLowerCase() || 'content';
  return (
    <>
      {error && <div className="mb-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2.5">Could not load your content right now. Try again in a moment.</div>}
      {view === 'history' ? <History drafts={mine} label={type === 'all' ? 'content' : label} onOpen={setOpen} /> : <Review drafts={mine} label={type === 'all' ? 'content' : label} onOpen={setOpen} />}
      <DraftPanel item={open} siteId={siteId} onClose={() => setOpen(null)} onChanged={onChanged} />
    </>
  );
}

function Row({ item, right, children, open, onToggle }) {
  return (
    <div className="border-t border-border first:border-t-0">
      <button type="button" onClick={onToggle} aria-expanded={onToggle ? open : undefined} disabled={!onToggle}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[#fafafa] disabled:hover:bg-transparent disabled:cursor-default">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg truncate">{item.title}</span>
          <span className="mt-1 flex items-center gap-2 min-w-0">
            <Badge tone="grey" className="shrink-0">{item.typeLabel}</Badge>
            <span className="font-mono text-xs text-faint truncate">{item.page}</span>
          </span>
        </span>
        <span className="shrink-0 flex items-center gap-2.5">{right}</span>
        {onToggle && open !== undefined && <ChevronDown size={15} className={`shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />}
      </button>
      {open && children}
    </div>
  );
}

function Review({ drafts, label, onOpen }) {
  const { waiting, onItsWay } = useMemo(() => reviewLists(drafts), [drafts]);
  if (!waiting.length && !onItsWay.length) return <Empty>No {label} drafts to review. When the agent drafts something for you, it appears here.</Empty>;
  return (
    <div className="space-y-5">
      <Section title="Waiting for you" subtitle="Read each one, then approve it. Nothing goes live until you do." empty="Nothing is waiting for you.">
        {waiting.map((i) => (
          <Row key={i.id} item={i} onToggle={() => onOpen(i)} right={<>
            {i.waitedDays >= 1 && <Badge tone="amber">Waited {i.waitedDays}d</Badge>}
            <span className="btn btn--primary btn--sm">Review</span>
          </>} />
        ))}
      </Section>
      {onItsWay.length > 0 && (
        <Section title="On its way" subtitle="Approved. A person reviews and merges before it goes live.">
          {onItsWay.map((i) => (
            <Row key={i.id} item={i} onToggle={() => onOpen(i)} right={<>
              {i.pr && <span className="hidden sm:inline text-xs text-faint tnum">PR #{i.pr.number}</span>}
              <Badge tone="blue">{STATUS_TEXT[i.status] || i.status}</Badge>
            </>} />
          ))}
        </Section>
      )}
    </div>
  );
}

function History({ drafts, label, onOpen }) {
  const { total, groups } = useMemo(() => historyByMonth(drafts), [drafts]);
  const [openId, setOpenId] = useState(null);
  const shown = groups;
  if (!total) return <Empty>No {label} has gone live yet. Content you approve shows up here once it is merged.</Empty>;
  return (
    <div>
      <div className="space-y-5">
        {shown.map((g) => (
          <Section key={g.label} title={g.label} subtitle={`${g.items.length} went live`}>
            {g.items.map((i) => (
              <Row key={i.id} item={i} open={openId === i.id} onToggle={() => setOpenId(openId === i.id ? null : i.id)}
                right={<><span className="hidden sm:inline text-xs text-faint">{timeAgo(i.wentLiveAt)}</span><Badge tone="green">Live</Badge></>}>
                <div className="px-4 pb-4 pt-1">
                  <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 rounded-control bg-[#fcfcfb] px-4 py-3 text-[13px]" style={{ boxShadow: 'inset 0 0 0 1px var(--border-canvas)' }}>
                    <Fact label="Went live">{fmt(i.wentLiveAt)}</Fact>
                    <Fact label="You approved">{fmt(i.approvedAt)}</Fact>
                    <Fact label="Merged in">
                      {i.pr ? (i.pr.url
                        ? <a href={i.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">PR #{i.pr.number}<ExternalLink size={11} aria-hidden /></a>
                        : <>PR #{i.pr.number}</>) : '—'}
                    </Fact>
                    {i.branch && <div className="sm:col-span-3"><Fact label="Branch"><span className="font-mono text-xs break-all">{i.branch}</span></Fact></div>}
                  </dl>
                  <div className="mt-2.5 text-right"><button type="button" onClick={() => onOpen(i)} className="text-[13px] text-text underline underline-offset-2 hover:text-fg">See the page on your site</button></div>
                </div>
              </Row>
            ))}
          </Section>
        ))}
      </div>
    </div>
  );
}

const Fact = ({ label, children }) => (<div><dt className="text-xs text-faint">{label}</dt><dd className="mt-0.5 text-fg">{children}</dd></div>);
const Empty = ({ children }) => <div className="rounded-card bg-white px-6 py-14 text-center text-sm text-text" style={{ boxShadow: 'var(--ring)' }}>{children}</div>;

function Section({ title, subtitle, empty, children }) {
  const rows = Array.isArray(children) ? children : [children];
  return (
    <div className="tray">
      <div className="px-2.5 pt-1.5 pb-1">
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
        {subtitle && <p className="text-xs text-faint">{subtitle}</p>}
      </div>
      <div className="tray-card overflow-hidden">
        {rows.filter(Boolean).length ? children : <div className="px-4 py-6 text-[13px] text-text">{empty}</div>}
      </div>
    </div>
  );
}
