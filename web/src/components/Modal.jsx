import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import Button from './Button.jsx';

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

  // Portal to <body> so a transformed/filtered ancestor (fade-up, backdrop-blur) can't become the fixed overlay's containing block.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/40 animate-fade-in" onClick={onClose}>
      <div className={`w-full ${maxWidth} rounded-card bg-white p-6 text-fg space-y-5`}
        style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -20px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <div className="w-8 h-8 rounded-control bg-primary-tint text-primary flex items-center justify-center shrink-0"
                style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
                <Icon size={16} />
              </div>
            )}
            <div>
              <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
              {subtitle && <p className="text-[13px] text-faint">{subtitle}</p>}
            </div>
          </div>
          <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
