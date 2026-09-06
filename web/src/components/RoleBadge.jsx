// Shared role label map — mirrors the ROLE_LABELS duplicated in TeamCard.jsx
// and admin/Users.jsx (login.js's PLATFORM_ROLE_RANK / TENANT_ROLE_RANK).
export const ROLE_LABELS = {
  platform_admin: 'Platform Admin',
  tenant_admin: 'Tenant Admin',
  tenant_member: 'Tenant Member',
};

export default function RoleBadge({ role, tone = 'neutral' }) {
  const cls = tone === 'brand'
    ? 'bg-indigo-50 text-indigo-650'
    : 'bg-slate-100 text-slate-500';
  return (
    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md ${cls}`}>
      {ROLE_LABELS[role] || role || '—'}
    </span>
  );
}
