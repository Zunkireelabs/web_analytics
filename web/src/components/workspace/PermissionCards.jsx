import ChoiceCard from './ChoiceCard.jsx';
import { PERMISSIONS, SCOPED_PERMISSIONS } from '../../lib/workspace.js';

// Owner / Admin / Read-only as three plain-language cards. Owner is only offered
// to someone who can grant it (an owner or the platform admin).
export default function PermissionCards({ value, onChange, withOwner = false, scoped = false }) {
  const table = scoped ? { ...PERMISSIONS, ...SCOPED_PERMISSIONS } : PERMISSIONS;
  const keys = ['owner', 'admin', 'member'].filter((k) => k !== 'owner' || (withOwner && !scoped));
  return (
    <div role="radiogroup" aria-label="What can they do?" className="space-y-2">
      {keys.map((k) => (
        <ChoiceCard key={k} selected={value === k} onSelect={() => onChange(k)}
          title={table[k].label} description={table[k].description} />
      ))}
    </div>
  );
}
