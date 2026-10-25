export default function Card({ as: Tag = 'div', className = '', ...props }) {
  return <Tag className={`card ${className}`.trim()} {...props} />;
}
