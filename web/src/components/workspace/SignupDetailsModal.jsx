import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';

const GOALS = { geo: 'Get quoted in AI answers', aeo: 'Show up in ChatGPT, Perplexity and Gemini', seo: 'Rank higher on Google' };
const regionName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const langName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
const country = (c) => (c ? (regionName?.of(c) || c) : '');
const nice = (v) => (String(v).includes('|') ? `${v.slice(v.indexOf('|') + 1)}, ${v.slice(0, v.indexOf('|'))}` : v);

function Section({ title, children }) {
  return (
    <div className="py-3 border-b border-border last:border-0">
      <p className="text-[11px] font-medium uppercase tracking-[.08em] text-faint mb-1.5">{title}</p>
      {children}
    </div>
  );
}
const Row = ({ k, v }) => (v ? <p className="text-[13px] text-text"><span className="inline-block w-[130px] text-faint">{k}</span><span className="text-fg">{v}</span></p> : null);
const Chips = ({ items }) => (items?.length
  ? <div className="flex flex-wrap gap-1.5">{items.map((t, i) => <span key={`${t}-${i}`} className="px-2 h-6 inline-flex items-center rounded-full bg-muted text-xs text-text">{t}</span>)}</div>
  : <p className="text-[13px] text-faint">Nothing entered.</p>);

// Staff: everything a person entered on /get-started, so a request can be judged and a project set up from it. Read only.
export default function SignupDetailsModal({ siteId, name, onClose }) {
  const [d, setD] = useState(undefined); // undefined = loading, null = failed
  useEffect(() => { api.clients.access.details(siteId).then(setD).catch(() => setD(null)); }, [siteId]);
  const s = d?.setup;
  const p = s?.profile || {};
  const lv = s?.markets?.levels || {};
  const levels = ['continent', 'country', 'state', 'city', 'neighborhood'].filter((l) => (lv[l] || []).length);
  const runs = s?.runs?.length ? s.runs : (s?.run?.country ? [s.run] : []);
  const topics = [...new Set((s?.prompts || []).map((x) => x.topic).filter(Boolean))];

  return (
    <Modal isOpen onClose={onClose} icon={FileText} title={`${name}: Get Started details`} subtitle="Everything they entered, as saved." maxWidth="max-w-[640px]" anchor="top"
      footer={<Button variant="light" onClick={onClose}>Close</Button>}>
      {d === undefined && <div className="h-24 bg-muted rounded-control animate-pulse" />}
      {d === null && <p className="text-[13px]" style={{ color: '#b42318' }}>Could not load the details.</p>}
      {d && (
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <Section title="Who">
            <Row k="Email" v={d.email} /><Row k="Name" v={d.name} /><Row k="Workspace name" v={d.workspaceName} /><Row k="Project name" v={d.projectName} />
            <Row k="Website" v={d.website} /><Row k="Billing country" v={country(s?.entityCountry)} /><Row k="Brand name" v={s?.brand} />
          </Section>
          {!s && <p className="py-3 text-[13px] text-faint">No setup answers were saved for this project.</p>}
          {s && <>
            <Section title="Brand profile">
              {p.description && <p className="text-[13px] text-fg mb-2">{p.description}</p>}
              <Row k="Category" v={p.category} />
              <p className="text-xs text-faint mt-2 mb-1">Brand identity</p><Chips items={p.identity} />
              <p className="text-xs text-faint mt-2 mb-1">Products and services</p><Chips items={p.products} />
              <p className="text-xs text-faint mt-2 mb-1">Personas</p><Chips items={p.personas} />
              <p className="text-xs text-faint mt-2 mb-1">Competitors</p><Chips items={p.competitors} />
            </Section>
            <Section title="Goals"><Chips items={(s.goals || []).map((g) => GOALS[g] || g)} /></Section>
            <Section title="Where they sell">
              {s.markets?.scope === 'global' || !levels.length ? <p className="text-[13px] text-fg">{s.markets?.scope === 'global' ? 'Global: every market' : (s.markets?.items || []).join(', ') || 'Not set'}</p>
                : levels.map((l) => <div key={l} className="mb-1.5"><p className="text-xs text-faint mb-1">{l[0].toUpperCase() + l.slice(1)}</p><Chips items={lv[l].map(nice)} /></div>)}
            </Section>
            <Section title="Prompts run from">
              {runs.length ? runs.map((r, i) => <p key={i} className="text-[13px] text-fg">{[country(r.country), r.city, r.language && (langName?.of(r.language) || r.language)].filter(Boolean).join(' · ')}</p>) : <p className="text-[13px] text-faint">Not set.</p>}
            </Section>
            <Section title={`Topics (${(s.topics || []).length})`}><Chips items={s.topics} /></Section>
            <Section title={`Prompts (${(s.prompts || []).length})`}>
              {(s.prompts || []).length === 0 && <p className="text-[13px] text-faint">None.</p>}
              {topics.map((t) => (
                <div key={t} className="mb-2">
                  <p className="text-xs font-medium text-fg mb-1">{t}</p>
                  {s.prompts.filter((x) => x.topic === t).map((x, i) => <p key={i} className="text-[13px] text-text pl-3">{x.text}{x.intent ? <span className="text-faint"> · {x.intent}</span> : null}</p>)}
                </div>
              ))}
            </Section>
          </>}
        </div>
      )}
    </Modal>
  );
}
