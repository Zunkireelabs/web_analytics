import { useEffect, useState } from 'react';
import { Target, Users, HandCoins, TrendingUp, CheckCircle2, Eye, ShieldAlert } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import KpiCard from '../components/KpiCard.jsx';

// Universal Product Growth mode's one new nav page (Sidebar.jsx's
// DEMAND_NAV_ITEM, shown only for a 'product' property). Deliberately
// generic — no funnel stage name here is Zenly-specific, and status is
// whatever free-text lifecycle the CRM/discovery agent actually set
// (server/store/prospects.js), not a fixed "booked demo" funnel.
//
// Approving a prospect here is the human-approval gate the Product Growth
// spec requires (server/routes/demand.js) — nothing is ever sent to the CRM
// automatically.
const CONFIDENCE_PILLS = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  medium: 'bg-amber-50 text-amber-700 border-amber-100',
  low: 'bg-slate-100 text-slate-500 border-slate-200',
};

// Classification pills for "see it live" trial signups
// (server/routes/trial-signup.js) — 'competitor_suspect' is real evidence
// to review, never an auto-block; a site owner blocks manually elsewhere.
const CLASSIFICATION_PILLS = {
  prospect: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  competitor_suspect: 'bg-rose-50 text-rose-700 border-rose-100',
  unclassified: 'bg-slate-100 text-slate-500 border-slate-200',
};

export default function Demand({ siteId }) {
  const [prospects, setProspects] = useState(null); // null = loading
  const [approving, setApproving] = useState({}); // {[id]: true}
  const [trialSignups, setTrialSignups] = useState(null); // null = loading

  const load = () => api.demand.prospects().then(setProspects).catch(() => setProspects([]));
  useEffect(() => {
    if (!siteId) return;
    load();
    api.demand.trialSignups().then(setTrialSignups).catch(() => setTrialSignups([]));
  }, [siteId]);

  const approve = async (id) => {
    setApproving((a) => ({ ...a, [id]: true }));
    try {
      await api.demand.approve(id);
      await load();
    } finally {
      setApproving((a) => ({ ...a, [id]: false }));
    }
  };

  const list = prospects || [];
  const kpis = {
    identified: list.length,
    approved: list.filter((p) => p.approvedForCrm).length,
    sentToCrm: list.filter((p) => p.crmSyncedAt).length,
    converted: list.filter((p) => p.status === 'converted').length,
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <PageHeader
        title="Demand"
        icon={<Target size={20} />}
        subtitle="Prospects discovered, qualified, and handed to your CRM — with outcomes measured back."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Users} iconBg="rgba(108,99,255,0.08)" iconColor="#6C63FF" label="Prospects Identified" value={prospects === null ? '—' : kpis.identified} />
        <KpiCard icon={CheckCircle2} iconBg="rgba(16,185,129,0.08)" iconColor="#10b981" label="Approved for CRM" value={prospects === null ? '—' : kpis.approved} />
        <KpiCard icon={HandCoins} iconBg="rgba(245,158,11,0.08)" iconColor="#f59e0b" label="Sent to CRM" value={prospects === null ? '—' : kpis.sentToCrm} />
        <KpiCard icon={TrendingUp} iconBg="rgba(236,72,153,0.08)" iconColor="#ec4899" label="Converted" value={prospects === null ? '—' : kpis.converted} />
      </div>

      {prospects === null ? (
        <p className="text-xs text-slate-400 font-semibold px-1">Loading…</p>
      ) : list.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <p className="text-sm font-black text-slate-800">No prospects yet</p>
          <p className="text-xs font-semibold text-slate-400 max-w-md mx-auto leading-relaxed">
            Prospect discovery hasn't found any evidence-backed candidates yet, or hasn't been enabled for this site
            (Clients &rarr; this site &rarr; Product Growth tab). Nothing here is ever estimated or fabricated — a
            prospect only appears once its own real page content confirms a configured ICP signal.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Company', 'Industry / Market', 'Confidence', 'Status', 'Discovered', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-[9px] font-black uppercase tracking-widest text-slate-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} className="border-b border-slate-50 last:border-b-0" style={{ height: '56px' }}>
                    <td className="px-4 py-2">
                      <p className="text-xs font-bold text-slate-800">{p.companyName}</p>
                      <p className="text-[10px] text-slate-400 font-semibold truncate max-w-xs" title={p.qualificationReason}>{p.qualificationReason}</p>
                    </td>
                    <td className="px-4 py-2">
                      <p className="text-xs font-semibold text-slate-600">{p.industry || '—'}</p>
                      <p className="text-[10px] text-slate-400">{p.market || '—'}</p>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${CONFIDENCE_PILLS[p.confidence] || CONFIDENCE_PILLS.low}`}>{p.confidence}</span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">{p.status}</span>
                    </td>
                    <td className="px-4 py-2 text-[10px] text-slate-400 font-semibold">{timeAgo(p.createdAt)}</td>
                    <td className="px-4 py-2 text-right">
                      {p.approvedForCrm ? (
                        <span className="text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100">
                          {p.crmSyncedAt ? 'Sent to CRM' : 'Approved'}
                        </span>
                      ) : (
                        <button type="button" onClick={() => approve(p.id)} disabled={approving[p.id]}
                          className="text-[9.5px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 transition disabled:opacity-60">
                          {approving[p.id] ? 'Approving…' : 'Approve for CRM'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <Eye size={14} className="text-slate-400" />
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-400">"See It Live" Trial Signups</h2>
        </div>
        {trialSignups === null ? (
          <p className="text-xs text-slate-400 font-semibold px-1">Loading…</p>
        ) : trialSignups.length === 0 ? (
          <div className="card p-8 text-center space-y-2">
            <p className="text-sm font-black text-slate-800">No trial signups yet</p>
            <p className="text-xs font-semibold text-slate-400 max-w-md mx-auto leading-relaxed">
              Once your trial/sandbox login reports signups here (Clients &rarr; this site &rarr; Product Growth
              tab for the webhook token), each one is checked against your real tracked competitors and configured
              competitor-signal phrases — never blocked automatically, just flagged for you to review.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100">
                    {['Company', 'Email', 'Classification', 'Evidence', 'Signed up'].map((h) => (
                      <th key={h} className="px-4 py-3 text-[9px] font-black uppercase tracking-widest text-slate-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trialSignups.map((s) => (
                    <tr key={s.id} className="border-b border-slate-50 last:border-b-0" style={{ height: '56px' }}>
                      <td className="px-4 py-2">
                        <p className="text-xs font-bold text-slate-800">{s.companyName || s.companyDomain || '—'}</p>
                        <p className="text-[10px] text-slate-400 font-mono">{s.companyDomain || '—'}</p>
                      </td>
                      <td className="px-4 py-2 text-xs font-semibold text-slate-600">{s.email || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border flex items-center gap-1 w-fit ${CLASSIFICATION_PILLS[s.classification] || CLASSIFICATION_PILLS.unclassified}`}>
                          {s.classification === 'competitor_suspect' && <ShieldAlert size={9} />}
                          {s.classification.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[10px] text-slate-400 font-semibold max-w-xs truncate" title={JSON.stringify(s.classificationEvidence)}>
                        {s.classificationEvidence?.matchedPhrase || s.classificationEvidence?.domain || s.classificationEvidence?.matchType || '—'}
                      </td>
                      <td className="px-4 py-2 text-[10px] text-slate-400 font-semibold">{timeAgo(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
