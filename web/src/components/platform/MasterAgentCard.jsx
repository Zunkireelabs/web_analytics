import { useState } from 'react';
import { Bot, Check, Info, ShieldCheck, X } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import Modal from '../Modal.jsx';
import { Switch } from './AutonomySwitch.jsx';

// The Master Agent's control and status, on Account settings -> Platform -> Agent instances. ONE switch, On or Off. Turning it on
// starts a SAFE START (the server's "shadow" mode: it plans and records, runs nothing); after at least 3 clean days a person
// presses "Go live" (the server's "on" mode). The server decides whether each step is allowed (the server-setting ceiling, and the
// 3 clean days), so this screen only explains it and never trusts its own buttons.

const LABEL = { off: 'Off', shadow: 'On · safe start', on: 'On · live' };
const PLAIN = { off: 'Off', shadow: 'On (safe start)', on: 'On (live)' };
const TONE = { off: 'grey', shadow: 'amber', on: 'green' };
const BLURB = {
  off: 'Not scheduling anything. The existing daily run is the only scheduler. When you turn it on it starts with a safe start: it plans each day and records what it would run, without running anything.',
  shadow: 'Safe start: each morning it works out the order and how long the day would take, and records it. It runs nothing and changes nothing. After 3 clean days you can take it live.',
  on: 'Live: running the daily work for every connected project from a queue. The 07:00 run now skips its own detection step.',
};
const stamp = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const span = (ms) => (ms == null ? '—' : ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

function Fact({ children }) {
  return <span className="inline-flex items-center gap-1.5 rounded-[10px] bg-white px-3 py-1.5 text-[13px] text-text" style={{ boxShadow: '0 0 0 1px var(--input)' }}>{children}</span>;
}
function Mark({ ok }) {
  const style = ok === true ? { background: 'var(--green-tint)', color: 'var(--green)' } : ok === false ? { background: '#fdecec', color: '#b42318' } : { background: '#fdf3e1', color: '#8a5300' };
  return <span className="w-[18px] h-[18px] rounded-full grid place-items-center shrink-0 mt-0.5" style={style}>{ok === true ? <Check size={11} strokeWidth={3} /> : ok === false ? <X size={11} strokeWidth={3} /> : <Info size={11} strokeWidth={3} />}</span>;
}

export default function MasterAgentCard({ m, onChanged }) {
  const [dialog, setDialog] = useState(null); // 'shadow' | 'on' | null
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  if (!m) return null;

  const mode = m.mode || 'off';
  const t = m.today || {};
  const ready = m.readiness;
  const can = m.canSwitch || {};
  const apply = async (next) => {
    setBusy(true); setError(null);
    try { onChanged(await api.platform.setMasterMode(next)); setDialog(null); setAck(false); }
    catch (e) { setError(e?.message || 'The Master Agent could not be switched.'); } finally { setBusy(false); }
  };
  const turnOn = () => { setError(null); if (!m.locked) setDialog('start'); };
  const goLive = () => { setError(null); if (!m.locked) setDialog('live'); };
  const lockedWhy = m.locked ? 'Locked by a server setting' : null;
  const bad = (t.failed || 0) + (t.timedOut || 0) + (m.stuckRunning || 0);

  return (
    <div className="rounded-card bg-white" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
      <div className="flex flex-wrap items-start gap-3.5 px-4 sm:px-[18px] py-4">
        <span className="w-[38px] h-[38px] rounded-[11px] bg-muted grid place-items-center text-text shrink-0"><Bot size={17} /></span>
        <div className="flex-1 min-w-[240px]">
          <div className="flex flex-wrap items-center gap-2.5"><b className="text-[15px] font-semibold text-fg">Master Agent</b><Badge tone={TONE[mode]} dot>{LABEL[mode]}</Badge></div>
          <p className="mt-0.5 max-w-[640px] text-[13.5px] leading-5 text-text">{BLURB[mode]}</p>
          {m.locked && <p className="mt-1.5 text-[12.5px]" style={{ color: '#8a5300' }}>Locked by a server setting ({m.ceiling === 'off' ? 'off' : `at most ${m.ceiling}`}). Change it in the server settings to use this switch.</p>}
        </div>
        <Switch on={mode !== 'off'} disabled={busy || m.locked} title={lockedWhy || undefined} label={mode === 'off' ? 'Off' : 'On'}
          onClick={() => (mode === 'off' ? turnOn() : apply('off'))} />
      </div>

      <div className="border-t border-border px-4 sm:px-[18px] py-3.5 space-y-3.5">
        {error && <div className="rounded-control px-3 py-2 text-[13px]" style={{ background: '#fdecec', color: '#b42318' }} role="alert">{error}</div>}

        {mode !== 'off' && (
          <div className="flex flex-wrap gap-2">
            {mode === 'shadow' ? (
              <>
                <Fact><b className="font-semibold text-fg tnum">{ready?.shadowDays ?? 0}</b> {ready?.shadowDays === 1 ? 'day' : 'days'} of plans recorded</Fact>
                <Fact><b className="font-semibold text-fg tnum">{m.shadow?.planned ?? 0}</b> projects planned today</Fact>
                <Fact><b className="font-semibold text-fg tnum">0</b> run (safe start runs nothing)</Fact>
                <Fact><b className="font-semibold text-fg tnum">{ready?.failedPlans ?? 0}</b> failed plans</Fact>
              </>
            ) : (
              <>
                <Fact><b className="font-semibold text-fg tnum">{t.succeeded || 0}</b> done today</Fact>
                <Fact><b className="font-semibold text-fg tnum">{t.running || 0}</b> running</Fact>
                <Fact><b className="font-semibold text-fg tnum">{bad}</b> failed or stuck</Fact>
                <Fact><b className="font-semibold text-fg tnum">{t.queued || 0}</b> waiting</Fact>
                {m.limits && <Fact>Concurrency <b className="font-semibold text-fg tnum">{m.limits.concurrency}</b></Fact>}
                {m.limits && <Fact>Browser slots <b className="font-semibold text-fg tnum">{m.limits.browserSlots}</b></Fact>}
                {m.autoBaseline && <Fact>New-project baselines today <b className="font-semibold text-fg tnum">{m.autoBaseline.startedToday}</b> of {m.autoBaseline.cap}</Fact>}
              </>
            )}
          </div>
        )}

        {mode === 'shadow' && (
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-fg">Plan compared with the existing daily run</p>
              <p className="text-[12.5px] text-faint mb-2">Today. The plan is only a prediction; the existing run is what actually happened.</p>
              {m.shadow?.projects?.length ? (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Project</th><th className="num">Plan order</th><th className="num">Planned</th><th className="num">Existing run</th></tr></thead>
                    <tbody>
                      {m.shadow.projects.map((p) => <tr key={p.siteId}><td>{p.name}</td><td className="num">{p.order}</td><td className="num">{span(p.plannedMs)}</td><td className="num">{span(p.legacyMs)}</td></tr>)}
                      <tr><td className="font-semibold text-fg">Whole day</td><td className="num">{m.shadow.projects.length}</td><td className="num font-semibold text-fg">{span(m.shadow.estimatedMs?.sequentialToday)}</td><td className="num font-semibold text-fg">{span(m.shadow.projects.reduce((a, p) => a + (p.legacyMs || 0), 0) || null)}</td></tr>
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-[13px] text-faint">No plan has been recorded for today yet. The first one is made at the next scheduled run.</p>}
            </div>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-fg mb-1.5">Ready to go live?</p>
              <ul className="space-y-2 list-none m-0 p-0">
                {(ready?.checks || []).map((c) => (
                  <li key={c.key} className="flex gap-2.5 text-[13.5px] leading-[19px] text-text"><Mark ok={c.ok} /><span><b className="font-medium text-fg">{c.label}</b><br />{c.detail}</span></li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {mode === 'on' && (
          <div className="rounded-[10px] px-3 py-2.5 text-[13px] leading-[19px]" style={{ background: '#fdf3e1', boxShadow: 'inset 0 0 0 1px #f1dcae', color: '#7a5b00' }}>
            Limits are set on the server. If a job fails it is retried once, then shown here as needing attention. Going back to safe start stops new jobs from starting; a job already running finishes.
          </div>
        )}

        {(mode === 'shadow' || mode === 'on') && (
          <div className="flex flex-wrap items-center gap-2.5">
            {mode === 'shadow' && <Button variant="primary" onClick={goLive} disabled={busy || m.locked || can.on?.ok === false} title={can.on?.reason || undefined}>Go live</Button>}
            {mode === 'on' && <Button variant="light" onClick={() => apply('shadow')} disabled={busy || m.locked}>Back to safe start</Button>}
            <span className="text-[12.5px] text-faint">{mode === 'shadow' ? (can.on?.ok === false ? can.on.reason : 'Ready: you can go live. Turning it off is instant.') : 'Turn the switch off to stop it at any time.'}</span>
          </div>
        )}

        {m.history?.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} className="flex w-full items-center gap-2 text-left text-[12.5px] text-text hover:text-fg">
              <span className="text-faint">Last change</span>
              <span className="min-w-0 truncate"><b className="font-medium text-fg">{m.history[0].by || 'Unknown'}</b> · {stamp(m.history[0].at)} · {PLAIN[m.history[0].from] || m.history[0].from} → {PLAIN[m.history[0].to] || m.history[0].to}</span>
              <span className="ml-auto shrink-0 text-faint">{showHistory ? 'Hide history' : `History (${m.history.length})`}</span>
            </button>
            {showHistory && (
              <ul className="list-none m-0 mt-1 p-0 divide-y divide-border">
                {m.history.slice(0, 8).map((h, i) => (
                  <li key={i} className="grid sm:grid-cols-[130px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 py-2 text-[13px] text-text items-center">
                    <span>{stamp(h.at)}</span><span className="min-w-0 truncate"><b className="font-medium text-fg">{h.by || 'Unknown'}</b> set it to {PLAIN[h.to] || String(h.to)}</span><span className="text-faint">{PLAIN[h.from] || String(h.from)} → {PLAIN[h.to] || String(h.to)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Modal isOpen={dialog === 'start'} onClose={() => !busy && setDialog(null)} icon={Bot} title="Turn on the Master Agent?" subtitle="It starts with a safe start: it only plans and records." maxWidth="max-w-[520px]"
        footer={<><Button variant="light" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => apply('shadow')} disabled={busy}>{busy ? 'Turning on…' : 'Turn on'}</Button></>}>
        <div className="space-y-3 text-[13.5px] leading-5 text-text">
          <div><h4 className="text-[11px] font-semibold uppercase tracking-[.05em] text-faint mb-1">What happens</h4><ul className="list-disc pl-5 space-y-1"><li>Each morning it plans the day for every connected project and records what it would run and how long that would take.</li><li>You can compare its plan with the existing daily run on this page.</li><li>After 3 clean days you decide whether to take it live.</li></ul></div>
          <div><h4 className="text-[11px] font-semibold uppercase tracking-[.05em] text-faint mb-1">What does not happen</h4><ul className="list-disc pl-5 space-y-1"><li>No project is run, changed or provisioned by it.</li><li>The existing daily run stays the only scheduler.</li></ul></div>
          <p className="rounded-[10px] px-3 py-2.5 text-[13px]" style={{ background: '#fdf3e1', boxShadow: 'inset 0 0 0 1px #f1dcae', color: '#7a5b00' }}>Takes effect within a minute. You can turn it off at any time, and it is recorded who changed it and when.</p>
          {error && <p className="text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</p>}
        </div>
      </Modal>
      <Modal isOpen={dialog === 'live'} onClose={() => !busy && setDialog(null)} icon={ShieldCheck} title="Take the Master Agent live?" subtitle="This changes how the daily work runs for every project." maxWidth="max-w-[520px]"
        footer={<><Button variant="light" onClick={() => { setDialog(null); setAck(false); }} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => apply('on')} disabled={busy || !ack}>{busy ? 'Going live…' : 'Go live'}</Button></>}>
        <div className="space-y-3 text-[13.5px] leading-5 text-text">
          <div><h4 className="text-[11px] font-semibold uppercase tracking-[.05em] text-faint mb-1">What happens</h4><ul className="list-disc pl-5 space-y-1"><li>New projects are set up by the Agent Factory as soon as they are created.</li><li>The daily work for every connected project runs from a queue, in this order: never-succeeded first, then longest wait.</li><li>The 07:00 run skips its own detection step and the queue starts earlier, at 05:00.</li><li>From this moment, a project that is onboarded gets its first baseline started automatically, up to {m.autoBaseline?.cap ?? 3} a day. Projects that already exist keep starting theirs by hand, as today.</li></ul></div>
          <p className="rounded-[10px] px-3 py-2.5 text-[13px]" style={{ background: '#fdf3e1', boxShadow: 'inset 0 0 0 1px #f1dcae', color: '#7a5b00' }}><b>Not yet proven on real clients.</b> Watch the first day. Going back to safe start stops new jobs; a job already running finishes.</p>
          <label className="flex items-start gap-2.5 text-fg cursor-pointer"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />I have compared the safe-start plan with the existing run and I want to take it live.</label>
          {error && <p className="text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</p>}
        </div>
      </Modal>
    </div>
  );
}
