export default function PageIntro({ title, subtitle, children }) {
  return (
    <div className="mb-6">
      <h1 className="text-[26px] leading-8 md:text-[30px] md:leading-9 font-medium tracking-[-0.03em] text-fg">{title}</h1>
      {subtitle && <p className="mt-1.5 text-[15px] text-text">{subtitle}</p>}
      {children}
    </div>
  );
}
