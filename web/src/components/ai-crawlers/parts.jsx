import { SERIES, CHART } from '../../lib/palette.js';

// Shared bits of the AI crawler screens (the client's Crawlers tab and the staff comparison).

export const PERIODS = [{ value: 7, label: '7 days' }, { value: 28, label: '28 days' }, { value: 90, label: '3 months' }];

export const VENDOR_COLOR = { OpenAI: SERIES[0], Google: SERIES[1], Apple: SERIES[2], Anthropic: SERIES[3], Perplexity: SERIES[4], Meta: SERIES[5] };
export const vendorColor = (v) => VENDOR_COLOR[v] || CHART.muted;

export const KIND_LABEL = { training: 'Training', search: 'Search', user: 'On request', other: 'Other' };
export const KIND_HELP = {
  training: 'Collects pages that may be used to train AI models',
  search: 'Builds an AI search index',
  user: 'Fetches a page because a person asked an assistant',
  other: 'General or site-owner-requested crawling',
};

export const num = (n) => Number(n || 0).toLocaleString('en-GB');
export const shortDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
export const changeText = (c) => (c == null ? null : `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)}%`);
export const changeTone = (c) => (c == null || c === 0 ? 'flat' : c > 0 ? 'good' : 'bad');

/** Hours-old is normal (the script runs hourly); a day or more of silence is worth a flag. */
export function freshness(lastUploadAt) {
  if (!lastUploadAt) return { state: 'never', text: 'No upload yet' };
  const mins = Math.round((Date.now() - new Date(lastUploadAt).getTime()) / 60000);
  const text = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return { state: mins > 1440 ? 'stale' : 'ok', text };
}

/** Stacked daily bars, one colour per company. Quiet days stay visible as an empty slot. */
export function StackedBars({ daily, height = 150 }) {
  const w = 1000; const pad = 4;
  const max = Math.max(1, ...daily.map((d) => d.total));
  const slot = (w - pad * 2) / Math.max(1, daily.length);
  const bw = Math.max(2, slot * 0.62);
  const vendors = Object.keys(VENDOR_COLOR);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full h-auto" role="img" aria-label="AI crawler visits per day, by company" preserveAspectRatio="none">
      {[0.5, 1].map((f) => <line key={f} x1="0" x2={w} y1={height - 14 - (height - 24) * f} y2={height - 14 - (height - 24) * f} stroke={CHART.grid} />)}
      {daily.map((d, i) => {
        let y = height - 14; const x = pad + i * slot + (slot - bw) / 2;
        const parts = [...vendors, ...Object.keys(d.byVendor).filter((v) => !vendors.includes(v))].filter((v) => d.byVendor[v]);
        return (
          <g key={d.day}>
            <title>{`${shortDay(d.day)}: ${d.total} visit${d.total === 1 ? '' : 's'}`}</title>
            <rect x={pad + i * slot} y="0" width={slot} height={height - 14} fill="transparent" />
            {parts.map((v) => { const h = ((height - 24) * d.byVendor[v]) / max; y -= h; return <rect key={v} x={x} y={y} width={bw} height={Math.max(1, h)} fill={vendorColor(v)} />; })}
          </g>
        );
      })}
      <line x1="0" x2={w} y1={height - 14} y2={height - 14} stroke={CHART.cursor} />
    </svg>
  );
}

export function Legend({ vendors }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text">
      {vendors.map((v) => <span key={v} className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: vendorColor(v) }} />{v}</span>)}
    </span>
  );
}
