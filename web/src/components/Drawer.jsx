import { useEffect } from 'react';
import { X } from 'lucide-react';

// Generic right-side drawer shell, factored out of AnalystCustomizerDrawer's
// pattern so Settings (and future callers) don't each hand-roll the overlay.
export default function Drawer({ isOpen, onClose, title, subtitle, icon: Icon, children, maxWidth = 'max-w-md', right }) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 backdrop-blur-xs animate-fade-in" onClick={onClose}>
      <div className={`w-full ${maxWidth} h-full bg-white border-l border-slate-200 text-slate-900 shadow-2xl flex flex-col overflow-y-auto custom-scrollbar`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-5 sticky top-0 bg-white/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[#6C63FF] shrink-0">
                <Icon size={16} />
              </div>
            )}
            <div className="min-w-0">
              <h3 className="text-sm font-black text-slate-900 truncate">{title}</h3>
              {subtitle && <p className="text-[11px] font-semibold text-slate-400 truncate">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {right}
            <button type="button" onClick={onClose}
              className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition shrink-0">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="p-6 flex-1">{children}</div>
      </div>
    </div>
  );
}
