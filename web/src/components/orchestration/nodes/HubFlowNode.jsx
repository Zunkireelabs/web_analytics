import { Link } from 'react-router-dom';
import { Handle, Position } from '@xyflow/react';

const VARIANT = {
  source: { size: 'w-9 h-9 text-sm', color: '#94a3b8', card: false },
  store: { size: 'w-11 h-11 text-lg', color: '#94a3b8', card: true },
  consumer: { size: 'w-11 h-11 text-lg', color: null, card: true }, // color comes from data.color per-consumer
};

// Shared node for every non-agent node in the graph — the 5 data sources
// (small, inert pills, no card chrome), the Findings Store, and the 3
// consumers (Command Center / Action Center / Executive Report). One
// component with a `data.variant` flag instead of 3 near-duplicate ones,
// since visually they're all "icon + label (+ sub)" at different weights.
export default function HubFlowNode({ data }) {
  const v = VARIANT[data.variant] || VARIANT.consumer;
  const color = data.color || v.color || '#94a3b8';
  const big = !!data.big;

  const icon = (
    <span className={`grid place-items-center shrink-0 rounded-2xl ${big ? 'w-14 h-14 text-2xl' : v.size}`}
      style={{ background: `${color}26`, color, boxShadow: `0 0 ${big ? 32 : 20}px ${color}66` }}>
      {data.icon}
    </span>
  );

  if (!v.card) {
    // Data source pill — lighter weight than the full cards (no live state
    // to show), but still a real elevated node on the canvas, not stray
    // floating text — same glass-pill language as the rest of the app.
    return (
      <div className="glass-panel shadow-sm relative flex items-center gap-2 pl-1.5 pr-3.5 py-1.5 rounded-full"
        style={{ background: 'rgba(255,255,255,0.85)' }}>
        <Handle type="source" position={Position.Right} style={{ background: 'transparent', border: 'none', width: 1, height: 1 }} />
        {icon}
        <span className="text-[11px] font-medium text-slate-700 whitespace-nowrap">{data.label}</span>
      </div>
    );
  }

  const content = (
    <>
      <Handle type="target" position={Position.Left} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', width: 6, height: 6 }} />
      <Handle type="source" position={Position.Right} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', width: 6, height: 6 }} />
      {icon}
      <p className={`font-bold text-slate-800 mt-2.5 text-center ${big ? 'text-[15px]' : 'text-[13px]'}`}>{data.label}</p>
      {data.sub && <p className="text-[10.5px] text-slate-400 mt-1 text-center leading-relaxed max-w-[190px]">{data.sub}</p>}
    </>
  );

  const className = `relative rounded-2xl px-5 py-5 w-[230px] flex flex-col items-center transition duration-200 hover:-translate-y-0.5 block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${(data.to || data.onSelect) ? 'cursor-pointer' : ''}`;
  const style = {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,255,255,0.90))',
    border: `1px solid ${color}40`,
    outlineColor: color,
    boxShadow: '0 1px 2px rgba(15,23,42,0.08), 0 8px 20px -8px rgba(15,23,42,0.18)',
  };

  if (data.to) return <Link to={data.to} className={className} style={style}>{content}</Link>;
  return (
    <div onClick={data.onSelect} role={data.onSelect ? 'button' : undefined} tabIndex={data.onSelect ? 0 : undefined}
      onKeyDown={data.onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') data.onSelect(); } : undefined}
      className={className} style={style}>
      {content}
    </div>
  );
}
