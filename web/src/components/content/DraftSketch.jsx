import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SketchPage from './SketchPage.jsx';
import SelectionBox from '../SelectionBox.jsx';

// A non-blog draft (a landing page, a FAQ, a meta title...) drawn in the site's own design. Same interaction as every other preview: select the words you want changed, a box opens
// right below them, say what to change and press Enter. The words are matched to the draft's own field that contains them, and that one field is rewritten and re-checked.
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export default function DraftSketch({ draftId, siteId, html, url, title, onSaved, onChanged }) {
  const [fields, setFields] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { text, words }: an error belongs to the words it was for
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => { let alive = true; api.actionCenter.editFields(draftId, siteId).then((r) => { if (alive) { setFields(r.fields || []); setLoadError(null); } }).catch((e) => { if (alive) setLoadError(e.message || 'The draft\'s wording could not be loaded.'); }); return () => { alive = false; }; }, [draftId, siteId, notice]);
  const fieldFor = (words) => { const w = norm(words); return fields.find((f) => norm(f.value).includes(w)) || null; };
  return (
    <div>
      {notice && <div className="mb-2 rounded-control px-3.5 py-2.5 text-[13px] bg-[#e8f6ec] text-[#14532d]">{notice}</div>}
      <SketchPage html={html} url={url} title={title}
        renderBox={({ text: words, close }) => {
          const field = fieldFor(words);
          return (
            <SelectionBox words={words} busy={busy} disabled={!field} submitLabel="Change it" onClose={() => { setError(null); close(); }}
              placeholder="For example: make this shorter, or use a friendlier tone"
              onSubmit={async (instruction, clear) => {
                setBusy(true); setError(null); setNotice(null);
                try {
                  const r = await api.actionCenter.rewriteField(draftId, { path: field.path, instruction, selected: words }, siteId);
                  if (r.draft) onSaved?.(r.draft);
                  setNotice('Changed and saved. Nothing goes live until you approve.'); clear(); close(); onChanged?.();
                } catch (e) { setError({ text: e.message || 'The change could not be made.', words }); } finally { setBusy(false); }
              }}>
              {!field && loadError && <div className="rounded-control px-3.5 py-3 text-[13px] bg-[#fdecec] text-[#b42318]">The draft’s wording could not be loaded ({loadError}), so these words cannot be changed right now. Close this and try again.</div>}
              {!field && !loadError && <div className="text-[13px] text-fg-muted">These words are not part of the draft’s own text (they are the site’s fixed page), so they cannot be changed here.</div>}
              {error && error.words === words && <div className="rounded-control px-3.5 py-3 text-[13px] bg-[#fdecec] text-[#b42318]">{error.text}</div>}
            </SelectionBox>
          );
        }} />
    </div>
  );
}
