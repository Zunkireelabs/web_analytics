import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ClipboardPaste, ExternalLink, Info, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import ChoiceCard from './ChoiceCard.jsx';
import Field from '../Field.jsx';
import Button from '../Button.jsx';

// The Business Profile question, shared by the New project popup (its optional step) and the project's
// General settings (to change the answer later), so the two can never drift apart.
const GUIDE = [
  ['Go to business.google.com', 'Sign in with the Google account that will own the listing, then choose Add your business.'],
  ['Enter your business name and category', 'Use the name customers know you by, and the closest category (for example "Education consultant").'],
  ['Add where you are', 'A street address if customers visit you, or the areas you serve if you go to them.'],
  ['Add phone, website and opening hours', 'Use the same details as your website, spelled the same way.'],
  ['Verify it', 'Google confirms the business is yours by video, phone, email or a postcard. A postcard can take a few days.'],
];

export const gbpReady = (choice, url) => Boolean(choice) && (choice !== 'linked' || String(url || '').trim().length > 0);

export const GBP_LABELS = { linked: 'Linked', none: 'Not created yet', not_applicable: 'Does not apply' };

// How the step reaches the server for one project: what Google returned, and where to send the person to sign in.
export const gbpSource = (siteId) => ({
  load: () => api.project.connect.businessProfileLocations(siteId),
  start: () => api.project.connect.businessProfileStart(siteId),
});

// What to say when Google sent the person back without a list (the code the server put in the address).
const OUTCOMES = {
  cancelled: 'Google sign-in was cancelled. You can try again.',
  expired: 'That took too long. Please connect Google again.',
  denied: 'That Google account cannot read a Business Profile for this project.',
  missing_scopes: 'Access to your Business Profile needs to be allowed on the Google screen.',
  exchange_failed: 'Google did not accept the sign-in. Please try again.',
  not_available: 'Google has not allowed SuperRank to list Business Profiles yet, so choose yours by pasting its link.',
  failed: 'We could not read your Business Profiles just now. You can paste its link instead.',
};

// Google's own page listing every Business Profile on the signed-in account (used when the business cannot be looked up).
const MANAGER_URL = 'https://business.google.com/locations';
const PANEL = { background: 'var(--muted)' };

// A short box that scrolls inside the popup (so choosing an option never makes the popup taller) and SHOWS that it
// does: a visible scrollbar, a fade at the bottom, and a "More steps" button that scrolls down, all gone at the end.
function ScrollBox({ children, label, className = '' }) {
  const ref = useRef(null);
  const [atEnd, setAtEnd] = useState(true);
  const check = () => { const el = ref.current; if (el) setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 4); };
  useEffect(() => { check(); }, [children]);
  return (
    <div className="relative">
      <div ref={ref} onScroll={check} tabIndex={0} aria-label={label} className={`scroll-always max-h-[176px] overflow-y-auto overscroll-contain pr-3 ${className}`}>{children}</div>
      {!atEnd && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14" style={{ background: 'linear-gradient(to top, var(--muted) 15%, transparent)' }} />
          <button type="button" onClick={() => ref.current?.scrollBy({ top: 120, behavior: 'smooth' })}
            className="absolute bottom-1 right-3 inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-fg hover:bg-muted"
            style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 3px rgba(0,0,0,.08)' }}>
            More steps <ChevronDown size={12} />
          </button>
        </>
      )}
    </div>
  );
}

// A small numbered list, the one shape every "do this, then this" in the step uses.
function Steps({ items }) {
  return (
    <ol className="space-y-3">
      {items.map(({ title, detail, extra }, i) => (
        <li key={title} className="flex items-start gap-3">
          <span className="w-5 h-5 rounded-full bg-white text-primary text-[11px] font-semibold grid place-items-center shrink-0 mt-px" style={{ boxShadow: '0 0 0 1px var(--primary-ring)' }}>{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-fg leading-5">{title}</span>
            {detail && <span className="block text-xs text-faint leading-[17px] mt-px">{detail}</span>}
            {extra && <span className="block mt-2">{extra}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function BusinessProfileFields({ choice, setChoice, url, setUrl, showWhy = true, source = null, outcome = null }) {
  // What Google returned for this project: idle -> loading -> ready | error.
  //   locations: null  = nothing listed yet (offer "Connect Google" when the server can), or the account's profiles
  const [list, setList] = useState({ status: 'idle', canConnect: false, locations: null, account: null });
  const [manual, setManual] = useState(false);   // "Paste a link instead"
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const started = useRef(false);   // the lookup runs once, the first time "I have one" is chosen
  const alive = useRef(true);
  const sourceRef = useRef(source); // the parent passes a new object every render; only the latest is ever used
  sourceRef.current = source;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (choice !== 'linked' || !sourceRef.current || started.current) return;
    started.current = true;
    setList((l) => ({ ...l, status: 'loading' }));
    sourceRef.current.load().then((r) => {
      if (alive.current) setList({ status: 'ready', canConnect: Boolean(r?.canConnect), locations: Array.isArray(r?.locations) ? r.locations : null, account: r?.account || null });
    }).catch(() => { if (alive.current) setList({ status: 'error', canConnect: false, locations: null, account: null }); });
  }, [choice]);

  const connectGoogle = async () => {
    setConnecting(true); setConnectError(null);
    try {
      const { url: next } = await sourceRef.current.start();
      window.location.assign(next);
    } catch (err) { setConnectError(err.message || 'Google could not be opened right now.'); setConnecting(false); }
  };

  const canPaste = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText);
  const looksLikeProfile = (t) => /^(https?:\/\/)?((www\.|maps\.)?google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|g\.co\/kgs|share\.google|business\.google\.com)/i.test(String(t || '').trim());
  const pasteLink = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) setUrl(text);
    } catch { /* the browser said no: they can still paste into the box */ }
  };
  const listed = list.status === 'ready' && Array.isArray(list.locations);
  // Google said it has not allowed Business Profile reads for this server yet: connecting again cannot help, so go straight to pasting.
  const blocked = outcome === 'not_available';
  const offerConnect = list.status === 'ready' && !listed && list.canConnect && !blocked;
  // The paste path: when they ask for it, or when Google cannot be used (not set up here, or it failed).
  const showBox = manual || blocked || list.status === 'error' || (list.status === 'ready' && !listed && !list.canConnect);
  // Coming back from Google after "Copy link": read it for them, so nothing has to be pasted. Only a Google Maps /
  // Business Profile looking link is taken (the server checks it again on save); the browser may ask permission once.
  const awaiting = choice === 'linked' && !url && showBox;
  useEffect(() => {
    if (!awaiting || !canPaste) return undefined;
    const grab = async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (looksLikeProfile(text)) setUrl(text);
      } catch { /* no permission: the Paste button and the box still work */ }
    };
    window.addEventListener('focus', grab);
    return () => window.removeEventListener('focus', grab);
  }, [awaiting, canPaste]);
  const outcomeText = outcome && outcome !== 'listed' ? (OUTCOMES[outcome] || OUTCOMES.failed) : null;
  const pasteInstead = !manual && (
    <button type="button" className="text-xs text-text underline underline-offset-2 hover:text-fg" onClick={() => { setManual(true); setUrl(''); }}>Paste its link instead</button>
  );

  const linkRow = (
    <div className="flex items-end gap-2">
      <Field className="flex-1 min-w-0" label="Your profile link" placeholder="https://maps.app.goo.gl/…" value={url} onChange={(e) => setUrl(e.target.value)} />
      {canPaste && <Button variant="light" onClick={pasteLink} className="shrink-0 mb-px"><ClipboardPaste size={14} />Paste</Button>}
    </div>
  );

  return (
    <div className="space-y-4">
      {showWhy && (
        <div className="flex items-start gap-2.5 rounded-control px-3 py-2.5 text-[13px] leading-5" style={PANEL}>
          <Info size={15} className="shrink-0 mt-0.5 text-text" />
          <span className="min-w-0 text-text">Google shows your Business Profile (map, reviews, hours, phone) when people search for what you do. A correct one helps you get found and trusted.</span>
        </div>
      )}
      <div role="radiogroup" aria-label="Your Business Profile" className="space-y-2.5">
        <ChoiceCard selected={choice === 'linked'} onSelect={() => setChoice('linked')} title="I have a Business Profile"
          description={list.status === 'ready' && !list.canConnect && !listed ? 'Open it on Google and we will pick up its link.' : 'Connect Google and choose it from your list.'} />
        {choice === 'linked' && (
          <div className="ml-7 rounded-card p-4 space-y-4" style={PANEL}>
            {(outcomeText || connectError) && (
              <div className="flex items-start gap-2 rounded-control bg-white px-3 py-2.5 text-[13px] leading-5" style={{ color: '#8a5300', boxShadow: '0 0 0 1px #f0d9ad' }}>
                <AlertTriangle size={15} className="shrink-0 mt-0.5" /><span className="min-w-0">{connectError || outcomeText}</span>
              </div>
            )}
            {list.status === 'loading' && <div className="flex items-center gap-2 text-[13px] text-text"><Loader2 size={15} className="animate-spin" />Checking Google…</div>}
            {offerConnect && (
              <div className="space-y-3">
                <div>
                  <div className="text-[13px] font-medium text-fg">Connect Google to choose your business</div>
                  <p className="mt-1 text-xs text-faint leading-[18px]">Google opens in a new screen. You choose a Google account and allow SuperRank to see your Business Profiles, then you come straight back and pick yours from the list. <span className="text-text">SuperRank only reads the list. It never changes your profile.</span></p>
                </div>
                <div className="flex items-start gap-2 rounded-control bg-white px-3 py-2.5 text-xs leading-[18px] text-text" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
                  <Info size={14} className="shrink-0 mt-px text-faint" />
                  <span className="min-w-0"><span className="font-medium text-fg">Which account?</span> The one you use to manage your business on Google, where you see it at business.google.com. It can be a different account from the one you used for Search Console.</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" onClick={connectGoogle} disabled={connecting}><ExternalLink size={14} />{connecting ? 'Opening Google…' : 'Connect Google'}</Button>
                  {pasteInstead}
                </div>
              </div>
            )}
            {listed && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text">
                  <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-green" />Connected{list.account ? <> as <span className="font-medium text-fg">{list.account}</span></> : ''}</span>
                  {list.canConnect && <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={connectGoogle} disabled={connecting}>Use a different account</button>}
                </div>
                {list.locations.length > 0 ? (
                  <div role="radiogroup" aria-label="Choose your business" className="space-y-2">
                    <div className="text-[13px] font-medium text-fg">Choose your business</div>
                    {list.locations.map((l) => (
                      <ChoiceCard key={l.id} selected={url === l.mapsUrl} onSelect={() => { setManual(false); setUrl(l.mapsUrl); }} title={l.name}
                        description={<>{l.address}{!l.verified && <span className="ml-2 text-[#8a5300]">Not verified yet</span>}</>} />
                    ))}
                    {pasteInstead}
                  </div>
                ) : (
                  <div className="space-y-2"><p className="text-[13px] text-text">This Google account does not manage any Business Profiles. Try <span className="font-medium text-fg">Use a different account</span> and choose the one you manage your business with, or paste a link.</p>{pasteInstead}</div>
                )}
              </div>
            )}
            {showBox && (
              <>
                <Steps items={[
                  { title: 'Open your profile on Google', extra: <Button variant="primary" onClick={() => window.open(MANAGER_URL, '_blank', 'noopener,noreferrer')}><ExternalLink size={14} />Open my Business Profile</Button> },
                  { title: 'Choose Share profile, then Copy link' },
                  { title: 'Come back to this tab', detail: 'The link fills in by itself.' },
                ]} />
                {linkRow}
              </>
            )}
          </div>
        )}
        <ChoiceCard selected={choice === 'none'} onSelect={() => setChoice('none')} title="I don't have one yet" description="It is free and takes about 10 minutes to start. You can carry on now and add the link later." />
        {choice === 'none' && (
          <div className="ml-7 rounded-card p-4 space-y-3.5" style={PANEL}>
            <ScrollBox label="How to create a Business Profile">
              <Steps items={GUIDE.map(([title, detail]) => ({ title, detail }))} />
            </ScrollBox>
            <a href="https://business.google.com/create" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg underline underline-offset-2 hover:text-primary">
              Create it on Google <ExternalLink size={13} />
            </a>
          </div>
        )}
        <ChoiceCard selected={choice === 'not_applicable'} onSelect={() => setChoice('not_applicable')} title="This isn't a local business" description="Software and online-only businesses usually don't need one." />
      </div>
    </div>
  );
}
