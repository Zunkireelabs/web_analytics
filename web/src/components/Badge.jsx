export default function Badge({ tone = 'grey', dot = false, className = '', children, ...props }) {
  return (
    <span className={`badge badge--${tone} ${className}`.trim()} {...props}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}
