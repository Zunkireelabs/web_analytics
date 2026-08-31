import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';

// The design-integrity gate's review screen (design-integrity-gate
// proposal, change 03): every section the design agent found on this site's
// real pages, every template it would write in the site's own style, and
// the role-verification verdict behind each — read entirely from
// server/agents/lib/design-review.js's buildDesignReviewReport. Approving
// here is what server/db.js's updateSiteDesignReview records, which is what
// validateAutoRemediationRequest (routes/clients.js) then requires before
// this site's agents may open a single pull request.

const ACTION_TYPE_LABEL = {
  faq: 'FAQ accordion', 'qa-content': 'Inline Q&A', 'expand-content': 'Expanded content section',
  'internal-links': 'Related links list', 'content-wrapper': 'New page / long-form content',
};

function Pill({ tone, children }) {
  const tones = {
    good: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    warn: 'bg-amber-50 text-amber-700 border-amber-100',
    bad: 'bg-rose-50 text-rose-700 border-rose-100',
    neutral: 'bg-slate-100 text-slate-500 border-slate-200',
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full border ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ReviewStateBanner({ reviewState, reviewedAt }) {
  if (reviewState.ok) {
    return (
      <div className="card p-4 flex items-center gap-3 bg-emerald-50/60 border-emerald-100">
        <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
        <div className="text-xs font-semibold text-emerald-800">
          Design reviewed and approved{reviewedAt ? ` on ${new Date(reviewedAt).toLocaleDateString()}` : ''}. Autonomous fixes may ship styled markup for this site.
        </div>
      </div>
    );
  }
  if (reviewState.reason === 'stale') {
    return (
      <div className="card p-4 flex items-center gap-3 bg-amber-50/60 border-amber-100">
        <AlertTriangle size={18} className="text-amber-600 shrink-0" />
        <div className="text-xs font-semibold text-amber-800">
          This site's design was re-analyzed since it was last approved. Autonomous fixes are paused for this site until it is reviewed again.
        </div>
      </div>
    );
  }
  return (
    <div className="card p-4 flex items-center gap-3 bg-slate-50 border-slate-200">
      <HelpCircle size={18} className="text-slate-500 shrink-0" />
      <div className="text-xs font-semibold text-slate-600">
        This site's design has never been reviewed. Autonomous fixes cannot ship styled markup until it is.
      </div>
    </div>
  );
}

function RoleCheckRow({ check }) {
  const tone = check.reason === 'role-mismatch' ? 'bad' : check.ok ? 'good' : 'warn';
  const label = check.reason === 'role-mismatch' ? 'Wrong role' : check.ok ? 'Verified' : check.reason === 'not-set' ? 'Not used' : 'No evidence yet';
  return (
    <div className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
      <Pill tone={tone}>{label}</Pill>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold text-slate-700 font-mono">{check.field}</div>
        {check.classes && <div className="text-[11px] text-slate-500 font-mono break-all mt-0.5">{check.classes}</div>}
        {check.error && <div className="text-xs text-rose-600 mt-1">{check.error}</div>}
        {check.example && (
          <div className="text-[11px] text-slate-400 mt-1">
            Real example: <span className="font-semibold text-slate-500">{check.example.itemRole}</span> on{' '}
            <span className="font-mono">{check.example.page}</span> (in a <span className="font-semibold">{check.example.sectionRole}</span> section)
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateCard({ template }) {
  const tone = template.ok === null ? 'neutral' : template.ok ? 'good' : 'bad';
  const label = !template.available ? 'Not available for this site' : template.ok === null ? 'No role check applies' : template.ok ? 'Passes role check' : 'Confirmed role mismatch';
  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-extrabold text-slate-900">{ACTION_TYPE_LABEL[template.actionType] || template.actionType}</div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {template.sample && (
        <pre className="text-[11px] leading-relaxed bg-slate-50 border border-slate-100 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-slate-600">
          {template.sample}
        </pre>
      )}
      {template.roleChecks.length > 0 && (
        <div className="pt-1">
          {template.roleChecks.map((check) => <RoleCheckRow key={check.field} check={check} />)}
        </div>
      )}
    </div>
  );
}

function SectionInventory({ sections }) {
  const pageTypes = Object.keys(sections);
  if (!pageTypes.length) return null;
  return (
    <div className="space-y-6">
      {pageTypes.map((pageType) => (
        <div key={pageType} className="card p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">{pageType}</div>
          <div className="space-y-4">
            {sections[pageType].map((page) => (
              <div key={page.url}>
                <div className="text-[11px] font-mono text-slate-500 mb-2 break-all">{page.url}</div>
                <div className="flex flex-wrap gap-1.5">
                  {page.sections.map((s, i) => (
                    <span key={i} className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-100 text-slate-600" title={`${s.width} · ${s.alignment}`}>
                      {s.role}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DesignReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [approving, setApproving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.clients.designReview(id)
      .then(setReport)
      .catch((e) => setError(e.message || 'Could not load the design review.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const approve = async () => {
    setApproving(true);
    setError(null);
    try {
      setReport(await api.clients.approveDesignReview(id));
    } catch (e) {
      setError(e.message || 'Approval failed.');
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6 relative font-sans fade-up">
      <button
        onClick={() => navigate('/clients')}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors"
      >
        <ArrowLeft size={13} /> Back to Clients
      </button>

      <PageHeader
        title="Design Review"
        subtitle={report?.site?.name || `Site #${id}`}
        icon="🎨"
        right={report?.hasProfile && (
          <button
            onClick={approve}
            disabled={approving || report.reviewState.ok}
            className="text-xs font-bold px-4 py-2.5 rounded-xl bg-[#6C63FF] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
          >
            {approving ? 'Approving…' : report.reviewState.ok ? 'Approved' : 'Approve current design'}
          </button>
        )}
      />

      {error && (
        <div className="card p-4 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs font-semibold text-slate-400 py-12 text-center">Loading…</div>
      ) : !report?.hasProfile ? (
        <div className="card p-8 flex flex-col items-center gap-3 text-center">
          <XCircle size={28} className="text-slate-300" />
          <div className="text-sm font-bold text-slate-600">No design profile yet</div>
          <div className="text-xs text-slate-400 max-w-sm">
            The design agent hasn't analyzed this site's live pages yet, or the analysis hasn't finished. Nothing can be approved until it has.
          </div>
        </div>
      ) : (
        <>
          <ReviewStateBanner reviewState={report.reviewState} reviewedAt={report.reviewedAt} />

          <div>
            <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">What we will write, in this site's style</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {report.templates.map((t) => <TemplateCard key={t.actionType} template={t} />)}
            </div>
          </div>

          <div>
            <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">What we found on your site</h2>
            <SectionInventory sections={report.sections} />
          </div>
        </>
      )}
    </div>
  );
}
