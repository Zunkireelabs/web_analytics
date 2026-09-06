import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import AccountCard from '../components/AccountCard.jsx';
import SecurityCard from '../components/SecurityCard.jsx';
import McpTokensCard from '../components/McpTokensCard.jsx';
import TeamCard from '../components/TeamCard.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

export default function Settings() {
  const [email, setEmail] = useState(null);
  const [role, setRole] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    Promise.all([api.me(), api.sites().catch(() => [])])
      .then(([me, sites]) => {
        setEmail(me.email);
        setRole(me.role);
        setWorkspace(sites?.[0]?.name || null);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6 relative font-sans fade-up">
      {error && (
        <div className="card p-4 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 text-center">
          Unable to load account details right now — try refreshing.
        </div>
      )}

      <PageHeader
        title="Settings"
        subtitle="Account & security"
        icon="⚙️"
        right={!loading && (
          <div className="flex items-center gap-1.5">
            <RoleBadge role={role} tone="brand" />
            {workspace && (
              <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">
                {workspace}
              </span>
            )}
          </div>
        )}
      />

      {/* 2-column enterprise settings grid. Rows pair related cards; new
          sections (2FA, Connected Apps, Activity History, Active Sessions —
          none have backend support yet) drop in as additional rows here
          without any layout rework. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <AccountCard email={email} role={role} workspace={workspace} loading={loading} />
        <SecurityCard />

        {!loading && <TeamCard role={role} />}
        <McpTokensCard />
      </div>
    </div>
  );
}
