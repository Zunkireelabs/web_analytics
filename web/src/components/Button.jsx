import { useReadOnly, READ_ONLY_HINT } from '../lib/access.jsx';

// `write` marks a button that changes something. For a read-only member it renders disabled with a
// reason, instead of being offered and failing. The server enforces this regardless.
export default function Button({ variant = 'light', size = 'md', icon = false, className = '', type = 'button', write = false, disabled, title, ...props }) {
  const readOnly = useReadOnly();
  const locked = write && readOnly;
  return (
    <button
      type={type}
      className={['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, icon && 'btn--icon', className].filter(Boolean).join(' ')}
      disabled={locked || disabled}
      title={locked ? READ_ONLY_HINT : title}
      {...props}
    />
  );
}
