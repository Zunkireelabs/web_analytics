import { useEffect, useRef, useState } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';

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
const flag = (c) => FLAG[c] || '🌐';

// Sequential single-hue ramp (indigo, light→dark) — magnitude by rank tier, not a
// continuous scale. With only a handful of countries carrying any clicks, a
// continuous fit crushes everyone but #1 into the same near-invisible shade.
const NO_DATA_FILL = '#eef1f6';
const TIERS = ['#c7d2fe', '#818cf8', '#6366f1', '#4338ca']; // low → high
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
      <div className="card p-6 fade-up">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-9 h-9 rounded-xl grid place-items-center text-white" style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>🌍</span>
          <div className="leading-tight">
            <div className="font-bold text-slate-900">Top Countries by Clicks</div>
            <div className="text-[11px] text-slate-400">Where your search clicks come from</div>
          </div>
        </div>
        <div className="text-sm text-slate-400 py-10 text-center">No country data for this range yet.</div>
      </div>
    );
  }

  return (
    <div className="relative rounded-[22px] overflow-hidden border border-white/60 shadow-xl"
      style={{ background: 'linear-gradient(135deg, rgba(108,99,255,0.06), rgba(255,255,255,0.85))', backdropFilter: 'blur(12px)' }}>
      {/* header + stat strip */}
      <div className="p-5 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-9 h-9 rounded-xl grid place-items-center text-white" style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>🌍</span>
            <div className="leading-tight">
              <div className="font-bold text-slate-900">Top Countries by Clicks</div>
              <div className="text-[11px] text-slate-400">Where your search clicks come from</div>
            </div>
          </div>
          {/* This card is real GSC data + plain threshold checks, not an LLM call — no "AI" badge. */}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <Stat label="Countries reached" value={countries} />
          <Stat label="Total clicks" value={total.toLocaleString()} />
          <Stat label="Top country" value={top ? <span>{flag(top.country)} {top.country}</span> : '—'} />
          <Stat label="Global reach" value={<span>{reach}<span className="text-sm text-slate-400">/100</span></span>} />
        </div>
      </div>

      {/* map (left) + ranked table (right) — side by side, sharing one tier scale */}
      <div className="grid lg:grid-cols-[1.3fr_1fr] gap-0">
        {/* map: tier-shaded + legend so the shading is actually legible */}
        <div className="relative p-3" ref={wrap} onMouseMove={onMove} onClick={() => setTip(null)}>
          <div className="flex items-center justify-between px-2 mb-1">
            <div className="text-[11px] font-semibold text-slate-500">Global reach</div>
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
                      hover: { fill: clicks > 0 ? '#312e81' : '#dbe2ea', outline: 'none', cursor: clicks > 0 ? 'pointer' : 'default' },
                      pressed: { outline: 'none' },
                    }} />
                );
              })}
            </Geographies>
          </ComposableMap>

          {tip && (
            <div className="pointer-events-none absolute z-10 bg-slate-900 text-white text-[11px] rounded-lg px-2.5 py-1.5 shadow-lg"
              style={{ left: Math.min(tip.x + 12, 520), top: tip.y + 12 }}>
              <div className="font-semibold">{flag(tip.name)} {tip.name}</div>
              <div className="text-slate-300">{tip.clicks} clicks · {tip.impr.toLocaleString()} impr · {tip.impr ? ((tip.clicks / tip.impr) * 100).toFixed(1) : '0.0'}% CTR</div>
            </div>
          )}
        </div>

        {/* ranked table: the exact numbers behind the map's shading */}
        <div className="p-5 pl-2 lg:border-l border-slate-100">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-semibold text-slate-500">Ranked by clicks</div>
            <div className="text-[10px] text-slate-400">Top {Math.min(8, sorted.length)} of {sorted.length}</div>
          </div>
          <div className="divide-y divide-slate-50">
            {sorted.slice(0, 8).map((r, i) => {
              const clicks = Number(r.clicks) || 0;
              const impr = Number(r.impressions) || 0;
              const ctr = impr > 0 ? (clicks / impr) * 100 : null;
              const share = Math.max(clicks > 0 ? (clicks / maxClicks) * 100 : 0, clicks > 0 ? 3 : 0);
              return (
                <div key={i} className="flex items-center gap-2.5 rounded-xl px-2 py-2.5 hover:bg-white/70 transition">
                  <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-bold shrink-0"
                    style={i < 3 ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff' } : { background: '#f1f5f9', color: '#94a3b8' }}>{i + 1}</span>
                  <span className="text-base shrink-0">{flag(r.country)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-slate-700 truncate">{r.country}</span>
                      <span className="text-sm font-bold text-slate-900 tabular-nums shrink-0">{clicks.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
                        <span className="block h-full rounded-full" style={{ width: `${share}%`, background: fillFor(r) }} />
                      </span>
                      <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                        {ctr != null ? `${ctr.toFixed(1)}% CTR` : `${impr.toLocaleString()} impr`}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Plain threshold checks over real country rows, not an LLM call — no "AI" badge. */}
      {top && (
        <div className="m-3 mt-2 rounded-2xl border p-4 flex items-start gap-3"
          style={{ borderColor: '#E5F5EC', background: '#f8fafc' }}>
          <span className="w-8 h-8 rounded-lg grid place-items-center text-slate-500 text-xs shrink-0 bg-white border border-slate-200">📊</span>
          <p className="text-sm text-slate-700 leading-relaxed">
            <span className="font-semibold">{flag(top.country)} {top.country}</span> generated <b>{topShare}%</b> of total clicks this period.
            {ctrOpp && <> {ctrOpp.country} showed high impression volume relative to clicks — a <b>CTR optimization opportunity</b>.</>}
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-white/70 border border-white px-3 py-2.5">
      <div className="text-lg font-bold text-slate-900 leading-tight">{value}</div>
      <div className="text-[11px] text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}

// Legend for the map's sequential shading — a color scale needs a key to read.
function Legend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
      <span>Fewer</span>
      <span className="flex gap-0.5">
        <i className="w-3 h-3 rounded-sm" style={{ background: NO_DATA_FILL }} />
        {TIERS.map((c) => <i key={c} className="w-3 h-3 rounded-sm" style={{ background: c }} />)}
      </span>
      <span>More clicks</span>
    </div>
  );
}
