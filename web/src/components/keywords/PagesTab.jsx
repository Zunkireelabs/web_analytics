import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, ChevronDown, ChevronRight, FileText, Wand2 } from 'lucide-react';
import { api, SELF } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import KpiStrip from '../layout/KpiStrip.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import { Pill, RankChip, num } from './shared.jsx';

const PAGES_SHOWN = 6;
const STEPS = [
  ['Reads Search Console', 'Every morning it pulls which search terms brought people to which page, and where each one ranks.'],
  ['Matches terms to pages', 'A term belongs to the page that earns the impressions for it. Your keywords per page come from that.'],
  ['Lists every page it can find', 'From your sitemap and a crawl, so pages nobody found yet still show up here.'],
  ['Flags the ones with nothing', 'A page with no search terms goes in the list below. Legal and utility pages are skipped on purpose.'],
  ['Suggests keywords to aim at', 'From the keywords it has collected, it picks the ones that fit the page. You approve before anything changes.'],
];

// Pages tab: the keywords each page ranks for, and the pages that rank for nothing. Built from the same
// Search Console rows as the Keywords tab, grouped by page, plus the site's own page list.
export default function PagesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('impressions');
  const [open, setOpen] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState({}); // page -> message after "Optimize this page"

  useEffect(() => {
    api.keywords.pages(SELF).then((d) => { setData(d); setOpen(d.pages[0]?.page || null); }).catch((e) => setError(e.message || 'Could not load your pages.'));
  }, []);

  const pages = useMemo(() => {
    const rows = [...(data?.pages || [])];
    if (sort === 'position') rows.sort((a, b) => (a.bestPosition ?? 999) - (b.bestPosition ?? 999));
    if (sort === 'keywords') rows.sort((a, b) => b.n - a.n);
    return rows;
  }, [data, sort]);

  // A page with no keywords gets a draft from the keyword the agent suggested, or a content expansion when
  // nothing fits. Same route as the Analyst page's "Send to Action Center".
  const optimize = async (row) => {
    setBusy(row.page);
    try {
      const opportunity = row.suggestions[0]
        ? { type: 'quick-win', page: row.page, query: row.suggestions[0] }
        : { type: 'page1-opportunity', page: row.page };
      await api.keywords.generateOpportunityDraft(SELF, opportunity);
      setNotes((n) => ({ ...n, [row.page]: 'Sent to Action Center, where it waits for your approval.' }));
    } catch (e) {
      setNotes((n) => ({ ...n, [row.page]: e.message || 'Could not prepare that right now.' }));
    } finally { setBusy(null); }
  };

  if (error) return <p className="px-1 text-[13px]" style={{ color: '#b42318' }}>{error}</p>;
  if (!data) return <KpiStrip loading items={[1, 2, 3, 4]} />;
  const s = data.summary;
  const shown = showAll ? pages : pages.slice(0, PAGES_SHOWN);
  const sortControls = <SegmentedTabs value={sort} onChange={setSort} options={[{ value: 'impressions', label: 'Most impressions' }, { value: 'position', label: 'Best ranking' }, { value: 'keywords', label: 'Most keywords' }]} />;

  return (
    <>
      <KpiStrip items={[
        { label: 'Pages with keywords', value: num(s.pagesWithKeywords), sub: `of ${num(s.totalPages)} pages found` },
        { label: 'Pages with none', value: num(s.pagesWithNone), sub: `${num(s.worthFixing)} worth fixing, ${num(s.skipped)} skipped` },
        { label: 'Impressions', value: num(s.impressions), sub: 'last 28 days' },
        { label: 'Keywords in top 3', value: num(s.top3), sub: 'across all pages' },
      ]} />

      <SettingsCard icon={FileText} title="Keywords on each page"
        description="Each page with the keywords that bring people to it, and the impressions they earn. Last 28 days."
        action={pages.length > 1 && <div className="hidden sm:block">{sortControls}</div>}>
        {pages.length > 1 && <div className="sm:hidden px-4 py-2.5 border-b border-border overflow-x-auto no-scrollbar">{sortControls}</div>}
        {pages.length === 0 ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">No page has been shown in search yet. They appear here as Google starts showing your pages.</p>
        ) : (
          <>
            {shown.map((r) => {
              const isOpen = open === r.page;
              return (
                <div key={r.page} className="border-b border-border last:border-0">
                  <button type="button" onClick={() => setOpen(isOpen ? null : r.page)} aria-expanded={isOpen}
                    className={`w-full text-left px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 ${isOpen ? 'bg-muted/50' : ''}`}>
                    <span className="text-faint shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                    <div className="min-w-0 flex-1 basis-[220px]"><div className="text-[13px] font-medium text-fg truncate">{r.path}</div><div className="text-xs text-faint truncate">Best: {r.topKeyword}</div></div>
                    <div className="flex items-center gap-2 shrink-0"><RankChip position={r.bestPosition} />{r.bestPosition != null && <span className="text-xs text-faint tnum">position {r.bestPosition}</span>}</div>
                    <div className="flex items-center gap-4 shrink-0 text-xs text-text tnum">
                      <span><b className="font-medium text-fg">{num(r.n)}</b> {r.n === 1 ? 'keyword' : 'keywords'}</span><span><b className="font-medium text-fg">{num(r.impressions)}</b> impressions</span><span><b className="font-medium text-fg">{num(r.clicks)}</b> clicks</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-4 sm:px-5 pb-3.5 pt-1 bg-muted/50">
                      <div className="md:hidden rounded-card bg-white" style={{ boxShadow: 'var(--ring)' }}>{r.keywords.map((k) => (
                        <div key={k.keyword} className="px-3 py-2.5 border-b border-border last:border-0">
                          <div className="text-[13px] font-medium text-fg">{k.keyword}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text tnum"><RankChip position={k.position} /><span>position {k.position}</span><span>{num(k.impressions)} impressions</span><span>{num(k.clicks)} clicks</span></div>
                        </div>
                      ))}</div>
                      <div className="hidden md:block rounded-card bg-white overflow-x-auto" style={{ boxShadow: 'var(--ring)' }}>
                        <table className="tbl">
                          <thead><tr><th>Keyword</th><th className="num">Impressions</th><th className="num">Clicks</th><th>Position</th></tr></thead>
                          <tbody>{r.keywords.map((k) => (
                            <tr key={k.keyword}><td className="font-medium">{k.keyword}</td><td className="num">{num(k.impressions)}</td><td className="num">{num(k.clicks)}</td><td><span className="tnum">{k.position}</span> <RankChip position={k.position} /></td></tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {pages.length > PAGES_SHOWN && (
              <div className="flex items-center justify-between px-4 sm:px-5 py-2.5 border-t border-border text-xs text-faint">
                <span>Showing {shown.length} of {num(pages.length)} pages</span>
                <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : 'Show all'}</Button>
              </div>
            )}
          </>
        )}
      </SettingsCard>

      <SettingsCard icon={AlertTriangle} title="Pages with no keywords yet"
        description="These pages exist but search sends nobody to them. Where the agent has collected keywords that fit a page, it suggests them."
        action={s.worthFixing > 0 && <Badge tone="amber">{s.worthFixing} to fix</Badge>}>
        {data.none.length === 0 ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">Every page the agent found is already shown in search.</p>
        ) : data.none.map((r) => (
          <div key={r.page} className="px-4 sm:px-5 py-3.5 border-b border-border last:border-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
            <div className="min-w-0 flex-1 basis-[260px]">
              <div className="flex items-center gap-2"><span className="text-[13px] font-medium text-fg break-all">{r.path}</span><Badge tone="amber">No keywords</Badge></div>
              <div className="text-xs text-faint mt-0.5">{r.why}</div>
              {r.suggestions.length > 0 && <div className="flex flex-wrap items-center gap-1.5 mt-2"><span className="text-xs text-text">Agent suggests</span>{r.suggestions.map((sg) => <Pill key={sg}>{sg}</Pill>)}</div>}
              {notes[r.page] && <div className="text-xs text-text mt-2">{notes[r.page]}</div>}
            </div>
            <Button variant="light" className="shrink-0" onClick={() => optimize(r)} disabled={busy === r.page || !!notes[r.page]}><Wand2 size={14} />{busy === r.page ? 'Preparing…' : 'Optimize this page'}</Button>
          </div>
        ))}
        {s.skipped > 0 && <div className="px-4 sm:px-5 py-2.5 border-t border-border text-xs text-faint">{num(s.skipped)} more are skipped on purpose: privacy, terms, cookie policy, thank-you pages and login pages do not need keywords.</div>}
      </SettingsCard>

      <SettingsCard icon={Bot} title="How the agent builds this" description="Five steps, every morning. Nothing is changed on your site without your approval.">
        <ol className="px-4 sm:px-5 pb-3" style={{ listStyle: 'none', margin: 0 }}>
          {STEPS.map(([t, b], i) => (
            <li key={t} className="flex gap-3 py-3 border-t border-border first:border-t-0">
              <span className="w-6 h-6 rounded-full grid place-items-center text-[12px] font-medium shrink-0 mt-0.5 bg-muted text-text">{i + 1}</span>
              <div className="min-w-0"><div className="text-[13px] font-medium text-fg">{t}</div><p className="mt-0.5 text-xs leading-[18px] text-text">{b}</p></div>
            </li>
          ))}
        </ol>
      </SettingsCard>
    </>
  );
}
