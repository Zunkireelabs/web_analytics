import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Plus, Loader2, AlertTriangle } from 'lucide-react';
import { STATUS } from '../lib/palette.js';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import Field from './Field.jsx';
import Select from './Select.jsx';
import AnalystCollapsible from './AnalystCollapsible.jsx';

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
          <li key={i} className="text-xs text-text">{st}</li>
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
  return parts.length ? <p className="text-xs text-text mt-1">{parts.join(' · ')}</p> : null;
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
    <AnalystCollapsible
      title="Product capabilities"
      subtitle="What this product does, how it works, what it costs, who it is for and the proof behind it — agents write from these verified facts instead of guessing"
      badge={!loading ? <Badge tone="grey">{capabilities.length}</Badge> : null}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {error && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: STATUS.critical.text }}>
          <AlertTriangle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-11 rounded-card bg-muted animate-pulse" />)}
        </div>
      ) : capabilities.length === 0 ? (
        <p className="text-[13px] text-text bg-muted rounded-card px-4 py-3">
          Nothing added yet. Agents only describe the product using what is verified here — add what this product
          does, how it works, its pricing, audience and proof below.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {capabilities.map((c) => (
            <div key={c.id} className="rounded-card bg-white p-3" style={{ boxShadow: 'var(--ring)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-medium text-fg">{c.name}</span>
                {(c.kind || 'capability') !== 'capability' && (
                  <Badge tone="grey">{KIND_LABEL[c.kind] || c.kind}</Badge>
                )}
                {c.category && <Badge tone="primary">{c.category}</Badge>}
              </div>
              {c.description && (
                <p className="text-xs text-faint mt-1 line-clamp-2">{c.description}</p>
              )}
              <DetailLines kind={c.kind} details={c.details} />
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="space-y-2 pt-1">
        <div className="flex flex-col sm:flex-row items-stretch gap-2">
          <Select
            value={form.kind}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
            disabled={saving}
            aria-label="Kind of product knowledge"
          >
            {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
          <Field
            className="flex-1"
            aria-label="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={KIND_OPTIONS.find((k) => k.value === form.kind)?.placeholder}
            maxLength={120}
            disabled={saving}
          />
          {form.kind === 'capability' && (
            <Select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              disabled={saving}
              aria-label="Category"
            >
              {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
        </div>
        <Field
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="Short description (optional)"
          maxLength={300}
          disabled={saving}
        />
        {form.kind === 'flow' && (
          <Field
            as="textarea"
            aria-label="Steps"
            value={form.steps}
            onChange={(e) => setForm((f) => ({ ...f, steps: e.target.value }))}
            placeholder={'Steps, one per line\ne.g. Customer picks a service\nChoose a branch and staff member\nConfirm the booking'}
            rows={4}
            disabled={saving}
          />
        )}
        {form.kind === 'pricing' && (
          <div className="flex flex-col sm:flex-row gap-2">
            <Field
              className="flex-1"
              aria-label="Price"
              value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              placeholder="Price, e.g. NPR 5,000 / month"
              maxLength={120}
              disabled={saving}
            />
            <Field
              className="flex-[1.5]"
              aria-label="What it includes"
              value={form.includes}
              onChange={(e) => setForm((f) => ({ ...f, includes: e.target.value }))}
              placeholder="What it includes (optional)"
              maxLength={200}
              disabled={saving}
            />
          </div>
        )}
        {form.kind === 'proof' && (
          <Field
            aria-label="Source"
            value={form.source}
            onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
            placeholder="Where this can be verified (customer, case study URL…)"
            maxLength={200}
            disabled={saving}
          />
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={saving || !form.name.trim()}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add
          </Button>
        </div>
      </form>
    </AnalystCollapsible>
  );
}
