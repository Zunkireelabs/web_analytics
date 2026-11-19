import { useEffect, useMemo, useState } from 'react';
import { ScanSearch, Search, Lock } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import { ProjectAvatar } from './ListParts.jsx';
import { siteInitials } from '../../lib/nav.js';
import { PERIODS, num, changeText, freshness } from '../ai-crawlers/parts.jsx';

// Account settings -> Platform -> AI crawlers: every client's AI crawler numbers side by side, for the SuperRank team only
// (server/routes/platform.js answers 404 to anyone else). Open switches into that client's project, logged as a support view like
// every other staff open, and lands on the same Crawlers tab the client sees.

const FILTERS = [['all', 'All'], ['tracking', 'Tracking'], ['attention', 'Needs attention'], ['notset', 'Not set up']];
const stateOf = (c) => {
  if (!c.connected) return 'notset';
  const f = freshness(c.lastUploadAt);
  return f.state === 'ok' ? 'tracking' : 'attention';
};

export default function CrawlersCompareView({ onOpen }) {
  const [days, setDays] = useState(28);
  const [mode, setMode] = useState('client');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(null);

  useEffect(() => {
    let off = false; setData(null); setError(null);
    api.platform.aiCrawlers(days).then((d) => { if (!off) setData(d); }).catch((e) => { if (!off) setError(e.message || 'Could not load the comparison.'); });
    return () => { off = true; };
  }, [days]);

  const clients = data?.clients || [];
  const counts = useMemo(() => {
    const c = { all: clients.length, tracking: 0, attention: 0, notset: 0 };
    for (const x of clients) c[stateOf(x)]++;
    return c;
  }, [clients]);
  const shown = clients.filter((c) => (filter === 'all' || stateOf(c) === filter) && (!q || `${c.name} ${c.domain || ''}`.toLowerCase().includes(q.toLowerCase())));
  const totalVisits = clients.reduce((n, c) => n + c.visits, 0);
  const crawlers = useMemo(() => [...new Map(clients.flatMap((c) => c.byCrawler).map((b) => [b.id, b.label])).entries()], [clients]);

  const open = async (c) => {
    setOpening(c.siteId);
    try { await onOpen(c.siteId); } catch (e) { setError(e.message || 'Could not open that project.'); setOpening(null); }
  };

  return (
    <SettingsCard icon={ScanSearch} title="AI crawlers across clients" description="Which AI bots read each client's website, side by side. Only SuperRank staff see this page.">
      <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-3 border-b border-border">
        <SegmentedTabs options={PERIODS} value={days} onChange={setDays} />
        <SegmentedTabs options={[{ value: 'client', label: 'By client' }, { value: 'crawler', label: 'By crawler' }]} value={mode} onChange={setMode} />
      </div>
      {error && <div className="px-5 py-4 text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</div>}
      {!error && !data && <div className="px-5 py-8"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>}
      {data && <>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-4 sm:px-5 py-4 border-b border-border">
          {[['Tracking', counts.tracking, ''], ['Not set up', counts.notset, ''], ['Needs attention', counts.attention, counts.attention ? 'bg-[#fdf3e1]' : ''], ['Verified AI visits, all clients', num(totalVisits), '']].map(([l, v, bg]) => (
            <div key={l} className={`rounded-[10px] bg-muted/60 px-4 py-3 ${bg}`}><div className="text-[22px] font-medium text-fg tnum">{v}</div><div className="text-[13px] text-faint">{l}</div></div>))}
        </div>
        <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-2 border-b border-border">
          <label className="relative flex-1 min-w-[180px] max-w-[300px]"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input className="field w-full pl-8" placeholder="Search client" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search client" /></label>
          {FILTERS.map(([k, l]) => <button key={k} type="button" onClick={() => setFilter(k)} className={`badge ${filter === k ? 'badge--dark' : 'badge--grey'}`} style={{ height: 28, padding: '0 12px', fontSize: 13 }}>{l} {counts[k]}</button>)}
        </div>
        {mode === 'client' ? (
          <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Client</th><th className="num">Verified visits</th><th className="num max-md:hidden">Crawlers</th><th className="max-lg:hidden">Pages reached</th><th className="num max-lg:hidden">Errors</th><th className="max-lg:hidden">Last update</th><th /></tr></thead>
            <tbody>{shown.map((c) => {
              const st = stateOf(c); const f = freshness(c.lastUploadAt); const ch = changeText(c.change);
              return (
                <tr key={c.siteId}>
                  <td><div className="flex items-center gap-2.5 min-w-0"><span className="max-sm:hidden"><ProjectAvatar name={c.name} initials={siteInitials(c.name)} /></span><div className="min-w-0"><div className="font-medium text-fg truncate">{c.name}</div><div className="text-xs text-faint truncate">{c.domain || '—'}</div></div></div></td>
                  {st === 'notset' ? <td colSpan={4} className="text-faint max-md:hidden">No data yet. Not connected to a web server.</td> : <>
                    <td className="num tnum">{num(c.visits)} {ch && <span className="text-xs" style={{ color: c.change >= 0 ? '#1a7f4b' : '#b42318' }}>{ch}</span>}</td>
                    <td className="num tnum max-md:hidden">{c.crawlersSeen}</td>
                    <td className="tnum max-lg:hidden">{c.pagesTotal ? `${c.pagesReached} of ${c.pagesTotal}` : '—'}</td>
                    <td className="num tnum max-lg:hidden">{c.errors ? <span style={{ color: '#b42318' }}>{c.errors}</span> : <span className="text-faint">0</span>}</td></>}
                  <td className="max-lg:hidden">{st === 'notset' ? <Badge tone="grey">Not set up</Badge> : st === 'attention' ? <Badge tone="amber">{f.text}</Badge> : <span className="text-faint">{f.text}</span>}</td>
                  <td className="text-right"><Button variant="light" size="sm" onClick={() => open(c)} disabled={opening === c.siteId}>{st === 'notset' ? 'Open' : 'Open'}</Button></td>
                </tr>);
            })}</tbody></table></div>
        ) : (
          <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Crawler</th>{shown.map((c) => <th key={c.siteId} className="num">{c.name}</th>)}</tr></thead>
            <tbody>{crawlers.length === 0 && <tr><td colSpan={shown.length + 1} className="text-faint">No AI crawler seen yet.</td></tr>}
              {crawlers.map(([id, label]) => <tr key={id}><td className="font-medium text-fg">{label}</td>{shown.map((c) => { const v = c.byCrawler.find((b) => b.id === id)?.visits; return <td key={c.siteId} className="num tnum">{v ? num(v) : <span className="text-faint">—</span>}</td>; })}</tr>)}</tbody></table></div>
        )}
        <div className="tbl-foot"><span>Totals count verified AI crawlers only. Googlebot is shown on each client's own page, not here.</span><span className="inline-flex items-center gap-1"><Lock size={12} /> Clients never see this page or each other's data</span></div>
      </>}
    </SettingsCard>
  );
}
