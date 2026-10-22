// SuperRank flame mark, optionally followed by the "super rank" wordmark (text,
// styled by .logo in index.css, as on the marketing site).
export default function Logo({ size = 22, wordmark = false }) {
  const icon = (
    <img src={`${import.meta.env.BASE_URL}logo.png`} width={size} height={size} alt=""
      className="logo__icon" style={{ display: 'block', width: size, height: size, objectFit: 'contain' }} />
  );
  if (!wordmark) return icon;
  return <span className="logo" aria-label="SuperRank">{icon}<span>super<b>rank</b></span></span>;
}
