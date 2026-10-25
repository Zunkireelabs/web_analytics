import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import AdminAssistantPanel from './AdminAssistantPanel.jsx';
import Button from './Button.jsx';
import PageToolbar from './PageToolbar.jsx';

// "Ask the analyst" used to be a permanent sticky column, always taking a
// third of the page's width whether or not anyone was using it. Collapsed
// here into a toolbar trigger + slide-up drawer instead, so the content
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
          className="fixed inset-0 z-30 bg-neutral-900/30 animate-fade-in"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <div
        className={`fixed bottom-6 right-6 z-40 w-[calc(100vw-3rem)] max-w-[24rem] bg-white rounded-card flex flex-col overflow-hidden transition-all duration-200 origin-bottom-right ${
          open ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto' : 'opacity-0 scale-95 translate-y-3 pointer-events-none'
        }`}
        style={{ height: 'min(34rem, calc(100vh - 6rem))', boxShadow: 'var(--float-shadow)' }}
      >
        {open && <AdminAssistantPanel clientId={clientId} onClose={() => setOpen(false)} />}
      </div>

      {/* The trigger lives in the page toolbar, not floating over the content —
          a floating button sat on top of charts and list rows. */}
      <PageToolbar>
        <Button variant="primary" className="ml-auto" onClick={() => setOpen(true)} aria-expanded={open}>
          <Sparkles size={14} />
          Ask the analyst
        </Button>
      </PageToolbar>
    </>
  );
}
