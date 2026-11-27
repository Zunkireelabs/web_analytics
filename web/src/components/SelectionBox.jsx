import { useState } from 'react';
import Button from './Button.jsx';

// THE ONE EDIT BOX, used on ideas and on drafts: it opens right below the words the person selected. Shows what was selected, takes what should change, and Enter (or the button) sends it.
// `onSubmit(text)` may be async and return false/throw to keep the box open (a draft rewrite that failed). `children` is for extra content under the button (an error, a manual edit).
export default function SelectionBox({ kind = '', words = '', placeholder = 'For example: make this shorter, sound more professional, make it more visible', submitLabel = 'Add this change', busy = false, disabled = false, onSubmit, onReplace = null, replaceLabel = 'Use my words', onClose, children = null }) {
  const [text, setText] = useState('');
  const replace = () => { if (text.trim() && !busy && !disabled) onReplace?.(text.trim(), () => setText('')); };
  const go = () => { if (text.trim() && !busy && !disabled) onSubmit?.(text.trim(), () => setText('')); };
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-faint">What should change in</div>
          <div className="text-sm font-medium text-fg break-words">{kind ? `${kind}: ` : ''}“{words}”</div>
        </div>
        <Button size="sm" variant="light" onClick={onClose}>Close</Button>
      </div>
      <textarea autoFocus rows={3} value={text} disabled={busy || disabled} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }}
        placeholder={placeholder} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" />
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" size="sm" disabled={!text.trim() || busy || disabled} onClick={go}>{busy ? 'Changing…' : submitLabel}</Button>
        {onReplace && <Button variant="light" size="sm" write disabled={!text.trim() || busy || disabled} onClick={replace} title="Put exactly what you typed in place of the selected words. The writer is not asked.">{replaceLabel}</Button>}
      </div>
      {children}
    </div>
  );
}
