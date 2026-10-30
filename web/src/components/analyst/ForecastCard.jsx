import Card from './Card.jsx';
import { STATUS } from '../../lib/palette.js';
import { accuracyLine, chartGeometry, changeText, rangeText } from '../../lib/analyst-view.js';

const num = (n) => Math.round(n).toLocaleString('en-US');

function Metric({ label, m }) {
  const change = changeText(m);
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-text">{label}</div>
      <div className="text-[26px] leading-8 font-medium tracking-[-0.02em] tnum text-fg">{m?.predicted != null ? num(m.predicted) : '—'}</div>
      {rangeText(m) && <div className="text-xs text-faint">{rangeText(m)}</div>}
      {change && <div className="text-xs mt-0.5" style={{ color: m.changePct >= 0 ? STATUS.good.text : STATUS.critical.text }}>{change}</div>}
    </div>
  );
}

export default function ForecastCard({ forecast, loading }) {
  const geo = chartGeometry(forecast);
  const acc = accuracyLine(forecast?.accuracy);
  return (
    <Card
      title="Next week at a glance" subtitle="Predicted from your recent weeks, as a range"
      loading={loading} empty={!loading && !forecast ? 'Nothing here yet. Predictions appear once there are enough weeks of data.' : null}
      footer={forecast && <><span className="min-w-0 truncate">{acc || 'Accuracy shows once a few predictions have been checked'}</span>{forecast.model && <span className="shrink-0 hidden sm:block">Model: {forecast.model}</span>}</>}
    >
      {forecast && (
        <>
          <div className="grid grid-cols-2 gap-4 px-4 pt-1">
            <Metric label="Clicks" m={forecast.clicks} />
            <Metric label="Impressions" m={forecast.impressions} />
          </div>
          {geo && (
            <div className="px-4 pt-2 pb-3">
              <svg width="100%" viewBox={`0 0 ${geo.width} ${geo.height}`} role="img" aria-label="Clicks over the past weeks and the predicted next weeks" style={{ display: 'block' }}>
                <polygon points={geo.band} fill="var(--primary)" opacity=".12" />
                <polyline points={geo.history} fill="none" stroke="var(--fg)" strokeWidth="2" strokeLinejoin="round" />
                <polyline points={geo.future} fill="none" stroke="var(--primary)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
                <line x1={geo.splitX} x2={geo.splitX} y1="6" y2={geo.height - 10} stroke="var(--border-2)" strokeDasharray="2 3" />
                <text x={geo.splitX - 6} y="14" fontSize="10" fill="var(--faint)" textAnchor="end">past weeks</text>
                <text x={geo.splitX + 6} y="14" fontSize="10" fill="var(--primary)">next weeks</text>
              </svg>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
