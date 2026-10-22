export default function Field({ label, hint, error, as: Tag = 'input', className = '', ...props }) {
  return (
    <label className={`fld ${className}`.trim()}>
      {label && <span className="fld__label">{label}</span>}
      <Tag className={error ? 'is-bad' : undefined} aria-invalid={error ? true : undefined} {...props} />
      {error ? <span className="fld__err">{error}</span> : hint && <span className="fld__hint">{hint}</span>}
    </label>
  );
}
