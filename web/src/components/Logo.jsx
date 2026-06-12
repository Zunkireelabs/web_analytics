// Zunkiree Labs logo mark (red circle + white trend chart), no text, no box.
// Sourced from the official logo.svg in /public.
export default function Logo({ size = 26 }) {
  return (
    <img
      src="/logo.svg"
      width={size}
      height={size}
      alt="Zunkiree Labs"
      style={{ display: 'block' }}
    />
  );
}
