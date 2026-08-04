import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Renders a trusted, server-generated markdown report (currently only the
// GEO Audit generator's output) in the existing slate/indigo card language
// instead of raw text. react-markdown renders straight to React elements —
// no dangerouslySetInnerHTML — so this is safe even if that ever stops
// being purely server-generated.
const COMPONENTS = {
  h1: ({ children }) => <h1 className="text-sm font-black text-slate-900 mt-5 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xs font-black text-slate-900 uppercase tracking-wide mt-5 mb-2 first:mt-0 pb-1.5 border-b border-slate-100">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xs font-extrabold text-slate-800 mt-3 mb-1.5">{children}</h3>,
  p: ({ children }) => <p className="text-xs text-slate-600 leading-relaxed mb-2">{children}</p>,
  strong: ({ children }) => <strong className="font-extrabold text-slate-900">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-700 hover:underline font-semibold">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="list-disc pl-4 space-y-1 mb-2 text-xs text-slate-600">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 space-y-1 mb-2 text-xs text-slate-600">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="text-[11px] text-slate-500 bg-slate-50/70 border border-slate-150 rounded-xl px-3 py-2 mb-2 italic">
      {children}
    </blockquote>
  ),
  code: ({ inline, children }) =>
    inline ? (
      <code className="font-mono text-[11px] bg-slate-100 text-indigo-700 rounded px-1 py-0.5">{children}</code>
    ) : (
      <code className="font-mono text-[11px] text-emerald-400/90 leading-relaxed">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="rounded-2xl bg-slate-950 border border-slate-800 p-3 overflow-x-auto mb-2 whitespace-pre">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2 rounded-xl border border-slate-200">
      <table className="w-full text-[11px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
  th: ({ children }) => <th className="text-left font-black uppercase tracking-wide text-slate-500 px-3 py-2 border-b border-slate-200">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 border-b border-slate-100 text-slate-700 font-mono">{children}</td>,
  hr: () => <hr className="border-slate-150 my-3" />,
};

export default function MarkdownReport({ content }) {
  if (!content) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
