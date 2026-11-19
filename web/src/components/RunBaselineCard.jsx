import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Play, PlugZap } from 'lucide-react';
import Button from './Button.jsx';
import { api } from '../api.js';

// Shown on Reports → Baseline when the project has no baseline yet. Setup used to start the baseline by itself on its
// last step, but a project whose setup finished later (or whose first try failed) never got one, and nothing on the
// page let anyone start it. The first baseline belongs to setting the project up, so a project admin may start it
// here; the server holds one lock per project, so a second click or a second tab follows the run instead.
//
// What the viewer sees comes from GET /projects/:id/baseline: running (follow it), idle with Google connected (Run
// baseline), idle without Google (finish setup first). A member who cannot run it gets the plain message only.
export default function RunBaselineCard({ siteId, message, onDone }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);   // null = loading | { status, state } | { denied: true }
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const read = () => api.project.baselineStatus(siteId)
    .then((r) => { if (live.current) setStatus(r); return r; })
    .catch(() => { if (live.current) setStatus({ denied: true }); return null; });
  useEffect(() => { if (siteId) read(); else setStatus({ denied: true }); }, [siteId]);

  // While it runs, check every few seconds; once it is done, the page reloads itself with the real report.
  useEffect(() => {
    if (status?.status !== 'running') return;
    const id = setInterval(async () => {
      const r = await read();
      if (r?.status === 'done') { clearInterval(id); onDone?.(); }
    }, 5000);
    return () => clearInterval(id);
  }, [status?.status]);
  useEffect(() => { if (status?.status === 'done') onDone?.(); }, [status?.status]);

  const start = async () => {
    setStarting(true); setError(null);
    // The request runs the whole baseline before it answers (minutes), so it is not waited on: the screen follows the
    // run through the status call instead. A refusal (Google not connected, no permission) comes back fast and shows.
    api.project.baseline(siteId)
      .then(() => read())
      .catch((err) => {
        if (!live.current) return;
        if (/timed out/i.test(err?.message || '')) return; // still running on the server; the status poll follows it
        setError(err?.message || 'The baseline could not start. Try again.');
        read();
      })
      .finally(() => { if (live.current) setStarting(false); });
    await new Promise((r) => setTimeout(r, 1500));
    if (live.current) await read();
  };

  const running = status?.status === 'running';
  const canRun = status && !status.denied && status.status === 'idle';
  const googleOk = Boolean(status?.state?.google?.connected);

  let text = message;
  if (running) text = 'Your baseline is being built. It reads your data and your site, and takes a few minutes. This page updates when it is ready.';
  else if (canRun && googleOk) text = 'This project has no baseline yet. The baseline records where the site stands today, so later progress can be measured against it.';
  else if (canRun && !googleOk) text = 'Connect Google Search Console and Analytics first. The baseline is built from their real data.';

  return (
    <div className="tray"><div className="tray-card px-4 py-10 text-center space-y-3">
      <p className="text-sm text-text max-w-[520px] mx-auto">{text}</p>
      {running && (
        <p className="inline-flex items-center gap-2 text-[13px] text-faint"><Loader2 size={14} className="animate-spin" /> Building your baseline…</p>
      )}
      {canRun && googleOk && (
        <Button write variant="primary" size="sm" onClick={start} disabled={starting}>
          {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run baseline
        </Button>
      )}
      {canRun && !googleOk && (
        <Button variant="primary" size="sm" onClick={() => navigate(`/workspace?finish=${siteId}`)}>
          <PlugZap size={14} /> Finish setup
        </Button>
      )}
      {error && <p className="text-[13px] text-[#b42318]">{error}</p>}
    </div></div>
  );
}
