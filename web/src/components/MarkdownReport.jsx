import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Renders a trusted, server-generated markdown report (the GEO Audit
// generator's output and the onboarding baseline report) as a calm document
// card: small type, hairline rules, tables via the shared .tbl look.
// react-markdown renders straight to React elements — no
// dangerouslySetInnerHTML — so this is safe even if that ever stops being
// purely server-generated.
const COMPONENTS = {
  h1: ({ children }) => <h1 className="text-[15px] font-medium text-fg mt-5 mb-3 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[13px] font-medium text-fg mt-5 mb-2 pb-1.5 border-b border-border first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[13px] font-medium text-fg mt-3 mb-1.5">{children}</h3>,
  p: ({ children }) => <p className="mb-2">{children}</p>,
  strong: ({ children }) => <strong className="font-medium text-fg">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1 mb-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1 mb-2">{children}</ol>,
  li: ({ children }) => <li className="leading-5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="text-text bg-muted rounded-control px-3 py-2 mb-2">
      {children}
    </blockquote>
  ),
  code: ({ inline, children }) =>
    inline ? (
      <code className="font-mono text-[12px] bg-muted text-fg rounded px-1 py-0.5">{children}</code>
    ) : (
      <code className="font-mono text-[12px] text-white/90">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="rounded-control bg-fg p-3 overflow-x-auto mb-2 whitespace-pre">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-3 rounded-control" style={{ boxShadow: '0 0 0 1px var(--border-2)' }}>
      <table className="tbl">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
  hr: () => <hr className="border-border my-3" />,
};

export default function MarkdownReport({ content }) {
  if (!content) return null;
  return (
    <div className="card px-5 py-4 md:px-6 md:py-5 text-[13px] leading-5 text-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
