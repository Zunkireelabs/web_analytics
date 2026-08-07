import React, { useState } from 'react';
import {
  Sparkles, Command, SlidersHorizontal, HelpCircle, ArrowRight, RefreshCw, ChevronDown,
  Radar, AlertTriangle, ListChecks, TrendingUp,
} from 'lucide-react';

function StatusChip({ icon: Icon, label, value, tone = 'violet', onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`an-chip an-chip-${tone} ${onClick ? 'cursor-pointer hover:brightness-95 transition' : ''}`}
      title={onClick ? `${label} — jump to details` : label}
    >
      <Icon size={10} />
      <span>{label}</span>
      <strong className="font-black">{value}</strong>
    </button>
  );
}

export default function AnalystHeaderOS({
  clients,
  selectedClientId,
  onSelectClient,
  activePreset,
  onSelectPreset,
  onOpenCommandPalette,
  onOpenCopilotWithPrompt,
  onToggleCustomizer,
  onOpenShortcuts,
  lastIngestedAt,
  isRefreshing,
  onRefresh,
  summary, // { openFindings, forecastRisks, readyFixes, insightsTotal } optional
  onNavigateToSection, // (sectionId) => void, jumps to & un-hides a dashboard section
}) {
  const [prompt, setPrompt] = useState('');

  const handlePromptSubmit = (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    onOpenCopilotWithPrompt(prompt.trim());
    setPrompt('');
  };

  const presets = [
    { id: 'executive', label: 'Executive', icon: '🏢' },
    { id: 'investigation', label: 'Triage', icon: '🔍' },
    { id: 'growth', label: 'Growth & Forecast', icon: '📈' },
    { id: 'copilot', label: 'AI Focus', icon: '🤖' },
  ];

  return (
    <div className="space-y-3 mb-5">
      {/* Command Center Bar — dark AI analyst status strip */}
      <div className="an-panel-glow px-4 py-3.5 flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3">
        {/* Left: Identity + live status + client switcher */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400 an-glow-dot"></span>
            </span>
            <div className="hidden sm:block">
              <div className="text-[11px] font-black uppercase tracking-widest text-slate-900 flex items-center gap-1.5">
                AI Data Analyst
              </div>
              <div className="text-[9px] font-semibold text-slate-400 -mt-0.5">Prediction & Fix Command Center</div>
            </div>
          </div>

          {clients && clients.length > 0 && (
            <div className="relative flex items-center">
              <select
                value={selectedClientId || ''}
                onChange={(e) => onSelectClient(Number(e.target.value))}
                className="an-input appearance-none font-bold px-3 py-1.5 pr-7 cursor-pointer"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id} className="bg-white text-slate-800">
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} className="absolute right-2 pointer-events-none text-slate-400" />
            </div>
          )}

          {lastIngestedAt && (
            <span className="text-[10px] font-semibold text-slate-400 hidden lg:inline">
              Synced {new Date(lastIngestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="p-1.5 rounded-lg border border-slate-300 bg-slate-100 text-slate-400 hover:text-slate-900 transition disabled:opacity-40 cursor-pointer"
              title="Refresh Dashboard Data"
            >
              <RefreshCw size={12} className={isRefreshing ? 'animate-spin text-indigo-600' : ''} />
            </button>
          )}
        </div>

        {/* Center/Right: prediction & action status chips */}
        {summary && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <StatusChip icon={Radar} label="Forecast risk" value={summary.forecastRisks ?? 0} tone="rose" onClick={onNavigateToSection && (() => onNavigateToSection('workspace'))} />
            <StatusChip icon={AlertTriangle} label="Open findings" value={summary.openFindings ?? 0} tone="amber" onClick={onNavigateToSection && (() => onNavigateToSection('workspace'))} />
            <StatusChip icon={ListChecks} label="Fixes ready" value={summary.readyFixes ?? 0} tone="emerald" onClick={onNavigateToSection && (() => onNavigateToSection('fixes'))} />
            <StatusChip icon={TrendingUp} label="Metrics" value={summary.metricsTotal ?? 0} tone="cyan" onClick={onNavigateToSection && (() => onNavigateToSection('diagnostics'))} />
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 p-0.5 rounded-xl bg-slate-100 border border-slate-200">
            {presets.map((p) => {
              const active = activePreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelectPreset(p.id)}
                  className={`text-[10px] font-bold px-2.5 py-1 rounded-lg transition flex items-center gap-1 cursor-pointer ${
                    active
                      ? 'bg-slate-100 text-slate-900 border border-white/15 font-extrabold an-glow-line'
                      : 'text-slate-400 hover:text-slate-800'
                  }`}
                >
                  <span>{p.icon}</span>
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-xl text-slate-900 shadow-2xs hover:brightness-110 transition cursor-pointer"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
          >
            <Command size={12} />
            <span className="hidden sm:inline">Commands</span>
            <kbd className="text-[8px] font-mono opacity-70 bg-slate-200 px-1 py-0.5 rounded">⌘K</kbd>
          </button>

          <button
            type="button"
            onClick={onToggleCustomizer}
            className="p-1.5 rounded-xl border border-slate-300 bg-slate-100 text-slate-700 hover:text-slate-900 transition cursor-pointer"
            title="Customizer & Layout Controls"
          >
            <SlidersHorizontal size={13} />
          </button>

          <button
            type="button"
            onClick={onOpenShortcuts}
            className="p-1.5 rounded-xl border border-slate-300 bg-slate-100 text-slate-400 hover:text-slate-800 transition cursor-pointer"
            title="Keyboard Shortcuts (?)"
          >
            <HelpCircle size={13} />
          </button>
        </div>
      </div>

      {/* Prompt Bar — ask the analyst anything about predictions */}
      <form
        onSubmit={handlePromptSubmit}
        className="relative flex items-center rounded-2xl border border-slate-200 bg-white hover:border-indigo-400 transition p-1.5 focus-within:ring-2 focus-within:ring-violet-500/20"
      >
        <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0 ml-1 border border-indigo-200">
          <Sparkles size={15} />
        </div>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask AI Analyst anything about predictions, search traffic, anomalies..."
          className="w-full bg-transparent text-xs font-medium text-slate-900 placeholder:text-slate-500 px-3 py-1.5 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!prompt.trim()}
          className="an-grad-btn flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-xl shadow-2xs disabled:opacity-40 transition cursor-pointer shrink-0"
        >
          <span>Ask AI</span>
          <ArrowRight size={12} />
        </button>
      </form>
    </div>
  );
}
