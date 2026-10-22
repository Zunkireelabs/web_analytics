import { User } from 'lucide-react';
import RoleBadge from './RoleBadge.jsx';
import SettingsCard, { SettingsRows } from './settings/SettingsCard.jsx';

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
        <SettingsRows rows={[['Email', email || '—'], ['Role', <RoleBadge key="role" role={role} tone="brand" />]]} />
      )}
    </SettingsCard>
  );
}
