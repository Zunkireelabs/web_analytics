import { Link } from 'react-router-dom';
import { Handle, Position } from '@xyflow/react';

const RING = { boxShadow: '0 0 0 1px var(--border-canvas)' };

// Shared node for every non-agent node in the graph — the 5 data sources
// (small, inert labels, no card chrome), the Findings Store, and the 3
// consumers (Command Center / Action Center / Executive Report). One
// component with a `data.variant` flag instead of 3 near-duplicate ones.
// `variant` only decides card-vs-label and `big` only the sizing; any
// `data.icon` glyph from layout.js is intentionally not rendered.
const CARD_VARIANTS = new Set(['store', 'consumer']);

export default function HubFlowNode({ data }) {
  const isCard = CARD_VARIANTS.has(data.variant) || !data.variant;
  const big = !!data.big;

  if (!isCard) {
    // Data source — lighter weight than the full cards (no live state to show).
    return (
      <div className="relative bg-white rounded-control px-2.5 py-1.5 text-xs text-fg whitespace-nowrap" style={RING}>
        <Handle type="source" position={Position.Right} style={{ background: 'transparent', border: 'none', width: 1, height: 1 }} />
        {data.label}
      </div>
    );
  }

  const content = (
    <>
      <Handle type="target" position={Position.Left} style={{ background: 'transparent', border: 'none', width: 6, height: 6 }} />
      <Handle type="source" position={Position.Right} style={{ background: 'transparent', border: 'none', width: 6, height: 6 }} />
      <p className={`font-medium text-fg ${big ? 'text-sm' : 'text-xs'}`}>{data.label}</p>
      {data.sub && <p className="text-[11px] text-faint mt-1 leading-relaxed">{data.sub}</p>}
    </>
  );

  const className = `relative block bg-white rounded-card p-3 w-[230px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${(data.to || data.onSelect) ? 'cursor-pointer' : ''}`;
  const style = { ...RING, outlineColor: 'var(--primary)' };

  if (data.to) return <Link to={data.to} className={className} style={style}>{content}</Link>;
  return (
    <div onClick={data.onSelect} role={data.onSelect ? 'button' : undefined} tabIndex={data.onSelect ? 0 : undefined}
      onKeyDown={data.onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') data.onSelect(); } : undefined}
      className={className} style={style}>
      {content}
    </div>
  );
}
