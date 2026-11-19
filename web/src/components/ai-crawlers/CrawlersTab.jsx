import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import KpiStrip from '../layout/KpiStrip.jsx';
import { Tray, TrayCard } from '../layout/Tray.jsx';
import Drawer from '../Drawer.jsx';
import { CHART } from '../../lib/palette.js';
import { PERIODS, KIND_LABEL, KIND_HELP, num, shortDay, changeText, changeTone, freshness, StackedBars, Legend, vendorColor } from './parts.jsx';

// AI visibility › Crawlers: which AI bots read this project's website (server/routes/ai-crawlers.js). Counts come from the
// web server's own log, verified against each company's published addresses; the project is whatever the session is in.

function Headline({ s }) {
  const t = s.totals;
  if (t.visits === 0) return <div className="text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] text-fg">No verified AI crawler visits in this period</div>;
  const dir = t.change == null ? '' : t.change > 0 ? `, up ${t.change}%` : t.change < 0 ? `, down ${Math.abs(t.change)}%` : ', unchanged';
  return <div className="text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] text-fg">AI crawlers made {num(t.visits)} verified visit{t.visits === 1 ? '' : 's'}{dir}</div>;
}

function NotConnected() {
  return (
    <div className="tray"><div className="tray-card px-5 py-8 text-center">
      <h2 className="text-[15px] font-semibold text-fg">AI crawler tracking is not connected for this project yet</h2>
      <p className="mt-1.5 text-[13px] text-text max-w-[520px] mx-auto">We read which AI bots visit your website from your web server's own log, once an hour. It needs a small setup on the server, which the SuperRank team does. Nothing about your visitors is collected.</p>
    </div></div>
  );
}

function CrawlerRow({ c, onOpen }) {
  const unverifiable = !c.verifiable && c.visits === 0;
  return (
    <tr className="cursor-pointer" onClick={() => onOpen(c)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c); }}>
      <td>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: vendorColor(c.vendor) }} />
          <div className="min-w-0">
            <div className="font-medium text-fg truncate">{c.label}</div>
            <div className="text-xs text-faint truncate">{c.vendor} · <span title={KIND_HELP[c.kind]}>{KIND_LABEL[c.kind]}</span></div>
          </div>
        </div>
      </td>
      <td className="num tnum">
        {unverifiable ? <span className="text-faint" title="This company publishes no list of addresses, so a visit cannot be proven">—</span> : num(c.visits)}
        {c.unchecked > 0 && <div className="text-xs text-faint font-normal">{num(c.unchecked)} unproven</div>}
        {c.unverified > 0 && <div className="text-xs font-normal" style={{ color: '#8a5300' }}>{num(c.unverified)} not counted</div>}
      </td>
      <td className="num tnum max-sm:hidden">{c.pagesRead}</td>
      <td className="num tnum max-sm:hidden">{c.errors > 0 ? <span style={{ color: '#b42318' }}>{c.errors}</span> : <span className="text-faint">0</span>}</td>
      <td className="text-faint max-lg:hidden">{shortDay(c.lastDay)}</td>
    </tr>
  );
}

function CrawlerTable({ rows, onOpen }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl"><thead><tr><th>Crawler</th><th className="num">Verified visits</th><th className="num max-sm:hidden">Pages</th><th className="num max-sm:hidden">Errors</th><th className="max-lg:hidden">Last visit</th></tr></thead>
        <tbody>{rows.map((c) => <CrawlerRow key={c.id} c={c} onOpen={onOpen} />)}</tbody></table>
    </div>
  );
}

function CrawlerDrawer({ crawler, onClose }) {
  const c = crawler;
  const days = c ? Object.entries(c.daily).sort(([a], [b]) => a.localeCompare(b)) : [];
  const max = Math.max(1, ...days.map(([, n]) => n));
  return (
    <Drawer isOpen={!!c} onClose={onClose} title={c?.label} subtitle={c ? `${c.vendor} · ${KIND_HELP[c.kind]}` : ''} maxWidth="max-w-[440px]">
      {c && (
        <div>
          <div className="grid grid-cols-3 border-b border-border">
            {[['Visits', num(c.visits)], ['Pages read', c.pagesRead], ['Errors', c.errors]].map(([l, v], i) => (
              <div key={l} className={`px-5 py-3 ${i ? 'border-l border-border' : ''}`}><div className="text-xs text-faint">{l}</div><div className="text-[20px] font-medium text-fg tnum">{v}</div></div>))}
          </div>
          {!c.verifiable && <p className="px-5 py-3 text-[13px] text-text border-b border-border">{c.vendor} publishes no list of addresses, so visits by {c.label} can be counted but not proven. {num(c.unchecked)} seen in this period.</p>}
          {days.length > 0 && (
            <div className="px-5 py-3 border-b border-border"><div className="text-[13px] font-medium text-fg mb-1.5">Daily visits</div>
              <svg viewBox="0 0 400 70" className="w-full h-auto">{days.map(([d, n], i) => <rect key={d} x={i * (400 / days.length) + 1} y={62 - (n / max) * 56} width={Math.max(2, 400 / days.length - 3)} height={(n / max) * 56} rx="2" fill={CHART.highlight}><title>{`${shortDay(d)}: ${n}`}</title></rect>)}<line x1="0" x2="400" y1="62" y2="62" stroke={CHART.grid} /></svg></div>)}
          <div className="px-5 py-3"><div className="text-[13px] font-medium text-fg mb-2">Pages it read</div>
            {c.pages.length === 0 ? <p className="text-[13px] text-faint">No verified page visits in this period.</p> : (
              <table className="tbl -mx-3.5"><thead><tr><th>Page</th><th className="num">Visits</th><th>Last</th><th>Status</th></tr></thead><tbody>
                {c.pages.map((p) => <tr key={p.path}><td className="max-w-[170px] truncate" title={p.path}>{p.path}</td><td className="num tnum">{p.visits}</td><td className="text-faint">{shortDay(p.lastDay)}</td>
                  <td><Badge tone={p.status >= 400 ? 'red' : 'green'}>{p.status >= 400 ? p.status : `${p.status} OK`}</Badge></td></tr>)}</tbody></table>)}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default function CrawlersTab() {
  const [days, setDays] = useState(28);
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let off = false; setData(null); setError(null);
    api.aiCrawlers.summary(days).then((d) => { if (!off) setData(d); }).catch((e) => { if (!off) setError(e.message || 'Could not load AI crawler visits.'); });
    return () => { off = true; };
  }, [days]);

  const { ai, ref } = useMemo(() => ({ ai: (data?.crawlers || []).filter((c) => c.ai), ref: (data?.crawlers || []).filter((c) => !c.ai) }), [data]);
  const vendors = useMemo(() => [...new Set((data?.daily || []).flatMap((d) => Object.keys(d.byVendor)))], [data]);

  if (error) return <p className="px-1 py-6 text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</p>;
  if (!data) return <KpiStrip items={[1, 2, 3, 4].map((n) => ({ label: String(n) }))} loading cols={4} />;

  const t = data.totals; const st = data.status; const fresh = freshness(st.lastUploadAt);
  if (!st.connected && !st.trackingSince) return <NotConnected />;

  const ch = changeText(t.change);
  const strip = [
    { label: 'Verified AI visits', value: num(t.visits), delta: ch ? { text: ch, tone: changeTone(t.change) } : null, sub: `vs previous ${data.period.days} days`, spark: data.daily.map((d) => d.total) },
    { label: 'AI crawlers seen', value: String(t.crawlersSeen), sub: `of ${t.crawlersWatched} we watch for` },
    { label: 'Pages reached', value: t.pagesTotal ? `${t.pagesReached} of ${t.pagesTotal}` : '—', sub: t.pagesTotal ? `${Math.round((t.pagesReached / t.pagesTotal) * 100)}% of your pages were read` : 'No page list yet' },
    { label: 'Errors served to crawlers', value: String(t.errors), delta: t.errors ? { text: 'worth fixing', tone: 'bad' } : null, sub: 'pages a crawler asked for and could not get' },
  ];
  return (
    <div className="space-y-3">
      <div>
        <Headline s={data} />
        <div className="mt-1 text-sm text-text">
          {t.crawlersSeen} crawler{t.crawlersSeen === 1 ? '' : 's'} read {t.pagesReached}{t.pagesTotal ? ` of ${t.pagesTotal}` : ''} of your pages.{' '}
          <span className="text-faint">Collected from your web server's log, updated hourly · last update {fresh.text}{st.trackingSince ? ` · tracking since ${shortDay(st.trackingSince)}` : ''}.</span>
        </div>
        {fresh.state === 'stale' && <p className="mt-1 text-[13px] flex items-center gap-1.5" style={{ color: '#8a5300' }}><AlertTriangle size={14} /> The log script has not reported for over a day, so recent visits may be missing.</p>}
      </div>
      <div className="flex"><SegmentedTabs options={PERIODS} value={days} onChange={setDays} /></div>
      <KpiStrip items={strip} cols={4} />
      <Tray><TrayCard title="Visits over time" subtitle="Verified AI crawler visits per day, by company" action={<span className="max-sm:hidden"><Legend vendors={vendors} /></span>}>
        <div className="px-4 pb-3">{t.visits === 0 ? <p className="py-6 text-[13px] text-faint">Nothing to chart yet for this period.</p> : <StackedBars daily={data.daily} />}</div></TrayCard></Tray>
      <Tray><TrayCard title="By crawler" subtitle="Click a crawler to see exactly which pages it read">
        {ai.length === 0 ? <p className="px-4 pb-4 text-[13px] text-faint">No AI crawler has been seen yet.</p> : <CrawlerTable rows={ai} onOpen={setOpen} />}
        {ref.length > 0 && <>
          <div className="px-4 py-2 text-xs text-faint border-t border-border">For reference, not counted as AI</div>
          <CrawlerTable rows={ref} onOpen={setOpen} />
        </>}
      </TrayCard></Tray>
      <div className="grid lg:grid-cols-2 gap-3 items-start">
        <Tray><TrayCard title="Pages no AI crawler has read" subtitle={`${t.pagesTotal - t.pagesReached} of ${t.pagesTotal} pages · in this period`}>
          {data.pagesNotRead.items.length === 0 ? <p className="px-4 pb-4 text-[13px] text-faint">{t.pagesTotal ? 'Every page was read.' : 'No page list yet.'}</p> : (
            <div>{data.pagesNotRead.items.map((p) => <div key={p} className="px-4 py-2.5 border-t border-border text-[13px] font-medium text-fg truncate" title={p}>{p}</div>)}
              <div className="tbl-foot"><span>{data.pagesNotRead.total > data.pagesNotRead.items.length ? `Showing ${data.pagesNotRead.items.length} of ${data.pagesNotRead.total}` : ''}</span><span>AI answers can only cite pages a crawler has read.</span></div></div>)}
        </TrayCard></Tray>
        <Tray><TrayCard title="Not counted" subtitle="Visits we could not prove came from an AI company">
          <div className="px-4 pb-4 space-y-2.5 text-[13px] text-text">
            <div className="flex gap-2.5"><span className="mt-0.5" style={{ color: '#8a5300' }}><AlertTriangle size={14} /></span><div><b className="font-medium text-fg">{num(t.unverified)} pretending</b> to be an AI crawler: they used a crawler's name from an address that company does not use.</div></div>
            <div className="flex gap-2.5"><span className="mt-0.5 text-faint"><Info size={14} /></span><div><b className="font-medium text-fg">{num(t.unchecked)} unproven</b>: the company (for example Meta) publishes no address list, so these are likely real but cannot be proven.</div></div>
            <div className="text-xs text-faint pt-1">Real crawlers come from addresses their company publishes. Only those are counted in the numbers above.</div>
          </div>
        </TrayCard></Tray>
      </div>
      <CrawlerDrawer crawler={open} onClose={() => setOpen(null)} />
    </div>
  );
}
