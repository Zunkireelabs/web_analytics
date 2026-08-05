import React from 'react';
import { X, SlidersHorizontal, Eye, EyeOff, ArrowUp, ArrowDown, RotateCcw, Palette, Layout, Sparkles, Check } from 'lucide-react';

export default function AnalystCustomizerDrawer({
  isOpen,
  onClose,
  sections,
  onToggleSection,
  onMoveSection,
  activePreset,
  onSelectPreset,
  activeTheme,
  onSelectTheme,
  activeDensity,
  onSelectDensity,
  onResetLayout,
  aiLayoutEnabled,
  onToggleAILayout,
}) {
  if (!isOpen) return null;

  const themes = [
    { id: 'velvet', label: 'Velvet Obsidian', color: '#8b5cf6', desc: 'Dark glassmorphic glow' },
    { id: 'slate', label: 'Slate Glass', color: '#64748b', desc: 'Clean modern monochrome' },
    { id: 'neon', label: 'Midnight Cyber', color: '#06b6d4', desc: 'High-contrast dark' },
  ];

  const densities = [
    { id: 'compact', label: 'Compact', desc: 'High density padding' },
    { id: 'standard', label: 'Standard', desc: 'Balanced visual rhythm' },
    { id: 'spacious', label: 'Spacious', desc: 'Relaxed card margins' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 backdrop-blur-xs animate-fade-in">
      <div className="w-full max-w-md h-full bg-white border-l border-slate-800 text-slate-900 p-6 shadow-2xl flex flex-col justify-between overflow-y-auto custom-scrollbar">
        <div className="space-y-6">
          {/* Drawer Header */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-indigo-100 border border-indigo-300 flex items-center justify-center text-indigo-600">
                <SlidersHorizontal size={16} />
              </div>
              <div>
                <h3 className="text-sm font-black uppercase tracking-wider text-slate-900">Layout & OS Customizer</h3>
                <p className="text-[11px] font-medium text-slate-400">Personalize layout, density & visual order</p>
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

          {/* Business Layout Presets */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Layout size={13} className="text-indigo-600" /> Preset Layouts
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'executive', name: 'Executive', desc: 'High-level' },
                { id: 'investigation', name: 'Investigation', desc: 'Triage first' },
                { id: 'growth', name: 'Organic Growth', desc: 'Search focus' },
                { id: 'copilot', name: 'AI Copilot Focus', desc: 'AI assistant' },
              ].map((p) => {
                const active = activePreset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelectPreset(p.id)}
                    className={`p-3 rounded-2xl text-left border transition ${
                      active
                        ? 'bg-indigo-100 border-violet-500 text-slate-900 ring-1 ring-violet-500/50'
                        : 'bg-slate-100 border-slate-800 text-slate-700 hover:border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold">{p.name}</span>
                      {active && <Check size={12} className="text-indigo-600" />}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">{p.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* AI-Arranged Layout */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={13} className="text-violet-500" /> AI-Arranged Layout
            </h4>
            <button
              type="button"
              onClick={onToggleAILayout}
              className={`w-full flex items-center justify-between p-3 rounded-2xl text-left border transition ${
                aiLayoutEnabled
                  ? 'bg-indigo-100 border-violet-500 text-slate-900'
                  : 'bg-slate-100 border-slate-800 text-slate-400'
              }`}
            >
              <div>
                <span className="text-xs font-bold block">{aiLayoutEnabled ? 'On' : 'Off'}</span>
                <p className="text-[10px] text-slate-400 mt-0.5">Claude reorders sections based on today&apos;s site activity</p>
              </div>
              {aiLayoutEnabled && <Check size={14} className="text-indigo-600 shrink-0" />}
            </button>
          </div>

          {/* Theme Palette */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Palette size={13} className="text-cyan-400" /> Theme Accent
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {themes.map((t) => {
                const active = activeTheme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onSelectTheme(t.id)}
                    className={`p-2.5 rounded-2xl text-left border transition ${
                      active
                        ? 'bg-slate-100 border-violet-500 text-slate-900'
                        : 'bg-slate-100 border-slate-800 text-slate-400 hover:bg-slate-100'
                    }`}
                  >
                    <div className="w-4 h-4 rounded-full mb-1.5" style={{ backgroundColor: t.color }} />
                    <span className="text-[11px] font-bold block truncate">{t.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Density Selection */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Eye size={13} className="text-emerald-600" /> Display Density
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {densities.map((d) => {
                const active = activeDensity === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onSelectDensity(d.id)}
                    className={`p-2.5 rounded-2xl text-center border transition ${
                      active
                        ? 'bg-slate-100 border-emerald-500 text-slate-900 font-bold'
                        : 'bg-slate-100 border-slate-800 text-slate-400 hover:bg-slate-100'
                    }`}
                  >
                    <span className="text-xs capitalize">{d.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section Visibility & Reordering */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <SlidersHorizontal size={13} className="text-amber-600" /> Section Priority & Visibility
            </h4>
            <div className="space-y-1.5 max-h-60 overflow-y-auto custom-scrollbar pr-1">
              {sections.map((sec, idx) => (
                <div
                  key={sec.id}
                  className={`flex items-center justify-between p-2.5 rounded-2xl border transition ${
                    sec.visible ? 'bg-slate-200/60 border-slate-200 text-slate-900' : 'bg-slate-200/60 border-slate-800/60 text-slate-500 opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => onToggleSection(sec.id)}
                      className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 transition"
                      title={sec.visible ? 'Hide Section' : 'Show Section'}
                    >
                      {sec.visible ? <Eye size={14} className="text-emerald-600" /> : <EyeOff size={14} className="text-slate-500" />}
                    </button>
                    <span className="text-xs font-bold truncate">{sec.title}</span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => onMoveSection(idx, -1)}
                      className="p-1 rounded-lg bg-slate-950/50 hover:bg-slate-700 disabled:opacity-20 text-slate-400 transition"
                      title="Move Up"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={idx === sections.length - 1}
                      onClick={() => onMoveSection(idx, 1)}
                      className="p-1 rounded-lg bg-slate-950/50 hover:bg-slate-700 disabled:opacity-20 text-slate-400 transition"
                      title="Move Down"
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="pt-6 border-t border-slate-800 flex items-center justify-between">
          <button
            type="button"
            onClick={onResetLayout}
            className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-slate-900 transition"
          >
            <RotateCcw size={13} /> Reset Layout
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-bold text-slate-900 transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
