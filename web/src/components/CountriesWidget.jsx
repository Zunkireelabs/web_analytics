import { useRef, useState } from 'react';
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

function lerp(a, b, t) {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const r = Math.round((A >> 16) + (((B >> 16) - (A >> 16)) * t));
  const g = Math.round(((A >> 8) & 255) + ((((B >> 8) & 255) - ((A >> 8) & 255)) * t));
  const bl = Math.round((A & 255) + (((B & 255) - (A & 255)) * t));
  return `rgb(${r},${g},${bl})`;
}

export default function CountriesWidget({ rows }) {
  const list = (rows || []).filter((r) => Number(r.clicks) >= 0);
  const withClicks = list.filter((r) => Number(r.clicks) > 0);
  const total = withClicks.reduce((s, r) => s + Number(r.clicks), 0);
  const max = Math.max(1, ...withClicks.map((r) => Number(r.clicks)));
  const sorted = [...list].sort((a, b) => Number(b.clicks) - Number(a.clicks));
  const top = sorted[0];
  const countries = withClicks.length;
  const topShare = top && total ? Math.round((Number(top.clicks) / total) * 100) : 0;
  const reach = Math.min(100, Math.round(countries * 7 + (1 - (total ? Number(top?.clicks || 0) / total : 0)) * 36));

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

  // AI insight
  const ctrOpp = sorted.filter((r) => r !== top && Number(r.impressions) > 0)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))[0];

  const fillFor = (clicks) => (clicks > 0 ? lerp('#ddd6fe', '#4338ca', Math.sqrt(clicks / max)) : '#eef2f7');

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
          <span className="text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: 'rgba(108,99,255,0.1)', color: '#6C63FF' }}>✨ AI</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <Stat label="Countries reached" value={countries} />
          <Stat label="Total clicks" value={total.toLocaleString()} />
          <Stat label="Top country" value={top ? <span>{flag(top.country)} {top.country}</span> : '—'} />
          <Stat label="Global reach" value={<span>{reach}<span className="text-sm text-slate-400">/100</span></span>} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-0">
        {/* map */}
        <div className="relative p-3" ref={wrap} onMouseMove={onMove}>
          <ComposableMap projectionConfig={{ scale: 145 }} width={800} height={420} style={{ width: '100%', height: 'auto' }}>
            <Geographies geography={GEO_URL}>
              {({ geographies }) => geographies.map((geo) => {
                const r = byNum[Number(geo.id)];
                const clicks = r ? Number(r.clicks) : 0;
                return (
                  <Geography key={geo.rsmKey} geography={geo}
                    fill={fillFor(clicks)} stroke="#ffffff" strokeWidth={0.4}
                    onMouseEnter={() => r && setTip({ x: 0, y: 0, name: r.country, clicks, impr: Number(r.impressions) || 0 })}
                    onMouseLeave={() => setTip(null)}
                    style={{
                      default: { outline: 'none' },
                      hover: { fill: clicks > 0 ? '#6C63FF' : '#e2e8f0', outline: 'none', cursor: clicks > 0 ? 'pointer' : 'default' },
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

        {/* leaderboard */}
        <div className="p-5 pl-2 lg:border-l border-slate-100">
          <div className="text-[11px] font-semibold text-slate-500 mb-2">Leaderboard · Top 8</div>
          <div className="space-y-1.5">
            {sorted.slice(0, 8).map((r, i) => {
              const share = total ? Math.round((Number(r.clicks) / total) * 100) : 0;
              const up = share >= (countries ? 100 / countries : 0);
              return (
                <div key={i} className="flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-white/70 transition">
                  <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] font-bold shrink-0"
                    style={i < 3 ? { background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', color: '#fff' } : { background: '#f1f5f9', color: '#94a3b8' }}>{i + 1}</span>
                  <span className="text-base shrink-0">{flag(r.country)}</span>
                  <span className="text-sm text-slate-700 truncate flex-1">{r.country}</span>
                  <span className="text-sm font-bold text-slate-900 shrink-0">{Number(r.clicks).toLocaleString()}</span>
                  <span className="text-[11px] font-semibold w-12 text-right shrink-0" style={{ color: up ? '#16A34A' : '#94a3b8' }}>
                    {up ? '↑' : '↓'} {share}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* AI insight */}
      {top && (
        <div className="m-3 mt-0 rounded-2xl border p-4 flex items-start gap-3"
          style={{ borderColor: '#E5F5EC', background: 'linear-gradient(135deg,#f0fdf4,#ffffff 85%)' }}>
          <span className="w-8 h-8 rounded-lg grid place-items-center text-white text-xs shrink-0" style={{ background: 'linear-gradient(135deg,#16a34a,#22c55e)' }}>AI</span>
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
