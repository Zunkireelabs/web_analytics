import KpiStrip from '../layout/KpiStrip.jsx';
import { fixesStrip } from '../../lib/analyst-view.js';
import { STATUS } from '../../lib/palette.js';

const TONE = { bad: STATUS.critical.text, warn: STATUS.warning.text, good: STATUS.good.text, neutral: undefined };

export default function FixesStrip({ counts, loading }) {
  const items = fixesStrip(counts).map((c) => ({ label: c.label, sub: c.sub, value: <span style={TONE[c.tone] ? { color: TONE[c.tone] } : undefined}>{c.value}</span> }));
  return <KpiStrip items={items} loading={loading} cols={5} />;
}
