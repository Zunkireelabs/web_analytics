import { useState, useEffect } from 'react';
import { Languages } from 'lucide-react';
import { api } from '../api.js';
import Sparkline from './Sparkline.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import KpiStrip from './layout/KpiStrip.jsx';
import { Tray, TrayCard } from './layout/Tray.jsx';
import { STATUS } from '../lib/palette.js';

const sum = (arr, k) => (arr || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
const fmtSigned = (n) => `${n >= 0 ? '+' : ''}${n.toLocaleString()}`;

function changePct(prior, delta) {
  const p = Number(prior);
  if (p === 0) return { text: 'New', isNew: true };
  const v = Math.round((Number(delta) / p) * 100);
  return { text: `${v >= 0 ? '+' : ''}${v}%`, isNew: false };
}

export default function MoversList({ gainers = [], droppers = [], comparisonLabel = 'the prior period' }) {
  const netChange = sum(gainers, 'delta') + sum(droppers, 'delta');
  const recentTotal = sum(gainers, 'recent') + sum(droppers, 'recent');
  const priorTotal = sum(gainers, 'prior') + sum(droppers, 'prior');
  const pct = priorTotal ? Math.round((netChange / priorTotal) * 100) : null;
  const changed = gainers.length + droppers.length;

  const kpis = [
    { label: 'Net click change', value: fmtSigned(netChange),
      delta: pct != null ? { text: `${pct >= 0 ? '+' : ''}${pct}%`, tone: netChange >= 0 ? 'good' : 'bad' } : undefined },
    { label: 'Clicks this period', value: recentTotal.toLocaleString(), sub: `vs ${priorTotal.toLocaleString()}` },
    { label: 'Queries moved', value: changed },
    { label: 'Gainers / drops',
      value: (
        <span>
          <span className="text-[#1a7f4b]">{gainers.length}</span>{' '}
          <span className="text-faint font-normal">/</span>{' '}
          <span className="text-[#b42318]">{droppers.length}</span>
        </span>
      ),
      sub: 'queries' },
  ];

  return (
    <>
      {/* 1 + 2 ─ Summary strip and highlights, stacked in one tray. */}
      <Tray>
        <TrayCard title="Query movements" subtitle={<span className="tip tip--down">Which searches gained or lost clicks<span className="tip__box">Queries that changed the most in clicks</span></span>} source={`vs ${comparisonLabel}`}>
          <div className="border-t border-border">
            <KpiStrip items={kpis} bare />
          </div>
        </TrayCard>
        <Highlights gainers={gainers} droppers={droppers} comparisonLabel={comparisonLabel} />
      </Tray>

      {/* 3 ─ Two-column gainers / drops. The wrapper carries the scroll-target id. */}
      <div id="movers-section" className="mt-3">
        <Tray cols={2}>
          <MoverCard kind="gain" rows={gainers} total={gainers.length} />
          <MoverCard kind="drop" rows={droppers} total={droppers.length} />
        </Tray>
      </div>
    </>
  );
}

/* ───────── Highlights band — local heuristics over gainers/droppers, not an LLM call ───────── */
const TAG_TONE = { Gainer: 'green', New: 'outline', Trending: 'primary', Drop: 'red' };

function Highlights({ gainers, droppers, comparisonLabel }) {
  const used = new Set();
  const take = (q) => { if (q) used.add(q.query); return q; };

  const topGain = take(gainers[0]);
  const newQ = take(gainers.find((g) => !used.has(g.query) && Number(g.prior) === 0));
  const vsQ = take([...gainers, ...droppers].find((q) => !used.has(q.query) && / vs /i.test(q.query)));
  const topDrop = take(droppers[0]);

  const highlighted = [topGain, newQ, vsQ, topDrop].filter(Boolean).map((q) => q.query);
  const [translations, setTranslations] = useState({});

  useEffect(() => {
    highlighted.forEach((q) => {
      api.translate(q).then((t) => {
        if (t.language !== 'English') setTranslations((prev) => ({ ...prev, [q]: t.translation }));
      }).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted.join('|')]);

  const withTranslation = (q, text) => translations[q] ? `${text} (“${translations[q]}”)` : text;

  const blocks = [];
  if (topGain) {
    const c = changePct(topGain.prior, topGain.delta);
    blocks.push({
      tag: 'Gainer',
      head: `“${topGain.query}”`,
      text: withTranslation(topGain.query, `Highest growth · ${c.isNew ? `+${topGain.recent} clicks` : `${c.text} clicks`}`),
    });
  }
  if (newQ) {
    blocks.push({
      tag: 'New',
      head: `“${newQ.query}”`,
      text: withTranslation(newQ.query, newQ.page ? `+${newQ.recent} new clicks → ${newQ.page}` : `+${newQ.recent} new clicks vs ${comparisonLabel}`),
    });
  }
  if (vsQ) {
    blocks.push({
      tag: 'Trending',
      head: `“${vsQ.query}”`,
      text: withTranslation(vsQ.query, 'Comparison searches gaining momentum'),
    });
  }
  if (topDrop) {
    blocks.push({
      tag: 'Drop',
      head: `“${topDrop.query}”`,
      text: withTranslation(topDrop.query, 'Lost the most visibility — refresh content'),
    });
  }

  if (blocks.length === 0) return null;

  return (
    <TrayCard title="Spotlight" subtitle="The movements worth a look">
      <div className="border-t border-border">
        {blocks.map((b, i) => (
          <div key={i} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-4 py-3 border-b border-border last:border-0 items-center">
            <Badge tone={TAG_TONE[b.tag]}>{b.tag}</Badge>
            <div className="text-sm font-medium text-fg truncate" title={b.head}>{b.head}</div>
            <div className="col-start-2 text-[13px] text-text">{b.text}</div>
          </div>
        ))}
      </div>
    </TrayCard>
  );
}

/* ───────── Gainers / Drops card ───────── */
function MoverCard({ kind, rows, total }) {
  const [showAll, setShowAll] = useState(false);
  const gain = kind === 'gain';
  const color = gain ? STATUS.good.color : STATUS.critical.color;
  const textColor = gain ? STATUS.good.text : STATUS.critical.text;
  const displayRows = showAll ? (rows || []) : (rows || []).slice(0, 7);
  const hasMore = (rows || []).length > 7;

  return (
    <TrayCard title={gain ? 'Top gainers' : 'Top drops'}
      subtitle={`${total} queries ${gain ? 'gained' : 'lost'} clicks`}>
      <div>
        {displayRows.length === 0 ? (
          <div className="text-sm text-faint text-center py-10">No queries moved in this period.</div>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Query</th>
                  <th className="num">Change</th>
                  <th className="num hidden sm:table-cell">%</th>
                  <th className="num hidden sm:table-cell">Trend</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, i) => {
                  const c = changePct(r.prior, r.delta);
                  return (
                    <tr key={i}>
                      <td className="rank">{i + 1}</td>
                      <td className="max-w-0 w-full">
                        <Translatable query={r.query}>
                          {({ button, result }) => (
                            <>
                              <span className="flex items-center gap-1 min-w-0">
                                <span className="text-sm text-fg truncate" title={r.query}>{r.query}</span>
                                {button}
                              </span>
                              {result}
                            </>
                          )}
                        </Translatable>
                        {r.page && (
                          <span className="block text-xs text-faint truncate" title={r.page}>
                            → {r.page.replace(/https?:\/\/[^\/]+/i, '')}{(r.device || r.country) && ` (${[r.device?.toLowerCase(), r.country].filter(Boolean).join(' · ')})`}
                          </span>
                        )}
                      </td>
                      <td className="num font-medium whitespace-nowrap" style={{ color: textColor }}>{fmtSigned(r.delta)}</td>
                      <td className="num hidden sm:table-cell whitespace-nowrap">
                        {c.isNew ? <Badge tone="outline">New</Badge> : <span style={{ color: textColor }}>{c.text}</span>}
                      </td>
                      <td className="num hidden sm:table-cell">
                        <span className="inline-flex justify-end">
                          <Sparkline data={sparkSteps(r.prior, r.recent)} color={color} width={56} height={16} fill={false} dot={false} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="tbl-foot">
              <span>Showing {displayRows.length} of {rows.length}</span>
              {hasMore && (
                <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
                  {showAll ? 'Show fewer' : `View all ${gain ? 'gainers' : 'drops'}`}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </TrayCard>
  );
}

/* ───────── Click-to-reveal translation ─────────
   Render-prop: the button goes beside the query, the result renders under it. */
function Translatable({ query, children }) {
  const [state, setState] = useState(null); // null | 'loading' | { language, translation }
  const hidden = state && state !== 'loading' && (state.language === 'English' || !state.translation);
  const button = hidden ? null : (
    <span className="shrink-0">
      {!state && (
        <Button variant="ghost" size="sm" icon title="Translate query" aria-label="Translate query"
          onClick={async (e) => {
            e.stopPropagation();
            setState('loading');
            try { setState(await api.translate(query)); }
            catch { setState({ language: 'unknown', translation: '' }); }
          }}>
          <Languages size={13} />
        </Button>
      )}
      {state === 'loading' && <span className="text-xs text-faint">…</span>}
    </span>
  );
  const result = state && state !== 'loading' && state.translation
    ? <span className="block text-xs text-faint" title={state.language}>“{state.translation}”</span>
    : null;
  return children({ button, result });
}

function sparkSteps(from, to) {
  const a = Number(from) || 0, b = Number(to) || 0;
  return [a, a + (b - a) * 0.2, a + (b - a) * 0.45, a + (b - a) * 0.62, a + (b - a) * 0.82, b];
}
