import { FileDown, Sparkles } from 'lucide-react';
import MarkdownReport from './MarkdownReport.jsx';
import { api } from '../api.js';

// The client-facing "day 0" document (server/agents/lib/baseline-report.js) —
// what the site's KPIs and issues looked like at onboarding, so later
// Milestones progress can be shown as a real before/after story. Reuses
// MarkdownReport.jsx (previously only used for the GEO Audit generator's
// output) since the narrative is already a clean markdown document.
//
// isInternal + siteId: only a staff Milestones view can trigger generation
// for a site that doesn't have one yet (pre-existing client, or a failed
// first attempt) — a regular client just sees the honest "not ready yet"
// message, same as the empty state elsewhere on this page.
export default function BaselineReportCard({ report, siteId, isInternal, onGenerated }) {
  if (report === null) return null; // still loading — let the page's own loading state cover this

  const downloadUrl = api.baselineReportDownloadUrl(isInternal ? siteId : undefined);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Your Baseline Report</h2>
        </div>
        {report.available && (
          <a href={downloadUrl}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-xl px-3 py-1.5 shadow-sm transition">
            <FileDown size={13} /> Download PDF
          </a>
        )}
      </div>

      {report.available ? (
        <MarkdownReport content={report.narrativeMd} />
      ) : (
        <div className="card p-8 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-700">{report.message}</p>
          {isInternal && siteId && (
            <button onClick={() => api.generateBaselineReport(siteId).then(onGenerated).catch(() => {})}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl px-3.5 py-2 shadow-sm transition">
              <Sparkles size={13} /> Generate Now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
