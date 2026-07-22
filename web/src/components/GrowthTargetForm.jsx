import { useState } from 'react';
import { api } from '../api.js';

// Used by PerformanceTrendCard (impressions/ctr targets, the only metrics
// still manually set) — a growth target is always { metric, targetValue,
// targetDate }; baseline_value/baseline_date are resolved server-side
// (server/routes/growth-report.js), never entered here, so a client can't
// set a fabricated starting point.

// Website Health Score, Clicks, Impressions, Competitor Readiness, Authority
// Score, and AI Recommendation Rate all now get an AI-computed projection
// (server/agents/lib/growth-projection.js, GrowthProjectionCard.jsx) instead
// of a human-entered target. Only impressions/ctr still support one, set
// per-tab from PerformanceTrendCard itself (the only remaining consumer of
// the single-metric form below), since they need the specific metric the
// client is already looking at.
export function buildChartRows(rows, target) {
  const actualByDate = new Map(rows.map((r) => [String(r.date).slice(0, 10), r.value]));
  const planByDate = new Map();
  if (target?.baselineValue != null) {
    planByDate.set(String(target.baselineDate).slice(0, 10), target.baselineValue);
    planByDate.set(String(target.date).slice(0, 10), target.value);
  }
  const dateSet = new Set([...actualByDate.keys(), ...planByDate.keys()]);
  if (!dateSet.size && target) dateSet.add(String(target.date).slice(0, 10));
  return Array.from(dateSet).sort().map((d) => ({
    date: d.slice(5),
    value: actualByDate.has(d) ? actualByDate.get(d) : null,
    plan: planByDate.has(d) ? planByDate.get(d) : null,
  }));
}

export default function GrowthTargetForm({ metric, unit, initial, onCancel, onSaved }) {
  const [value, setValue] = useState(initial?.value ?? '');
  const [date, setDate] = useState(initial?.date ? String(initial.date).slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.growthTargets.set({ metric, targetValue: Number(value), targetDate: date });
      onSaved();
    } catch (err) {
      setError(err.message || 'Could not save target.');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-2 mb-3 p-3 rounded-xl bg-slate-50 border border-slate-200/70 space-y-2">
      <div className="flex gap-2">
        <input type="number" step="any" required value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={`Target${unit}`} className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white" />
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)}
          className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white" />
      </div>
      {error && <p className="text-[10px] text-rose-600 font-semibold">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-lg text-white bg-[#6C63FF] disabled:opacity-60">
          {saving ? 'Saving…' : 'Save Target'}
        </button>
        <button type="button" onClick={onCancel} className="text-[10px] font-bold text-slate-400 hover:text-slate-600 px-2">Cancel</button>
      </div>
    </form>
  );
}
