import { useEffect } from 'react';
import { X } from 'lucide-react';

// Generic centered modal shell, factored out of AnalystKeyboardShortcutsModal's
// pattern so Settings (and future callers) don't each hand-roll the overlay.
export default function Modal({ isOpen, onClose, title, subtitle, icon: Icon, children, maxWidth = 'max-w-md' }) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md animate-fade-in" onClick={onClose}>
      <div className={`w-full ${maxWidth} rounded-3xl bg-white border border-slate-200 shadow-2xl p-6 text-slate-900 space-y-5`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[#6C63FF] shrink-0">
                <Icon size={16} />
              </div>
            )}
            <div>
              <h3 className="text-sm font-black text-slate-900">{title}</h3>
              {subtitle && <p className="text-[11px] font-semibold text-slate-400">{subtitle}</p>}
            </div>
          </div>
          <button type="button" onClick={onClose}
            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition shrink-0">
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
