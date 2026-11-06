import { useEffect, useState } from 'react';
import { Compass, Plus, X, ArrowLeft } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Badge from '../Badge.jsx';
import Field from '../Field.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import { shortDate } from './ListParts.jsx';

// Account settings -> Platform -> Industry sets. What the platform knows up front about each industry: the four growth stages, the
// typical key dates (shown to clients as "typical for this industry"), the extra agents worth running, and a short brief. A saved set
// replaces the built-in default; "Reset" brings the default back. Every save is recorded with who made it (server/lib/industry-sets.js).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = (id) => String(id || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Chips({ label, items, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => { const v = draft.trim(); if (v && !items.includes(v)) onChange([...items, v]); setDraft(''); };
  return (
    <div className="mb-4">
      <div className="text-[13px] font-medium text-fg mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {items.length === 0 && <span className="text-[13px] text-faint">None yet.</span>}
        {items.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 text-[12.5px] pl-2.5 pr-1.5 py-1 rounded-full bg-muted text-text">
            {c}<button type="button" aria-label={`Remove ${c}`} onClick={() => onChange(items.filter((x) => x !== c))} className="text-faint hover:text-fg"><X size={13} /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Field className="flex-1" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button size="sm" onClick={add} disabled={!draft.trim()}><Plus size={14} /> Add</Button>
      </div>
    </div>
  );
}

function Editor({ set, history, agents, onBack, onSaved }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(set)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(set);
  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await api.platform.saveIndustrySet(set.industry, draft); onSaved(r.set); }
    catch (e) { setError(e.message || 'Could not save.'); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!window.confirm(`Restore the built-in ${set.label} set? Your edits are kept in the history.`)) return;
    setBusy(true); setError(null);
    try { const r = await api.platform.resetIndustrySet(set.industry); onSaved(r.set); }
    catch (e) { setError(e.message || 'Could not reset.'); } finally { setBusy(false); }
  };

  return (
    <div>
      <button type="button" className="inline-flex items-center gap-1.5 text-[13px] text-text hover:text-fg mb-3" onClick={onBack}><ArrowLeft size={14} /> All industries</button>
      <SettingsCard icon={Compass} title={`${set.label} set`} description={set.custom ? `Edited${set.updatedBy ? ` by ${set.updatedBy}` : ''}${set.updatedAt ? ` on ${shortDate(set.updatedAt)}` : ''}.` : 'Built-in default. Save a change to make it your own.'}
        footer={<>
          {set.custom && <Button onClick={reset} disabled={busy}>Reset to default</Button>}
          <Button variant="primary" onClick={save} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </>}>
        <div className="px-5 py-4">
          {error && <p className="text-[13px] text-[#b42318] mb-3">{error}</p>}

          <div className="text-[13px] font-medium text-fg mb-1.5">Growth stages</div>
          <p className="text-[13px] text-faint mb-2">Four stages, in order. Clients see where they are on this path.</p>
          {draft.stages.map((s, i) => (
            <div key={s.key} className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)] mb-2">
              <Field aria-label={`Stage ${i + 1} title`} value={s.title} onChange={(e) => patch({ stages: draft.stages.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
              <Field aria-label={`Stage ${i + 1} description`} value={s.description} onChange={(e) => patch({ stages: draft.stages.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
            </div>
          ))}

          <div className="text-[13px] font-medium text-fg mt-5 mb-1">Key dates</div>
          <p className="text-[13px] text-faint mb-2">When interest in this industry rises. Clients see these as "typical for this industry", never as their own data.</p>
          {draft.keyDates.map((k, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[90px_minmax(0,1fr)_minmax(0,1.4fr)_auto] mb-2 items-start">
              <Field as="select" aria-label="Month" value={k.month} onChange={(e) => patch({ keyDates: draft.keyDates.map((x, j) => (j === i ? { ...x, month: Number(e.target.value) } : x)) })}>
                {MONTHS.map((m, n) => <option key={m} value={n + 1}>{m}</option>)}
              </Field>
              <Field aria-label="What happens" placeholder="What happens" value={k.title} onChange={(e) => patch({ keyDates: draft.keyDates.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
              <Field aria-label="What to do before it" placeholder="What to do before it" value={k.advice} onChange={(e) => patch({ keyDates: draft.keyDates.map((x, j) => (j === i ? { ...x, advice: e.target.value } : x)) })} />
              <button type="button" aria-label="Remove date" className="p-2 text-faint hover:text-fg" onClick={() => patch({ keyDates: draft.keyDates.filter((_, j) => j !== i) })}><X size={15} /></button>
            </div>
          ))}
          <Button size="sm" onClick={() => patch({ keyDates: [...draft.keyDates, { month: 1, title: '', advice: '' }] })}><Plus size={14} /> Add a date</Button>

          <div className="text-[13px] font-medium text-fg mt-6 mb-1.5">Extra agents for this industry</div>
          <p className="text-[13px] text-faint mb-2">Pick the agents most useful here. They run on top of the core agents.</p>
          <div className="flex flex-wrap gap-1.5 mb-5">
            {agents.map((a) => {
              const on = draft.agents.includes(a.id);
              return <button key={a.id} type="button" aria-pressed={on} onClick={() => patch({ agents: on ? draft.agents.filter((x) => x !== a.id) : [...draft.agents, a.id] })}
                className={`text-[12.5px] px-2.5 py-1 rounded-full ${on ? 'bg-primary-tint text-primary-strong' : 'bg-muted text-text'}`} style={on ? { boxShadow: 'inset 0 0 0 1px var(--primary-ring)' } : undefined}>{a.name || nice(a.id)}</button>;
            })}
          </div>

          <Chips label="Who it is for" items={draft.brief.audience} placeholder="e.g. Prospective students" onChange={(v) => patch({ brief: { ...draft.brief, audience: v } })} />
          <Chips label="What to focus on" items={draft.brief.focus} placeholder="e.g. Fees and costs" onChange={(v) => patch({ brief: { ...draft.brief, focus: v } })} />
          <Chips label="What to avoid" items={draft.brief.avoid} placeholder="e.g. Guaranteed outcomes" onChange={(v) => patch({ brief: { ...draft.brief, avoid: v } })} />

          {history?.length > 0 && (
            <div className="mt-5 pt-4 border-t border-border">
              <div className="text-[13px] font-medium text-fg mb-1.5">Recent changes</div>
              {history.map((h, i) => <div key={i} className="text-[13px] text-text">{shortDate(h.at)} · {h.by || 'system'} · {h.to ? 'saved' : 'reset to default'}</div>)}
            </div>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}

export default function IndustrySetsView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const load = () => api.platform.industrySets().then(setData).catch((e) => setError(e.message || 'Could not load the industry sets.'));
  useEffect(() => { load(); }, []);

  if (error) return <SettingsCard icon={Compass} title="Industry sets"><p className="px-5 py-6 text-[13px] text-[#b42318]">{error}</p></SettingsCard>;
  if (!data) return <SettingsCard icon={Compass} title="Industry sets"><p className="px-5 py-6 text-[13px] text-faint">Loading…</p></SettingsCard>;

  const current = open && data.sets.find((s) => s.industry === open);
  if (current) return <Editor key={current.industry + (current.updatedAt || '')} set={current} history={data.history[current.industry]} agents={data.agents} onBack={() => setOpen(null)} onSaved={() => { load(); }} />;

  return (
    <SettingsCard icon={Compass} title="Industry sets" description="What the platform knows up front about each industry. A client's industry is detected on its own at the baseline; the set for that industry then applies.">
      {data.sets.map((s) => (
        <div key={s.industry} className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border last:border-0">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-fg">{s.label} {s.custom ? <Badge tone="amber">Edited</Badge> : <Badge tone="grey">Built-in</Badge>}</div>
            <div className="text-[13px] text-text">{s.keyDates.length} key dates · {s.agents.length} extra agents · {s.brief.focus.length} focus points</div>
          </div>
          <Button size="sm" onClick={() => setOpen(s.industry)}>Open</Button>
        </div>
      ))}
    </SettingsCard>
  );
}
