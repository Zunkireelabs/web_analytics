import React, { useEffect } from 'react';
import { X, Command, Keyboard } from 'lucide-react';

export default function AnalystKeyboardShortcutsModal({ isOpen, onClose }) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const shortcuts = [
    { key: '⌘ K / Ctrl+K', description: 'Open Raycast / Linear Command Palette' },
    { key: '⌘ 1', description: 'Switch to Executive Overview Preset' },
    { key: '⌘ 2', description: 'Switch to Deep Investigation Triage Preset' },
    { key: '⌘ 3', description: 'Switch to Organic Growth Preset' },
    { key: '⌘ 4', description: 'Switch to AI Copilot Focus Preset' },
    { key: '⌘ E', description: 'Scroll to AI Executive Summary' },
    { key: '⌘ I', description: 'Scroll to Investigation Workspace' },
    { key: '⌘ D', description: 'Scroll to Diagnostic Tools' },
    { key: '?', description: 'Open Keyboard Shortcuts Help' },
    { key: 'Esc', description: 'Close any open drawer, modal, or command palette' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-md rounded-3xl bg-white border border-slate-800 shadow-2xl p-6 text-slate-900 space-y-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-100 border border-indigo-300 flex items-center justify-center text-indigo-600">
              <Keyboard size={16} />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider">Keyboard Shortcuts</h3>
              <p className="text-[11px] font-medium text-slate-400">Navigate the AI Operating System at speed</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-700 flex items-center justify-center text-slate-400 transition"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
          {shortcuts.map((s, idx) => (
            <div key={idx} className="flex items-center justify-between p-2.5 rounded-2xl bg-slate-100 border border-slate-800 text-xs">
              <span className="text-slate-700 font-medium">{s.description}</span>
              <kbd className="font-mono text-[10px] font-bold text-indigo-500 bg-slate-950 border border-slate-800 px-2 py-1 rounded-md">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="pt-2 text-center">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-bold text-slate-900 transition"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
