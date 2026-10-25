import { useEffect, useState } from 'react';
import { DollarSign } from 'lucide-react';
import { api } from '../api.js';
import Button from './Button.jsx';
import Field from './Field.jsx';
import Select from './Select.jsx';

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
    return <div role="alert" className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{loadError}</div>;
  }
  if (values === null) {
    return <div className="text-[13px] text-faint px-1 py-2">Loading business values…</div>;
  }

  return (
    <div className="rounded-card bg-[#fcfcfb] p-4 space-y-3" style={{ boxShadow: 'var(--ring)' }}>
      <div className="flex items-start gap-2">
        <DollarSign size={14} className="text-faint shrink-0 mt-0.5" aria-hidden />
        <p className="text-xs leading-5 text-text">
          Real $ inputs for this client's Expected Business Impact projections. Leave a field blank if it doesn't apply — only one needs to be set.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <Field
            key={f.key} label={f.label} title={f.hint}
            type="number" min={0} step="0.01"
            disabled={saveState === 'running'}
            value={values[f.key] ?? ''}
            onChange={(e) => setField(f.key, e.target.value)}
            placeholder="Not set"
          />
        ))}
        <Select
          label="Currency"
          disabled={saveState === 'running'}
          value={values.currency || 'USD'}
          onChange={(e) => setValues((v) => ({ ...v, currency: e.target.value }))}
        >
          {['USD', 'GBP', 'EUR', 'CAD', 'AUD'].map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={saveState === 'running'}>
          {saveState === 'running' ? 'Saving…' : 'Save Business Values'}
        </Button>
        {saveState === 'done' && <span className="text-[13px] text-[var(--green)]">Saved.</span>}
        {saveState === 'error' && <span className="text-[13px] text-[#b42318]">{saveError}</span>}
      </div>
    </div>
  );
}
