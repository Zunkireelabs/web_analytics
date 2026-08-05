// Initials avatar derived from an email — this app has no display-name field
// anywhere in the user model, so email is the only real identity to draw from.
function initialsFromEmail(email) {
  if (!email) return '?';
  const local = email.split('@')[0] || '';
  const parts = local.split(/[.\-_+]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || '?';
}

const SIZES = {
  sm: { box: 'w-7 h-7', text: 'text-[10px]' },
  md: { box: 'w-10 h-10', text: 'text-xs' },
  lg: { box: 'w-14 h-14', text: 'text-base' },
};

export default function Avatar({ email, size = 'sm' }) {
  const s = SIZES[size] || SIZES.sm;
  return (
    <div
      className={`${s.box} ${s.text} rounded-full grid place-items-center font-black text-white shrink-0`}
      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
      title={email}
    >
      {initialsFromEmail(email)}
    </div>
  );
}
