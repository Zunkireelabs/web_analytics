import { Sparkles } from 'lucide-react';
import MarkdownReport from './MarkdownReport.jsx';
import Section from './layout/Section.jsx';
import Button from './Button.jsx';
import { api } from '../api.js';

// The client-facing "day 0" document (server/agents/lib/baseline-report.js) —
// what the site's KPIs and issues looked like at onboarding, so later
// Milestones progress can be shown as a real before/after story. Reuses MarkdownReport.jsx since the narrative is
// already a clean markdown document. Downloading is the page toolbar's job, not this card's.
//
// isInternal + siteId: only a staff Milestones view can trigger generation
// for a site that doesn't have one yet (pre-existing client, or a failed
// first attempt) — a regular client just sees the honest "not ready yet"
// message, same as the empty state elsewhere on this page.
export default function BaselineReportCard({ report, siteId, isInternal, onGenerated }) {
  if (report === null) return null; // still loading — let the page's own loading state cover this

  return (
    // No download buttons here on purpose: the page toolbar above this card already carries "Download PDF" for the
    // baseline, so a second pair in the card header was the same action offered twice, a few centimetres apart.
    <Section tray title="Your baseline report" subtitle="Where the site stood at onboarding">
      {report.available ? (
        <MarkdownReport bare content={report.narrativeMd} />
      ) : (
        <div className="px-4 py-8 text-center space-y-3 border-t border-border">
          <p className="text-sm text-text">{report.message}</p>
          {isInternal && siteId && (
            <Button write variant="light" size="sm" onClick={() => api.generateBaselineReport(siteId).then(onGenerated).catch(() => {})}>
              <Sparkles size={14} /> Generate Now
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}
