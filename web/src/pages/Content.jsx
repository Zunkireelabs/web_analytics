import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, LayoutTemplate, Languages, PenLine } from 'lucide-react';
import { api } from '../api.js';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import OptionPreview from '../components/content/OptionPreview.jsx';
import RealPreview from '../components/content/RealPreview.jsx';
import ApproveBar from '../components/ApproveBar.jsx';
import ContentStages from '../components/content/ContentStages.jsx';
import IdeaPanel from '../components/content/IdeaPanel.jsx';
import ContentDrafts from '../components/content/ContentDrafts.jsx';
import { viewFromParam } from '../lib/content-tabs.js';
import { typeFromParam, stageCounts, CONTENT_TYPES } from '../lib/content-types.js';
import { inDraftScope } from '../lib/draft-scope.js';

// Content: what the agent found to write, as one list per kind (landing pages, translations, blog posts). Each found
// idea shows its options right on the row. You SELECT one option on each, then press Approve ONCE at the bottom: that is
// the approval and only then is it saved. The agent reads the approved picks in its next scheduled run, builds exactly
// those options and puts them in the day's pull request with its other fixes, which a person still merges. This is deliberately not the Action Center board (see ActionCenter.jsx, which
// is the issue list); drafts already generated the old way are on /content/drafts.
const TYPES = [
  { type: 'landing', generatorId: 'landing-page', label: 'Landing pages', icon: LayoutTemplate, found: 'Pages your customers search for that your site does not have yet' },
  { type: 'translation', generatorId: 'translation', label: 'Translations', icon: Languages, found: 'Pages of yours that exist in one language only' },
  { type: 'blog', generatorId: 'blog-outline', label: 'Blog posts', icon: PenLine, found: 'Topics people search for that you have not written about yet' },
];
const GENERATOR_IDS = new Set(TYPES.map((t) => t.generatorId));

const pathOf = (url) => { try { return new URL(url).pathname || '/'; } catch { return url || ''; } };
const titleOf = (item) => item.params?.topic || item.params?.query || item.params?.title || item.title || item.tag || 'Untitled idea';
const urlOf = (item) => { const u = item.url || item.params?.page; return u ? pathOf(u) : ''; };
const findingOf = (item) => item.findingIds?.[0];

export default function Content() {
  const [searchParams] = useSearchParams();
  const view = viewFromParam(searchParams.get('view'));
  const siteId = searchParams.get('siteId') || undefined;
  const type = typeFromParam(searchParams.get('type'));
  const tab = type === 'all' ? 'landing' : type; // the kind used when only one is shown
  const [drafts, setDrafts] = useState(null);     // null = loading
  const [draftsError, setDraftsError] = useState(false);
  const [recs, setRecs] = useState(null);          // null = loading
  const [picks, setPicks] = useState({});          // approved and saved: findingId -> { optionKey, status }
  const [selected, setSelected] = useState({});    // chosen on screen but NOT approved yet: findingId -> { generatorId, optionKey }
  const [catalog, setCatalog] = useState({});
  const [previews, setPreviews] = useState({}); // each option drawn in this site's own look (server: lib/content-preview.js)
  const [builtToday, setBuiltToday] = useState(false); // today's daily run already happened: new approvals wait for tomorrow's
  const [busy, setBusy] = useState(null);
  const [idea, setIdea] = useState(null); // { item, startKey }: the idea whose side panel is open
  const [error, setError] = useState(null);

  const loadDrafts = () => api.actionCenter.drafts({}, siteId).then((all) => { setDrafts((all || []).filter((d) => inDraftScope(d.action_type, 'content'))); setDraftsError(false); }).catch(() => { setDrafts((d) => d || []); setDraftsError(true); });
  useEffect(() => { loadDrafts(); }, [siteId]);

  useEffect(() => {
    let alive = true;
    api.actionCenter.recommendations(siteId).then((all) => { if (alive) setRecs((all?.items || []).filter((i) => GENERATOR_IDS.has(i.generatorId) && findingOf(i))); }).catch(() => { if (alive) setRecs([]); });
    // The picks and the options come first; the option pictures follow per kind (below), so the page is usable before any picture is drawn.
    api.actionCenter.contentPicks(siteId, { previews: false }).then((r) => {
      if (!alive) return;
      setCatalog(r?.catalog || {});
      setBuiltToday(!!r?.builtToday);
      setPicks(Object.fromEntries((r?.picks || []).map((p) => [p.finding_id, { optionKey: p.option_key, status: p.status, notes: p.notes || [] }])));
    }).catch(() => { if (alive) setError('Your picks could not be loaded just now.'); });
    return () => { alive = false; };
  }, [siteId]);

  // The pictures for the kinds on screen, asked for once each. Until one arrives the card shows its sketch; if the site's fonts were still loading, ask once more.
  const wantedKinds = type === 'all' ? TYPES.map((t) => t.generatorId) : [TYPES.find((t) => t.type === type)?.generatorId].filter(Boolean);
  const kindsKey = wantedKinds.join(',');
  const askedKinds = useRef(new Set());
  useEffect(() => { askedKinds.current = new Set(); setPreviews({}); }, [siteId]);
  useEffect(() => {
    if (!Object.keys(catalog).length) return undefined;
    const todo = wantedKinds.filter((g) => !askedKinds.current.has(g));
    if (!todo.length) return undefined;
    todo.forEach((g) => askedKinds.current.add(g));
    let alive = true; let timer;
    const ask = (again) => api.actionCenter.contentPreviews(todo, siteId).then((r) => {
      if (!alive) return;
      setPreviews((p) => ({ ...p, ...(r?.previews || {}) }));
      if (r?.settling && !again) timer = setTimeout(() => ask(true), 3000);
    }).catch(() => { todo.forEach((g) => askedKinds.current.delete(g)); });
    ask(false);
    return () => { alive = false; clearTimeout(timer); };
  }, [kindsKey, catalog, siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const byType = useMemo(() => Object.fromEntries(TYPES.map((t) => [t.type, (recs || []).filter((i) => i.generatorId === t.generatorId)])), [recs]);
  const waitingIn = (t) => byType[t.type].filter((i) => !picks[findingOf(i)] && !selected[findingOf(i)]).length;
  const savedCount = Object.values(picks).filter((p) => p.status === 'saved').length;
  const selectedCount = Object.keys(selected).length;

  // Selecting only marks the option on screen. Clicking the selected option again un-selects it.
  const select = (item, optionKey) => {
    const id = findingOf(item);
    setError(null);
    setSelected((all) => {
      const next = { ...all };
      if (next[id]?.optionKey === optionKey) delete next[id]; else next[id] = { generatorId: item.generatorId, optionKey, notes: next[id]?.notes || picks[id]?.notes || [] };
      return next;
    });
  };
  // What the person asks to change on an idea (a part clicked on the page, or the whole piece). It rides with the option they pick and is approved with it; nothing is built until then.
  const setNotes = (item, optionKey, notes) => {
    const id = findingOf(item);
    setError(null);
    setSelected((all) => ({ ...all, [id]: { generatorId: item.generatorId, optionKey: all[id]?.optionKey || optionKey, notes } }));
  };

  // The one Approve button: everything selected is approved together (and only then saved).
  const approveAll = async () => {
    const list = Object.entries(selected).map(([findingId, v]) => ({ findingId, generatorId: v.generatorId, optionKey: v.optionKey, notes: v.notes || [] }));
    if (!list.length) return;
    setBusy('all'); setError(null);
    try {
      const r = await api.actionCenter.approveContentPicks(list, siteId);
      setPicks((p) => ({ ...p, ...Object.fromEntries((r.saved || []).map((x) => [x.finding_id, { optionKey: x.option_key, status: x.status, notes: x.notes || [] }])) }));
      setSelected({});
    } catch (e) { setError(e.message || 'These could not be approved. Nothing was saved.'); } finally { setBusy(null); }
  };

  // Taking back an approval that the agent has not started on.
  const withdraw = async (item) => {
    const id = findingOf(item);
    setBusy(id); setError(null);
    try {
      await api.actionCenter.clearContentPick(id, siteId);
      setPicks((p) => { const n = { ...p }; delete n[id]; return n; });
    } catch (e) { setError(e.message || 'That could not be taken back.'); } finally { setBusy(null); }
  };

  const current = TYPES.find((t) => t.type === tab);

  // One kind's list of found ideas with their options (the Content studio). All shows each kind in turn.
  const section = (current) => {
    const items = byType[current.type] || [];
    const options = catalog[current.generatorId]?.options || [];
    return (
      <>
      <div className="mt-6 mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-fg flex items-center gap-2"><span className="w-8 h-8 rounded-control grid place-items-center bg-muted text-text"><current.icon size={16} /></span>{current.label} found</h2>
          <p className="text-[13px] text-text mt-1">{current.found}</p>
        </div>
        {recs && <div className="text-[13px]"><b className="text-fg">{items.length}</b> <span className="text-faint">found</span> · <b style={{ color: waitingIn(current) ? '#b54708' : '#1a7f4b' }}>{waitingIn(current)}</b> <span className="text-faint">need{waitingIn(current) === 1 ? 's' : ''} your approval</span></div>}
      </div>

      {recs === null ? (
        <div className="grid gap-3">{[0, 1].map((i) => <div key={i} className="h-64 rounded-card bg-muted animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <div className="tray"><div className="tray-card px-4 py-12 text-center text-sm text-text">The agent has not found any {current.label.toLowerCase()} for you yet. It looks again every morning.</div></div>
      ) : (
        <div className="grid gap-3.5">
          {items.map((item) => {
            const id = findingOf(item);
            const mine = picks[id];
            const active = mine && mine.status !== 'withdrawn' ? mine : null; // a withdrawn pick can no longer be built, so no option stays approved
            const sel = selected[id] || null;
            const chosen = options.find((o) => o.key === active?.optionKey);
            const selOpt = options.find((o) => o.key === sel?.optionKey);
            const locked = mine && mine.status !== 'saved' && mine.status !== 'withdrawn';
            return (
              <div key={id} className="tray"><div className="tray-card">
                <div className="px-4 py-3.5 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1" style={{ minWidth: 240 }}>
                    <div className="flex items-center gap-2 flex-wrap"><h3 className="text-[15px] font-semibold text-fg">{titleOf(item)}</h3>{urlOf(item) && <span className="text-xs text-faint">{urlOf(item)}</span>}</div>
                    {item.reason && <p className="text-[13px] leading-5 text-text mt-1">{item.reason}</p>}
                  </div>
                  {sel ? <Badge tone="amber">Selected: Option {sel.optionKey}{selOpt ? `, ${selOpt.name}` : ''}. Not approved yet</Badge>
                    : mine?.status === 'withdrawn' ? <Badge tone="red">Could not be built. Select an option again</Badge>
                    : mine ? <Badge tone="green">{mine.status === 'shipped' ? 'Pull request opened' : mine.status === 'building' ? 'Building now' : `Approved: Option ${mine.optionKey}${chosen ? `, ${chosen.name}` : ''}. Builds in the next run`}</Badge>
                    : <Badge tone="amber">Approval needed. Select one option</Badge>}
                </div>
                <div className="px-4 pb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
                  {options.map((o) => {
                    const isSel = sel?.optionKey === o.key;
                    const isApproved = !sel && active?.optionKey === o.key;
                    const on = isSel || isApproved;
                    return (
                      <div key={o.key} className="rounded-[12px] bg-white overflow-hidden" style={{ boxShadow: `0 0 0 ${on ? 2 : 1}px ${on ? 'var(--primary)' : 'var(--border-2)'}` }}>
                        <div role="button" tabIndex={0} aria-label={`See Option ${o.key} on your site`} title="See it on your site" onClick={() => setIdea({ item, startKey: o.key })}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIdea({ item, startKey: o.key }); }}
                          className={`flex justify-center border-b border-border cursor-pointer ${previews[current.generatorId]?.[o.key] ? '' : 'p-3'}`} style={{ background: '#faf9f7' }}>
                          {previews[current.generatorId]?.[o.key] ? <RealPreview html={previews[current.generatorId][o.key]} title={o.name} height={460} /> : <OptionPreview type={current.type} optionKey={o.key} />}
                        </div>
                        <div className="px-3.5 pt-3 pb-3.5">
                          <div className="flex items-center gap-2 flex-wrap"><span className="text-[11px] font-semibold tracking-[.06em] uppercase text-faint">Option {o.key}</span>{o.tag && <Badge tone="amber">{o.tag}</Badge>}</div>
                          <div className="text-sm font-semibold text-fg mt-0.5">{o.name}</div>
                          <p className="text-[13px] leading-5 text-text mt-1" style={{ minHeight: 40 }}>{o.note}</p>
                          <div className="mt-2.5">
<Button variant={on ? 'light' : 'primary'} onClick={() => select(item, o.key)} disabled={busy === id || busy === 'all' || locked}>
                              {isSel ? <><Check size={14} />Selected</> : isApproved ? <><Check size={14} />Approved</> : 'Select this one'}
                            </Button>
                            {isApproved && mine?.status === 'saved' && <button type="button" className="ml-3 text-[13px] text-text underline underline-offset-2 hover:text-fg" onClick={() => withdraw(item)} disabled={busy === id}>Take back approval</button>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div></div>
            );
          })}
        </div>
      )}

      </>
    );
  };

  // The numbers for the toggle and the stage strip, per kind. Ideas waiting come from the recommendations, the rest from the drafts.
  const counts = Object.fromEntries(CONTENT_TYPES.map((t) => [t.key, stageCounts(drafts, t.key, t.key === 'all' ? TYPES.reduce((n, x) => n + waitingIn(x), 0) : waitingIn(TYPES.find((x) => x.type === t.key)))]));

  // Drafted and History are part of this page (?view=), not another page. All hooks are above this line.
  if (view !== 'ideas') {
    return (
      <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-8 fade-up">
        <ContentStages view={view} type={type} counts={counts} />
        <ContentDrafts view={view} drafts={drafts} error={draftsError} type={type} siteId={siteId} onChanged={loadDrafts} openId={searchParams.get('openDraft')} />
      </div>
    );
  }

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-8 fade-up">
      <ContentStages view="ideas" type={type} counts={counts} />

      <div className="rounded-[16px] px-6 py-5" style={{ background: 'linear-gradient(135deg,#fff3ea 0%,#fff 62%)', boxShadow: '0 0 0 1px var(--primary-ring)' }}>
        <div className="text-[11px] font-semibold tracking-[.1em] uppercase text-primary">Content studio</div>
        <h1 className="mt-2 text-fg text-[25px] leading-[31px] font-semibold tracking-[-0.025em]">{selectedCount ? `${selectedCount} selected. Approve them below.` : savedCount ? `${savedCount} approved for the next run.` : 'Select one option for each idea.'}</h1>
        <p className="mt-2 text-sm leading-6 text-text max-w-[760px]">Select one option on each idea, then press Approve once at the bottom. The agent reads what you approved in its next run, builds exactly that and opens the pull request with the day's other fixes. Nothing reaches your site until someone merges it.</p>
      </div>

      {error && <div className="mt-3 rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3">{error}</div>}

      {(type === 'all' ? TYPES : [current]).map((t) => <Fragment key={t.type}>{section(t)}</Fragment>)}

      {idea && (() => {
        const t = TYPES.find((x) => x.generatorId === idea.item.generatorId) || TYPES[0];
        const id = findingOf(idea.item);
        return <IdeaPanel idea={{ item: idea.item, startKey: idea.startKey, generatorId: t.generatorId, siteId, title: titleOf(idea.item), url: urlOf(idea.item), options: catalog[t.generatorId]?.options || [], previews: previews[t.generatorId] || {},
          selectedKey: selected[id]?.optionKey || (picks[id] && picks[id].status !== 'withdrawn' ? picks[id].optionKey : null), notes: selected[id]?.notes || picks[id]?.notes || [], locked: Boolean(picks[id] && picks[id].status !== 'saved' && picks[id].status !== 'withdrawn') }}
          onClose={() => setIdea(null)} onPick={(key) => select(idea.item, key)} onNotes={(key, notes) => setNotes(idea.item, key, notes)} />;
      })()}

      <ApproveBar builtToday={builtToday} selected={selectedCount} approved={savedCount} busy={busy === 'all'} onApprove={approveAll} onClear={() => setSelected({})} noun="idea" />
    </div>
  );
}
