import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, Search } from 'lucide-react';
import { api, SELF } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import KpiStrip from '../layout/KpiStrip.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import PlanModal from './PlanModal.jsx';
import { PLAN_LABEL, RankChip, Trend, num, pathOf } from './shared.jsx';

const HAVE_SHOWN = 8;
const NEW_SHOWN = 6;
const MAX_KEYWORD_LENGTH = 200;

// Keywords tab, top to bottom: what the site already ranks for (with the page and impressions), what people
// search that it has no page for (with what they could bring), and adding a keyword of your own, which asks
// what to create for it. The numbers are the last 28 days of Search Console data; see keyword-plan.js.
export default function KeywordsTab({ isProduct }) {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [haveSort, setHaveSort] = useState('impressions');
  const [showAllHave, setShowAllHave] = useState(false);
  const [newSort, setNewSort] = useState('best');
  const [industry, setIndustry] = useState('All');
  const [showAllNew, setShowAllNew] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState(null);
  const [ask, setAsk] = useState(null); // { keyword, gapId?, recommended?, volume? }
  const [note, setNote] = useState(null);

  const load = () => api.keywords.overview(SELF).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message || 'Could not load your keywords.'));
  useEffect(() => { load(); }, []);

  const have = useMemo(() => {
    const rows = [...(data?.have || [])];
    if (haveSort === 'position') rows.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    return rows;
  }, [data, haveSort]);

  const notYet = useMemo(() => {
    let rows = data?.notYet || [];
    if (isProduct && industry !== 'All') rows = rows.filter((r) => r.industry === industry);
    if (newSort === 'rising') rows = rows.filter((r) => r.trend?.pct > 0).sort((a, b) => b.trend.pct - a.trend.pct);
    return rows;
  }, [data, newSort, industry, isProduct]);

  const submitTyped = (e) => {
    e.preventDefault();
    const keyword = typed.trim().replace(/\s+/g, ' ');
    if (!keyword) { setTypedError('Type a keyword first.'); return; }
    if (keyword.length > MAX_KEYWORD_LENGTH) { setTypedError(`Keep it to ${MAX_KEYWORD_LENGTH} characters or fewer.`); return; }
    setTypedError(null);
    setAsk({ keyword });
  };
  const done = (message) => { setAsk(null); setTyped(''); setNote(message); load(); };

  if (error) return <p className="px-1 text-[13px]" style={{ color: '#b42318' }}>{error}</p>;
  if (!data) return <KpiStrip loading items={[1, 2, 3, 4]} />;

  const noGsc = !data.window;
  const s = data.summary;
  const haveRows = showAllHave ? have : have.slice(0, HAVE_SHOWN);
  const newRows = showAllNew ? notYet : notYet.slice(0, NEW_SHOWN);

  const haveControls = <SegmentedTabs value={haveSort} onChange={setHaveSort} options={[{ value: 'impressions', label: 'Most impressions' }, { value: 'position', label: 'Best ranking' }]} />;
  const newControls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {isProduct && data.industries.length > 0 && (
        <div className="max-w-full overflow-x-auto no-scrollbar">
          <SegmentedTabs value={industry} onChange={setIndustry} options={['All', ...data.industries].map((i) => ({ value: i, label: i }))} />
        </div>
      )}
      <SegmentedTabs value={newSort} onChange={setNewSort} options={[{ value: 'best', label: 'Best first' }, { value: 'rising', label: 'Rising' }]} />
    </div>
  );

  const planCell = (r) => (r.plan ? (
    <span className="inline-flex items-center gap-2">
      <Badge tone={r.plan === 'track' ? 'grey' : 'green'}>{r.plan === 'track' ? 'Tracking' : `${PLAN_LABEL[r.plan]} planned`}</Badge>
      {r.plan === 'track' && <Button size="sm" variant="ghost" onClick={() => setAsk({ keyword: r.keyword, gapId: r.id, recommended: r.recommended, volume: r.volume })}>Change</Button>}
    </span>
  ) : (
    <Button size="sm" variant="light" onClick={() => setAsk({ keyword: r.keyword, gapId: r.id, recommended: r.recommended, volume: r.volume })}><Plus size={14} />Go after this</Button>
  ));

  return (
    <>
      <KpiStrip items={[
        { label: 'Keywords on your site', value: num(s.keywords), sub: `across ${num(s.pages)} pages` },
        { label: 'Impressions', value: num(s.impressions), sub: 'last 28 days' },
        { label: 'In the top 3', value: num(s.top3), sub: 'positions 1 to 3' },
        { label: 'To go after', value: num(s.toGoAfter), sub: 'collected by the agent' },
      ]} />

      {note && (
        <div className="rounded-control bg-muted px-3 py-2 text-[13px] text-text flex items-start gap-2">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-faint" /><span className="flex-1">{note}</span>
          <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setNote(null)}>Dismiss</button>
        </div>
      )}

      <SettingsCard icon={CheckCircle2} title="Keywords your site already has"
        description={noGsc ? 'These appear once Search Console has data for this project.' : `${num(s.keywords)} keywords on ${num(s.pages)} pages, bringing ${num(s.impressions)} impressions in the last 28 days.`}
        action={have.length > 1 && <div className="hidden sm:block">{haveControls}</div>}>
        {have.length > 1 && <div className="sm:hidden px-4 py-2.5 border-b border-border">{haveControls}</div>}
        {have.length === 0 ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">{noGsc ? 'Search Console is not sending data for this project yet.' : 'No keywords have been shown in search yet. They appear here as Google starts showing your pages.'}</p>
        ) : (
          <>
            <div className="hidden lg:block overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Keyword</th><th>Page</th><th className="num">Impressions</th><th className="num">Clicks</th><th>Position</th></tr></thead>
                <tbody>{haveRows.map((r) => (
                  <tr key={r.keyword}>
                    <td className="font-medium">{r.keyword}</td>
                    <td className="text-text">{pathOf(r.page)}{r.pageCount > 1 && <span className="text-xs text-faint"> +{r.pageCount - 1} more</span>}</td>
                    <td className="num">{num(r.impressions)}</td><td className="num">{num(r.clicks)}</td>
                    <td><span className="tnum">{r.position}</span> <RankChip position={r.position} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="lg:hidden">{haveRows.map((r) => (
              <div key={r.keyword} className="px-4 py-3 border-b border-border last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="text-[13px] font-medium text-fg">{r.keyword}</div><div className="text-xs text-faint mt-0.5 truncate">{pathOf(r.page)}</div></div>
                  <RankChip position={r.position} />
                </div>
                <div className="mt-1.5 flex gap-4 text-xs text-text tnum"><span><b className="font-medium text-fg">{num(r.impressions)}</b> impressions</span><span><b className="font-medium text-fg">{num(r.clicks)}</b> clicks</span><span>position {r.position}</span></div>
              </div>
            ))}</div>
            {have.length > HAVE_SHOWN && (
              <div className="flex items-center justify-between px-4 sm:px-5 py-2.5 border-t border-border text-xs text-faint">
                <span>Showing {haveRows.length} of {num(have.length)} keywords</span>
                <Button size="sm" variant="ghost" onClick={() => setShowAllHave((v) => !v)}>{showAllHave ? 'Show fewer' : `Show all ${num(have.length)}`}</Button>
              </div>
            )}
          </>
        )}
      </SettingsCard>

      <SettingsCard icon={Search} title="Keywords people search that you do not have yet"
        description="The agent collects these from Search Console and market demand. Add the ones worth going after."
        action={<div className="hidden sm:block">{newControls}</div>}>
        <div className="sm:hidden px-4 py-2.5 border-b border-border">{newControls}</div>
        {notYet.length === 0 ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">{data.notYet.length === 0 ? 'The agent has not collected any new keywords yet. They appear here after its next research run.' : 'Nothing matches that filter.'}</p>
        ) : (
          <>
            <div className="hidden lg:block overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Keyword</th><th className="num">People search it a month</th><th className="num">Could bring you*</th><th>Last 3 months</th><th /></tr></thead>
                <tbody>{newRows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'normal' }}><div className="font-medium">{r.keyword}</div><div className="text-xs text-faint mt-0.5">{r.why}</div></td>
                    <td className="num">{num(r.volume)}</td>
                    <td className="num font-medium">{r.potential != null ? `~${num(r.potential)}` : '—'}</td>
                    <td><Trend trend={r.trend} /></td>
                    <td className="num">{planCell(r)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="lg:hidden">{newRows.map((r) => (
              <div key={r.id} className="px-4 py-3.5 border-b border-border last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="text-[13px] font-medium text-fg">{r.keyword}</div><div className="text-xs text-faint mt-0.5">{r.why}</div></div>
                  <div className="shrink-0 text-right"><Trend trend={r.trend} width={56} height={20} /></div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-text tnum"><b className="font-medium text-fg">{num(r.volume)}</b> search it a month{r.potential != null && <> · could bring <b className="font-medium text-fg">~{num(r.potential)}</b></>}</div>
                  {planCell(r)}
                </div>
              </div>
            ))}</div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-2.5 border-t border-border text-xs text-faint">
              <span>* Estimated impressions a month if the keyword reached page 1.</span>
              {notYet.length > NEW_SHOWN && <Button size="sm" variant="ghost" onClick={() => setShowAllNew((v) => !v)}>{showAllNew ? 'Show fewer' : `Show all ${num(notYet.length)}`}</Button>}
            </div>
          </>
        )}
      </SettingsCard>

      <SettingsCard icon={Plus} title="Add a keyword" description="Type a search you want to win, or pick one we suggest. We then ask what to create for it.">
        <form onSubmit={submitTyped} className="px-4 sm:px-5 py-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Field className="flex-1" aria-label="Keyword" placeholder="e.g. seo for law firms" value={typed} maxLength={MAX_KEYWORD_LENGTH + 20}
              error={typedError} onChange={(e) => { setTyped(e.target.value); setTypedError(null); }} />
            <Button type="submit" variant="primary" className="sm:self-start"><Plus size={14} />Add</Button>
          </div>
          {data.suggestions.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-text">Suggested for your site</span>
              {data.suggestions.map((sg) => (
                <button key={sg} type="button" onClick={() => setAsk({ keyword: sg })}
                  className="inline-flex items-center gap-1 h-[26px] px-2.5 rounded-full text-xs font-medium bg-white text-fg" style={{ boxShadow: 'var(--ring)' }}>
                  <Plus size={11} className="text-faint" />{sg}
                </button>
              ))}
            </div>
          )}
        </form>
      </SettingsCard>

      {ask && <PlanModal {...ask} onClose={() => setAsk(null)} onDone={done} />}
    </>
  );
}
