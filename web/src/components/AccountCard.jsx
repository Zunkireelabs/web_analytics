import { User } from 'lucide-react';
import RoleBadge from './RoleBadge.jsx';
import SettingsCard from './settings/SettingsCard.jsx';

// Read-only profile summary. There's no separate profile-edit capability
// anywhere in this app (no name field, no editable-profile endpoint) — this
// card only ever reflects what /me already returns. `workspace` is still
// accepted (Settings.jsx passes it) but no longer shown: the workspace lives
// in the in-app Settings now.
export default function AccountCard({ email, role, loading }) {
  return (
    <SettingsCard icon={User} title="Profile" description="Who you are signed in as">
      {loading ? (
        <div className="px-5 py-4 space-y-2">
          <div className="h-4 bg-muted rounded-control animate-pulse w-1/2" />
          <div className="h-4 bg-muted rounded-control animate-pulse w-1/3" />
        </div>
      ) : (
        <div className="px-5 py-4 flex flex-wrap items-center gap-3.5">
          <span className="w-11 h-11 rounded-full bg-fg text-white grid place-items-center text-[17px] font-semibold shrink-0 uppercase" aria-hidden="true">{(email || '?')[0]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-fg truncate">{email || '—'}</div>
            <div className="text-[13px] text-faint mt-0.5">Signed in on this device</div>
          </div>
          <RoleBadge role={role} tone="brand" />
        </div>
      )}
    </SettingsCard>
  );
}
