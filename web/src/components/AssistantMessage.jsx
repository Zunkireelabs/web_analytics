import { Compass } from 'lucide-react';

// Shared rendering for both Assistant surfaces (ClientAssistantPanel,
// AdminAssistantPanel). The server composes replies as plain text with a
// light convention — numbered lists ("1. Subject\n   Risk: ...", see
// server/assistant/assistant.js's composeNeeds/composeExplanation/etc.) and
// occasional quoted values/URLs — never markdown syntax, so this parses that
// convention directly rather than running a markdown renderer over text that
// was never markdown.

function renderInline(text) {
  if (!text) return null;
  const regex = /(https?:\/\/[^\s)]+)|("[^"]+")/g;
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('http://') || part.startsWith('https://')) {
      let label = part;
      try {
        const u = new URL(part);
        label = u.pathname === '/' ? u.hostname : u.pathname;
        if (label.length > 30) label = label.slice(0, 12) + '...' + label.slice(-15);
      } catch { /* not a real URL — render as-is */ }
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-650 hover:text-indigo-800 bg-indigo-50 border border-indigo-100/50 hover:border-indigo-200 rounded-lg px-2 py-0.5 mx-0.5 transition-colors">
          <Compass size={10} className="shrink-0" />
          {label}
        </a>
      );
    }
    if (part.startsWith('"') && part.endsWith('"')) {
      return (
        <code key={i} className="inline-block text-[11px] font-extrabold px-1.5 py-0.5 rounded border leading-none font-mono bg-slate-100 text-slate-700 border-slate-200/65 mx-0.5">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function parseNumberedList(text) {
  const firstListIndex = text.search(/(?:^|\n)\d+\.\s+/);
  if (firstListIndex === -1) return { intro: text, items: [] };
  const intro = text.slice(0, firstListIndex).trim();
  const listPart = text.slice(firstListIndex);
  const matches = [...listPart.matchAll(/(?:^|\n)(\d+)\.\s+([\s\S]*?)(?=(?:\n\d+\.\s+)|$)/g)];
  const items = matches.map((m) => {
    const raw = m[2].trim();
    const dot = raw.indexOf('. ');
    const colon = raw.indexOf(': ');
    if (dot !== -1) return { num: m[1], header: raw.slice(0, dot).trim(), body: raw.slice(dot + 1).trim() };
    if (colon !== -1) return { num: m[1], header: raw.slice(0, colon).trim(), body: raw.slice(colon + 1).trim() };
    return { num: m[1], header: raw, body: '' };
  });
  return { intro, items };
}

export default function AssistantMessage({ content }) {
  const { intro, items } = parseNumberedList(content || '');

  if (!items.length) {
    return <p className="whitespace-pre-line font-medium text-slate-800 leading-relaxed">{renderInline(content)}</p>;
  }

  return (
    <div className="space-y-3">
      {intro && <p className="whitespace-pre-line font-medium text-slate-800 leading-relaxed">{renderInline(intro)}</p>}
      <div className="flex flex-col gap-3 mt-1">
        {items.map((item, i) => (
          <div key={i} className="p-3 rounded-2xl border border-slate-200/60 bg-slate-50/50 flex gap-3 items-start">
            <div className="w-6 h-6 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-650 grid place-items-center text-[11px] font-black shrink-0">
              {item.num}
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="text-[12px] font-black text-slate-850 leading-snug">{item.header}</h5>
              {item.body && <p className="text-[11px] font-semibold text-slate-500 leading-relaxed mt-1 whitespace-pre-line">{renderInline(item.body)}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
