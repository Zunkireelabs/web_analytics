import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Layers, Plus, Loader2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

const CATEGORY_OPTIONS = [
  'CRM', 'Booking', 'Appointment Management', 'Billing/Payments', 'Customer Management', 'Operations', 'Other',
];

// Kinds of product knowledge (server migration 176). 'capability' is what this
// list has always held; the others let an agent write ACCURATE copy about how
// the product works, what it costs, who it is for and what proof exists.
const KIND_OPTIONS = [
  { value: 'capability', label: 'Capability', placeholder: 'e.g. Booking Engine' },
  { value: 'flow', label: 'How it works', placeholder: 'e.g. Booking flow' },
  { value: 'pricing', label: 'Pricing', placeholder: 'e.g. Starter plan' },
  { value: 'audience', label: 'Audience', placeholder: 'e.g. Multi-branch spas' },
  { value: 'proof', label: 'Proof', placeholder: 'e.g. Customer result' },
];
const KIND_LABEL = Object.fromEntries(KIND_OPTIONS.map((k) => [k.value, k.label]));

const EMPTY_FORM = {
  kind: 'capability', name: '', category: CATEGORY_OPTIONS[0], description: '',
  steps: '', price: '', includes: '', source: '',
};

// Only the fields that belong to the chosen kind are sent, so switching kinds
// mid-edit never leaks a stale value into the saved row.
function buildDetails(f) {
  if (f.kind === 'flow') {
    const steps = f.steps.split('\n').map((x) => x.trim()).filter(Boolean);
    return steps.length ? { steps } : {};
  }
  if (f.kind === 'pricing') {
    const d = {};
    if (f.price.trim()) d.price = f.price.trim();
    if (f.includes.trim()) d.includes = f.includes.trim();
    return d;
  }
  if (f.kind === 'proof') return f.source.trim() ? { source: f.source.trim() } : {};
  return {};
}

function DetailLines({ kind, details }) {
  if (!details || typeof details !== 'object') return null;
  if (kind === 'flow' && Array.isArray(details.steps) && details.steps.length) {
    return (
      <ol className="mt-1.5 space-y-0.5 list-decimal list-inside">
        {details.steps.map((st, i) => (
          <li key={i} className="text-[11px] font-medium text-slate-600">{st}</li>
        ))}
      </ol>
    );
  }
  const parts = [];
  if (kind === 'pricing') {
    if (details.price) parts.push(details.price);
    if (details.includes) parts.push(`includes ${details.includes}`);
  }
  if (kind === 'proof' && details.source) parts.push(`source: ${details.source}`);
  return parts.length ? <p className="text-[11px] font-semibold text-slate-600 mt-1">{parts.join(' · ')}</p> : null;
}

// Ground truth for what this site's product actually does — read by
// classifyGapRelevance (server/agents/lib/analyst-seo-mapping.js) before a
// keyword gap is routed to a generator, so a "spa billing software" search
// only becomes a landing page if a capability like this genuinely exists.
// Every row added here is 'verified' immediately (staff-asserted, not an
// agent's guess) — there is no agent-proposal writer yet, so this list is
// authoritative until/unless that's built.
export default function AnalystProductCapabilities({ clientId }) {
  const [capabilities, setCapabilities] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    api.keywords.capabilities(clientId, undefined, 'all')
      .then(setCapabilities)
      .catch((e) => setError(e.message || 'Failed to load product capabilities.'));
  };

  useEffect(() => {
    setCapabilities(null);
    setError(null);
    setExpanded(false);
    load();
  }, [clientId]);

  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.keywords.addCapability(clientId, {
        name,
        kind: form.kind,
        category: form.kind === 'capability' ? form.category : null,
        description: form.description.trim() || null,
        details: buildDetails(form),
      });
      // Keep the chosen kind so several rows of one kind (e.g. pricing plans)
      // can be added in a row.
      setForm({ ...EMPTY_FORM, kind: form.kind });
      load();
    } catch (e) {
      setError(e.message || 'Could not add that capability.');
    } finally {
      setSaving(false);
    }
  };

  const loading = capabilities === null;

  return (
    <div className="an-panel p-5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 cursor-pointer"
      >
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-500/10 border border-indigo-500/25 text-indigo-600 shrink-0">
          <Layers size={15} />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Product Capabilities</h2>
          <p className="text-[11px] font-medium text-slate-500">
            What this product does, how it works, what it costs, who it is for and the proof behind it — agents write
            from these verified facts instead of guessing
          </p>
        </div>
        {!loading && (
          <span className="an-chip an-chip-slate shrink-0">{capabilities.length}</span>
        )}
        {expanded ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {error && (
            <p className="text-[11px] font-semibold text-rose-600 flex items-center gap-1.5">
              <AlertTriangle size={11} className="shrink-0" />
              {error}
            </p>
          )}

          {loading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => <div key={i} className="h-11 rounded-xl bg-slate-200/50 animate-pulse" />)}
            </div>
          ) : capabilities.length === 0 ? (
            <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
              Nothing added yet. Agents only describe the product using what is verified here — add what this product
              does, how it works, its pricing, audience and proof below.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {capabilities.map((c) => (
                <div key={c.id} className="rounded-xl border border-slate-200 bg-slate-100/40 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-black text-slate-800">{c.name}</span>
                    {(c.kind || 'capability') !== 'capability' && (
                      <span className="an-chip an-chip-slate">{KIND_LABEL[c.kind] || c.kind}</span>
                    )}
                    {c.category && <span className="an-chip an-chip-violet">{c.category}</span>}
                  </div>
                  {c.description && (
                    <p className="text-[11px] font-medium text-slate-500 mt-1 line-clamp-2">{c.description}</p>
                  )}
                  <DetailLines kind={c.kind} details={c.details} />
                </div>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="space-y-2 pt-1">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
                disabled={saving}
                className="an-input text-[11px] font-bold py-2.5 pr-8 cursor-pointer"
                aria-label="Kind of product knowledge"
              >
                {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={KIND_OPTIONS.find((k) => k.value === form.kind)?.placeholder}
                maxLength={120}
                disabled={saving}
                className="an-input flex-1 text-[11px] font-semibold py-2.5"
              />
              {form.kind === 'capability' && (
                <select
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  disabled={saving}
                  className="an-input text-[11px] font-bold py-2.5 pr-8 cursor-pointer"
                >
                  {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
            </div>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Short description (optional)"
              maxLength={300}
              disabled={saving}
              className="an-input w-full text-[11px] font-semibold py-2.5"
            />
            {form.kind === 'flow' && (
              <textarea
                value={form.steps}
                onChange={(e) => setForm((f) => ({ ...f, steps: e.target.value }))}
                placeholder={'Steps, one per line\ne.g. Customer picks a service\nChoose a branch and staff member\nConfirm the booking'}
                rows={4}
                disabled={saving}
                className="an-input w-full text-[11px] font-semibold py-2.5"
              />
            )}
            {form.kind === 'pricing' && (
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  placeholder="Price, e.g. NPR 5,000 / month"
                  maxLength={120}
                  disabled={saving}
                  className="an-input flex-1 text-[11px] font-semibold py-2.5"
                />
                <input
                  value={form.includes}
                  onChange={(e) => setForm((f) => ({ ...f, includes: e.target.value }))}
                  placeholder="What it includes (optional)"
                  maxLength={200}
                  disabled={saving}
                  className="an-input flex-[1.5] text-[11px] font-semibold py-2.5"
                />
              </div>
            )}
            {form.kind === 'proof' && (
              <input
                value={form.source}
                onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
                placeholder="Where this can be verified (customer, case study URL…)"
                maxLength={200}
                disabled={saving}
                className="an-input w-full text-[11px] font-semibold py-2.5"
              />
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving || !form.name.trim()}
                className="an-grad-btn text-[11px] font-bold px-3 py-2.5 rounded-xl text-white shrink-0 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                Add
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
