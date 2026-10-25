export default function Select({ label, hint, error, className = '', children, ...props }) {
  return (
    <label className={`fld ${className}`.trim()}>
      {label && <span className="fld__label">{label}</span>}
      <select className={error ? 'is-bad' : undefined} aria-invalid={error ? true : undefined} {...props}>{children}</select>
      {error ? <span className="fld__err">{error}</span> : hint && <span className="fld__hint">{hint}</span>}
    </label>
  );
}
