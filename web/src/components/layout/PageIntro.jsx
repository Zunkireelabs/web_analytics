export default function PageIntro({ title, subtitle, children }) {
  return (
    <div className="mb-5">
      <h1 className="text-[22px] leading-7 md:text-[24px] md:leading-[30px] font-semibold tracking-[-0.025em] text-fg">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-text">{subtitle}</p>}
      {children}
    </div>
  );
}
