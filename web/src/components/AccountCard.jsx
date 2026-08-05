import { User } from 'lucide-react';
import Avatar from './Avatar.jsx';
import RoleBadge from './RoleBadge.jsx';

// Read-only profile summary. There's no separate profile-edit capability
// anywhere in this app (no name field, no editable-profile endpoint) — this
// card only ever reflects what /me and /sites already return.
export default function AccountCard({ email, role, workspace, loading }) {
  return (
    <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-6">
      <h2 className="text-sm font-black text-slate-900 mb-4 flex items-center gap-2">
        <User size={15} className="text-[#6C63FF]" /> Account
      </h2>

      {loading ? (
        <p className="text-xs text-slate-400 font-semibold">Loading…</p>
      ) : (
        <div className="flex items-center gap-3.5">
          <Avatar email={email} size="lg" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-bold text-slate-800 truncate">{email || '—'}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <RoleBadge role={role} tone="brand" />
              {workspace && (
                <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">
                  {workspace}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
