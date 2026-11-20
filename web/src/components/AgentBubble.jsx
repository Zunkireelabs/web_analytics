import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';

const KEY = 'agent-reminder-dismissed';
const read = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };

// The agent's button, bottom-right, on every page: always there so the client can open the chat any time. The count and the pulse show
// only while something is waiting on the client; it opens the small chat popup when pressed. Above it, a small reminder message pops out ("Hey, 4 fixes and 3 pieces of content are
// left for your approval") so the client sees what is waiting without opening anything. They can close the reminder; it stays closed for
// that wording during this visit and comes back if what is waiting changes.
export default function AgentBubble({ count, pulse, onOpen, message }) {
  const [dismissed, setDismissed] = useState(read);
  useEffect(() => { setDismissed(read()); }, [message]);
  const showReminder = count > 0 && Boolean(message) && dismissed !== message;
  const close = (e) => { e.stopPropagation(); try { sessionStorage.setItem(KEY, message); } catch { /* it just shows again next visit */ } setDismissed(message); };
  return (
    <>
      {showReminder && (
        <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
          className="fixed bottom-[86px] right-5 z-40 w-[min(290px,calc(100vw-40px))] cursor-pointer rounded-[14px] bg-white pl-4 pr-8 py-3 text-[13.5px] leading-5 text-fg animate-fade-in"
          style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 14px 34px -12px rgba(0,0,0,.3)' }} data-agent-reminder>
          {message}
          <button type="button" onClick={close} aria-label="Close this reminder" className="absolute top-2 right-2 w-5 h-5 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-muted"><X size={12} /></button>
          <span aria-hidden className="absolute -bottom-[6px] right-[22px] w-3 h-3 rotate-45 bg-white" style={{ boxShadow: '2px 2px 2px -1px rgba(0,0,0,.08)' }} />
        </div>
      )}
      <button type="button" onClick={onOpen} aria-label={count > 0 ? `The agent has ${count} ${count === 1 ? 'thing' : 'things'} waiting for you` : 'Chat with the agent'}
        className={`fixed bottom-5 right-5 z-40 w-[52px] h-[52px] rounded-[16px] bg-primary text-white grid place-items-center ${pulse ? 'agent-pulse' : ''}`}
        style={{ boxShadow: '0 12px 30px -8px rgba(213,78,0,.55), 0 0 0 1px rgba(0,0,0,.05)' }}>
        <Sparkles size={22} />
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1.5 rounded-full bg-[#171717] text-white text-[11px] font-semibold grid place-items-center tnum"
            style={{ boxShadow: '0 0 0 2px #fff' }}>{count}</span>
        )}
      </button>
    </>
  );
}
