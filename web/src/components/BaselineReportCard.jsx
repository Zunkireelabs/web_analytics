import { FileDown, Sparkles } from 'lucide-react';
import MarkdownReport from './MarkdownReport.jsx';
import Section from './layout/Section.jsx';
import Button from './Button.jsx';
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
    <Section label="Baseline" title="Your baseline report" subtitle="Where the site stood at onboarding"
      action={report.available && (
        <a href={downloadUrl} className="btn btn--light">
          <FileDown size={14} /> Download PDF
        </a>
      )}>
      {report.available ? (
        <MarkdownReport content={report.narrativeMd} />
      ) : (
        <div className="card px-4 py-8 text-center space-y-3">
          <p className="text-sm text-text">{report.message}</p>
          {isInternal && siteId && (
            <Button variant="light" size="sm" onClick={() => api.generateBaselineReport(siteId).then(onGenerated).catch(() => {})}>
              <Sparkles size={14} /> Generate Now
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}
