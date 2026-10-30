// The top of a client's report, in that client's own brand: their colour as the band, their logo and name, the kind of
// report and its period. The colour (and what is readable on it) comes from the server, see server/report/brand.js:
// a light brand colour gets dark text on its band instead of unreadable white.
export default function ReportBand({ brand, kind, period, sub = 'Search and AI visibility' }) {
  if (!brand) return <div className="h-[68px] rounded-card bg-muted animate-pulse" aria-hidden="true" />;
  const on = brand.onColor || '#ffffff';
  return (
    <div className="tray"><div className="tray-card overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4" style={{ background: brand.color, color: on, WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
        <span className="grid place-items-center shrink-0 overflow-hidden" style={{ height: 38, minWidth: 38, padding: brand.logoDataUrl ? '0 7px' : 0, borderRadius: 9, background: brand.logoDataUrl ? '#fff' : 'rgba(255,255,255,.2)' }}>
          {brand.logoDataUrl
            ? <img src={brand.logoDataUrl} alt="" style={{ height: 24, width: 'auto', maxWidth: 140, display: 'block' }} />
            : <span style={{ fontSize: 15, fontWeight: 700 }}>{(brand.name || '?').trim().charAt(0).toUpperCase()}</span>}
        </span>
        <div className="min-w-0">
          <div className="truncate" style={{ fontSize: 15, fontWeight: 600, lineHeight: '19px' }}>{brand.name}</div>
          <div className="truncate" style={{ fontSize: 12, opacity: 0.8 }}>{brand.website || sub}</div>
        </div>
        <div className="ml-auto text-right shrink-0">
          <div style={{ fontSize: 11, opacity: 0.8, lineHeight: '15px' }}>{kind}</div>
          {period && <div style={{ fontSize: 13, fontWeight: 500 }}>{period}</div>}
        </div>
      </div>
    </div></div>
  );
}
