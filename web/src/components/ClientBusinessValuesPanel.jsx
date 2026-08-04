import { useEffect, useState } from 'react';
import { DollarSign } from 'lucide-react';
import { api } from '../api.js';

const fieldCls = 'w-full text-[11px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2.5 py-1.5 bg-white disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF]';
const labelCls = 'block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1';

const FIELDS = [
  { key: 'conversion_value', label: 'Conversion value', hint: 'Revenue per conversion event (e.g. a lead form submit)' },
  { key: 'avg_order_value', label: 'Avg order value', hint: 'Average $ per completed order/purchase' },
  { key: 'lead_value', label: 'Lead value', hint: '$ value of a raw lead before it converts' },
  { key: 'revenue_per_conversion', label: 'Revenue per conversion', hint: 'Blended $ per conversion, if the above don’t fit' },
];

// Feeds ROI Estimation Mode 2 (data-analyst-agent/app/scoring/impact_
// projection.py) — without at least one of these set for a client, every
// "Expected Business Impact" card on /analyst permanently reads
// "isn't configured yet". Full-state Save (not autosave-per-keystroke)
// since these are monetary inputs staff should confirm before committing.
export default function ClientBusinessValuesPanel({ clientId }) {
  const [values, setValues] = useState(null); // {conversion_value, avg_order_value, lead_value, revenue_per_conversion, currency}
  const [loadError, setLoadError] = useState(null);
  const [saveState, setSaveState] = useState('idle'); // idle | running | done | error
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.analyst.getBusinessValues(clientId)
      .then((data) => { if (!cancelled) setValues(data); })
      .catch((err) => { if (!cancelled) setLoadError(err.message || 'Could not load business values.'); });
    return () => { cancelled = true; };
  }, [clientId]);

  const setField = (key, raw) => {
    const n = raw === '' ? null : Number(raw);
    setValues((v) => ({ ...v, [key]: Number.isFinite(n) ? n : null }));
  };

  const save = async () => {
    setSaveState('running');
    setSaveError(null);
    try {
      const updated = await api.analyst.setBusinessValues(clientId, {
        conversionValue: values.conversion_value,
        avgOrderValue: values.avg_order_value,
        leadValue: values.lead_value,
        revenuePerConversion: values.revenue_per_conversion,
        currency: values.currency || 'USD',
      });
      setValues(updated);
      setSaveState('done');
    } catch (err) {
      setSaveError(err.message || 'Could not save.');
      setSaveState('error');
    }
  };

  if (loadError) {
    return <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{loadError}</div>;
  }
  if (values === null) {
    return <div className="text-[10px] font-semibold text-slate-400 px-1 py-2">Loading business values…</div>;
  }

  return (
    <div className="rounded-2xl bg-[#6C63FF]/[0.04] border border-[#6C63FF]/15 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <DollarSign size={11} className="text-[#6C63FF] shrink-0" />
        <p className="text-[10px] font-bold text-slate-600 leading-relaxed">
          Real $ inputs for this client's Expected Business Impact projections. Leave a field blank if it doesn't apply — only one needs to be set.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className={labelCls} title={f.hint}>{f.label}</label>
            <input
              type="number" min={0} step="0.01"
              className={fieldCls}
              disabled={saveState === 'running'}
              value={values[f.key] ?? ''}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder="Not set"
            />
          </div>
        ))}
        <div>
          <label className={labelCls}>Currency</label>
          <select
            className={fieldCls}
            disabled={saveState === 'running'}
            value={values.currency || 'USD'}
            onChange={(e) => setValues((v) => ({ ...v, currency: e.target.value }))}
          >
            {['USD', 'GBP', 'EUR', 'CAD', 'AUD'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button" onClick={save} disabled={saveState === 'running'}
          className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-xl text-white transition disabled:opacity-50 active:scale-95"
          style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
        >
          {saveState === 'running' ? 'Saving…' : 'Save Business Values'}
        </button>
        {saveState === 'done' && <span className="text-[10px] font-bold text-emerald-600">Saved.</span>}
        {saveState === 'error' && <span className="text-[10px] font-bold text-rose-600">{saveError}</span>}
      </div>
    </div>
  );
}
