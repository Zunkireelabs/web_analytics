import React, { useEffect, useState } from 'react';
import { Search, Sparkles, Layout, Eye, Palette, Zap, ArrowRight, CornerDownLeft, Command, X, Check, Activity, ListChecks, LineChart } from 'lucide-react';

export default function AnalystCommandPalette({
  isOpen,
  onClose,
  onSelectPreset,
  onSelectTheme,
  onSelectDensity,
  onNavigateSection,
  onOpenCopilot,
  activePreset,
  activeTheme,
  activeDensity,
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actions = [
    {
      id: 'ask-ai',
      category: 'AI Assistant',
      title: 'Ask AI Analyst a question',
      subtitle: 'Open Perplexity-style AI Copilot & launch prompt',
      icon: Sparkles,
      iconColor: '#6C63FF',
      perform: () => { onOpenCopilot(); onClose(); },
    },
    {
      id: 'preset-executive',
      category: 'Layout Presets',
      title: 'Executive Overview Preset',
      subtitle: 'Priority: AI Summary → Prioritized Actions → Trend Forecast',
      icon: Layout,
      iconColor: '#3b82f6',
      active: activePreset === 'executive',
      perform: () => { onSelectPreset('executive'); onClose(); },
    },
    {
      id: 'preset-investigation',
      category: 'Layout Presets',
      title: 'Deep Investigation Preset',
      subtitle: 'Priority: Triage Workspace → Root Cause → Diagnostic Tools',
      icon: ListChecks,
      iconColor: '#f97316',
      active: activePreset === 'investigation',
      perform: () => { onSelectPreset('investigation'); onClose(); },
    },
    {
      id: 'preset-growth',
      category: 'Layout Presets',
      title: 'Search & Organic Growth Preset',
      subtitle: 'Priority: Metric Navigator → Drivers → Correlations',
      icon: LineChart,
      iconColor: '#10b981',
      active: activePreset === 'growth',
      perform: () => { onSelectPreset('growth'); onClose(); },
    },
    {
      id: 'preset-copilot',
      category: 'Layout Presets',
      title: 'AI Copilot Focus Preset',
      subtitle: 'Priority: AI Reasoning → Copilot Workspace',
      icon: Sparkles,
      iconColor: '#8b5cf6',
      active: activePreset === 'copilot',
      perform: () => { onSelectPreset('copilot'); onClose(); },
    },
    {
      id: 'nav-summary',
      category: 'Jump to Section',
      title: 'AI Executive Summary',
      subtitle: 'Top LLM synthesis of active client status',
      icon: Zap,
      iconColor: '#a855f7',
      perform: () => { onNavigateSection('analyst-summary'); onClose(); },
    },
    {
      id: 'nav-priorities',
      category: 'Jump to Section',
      title: 'Recommendation Priority',
      subtitle: 'Ranked work queue of predicted opportunities',
      icon: ListChecks,
      iconColor: '#ea580c',
      perform: () => { onNavigateSection('analyst-priorities'); onClose(); },
    },
    {
      id: 'nav-workspace',
      category: 'Jump to Section',
      title: 'Investigation Workspace',
      subtitle: 'Linear-style anomaly & forecast triage view',
      icon: Activity,
      iconColor: '#ef4444',
      perform: () => { onNavigateSection('analyst-workspace'); onClose(); },
    },
    {
      id: 'nav-diagnostics',
      category: 'Jump to Section',
      title: 'Diagnostic Tools & Metric Navigator',
      subtitle: 'Investigate trends, drivers, and forecast models',
      icon: Search,
      iconColor: '#6366f1',
      perform: () => { onNavigateSection('analyst-forecast-center'); onClose(); },
    },
    {
      id: 'theme-velvet',
      category: 'Appearance',
      title: 'Theme: Velvet Obsidian (Dark)',
      subtitle: 'Rich violet-dark glassmorphic ambiance',
      icon: Palette,
      iconColor: '#8b5cf6',
      active: activeTheme === 'velvet',
      perform: () => { onSelectTheme('velvet'); onClose(); },
    },
    {
      id: 'theme-slate',
      category: 'Appearance',
      title: 'Theme: Slate Glass (Clean Modern)',
      subtitle: 'Crisp light-gray substrate',
      icon: Palette,
      iconColor: '#64748b',
      active: activeTheme === 'slate',
      perform: () => { onSelectTheme('slate'); onClose(); },
    },
    {
      id: 'theme-neon',
      category: 'Appearance',
      title: 'Theme: Midnight Cyber (High Contrast)',
      subtitle: 'Pure dark contrast styling',
      icon: Palette,
      iconColor: '#06b6d4',
      active: activeTheme === 'neon',
      perform: () => { onSelectTheme('neon'); onClose(); },
    },
    {
      id: 'density-compact',
      category: 'Display Density',
      title: 'Density: Compact',
      subtitle: 'High visual density for maximum data visibility',
      icon: Eye,
      iconColor: '#64748b',
      active: activeDensity === 'compact',
      perform: () => { onSelectDensity('compact'); onClose(); },
    },
    {
      id: 'density-standard',
      category: 'Display Density',
      title: 'Density: Standard',
      subtitle: 'Balanced spacing & comfortable padding',
      icon: Eye,
      iconColor: '#64748b',
      active: activeDensity === 'standard',
      perform: () => { onSelectDensity('standard'); onClose(); },
    },
  ];

  const filtered = actions.filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return a.title.toLowerCase().includes(q) || a.subtitle.toLowerCase().includes(q) || a.category.toLowerCase().includes(q);
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % (filtered.length || 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % (filtered.length || 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].perform();
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filtered, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-slate-950/60 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-xl rounded-3xl bg-white border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Search Bar */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-800 bg-white">
          <Command size={18} className="text-indigo-600 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, search section, or preset (⌘K)..."
            className="w-full bg-transparent text-sm font-medium text-slate-900 placeholder:text-slate-500 focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-700 flex items-center justify-center text-slate-400 transition"
          >
            <X size={14} />
          </button>
        </div>

        {/* Action List */}
        <div className="flex-1 overflow-y-auto p-2 custom-scrollbar space-y-1">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 font-medium">
              No matching commands found.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const Icon = item.icon;
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => item.perform()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full text-left flex items-center gap-3 p-3 rounded-2xl transition ${
                    isSelected ? 'bg-indigo-100 border border-indigo-300 text-slate-900' : 'text-slate-700 hover:bg-slate-100 border border-transparent'
                  }`}
                >
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border"
                    style={{
                      backgroundColor: `${item.iconColor}15`,
                      borderColor: `${item.iconColor}30`,
                      color: item.iconColor,
                    }}
                  >
                    <Icon size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900 truncate">{item.title}</span>
                      <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 px-1.5 py-0.5 rounded bg-slate-200/60">
                        {item.category}
                      </span>
                      {item.active && (
                        <span className="text-[9px] font-bold text-emerald-600 bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.5 rounded flex items-center gap-1 ml-auto">
                          <Check size={10} /> Active
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">{item.subtitle}</p>
                  </div>
                  {isSelected && (
                    <CornerDownLeft size={14} className="text-indigo-600 shrink-0" />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer shortcuts helper */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-800 bg-slate-950/50 text-[10px] text-slate-500 font-mono">
          <div className="flex items-center gap-3">
            <span><kbd className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">↑↓</kbd> Navigate</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">↵</kbd> Select</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">Esc</kbd> Close</span>
          </div>
          <span className="text-indigo-600 font-sans font-bold">AI Operating System</span>
        </div>
      </div>
    </div>
  );
}
