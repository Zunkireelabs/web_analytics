import Badge from './Badge.jsx';

// Shared role label map — mirrors the ROLE_LABELS duplicated in TeamCard.jsx
// and admin/Users.jsx (login.js's PLATFORM_ROLE_RANK / TENANT_ROLE_RANK).
export const ROLE_LABELS = {
  platform_admin: 'Platform Admin',
  tenant_admin: 'Tenant Admin',
  tenant_member: 'Tenant Member',
};

export default function RoleBadge({ role, tone = 'neutral' }) {
  return <Badge tone={tone === 'brand' ? 'primary' : 'grey'}>{ROLE_LABELS[role] || role || '—'}</Badge>;
}
