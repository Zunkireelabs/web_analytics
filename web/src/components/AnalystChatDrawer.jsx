import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import AdminAssistantPanel from './AdminAssistantPanel.jsx';

// "Ask the analyst" used to be a permanent sticky column, always taking a
// third of the page's width whether or not anyone was using it. Collapsed
// here into a floating trigger + slide-up drawer instead, so the content
// column (Growth Outlook, Keyword Opportunities, Impression Forecast) gets
// the full page width by default. The global client Assistant bubble
// (App.jsx's hideAssistant) is hidden on this route specifically so this is
// the only floating assistant trigger on the Analyst page — the staff-only
// AdminAssistantPanel, not the client-facing one.
export default function AnalystChatDrawer({ clientId, dashboard }) {
  const [open, setOpen] = useState(false);

  // Closing on client switch avoids one client's conversation staying open
  // (and visibly attached) while another client's data is on screen.
  useEffect(() => { setOpen(false); }, [clientId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Always shown while open, not just on mobile — the drawer's own
          background is solid, but the page behind it is a dense grid of
          cards; without a backdrop dimming ALL of it, card borders/text show
          through as ghosting right where the chat needs to be readable. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/20 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <div
        className={`fixed bottom-6 right-6 z-40 w-[calc(100vw-3rem)] max-w-[24rem] bg-white rounded-[20px] border border-slate-200 shadow-2xl flex flex-col overflow-hidden transition-all duration-200 origin-bottom-right ${
          open ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto' : 'opacity-0 scale-95 translate-y-3 pointer-events-none'
        }`}
        style={{ height: 'min(34rem, calc(100vh - 6rem))' }}
      >
        {open && <AdminAssistantPanel clientId={clientId} onClose={() => setOpen(false)} />}
      </div>

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 pl-3.5 pr-4 h-12 rounded-full text-white text-xs font-bold shadow-lg
                     hover:scale-105 transition-transform focus-visible:outline focus-visible:outline-2
                     focus-visible:outline-offset-2 focus-visible:outline-indigo-400 cursor-pointer"
          style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 8px 24px -4px rgba(99,102,241,0.5)' }}
        >
          <span className="w-6 h-6 rounded-full bg-white/20 grid place-items-center shrink-0">
            <Sparkles size={13} />
          </span>
          Ask the analyst
        </button>
      )}
    </>
  );
}
