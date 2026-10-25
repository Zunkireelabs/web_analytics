import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import Button from './Button.jsx';

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

  // Portal to <body> so a transformed/filtered ancestor (fade-up, backdrop-blur) can't become the fixed overlay's containing block.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-neutral-900/30 animate-fade-in" onClick={onClose}>
      <div className={`w-full ${maxWidth} h-full bg-white border-l border-border-2 text-sm text-fg flex flex-col overflow-y-auto custom-scrollbar`}
        style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -20px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <div className="w-8 h-8 rounded-control bg-primary-tint text-primary flex items-center justify-center shrink-0"
                style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
                <Icon size={16} />
              </div>
            )}
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-fg truncate">{title}</h3>
              {subtitle && <p className="text-[13px] text-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {right}
            <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}>
              <X size={14} />
            </Button>
          </div>
        </div>
        <div className="p-6 flex-1">{children}</div>
      </div>
    </div>,
    document.body
  );
}
