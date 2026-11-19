import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Play } from 'lucide-react';
import Button from './Button.jsx';
import { api } from '../api.js';

// Staff only. Shown above a baseline report that was frozen before the audit crawl finished or before the AI visibility check
// ran (lib/baseline-gaps.js). Two different actions, because they cost different things:
//
//   Regenerate   rebuilds the report from what the platform holds NOW (one narrative call, no analysis agents). The right
//                click when the audit or the AI check has since finished and only the frozen report is stale.
//   Re-run       runs the whole baseline again: every analysis agent, so real money per click (the server keeps this with
//                staff for that reason). Needed when the data itself was never collected. Asks first.
export default function IncompleteBaselineBanner({ gaps, siteId, onChanged }) {
  const [busy, setBusy] = useState(null);      // null | 'regen' | 'run'
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // While a re-run is going, follow it through the status call; when it stops, reload the report.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      try {
        const r = await api.project.baselineStatus(siteId);
        if (live.current && r.status !== 'running') { clearInterval(id); setRunning(false); onChanged?.(); }
      } catch { /* keep following */ }
    }, 5000);
    return () => clearInterval(id);
  }, [running, siteId]);

  const regenerate = async () => {
    setBusy('regen'); setError(null);
    try { await api.generateBaselineReport(siteId); onChanged?.(); }
    catch (err) { if (live.current) setError(err?.message || 'The report could not be regenerated.'); }
    finally { if (live.current) setBusy(null); }
  };

  const rerun = async () => {
    if (!window.confirm('Re-run the whole baseline? It runs every analysis agent again and costs real money each time.')) return;
    setBusy('run'); setError(null);
    // The request answers only when the baseline is finished (minutes), so it is not waited on: the status poll follows it.
    api.project.baseline(siteId).catch((err) => {
      if (!live.current || /timed out/i.test(err?.message || '')) return;
      setError(err?.message || 'The baseline could not start.'); setRunning(false);
    });
    await new Promise((r) => setTimeout(r, 1500));
    if (live.current) { setRunning(true); setBusy(null); }
  };

  return (
    <div className="tray mb-3"><div className="tray-card px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
      <p className="text-[13px] text-text max-w-[640px]">
        This baseline is incomplete: {gaps.map((g) => g.label).join(', and ')} when it was built. Staff only.
      </p>
      {running ? (
        <span className="inline-flex items-center gap-2 text-[13px] text-faint"><Loader2 size={14} className="animate-spin" /> Re-running the baseline…</span>
      ) : (
        <div className="flex gap-2">
          <Button write variant="light" size="sm" onClick={regenerate} disabled={busy !== null}>
            {busy === 'regen' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Regenerate from current data
          </Button>
          <Button write variant="primary" size="sm" onClick={rerun} disabled={busy !== null}>
            {busy === 'run' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Re-run baseline
          </Button>
        </div>
      )}
      {error && <p className="w-full text-[13px] text-[#b42318]">{error}</p>}
    </div></div>
  );
}
