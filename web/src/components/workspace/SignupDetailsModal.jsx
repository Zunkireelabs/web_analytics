import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import { StatusPill, Avatar } from '../platform/RequestsParts.jsx';
import { GOAL_INFO, marketGroups, detailCounts, promptView, requestStatus, plural } from '../../lib/requests-view.js';

const regionName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const langName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
const country = (c) => (c ? (regionName?.of(c) || c) : '');
const LEVEL_NOUN = { continent: ['continent', 'continents'], country: ['country', 'countries'], state: ['state', 'states'], city: ['city', 'cities'], neighborhood: ['neighborhood', 'neighborhoods'] };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fmtTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const INTENT = { commercial: ['#fff4ed', '#b34400'], informational: ['#eaf1fb', '#2a5db0'], transactional: ['#e8f7ee', '#17734a'] };
const IntentTag = ({ intent }) => (intent ? (
  <em className="not-italic shrink-0 px-2 h-5 inline-flex items-center rounded-full text-[11px]" style={{ background: (INTENT[intent] || ['#f4f2ef'])[0], color: (INTENT[intent] || [, '#525252'])[1] }}>{cap(intent)}</em>
) : null);

// A card in the same look as the All workspaces cards: rounded, tinted header band, clean rows.
function Card({ title, aside, children, className = '' }) {
  return (
    <section className={`rounded-card bg-white overflow-hidden flex flex-col ${className}`} style={{ boxShadow: '0 0 0 1px var(--input)' }}>
      <h4 className="flex items-center justify-between px-4 py-2.5 text-[13px] font-semibold text-fg" style={{ background: '#fafaf9', borderBottom: '1px solid var(--border)' }}>
        <span>{title}</span>{aside && <span className="text-xs font-normal text-faint">{aside}</span>}
      </h4>
      <div className="p-4 flex-1">{children}</div>
    </section>
  );
}
const Chips = ({ items }) => (
  <div className="flex flex-wrap gap-1.5">{items.map((t, i) => <span key={`${t}-${i}`} className="px-2.5 h-7 inline-flex items-center rounded-full bg-muted text-[13px] text-fg">{t}</span>)}</div>
);
const Pill = ({ on, onClick, children, count }) => (
  <button type="button" aria-pressed={on} onClick={onClick} className={`h-[30px] px-2.5 rounded-full text-[12.5px] font-medium ${on ? 'bg-fg text-white' : 'bg-muted text-text hover:text-fg'}`}>
    {children}{count !== undefined && <em className="not-italic ml-1.5 font-normal opacity-60">{count}</em>}
  </button>
);
const Dl = ({ rows }) => {
  const shown = rows.filter(([, v]) => v);
  return shown.length ? (
    <dl className="grid grid-cols-[104px_minmax(0,1fr)] sm:grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px] m-0">
      {shown.map(([k, v]) => (<div key={k} className="contents"><dt className="text-faint">{k}</dt><dd className="m-0 text-fg [overflow-wrap:anywhere]">{v}</dd></div>))}
    </dl>
  ) : null;
};
const NotFilled = ({ what }) => (what.length ? <p className="mt-3 text-[12.5px] text-faint-2">Not filled in: {what.join(', ')}</p> : null);

// Staff: everything a person entered on /get-started, so a request can be judged and a project set up from it. Read only.
// `request` is the row it was opened from (for its name and state); `onApprove` is given only when the request can still be approved.
export default function SignupDetailsModal({ request, siteId, name, onClose, onApprove }) {
  const id = request?.siteId ?? siteId;
  const [d, setD] = useState(undefined); // undefined = loading, null = failed
  const [tab, setTab] = useState('overview');
  const [q, setQ] = useState('');
  const [intent, setIntent] = useState('all');
  const [topic, setTopic] = useState('all');
  useEffect(() => { api.clients.access.details(id).then(setD).catch(() => setD(null)); }, [id]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const s = d?.setup;
  const p = s?.profile || {};
  const counts = detailCounts(s);
  const groups = useMemo(() => marketGroups(s?.markets), [s]);
  const view = useMemo(() => promptView(s?.prompts || [], { q, intent, topic }), [s, q, intent, topic]);
  const runs = s?.runs?.length ? s.runs : (s?.run?.country ? [s.run] : []);
  const brand = s?.brand || request?.name || name || d?.name || 'Request';
  const status = request ? requestStatus(request) : d?.state === 'pending' ? { tone: 'warn', text: 'Waiting for approval' } : null;
  const canApprove = onApprove && (request?.state === 'pending' || request?.state === 'rejected');
  const stat = [['Goals', counts.goals], ['Markets', groups.reduce((n, g) => n + g.items.length, 0)], ['Topics', counts.topics], ['Prompts', counts.prompts], ['Competitors', counts.competitors]];
  const tabs = [['overview', 'Overview'], ['markets', 'Markets', groups.reduce((n, g) => n + g.items.length, 0)], ['prompts', 'Topics and prompts', counts.prompts], ['brand', 'Brand profile']];
  const global = s?.markets?.scope === 'global' && !groups.length;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-neutral-900/40 animate-fade-in" onClick={onClose}>
      <div role="dialog" aria-label={`${brand}: Get Started details`} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[900px] max-h-[calc(100vh-1.5rem)] sm:max-h-[calc(100vh-2rem)] rounded-card bg-white text-sm text-fg overflow-hidden flex flex-col"
        style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -20px rgba(0,0,0,.12)' }}>
        <div className="flex items-start gap-3 sm:gap-4 px-4 sm:px-5 pt-4 sm:pt-5 pb-4 shrink-0">
          <Avatar name={brand} size={46} />
          <div className="min-w-0 flex-1">
            <p className="text-[16px] leading-6 font-semibold truncate">{brand}</p>
            <p className="text-[13px] text-faint truncate">{[d?.website || request?.websiteDomain, d?.email || request?.owner?.email].filter(Boolean).join(' · ')}</p>
            {status && <div className="mt-1.5"><StatusPill tone={status.tone}>{status.text}</StatusPill></div>}
          </div>
          <div className="hidden lg:flex gap-2">
            {stat.map(([k, n]) => (
              <div key={k} className="min-w-[70px] px-2.5 py-1.5 rounded-control text-center" style={{ background: '#faf9f7', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                <b className="block text-[16px] leading-5 font-semibold tnum">{n}</b><span className="text-[11px] text-faint">{k}</span>
              </div>
            ))}
          </div>
          <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}><X size={14} /></Button>
        </div>
        <div className="lg:hidden flex gap-2 overflow-x-auto px-4 sm:px-5 pb-3 shrink-0">
          {stat.map(([k, n]) => (
            <span key={k} className="shrink-0 px-2.5 h-7 inline-flex items-center gap-1.5 rounded-full bg-muted text-xs text-text"><b className="font-semibold text-fg tnum">{n}</b>{k}</span>
          ))}
        </div>
        <div className="flex gap-5 px-4 sm:px-5 border-y border-border overflow-x-auto shrink-0" role="tablist">
          {tabs.map(([k, label, n]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`h-11 inline-flex items-center gap-1.5 whitespace-nowrap text-[13.5px] -mb-px border-b-2 ${tab === k ? 'border-fg text-fg font-medium' : 'border-transparent text-text hover:text-fg'}`}>
              {label}{n ? <em className="not-italic px-1.5 rounded-full bg-muted text-[11px] text-faint tnum">{n}</em> : null}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 min-h-[260px]" style={{ background: '#fcfcfb' }}>
          {d === undefined && <div className="h-40 bg-muted rounded-control animate-pulse" />}
          {d === null && <p className="text-[13px]" style={{ color: '#b42318' }}>Could not load the details.</p>}
          {d && !s && <p className="text-[13px] text-faint">No setup answers were saved for this project.</p>}
          {d && tab === 'overview' && (
            <div className="grid md:grid-cols-2 gap-3">
              <Card title="The business">
                <Dl rows={[['Contact', d.email], ['Workspace', d.workspaceName], ['Project', d.projectName], ['Billing country', country(s?.entityCountry)], ['Category', p.category], ['Asked on', fmtTime(d.requestedAt)]]} />
              </Card>
              <Card title="Goals they picked">
                {(s?.goals || []).length ? (
                  <ul className="list-none m-0 p-0">
                    {s.goals.map((g) => (
                      <li key={g} className="flex gap-3 py-2.5 first:pt-0 last:pb-0 border-b border-border last:border-0">
                        <span className="min-w-9 h-9 px-1.5 rounded-control bg-primary-tint text-primary grid place-items-center text-[10.5px] font-semibold shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>{String(g).toUpperCase()}</span>
                        <div className="min-w-0"><p className="text-[13.5px] font-medium">{GOAL_INFO[g]?.title || g}</p>{GOAL_INFO[g]?.text && <p className="text-[12.5px] leading-[18px] text-faint">{GOAL_INFO[g].text}</p>}</div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[13px] text-faint">None picked.</p>}
              </Card>
              <Card title="Where prompts run from">
                {runs.length ? (
                  <ul className="list-none m-0 p-0">
                    {runs.map((r, i) => (
                      <li key={i} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0 border-b border-border last:border-0 text-[13px]">
                        <span className="px-1.5 h-6 inline-flex items-center rounded-control bg-muted text-[11px] font-semibold text-text">{r.country}</span>
                        <span className="min-w-0 flex-1 truncate">{[country(r.country), r.city].filter(Boolean).join(' · ')}</span>
                        {r.language && <span className="text-faint">{langName?.of(r.language) || r.language}</span>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[13px] text-faint-2">Not filled in</p>}
              </Card>
              <Card title="Where they sell">
                {global ? <p className="text-[13px]">Everywhere (global)</p> : groups.length ? (
                  <>
                    <p className="text-[13px] text-text mb-2.5">{groups.map((g) => { const [one, many] = LEVEL_NOUN[g.key] || ['market', 'markets']; return plural(g.items.length, one, many); }).join(', ')}</p>
                    <Chips items={groups.flatMap((g) => g.items).slice(0, 12)} />
                    <button type="button" className="mt-3 text-[13px] font-medium text-primary hover:underline" onClick={() => setTab('markets')}>See all markets {'→'}</button>
                  </>
                ) : <p className="text-[13px] text-faint-2">Not filled in</p>}
              </Card>
            </div>
          )}

          {d && tab === 'markets' && (
            <div>
              <p className="text-[13px] text-text mb-3.5">{global ? 'They sell worldwide.' : groups.length ? <>What they chose on the map. They sell worldwide: <b className="font-medium text-fg">no</b>.</> : 'No markets were chosen.'}</p>
              {groups.map((g) => (
                <div key={g.key} className="mb-4 last:mb-0">
                  <p className="text-[13px] font-semibold mb-2">{g.label} <span className="font-normal text-faint ml-1">{g.items.length}</span></p>
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 md:grid-cols-3">
                    {g.items.map((it, i) => <span key={`${it}-${i}`} className="px-3 h-10 inline-flex items-center rounded-control bg-white text-[13.5px] truncate" style={{ boxShadow: '0 0 0 1px var(--input)' }}>{it}</span>)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {d && tab === 'prompts' && (
            (s?.prompts || []).length === 0 ? (
              <p className="text-[13px] text-faint">{counts.topics ? `${plural(counts.topics, 'topic')}, no prompts yet.` : 'No topics or prompts yet.'}</p>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-2.5">
                  <div className="relative basis-full sm:basis-[240px]">
                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                    <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts" aria-label="Search prompts" className="h-8 w-full pl-8 pr-3 rounded-control bg-white text-[13px] outline-none" style={{ boxShadow: '0 0 0 1px var(--input)' }} />
                  </div>
                  <Pill on={intent === 'all'} onClick={() => setIntent('all')} count={view.allIntentCount}>All</Pill>
                  {view.intents.map((i) => <Pill key={i.key} on={intent === i.key} onClick={() => setIntent(i.key)} count={i.count}>{cap(i.key)}</Pill>)}
                </div>
                <div className="flex flex-wrap gap-2 mb-3">
                  <Pill on={topic === 'all'} onClick={() => setTopic('all')} count={view.allTopicCount}>All topics</Pill>
                  {view.topics.map((t) => <Pill key={t.key} on={topic === t.key} onClick={() => setTopic(t.key)} count={t.count}>{t.key}</Pill>)}
                </div>
                <p className="text-[13px] text-text mb-3">Showing <b className="font-medium text-fg">{view.shown}</b> of {view.total} prompts</p>
                <div className="grid gap-3">
                  {view.groups.map((g) => (
                    <Card key={g.topic} title={g.topic} aside={plural(g.prompts.length, 'prompt')}>
                      <ul className="list-none m-0 -my-1.5 p-0">
                        {g.prompts.map((x, i) => (
                          <li key={i} className="flex items-start justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]"><span className="min-w-0">{x.text}</span><IntentTag intent={x.intent} /></li>
                        ))}
                      </ul>
                    </Card>
                  ))}
                  {view.groups.length === 0 && <p className="text-[13px] text-faint">No prompts match.</p>}
                </div>
              </div>
            )
          )}

          {d && tab === 'brand' && (() => {
            const real = (t) => t && t.trim().length > 2;
            const boxes = [['Products and services', p.products], ['Who it is for', p.personas], ['How the brand comes across', p.identity]];
            return (
              <div>
                {real(p.description) && <p className="rounded-control px-4 py-3 mb-3 text-[13.5px] leading-5" style={{ background: '#fafaf9', boxShadow: 'inset 0 0 0 1px var(--border)' }}>{p.description}</p>}
                <div className="grid md:grid-cols-2 gap-3">
                  {boxes.filter(([, v]) => v?.length).map(([k, v]) => <Card key={k} title={k}><Chips items={v} /></Card>)}
                  {p.competitors?.length > 0 && (
                    <Card title={`Competitors (${p.competitors.length})`}>
                      <ul className="list-none m-0 p-0 grid gap-1.5">{p.competitors.map((c, i) => <li key={`${c}-${i}`} className="px-3 h-9 inline-flex items-center rounded-control text-[13px]" style={{ boxShadow: '0 0 0 1px var(--input)' }}>{c}</li>)}</ul>
                    </Card>
                  )}
                </div>
                <NotFilled what={[...(real(p.description) ? [] : ['Description']), ...boxes.filter(([, v]) => !v?.length).map(([k]) => k), ...(p.competitors?.length ? [] : ['Competitors'])]} />
              </div>
            );
          })()}
        </div>

        <div className="flex items-center gap-3 px-4 sm:px-5 py-3 border-t border-border shrink-0">
          <p className="hidden sm:block text-[12.5px] text-faint flex-1">Everything they entered on Get Started, as saved. Read only.</p>
          <span className="flex-1 sm:hidden" />
          <Button variant="light" onClick={onClose}>Close</Button>
          {canApprove && <Button variant="primary" onClick={onApprove}>Approve…</Button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
