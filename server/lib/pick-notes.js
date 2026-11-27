// What a person asks to change on a content idea (see migration 276): cleaned on the way in, and turned into the instruction the writer follows when the idea is built.
const MAX_NOTES = 12;
const MAX_TEXT = 600;
const MAX_PART = 80;
const MAX_PART_TEXT = 300;
const MAX_CONTEXT = 200;
const MAX_SELECTED = 300;
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();

/** { ok: true, notes } with only what is safe to keep, or { ok: false, error }. No notes (undefined or null) is fine and means none. */
export function cleanPickNotes(raw) {
  if (raw == null) return { ok: true, notes: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'notes must be a list.' };
  if (raw.length > MAX_NOTES) return { ok: false, error: `At most ${MAX_NOTES} changes can be asked for on one idea.` };
  const notes = [];
  for (const n of raw) {
    const text = clean(n?.text);
    if (!text) return { ok: false, error: 'Each change needs some text.' };
    if (text.length > MAX_TEXT) return { ok: false, error: `Each change can be at most ${MAX_TEXT} characters.` };
    const part = clean(n?.part).slice(0, MAX_PART);
    const partText = clean(n?.partText).slice(0, MAX_PART_TEXT);
    const context = clean(n?.context).slice(0, MAX_CONTEXT);
    const selected = clean(n?.selected).slice(0, MAX_SELECTED);
    notes.push({ part: part || null, ...(selected ? { selected } : {}), ...(partText ? { partText } : {}), ...(context ? { context } : {}), text });
  }
  return { ok: true, notes };
}

/** The writer's instruction: the chosen structure plus the person's changes. The person's words are what to change, never new facts. */
export function instructionWithNotes(instruction, notes) {
  const list = (Array.isArray(notes) ? notes : []).filter((n) => n?.text);
  if (!list.length) return instruction;
  return `${instruction}\n\nTHE PERSON APPROVING THIS ALSO ASKED FOR THESE CHANGES. Apply every one exactly as asked and change nothing else about the structure they chose. ` +
    'They say what to change in the wording or the emphasis; they do not supply facts, so never add a statistic, number, date, name or claim that is not already grounded in the page, and if a request would need one, leave it out:\n' +
    'A change that names a part applies to THAT ONE element only (its current words are quoted so you can find it); leave every other element exactly as it is:\n' +
    list.map((n) => (n.selected
      ? `- The person selected these exact words: "${n.selected}"${n.part ? ` (in ${n.part}${n.partText ? `, which reads "${n.partText}"` : ''}${n.context ? `, ${n.context}` : ''})` : ''}. Change only those words: ${n.text}`
      : n.part
        ? `- Part [${n.part}]${n.partText ? ` currently reads "${n.partText}"` : ''}${n.context ? `, ${n.context}` : ''}: ${n.text}`
        : `- Whole piece: ${n.text}`)).join('\n');
}
