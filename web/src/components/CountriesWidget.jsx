import { useEffect, useRef, useState } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import KpiStrip from './layout/KpiStrip.jsx';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

// ISO 3166-1 alpha-3 (lowercase, as GSC returns) → numeric id used by world-atlas.
const ISO3_NUM = {
  npl: 524, ind: 356, usa: 840, gbr: 826, can: 124, aus: 36, deu: 276, fra: 250, nld: 528,
  pak: 586, bgd: 50, lka: 144, are: 784, sau: 682, sgp: 702, mys: 458, idn: 360, phl: 608,
  tha: 764, jpn: 392, chn: 156, kor: 410, rus: 643, bra: 76, ita: 380, esp: 724, che: 756,
  swe: 752, irl: 372, nzl: 554, zaf: 710, nga: 566, ken: 404, egy: 818, tur: 792, mex: 484,
  pol: 616, vnm: 704, hkg: 344, qat: 634, kwt: 414, omn: 512, bhr: 48, bel: 56, aut: 40,
  dnk: 208, nor: 578, fin: 246, prt: 620, irn: 364, irq: 368, ukr: 804, rou: 642, grc: 300,
};

const FLAG = {
  Nepal: '🇳🇵', India: '🇮🇳', 'United States': '🇺🇸', 'United Kingdom': '🇬🇧', Canada: '🇨🇦',
  Australia: '🇦🇺', Germany: '🇩🇪', France: '🇫🇷', Netherlands: '🇳🇱', Singapore: '🇸🇬',
  Turkey: '🇹🇷', Japan: '🇯🇵', Poland: '🇵🇱', Brazil: '🇧🇷', Spain: '🇪🇸', Italy: '🇮🇹',
};
const flag = (c) => FLAG[c] || '🏳️';

// Sequential single-hue ramp (orange, light→dark) — magnitude by rank tier, not a
// continuous scale. With only a handful of countries carrying any clicks, a
// continuous fit crushes everyone but #1 into the same near-invisible shade.
const NO_DATA_FILL = '#ebe9e6';
const TIERS = ['#fbe3d3', '#f2a679', '#e07a3f', '#d54e00']; // low → high
const tierFor = (rank, total) => {
  if (rank === 0) return TIERS[3];
  if (total <= 4) return TIERS[Math.max(0, 3 - rank)];
  const q = rank / total;
  if (q < 0.2) return TIERS[3];
  if (q < 0.45) return TIERS[2];
  if (q < 0.75) return TIERS[1];
  return TIERS[0];
};

export default function CountriesWidget({ rows }) {
  const list = (rows || []).filter((r) => Number(r.clicks) >= 0);
  const withClicks = list.filter((r) => Number(r.clicks) > 0);
  const total = withClicks.reduce((s, r) => s + Number(r.clicks), 0);
  const sorted = [...list].sort((a, b) => Number(b.clicks) - Number(a.clicks));
  const top = sorted[0];
  const countries = withClicks.length;
  const topShare = top && total ? Math.round((Number(top.clicks) / total) * 100) : 0;
  const reach = Math.min(100, Math.round(countries * 7 + (1 - (total ? Number(top?.clicks || 0) / total : 0)) * 36));
  const maxClicks = Math.max(1, ...withClicks.map((r) => Number(r.clicks)));

  // rank (within countries that have clicks) → tier color, shared by list & map.
  const tierByCode = {};
  withClicks.forEach((r, i) => { tierByCode[r.code] = tierFor(i, withClicks.length); });

  // map numeric id → country row (for choropleth fill + hover)
  const byNum = {};
  for (const r of list) { const num = ISO3_NUM[(r.code || '').toLowerCase()]; if (num) byNum[num] = r; }

  const [tip, setTip] = useState(null);
  const wrap = useRef(null);
  const onMove = (e) => {
    if (!wrap.current) return;
    const b = wrap.current.getBoundingClientRect();
    setTip((t) => (t ? { ...t, x: e.clientX - b.left, y: e.clientY - b.top } : t));
  };
  // Touch devices don't fire hover events — tap a country to toggle its
  // tooltip at the tapped point, tap it again (or elsewhere) to dismiss.
  const onTapCountry = (e, r) => {
    if (!wrap.current || !r) return;
    e.stopPropagation();
    const b = wrap.current.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    setTip((t) => (t && t.name === r.country
      ? null
      : { x, y, name: r.country, clicks: Number(r.clicks) || 0, impr: Number(r.impressions) || 0 }));
  };
  // Tap-outside-to-dismiss: any click landing outside the map wrapper
  // closes an open (tap-triggered) tooltip.
  useEffect(() => {
    if (!tip) return;
    const onDocClick = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setTip(null);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [tip]);

  // AI insight
  const ctrOpp = sorted.filter((r) => r !== top && Number(r.impressions) > 0)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))[0];

  const fillFor = (row) => {
    if (!row) return NO_DATA_FILL;
    const clicks = Number(row.clicks) || 0;
    if (clicks <= 0) return NO_DATA_FILL;
    return tierByCode[row.code] || TIERS[0];
  };

  if (sorted.length === 0) {
    return (
      <div className="text-sm text-faint py-10 text-center">No country data for this range yet.</div>
    );
  }

  const kpis = [
    { label: 'Countries reached', value: countries },
    { label: 'Total clicks', value: total.toLocaleString() },
    { label: 'Top country', value: top ? <span>{flag(top.country)} {top.country}</span> : '—', sub: top ? `${topShare}% of clicks` : undefined },
    { label: 'Global reach', value: <span>{reach}<span className="text-sm text-faint font-normal ml-0.5">/100</span></span> },
  ];
  const ring = { boxShadow: 'inset 0 0 0 1px var(--border-2)' };

  return (
    <div className="border-t border-border">
      {/* This card is real GSC data + plain threshold checks, not an LLM call — no "AI" badge. */}
      <KpiStrip items={kpis} bare />

      {/* map (left) + ranked table (right) — side by side, sharing one tier scale */}
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr] p-4 border-t border-border">
        {/* map: tier-shaded + legend so the shading is actually legible */}
        <div className="relative rounded-control bg-[#fcfcfb] p-3 min-w-0" style={ring} ref={wrap} onMouseMove={onMove} onClick={() => setTip(null)}>
          <div className="flex justify-end px-1 mb-1">
            <Legend />
          </div>
          <ComposableMap projectionConfig={{ scale: 145 }} width={800} height={420} style={{ width: '100%', height: 'auto' }}>
            <Geographies geography={GEO_URL}>
              {({ geographies }) => geographies.map((geo) => {
                const r = byNum[Number(geo.id)];
                const clicks = r ? Number(r.clicks) : 0;
                return (
                  <Geography key={geo.rsmKey} geography={geo}
                    fill={fillFor(r)} stroke="#ffffff" strokeWidth={0.4}
                    onMouseEnter={() => r && setTip({ x: 0, y: 0, name: r.country, clicks, impr: Number(r.impressions) || 0 })}
                    onMouseLeave={() => setTip(null)}
                    onClick={(e) => onTapCountry(e, r)}
                    style={{
                      default: { outline: 'none' },
                      hover: { fill: clicks > 0 ? '#a63c00' : '#dcd9d5', outline: 'none', cursor: clicks > 0 ? 'pointer' : 'default' },
                      pressed: { outline: 'none' },
                    }} />
                );
              })}
            </Geographies>
          </ComposableMap>

          {tip && (
            <div className="pointer-events-none absolute z-10 bg-fg text-white text-xs rounded-control px-2.5 py-1.5"
              style={{ left: Math.min(tip.x + 12, 520), top: tip.y + 12 }}>
              <div className="font-medium">{flag(tip.name)} {tip.name}</div>
              <div className="text-faint-2">{tip.clicks} clicks · {tip.impr.toLocaleString()} impr · {tip.impr ? ((tip.clicks / tip.impr) * 100).toFixed(1) : '0.0'}% CTR</div>
            </div>
          )}
        </div>

        {/* ranked table: the exact numbers behind the map's shading */}
        <div className="rounded-control overflow-hidden min-w-0 self-start" style={ring}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Country</th>
                <th className="num">Clicks</th>
                <th className="num hidden sm:table-cell">CTR</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 8).map((r, i) => {
                const clicks = Number(r.clicks) || 0;
                const impr = Number(r.impressions) || 0;
                const ctr = impr > 0 ? (clicks / impr) * 100 : null;
                const share = Math.max(clicks > 0 ? (clicks / maxClicks) * 100 : 0, clicks > 0 ? 4 : 0);
                return (
                  <tr key={i}>
                    <td className="rank">{i + 1}</td>
                    <td className="bar max-w-0 w-full">
                      <i style={{ width: `${share}%` }} />
                      <span className="block truncate">{flag(r.country)} {r.country}</span>
                    </td>
                    <td className="num">{clicks.toLocaleString()}</td>
                    <td className="num hidden sm:table-cell">{ctr != null ? `${ctr.toFixed(1)}%` : `${impr.toLocaleString()} impr`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="tbl-foot"><span>Top {Math.min(8, sorted.length)} of {sorted.length}</span></div>
        </div>
      </div>

      {/* Plain threshold checks over real country rows, not an LLM call — no "AI" badge. */}
      {top && (
        <p className="mx-4 mb-4 rounded-control bg-muted px-3.5 py-3 text-[13px] text-text">
          <span className="font-medium text-fg">{flag(top.country)} {top.country}</span> generated <span className="font-medium text-fg">{topShare}%</span> of total clicks this period.
          {ctrOpp && <> {ctrOpp.country} showed high impression volume relative to clicks — a <span className="font-medium text-fg">CTR optimization opportunity</span>.</>}
        </p>
      )}
    </div>
  );
}

// Legend for the map's sequential shading — a color scale needs a key to read.
function Legend() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-faint">
      <span>Fewer</span>
      <span className="flex gap-0.5">
        {TIERS.map((c) => <i key={c} className="w-3 h-3 rounded-[3px]" style={{ background: c }} />)}
      </span>
      <span>More clicks</span>
    </div>
  );
}
