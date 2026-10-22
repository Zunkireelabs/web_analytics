export default function Button({ variant = 'light', size = 'md', icon = false, className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, icon && 'btn--icon', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}
