import { timeAgo } from '../api.js';
import { 
  RefreshCw, 
  Key, 
  Search, 
  GitBranch, 
  Link2, 
  Check, 
  AlertTriangle, 
  Clock,
  Settings
} from 'lucide-react';

const STATUS = {
  ok: { 
    label: 'Connected', 
    text: 'text-emerald-700 bg-emerald-50 border-emerald-100', 
    bar: '#10b981', 
    dot: '#10b981',
  },
  error: { 
    label: 'Connection Error', 
    text: 'text-rose-700 bg-rose-50 border-rose-100', 
    bar: '#f43f5e', 
    dot: '#f43f5e',
  },
  unknown: { 
    label: 'Not Checked', 
    text: 'text-slate-500 bg-slate-50 border-slate-100', 
    bar: '#94a3b8', 
    dot: '#94a3b8',
  },
};

const TYPE_ICON = {
  'daily-pipeline': RefreshCw,
  'google-oauth': Key,
  'gsc-url-inspection': Search,
  'github': GitBranch,
};
const DEFAULT_ICON = Link2;

export default function IntegrationHealthCard({ integration, checking, onCheck }) {
  const s = STATUS[integration.status] || STATUS.unknown;
  const IconComponent = TYPE_ICON[integration.id] || DEFAULT_ICON;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm shadow-slate-100/60 hover:shadow-md hover:border-slate-350 hover:-translate-y-0.5 transition-all duration-300 flex flex-col h-full relative overflow-hidden">
      {/* Accent Indicator Bar */}
      <div className="h-[3px] shrink-0" style={{ backgroundColor: s.bar }} />
      
      <div className="p-5 flex flex-col flex-1">
        
        {/* Header: Icon, Label & Status Badge */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span 
              className="relative w-9 h-9 rounded-xl grid place-items-center shrink-0 border"
              style={{ backgroundColor: `${s.dot}0c`, borderColor: `${s.dot}1e`, color: s.dot }}
            >
              <IconComponent size={14} strokeWidth={2.25} />
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white animate-pulse" style={{ backgroundColor: s.dot }} />
            </span>
            <span className="text-xs font-black text-slate-900 truncate block">{integration.label}</span>
          </div>
          
          <span className={`text-[9px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full shrink-0 border ${s.text}`}>
            {s.label}
          </span>
        </div>

        {/* Description */}
        <p className="text-[11px] font-semibold text-slate-500 mt-3.5 leading-relaxed">
          {integration.description}
        </p>

        {/* Timestamps */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-4 text-[10px] text-slate-400 font-medium">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} className="text-slate-350" />
            {integration.lastCheckedAt ? timeAgo(integration.lastCheckedAt) : 'never checked'}
          </span>
          {integration.lastSuccessAt && (
            <span className="inline-flex items-center gap-1 text-emerald-600 font-bold">
              <Check size={10} strokeWidth={3} /> {timeAgo(integration.lastSuccessAt)}
            </span>
          )}
          {integration.lastFailureAt && (
            <span className="inline-flex items-center gap-1 text-rose-500 font-bold">
              <AlertTriangle size={10} /> {timeAgo(integration.lastFailureAt)}
            </span>
          )}
        </div>

        {/* Errors / Action Prompts */}
        {integration.errorMessage && (
          <div className="mt-3.5 bg-rose-50 border border-rose-100/70 rounded-2xl p-3 text-[10px] text-rose-750 leading-relaxed font-semibold">
            {integration.errorMessage}
          </div>
        )}
        {integration.recoveryAction && (
          <div className="mt-2 text-[10px] text-indigo-650 leading-relaxed font-black flex items-center gap-1">
            <Settings size={10} /> {integration.recoveryAction}
          </div>
        )}

        {/* Test Trigger Button */}
        <div className="mt-auto pt-4 border-t border-slate-100 flex items-center justify-between">
          <button 
            type="button" 
            onClick={onCheck} 
            disabled={checking}
            className="text-[9px] font-black uppercase tracking-wider px-4 py-2 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/15"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
          >
            {checking ? 'Testing Connection…' : 'Test Connection'}
          </button>
        </div>

      </div>
    </div>
  );
}
