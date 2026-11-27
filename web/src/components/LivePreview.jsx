import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Button from './Button.jsx';
import InteractivePage from './InteractivePage.jsx';
import SelectionBox from './SelectionBox.jsx';
import { STATUS } from '../lib/palette.js';

// The draft as a real page of the client's site, not a picture: its own header, fonts, FAQ design, related articles and footer, with the draft in the article. Every part of the
// post can be clicked; a box opens on the side where the person types what to change (the writing assistant changes just that part) or edits the text directly. A change is
// checked by the same rules a new post is checked by before it is saved. See server/lib/draft-live-preview.js.
const WARN = { background: STATUS.warning.tint, color: STATUS.warning.text };

// The person's own words in place of the words they selected: found in the part's text (a heading, the body, the short answer, or a FAQ question or answer) and swapped for what they typed.
// Null when the selected words are not found as typed (the page shows them without the post's own formatting marks), so the caller can say so instead of changing the wrong thing.
function replaceSelected(block, words, typed) {
  const find = String(words || '').replace(/\s+/g, ' ').trim();
  if (!find) return { error: 'Nothing is selected.' };
  // Every place in this part the selected words occur. Exactly one is a safe swap; more than one would change a guess, so the person is asked to select a little more.
  const fields = block.kind === 'quick' ? [null] : ['heading', 'body', 'question', 'answer'].filter((k) => block.value && typeof block.value[k] === 'string');
  const hits = [];
  for (const k of fields) {
    const text = String(k === null ? block.value : block.value[k] ?? '');
    let from = 0;
    for (;;) { const i = text.indexOf(find, from); if (i < 0) break; hits.push({ k, i }); from = i + find.length; }
  }
  if (hits.length === 0) return { error: 'Those exact words were not found in the text, so nothing was changed. Select a smaller piece of plain text, or use “Or edit the whole part yourself” below.' };
  if (hits.length > 1) return { error: 'Those words appear more than once in this part, so it is not clear which one to change. Select a few more words around the one you mean.' };
  const { k, i } = hits[0];
  const swap = (t) => t.slice(0, i) + typed + t.slice(i + find.length);
  return { value: k === null ? swap(String(block.value)) : { ...block.value, [k]: swap(String(block.value[k])) } };
}

const asDraftValue = (block) => (block.kind === 'quick' ? block.value : { ...block.value });

function ManualEdit({ block, busy, onSaveText }) {
  const [value, setValue] = useState(() => asDraftValue(block));
  useEffect(() => { setValue(asDraftValue(block)); }, [block.id, block.value]);
  const set = (k) => (e) => setValue((v) => ({ ...v, [k]: e.target.value }));
  return (
    <details className="pt-2 border-t border-border">
      <summary className="text-[13px] text-fg-muted cursor-pointer">Or edit the whole part yourself</summary>
      <div className="space-y-2 mt-2">
        {block.kind === 'quick' && <textarea rows={4} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" />}
        {block.kind === 'section' && (
          <>
            <input value={value.heading} onChange={set('heading')} disabled={busy} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" aria-label="Heading" />
            <textarea rows={10} value={value.body} onChange={set('body')} disabled={busy} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white font-mono" aria-label="Text" />
          </>
        )}
        {block.kind === 'faq' && (
          <>
            <input value={value.question} onChange={set('question')} disabled={busy} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" aria-label="Question" />
            <textarea rows={5} value={value.answer} onChange={set('answer')} disabled={busy} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" aria-label="Answer" />
          </>
        )}
        <Button variant="light" write onClick={() => onSaveText(value)} disabled={busy}>{busy ? 'Saving…' : 'Save my text'}</Button>
      </div>
    </details>
  );
}

export default function LivePreview({ draftId, siteId, onSaved }) {
  const [state, setState] = useState(null); // null | 'loading' | { ok:true, html, blocks, editable } | { ok:false, error }
  const [view, setView] = useState('desktop');
  const [selected, setSelected] = useState(null); // block id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [issues, setIssues] = useState(null);
  const [notice, setNotice] = useState(null);

  // A response is used only if it is still the latest request for the draft on screen: opening another draft, or a second load, must never let an older answer land on top.
  const latest = useRef(0);
  const load = useCallback(async ({ keepOnError = false } = {}) => {
    const mine = ++latest.current;
    setState((s) => (s && s.ok ? s : 'loading'));
    try {
      const r = await api.actionCenter.livePreview(draftId, siteId);
      if (mine === latest.current) setState({ ok: true, ...r });
    } catch (e) {
      if (mine !== latest.current) return;
      // A change was just saved and only the redraw failed: keep what is on screen and say so, never replace it with "could not be drawn".
      if (keepOnError) { setState((s) => (s && s.ok ? s : { ok: false, error: e.message || 'The preview could not be drawn.' })); setNotice('Changed and saved. The preview could not be redrawn just now; reload to see it.'); }
      else setState({ ok: false, error: e.message || 'The preview could not be drawn.' });
    }
  }, [draftId, siteId]);

  // Another draft (or project) is a fresh start: nothing of the previous one stays selected or on screen.
  useEffect(() => { latest.current += 1; setState('loading'); setSelected(null); setError(null); setIssues(null); setNotice(null); load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id) => { setSelected(id); setError(null); setIssues(null); setNotice(null); };

  async function send(body, blockId = selected) {
    setBusy(true); setError(null); setIssues(null); setNotice(null);
    try {
      const r = await api.actionCenter.editBlock(draftId, { blockId, ...body }, siteId);
      setNotice('Changed. The page below shows it now.');
      if (r.draft && onSaved) onSaved(r.draft);
      await load({ keepOnError: true });
      return true;
    } catch (e) { setError(e.message || 'The change could not be made.'); setIssues(e.issues || e.body?.issues || null); return false; }
    finally { setBusy(false); }
  }

  const phone = view === 'mobile';
  return (
    <div className="pt-5 border-t border-border space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-fg">See it on the site</div>
          <div className="text-xs text-fg-muted">Your post as a real page of this site. Select the words you want changed and a box opens right below them: say what to change and press Enter.</div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={!phone ? 'dark' : 'light'} onClick={() => setView('desktop')}>Desktop</Button>
          <Button size="sm" variant={phone ? 'dark' : 'light'} onClick={() => setView('mobile')}>Phone</Button>
        </div>
      </div>

      {state === 'loading' && <div className="text-[13px] text-fg-muted">Drawing the page…</div>}
      {state && state !== 'loading' && !state.ok && <div className="rounded-control px-3.5 py-3 text-[13px]" style={WARN}>{state.error}</div>}

      {state?.ok && (
        <>
          {notice && <div className="rounded-control px-3.5 py-2.5 text-[13px]" style={{ background: STATUS.success?.tint, color: STATUS.success?.text }}>{notice}</div>}
          <InteractivePage
            html={state.html} phone={phone} title="Your post inside the site" selected={selected} selectMode
            onSelect={(id) => { setSelected(id); setError(null); setIssues(null); setNotice(null); }}
            renderBox={({ id, text: words, close }) => {
              const block = state.blocks.find((b) => b.id === id);
              if (!block) return <div className="text-[13px] text-fg-muted">Select words inside the post’s own text to change them. <Button size="sm" variant="light" onClick={close}>Close</Button></div>;
              const canEdit = state.editable && block.editable;
              return (
                <SelectionBox kind={block.label.split(':')[0]} words={words} busy={busy} disabled={!canEdit} submitLabel="Change it"
                  placeholder="For example: make this shorter, or say that applications close in March, or use a friendlier tone"
                  onClose={close}
                  onReplace={async (typed, clear) => {
                    const r = replaceSelected(block, words, typed);
                    if (r.error) { setError(r.error); setIssues(null); return; }
                    const value = r.value;
                    if (await send({ value }, id)) { clear(); close(); }
                  }}
                  onSubmit={async (instruction, clear) => { if (await send({ instruction, selected: words }, id)) { clear(); close(); } }}>
                  {!block.editable && <div className="rounded-control px-3.5 py-3 text-[13px]" style={WARN}>The sources are verified links, so they are not edited here. Ask the team to change them.</div>}
                  {block.editable && !state.editable && <div className="rounded-control px-3.5 py-3 text-[13px]" style={WARN}>This draft has already been approved or shipped, so it can no longer be edited here.</div>}
                  {error && (
                    <div className="rounded-control px-3.5 py-3 text-[13px] space-y-1" style={WARN}>
                      <div>{error}</div>
                      {issues?.length > 0 && <ul className="list-disc pl-5">{issues.map((i, n) => <li key={n}>{i.detail || i.rule}</li>)}</ul>}
                    </div>
                  )}
                  {canEdit && <ManualEdit block={block} busy={busy} onSaveText={(value) => send({ value }, id)} />}
                </SelectionBox>
              );
            }}
          />
        </>
      )}
    </div>
  );
}
