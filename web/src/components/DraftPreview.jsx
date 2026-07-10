// Renders one draft's structured content in a readable form. Shape varies
// by action_type — this is the one place that knows all seven shapes, so
// every other consumer (modal, copy button) can stay generic.

function Field({ label, children }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm text-slate-700 leading-relaxed">{children}</div>
    </div>
  );
}

export default function DraftPreview({ actionType, content }) {
  switch (actionType) {
    case 'meta-title':
      return (
        <div className="space-y-3">
          <Field label="Title options">
            <ul className="space-y-1.5">
              {content.titles.map((t, i) => (
                <li key={i} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">{t}</li>
              ))}
            </ul>
          </Field>
          <Field label="Meta description">{content.metaDescription}</Field>
        </div>
      );

    case 'faq':
      return (
        <div className="space-y-3">
          {content.items.map((qa, i) => (
            <div key={i} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
              <div className="text-sm font-semibold text-slate-800">{qa.question}</div>
              <div className="text-sm text-slate-600 mt-1">{qa.answer}</div>
            </div>
          ))}
        </div>
      );

    case 'schema':
      return (
        <div className="space-y-3">
          {content.placeholderFields?.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              ⏳ {content.placeholderFields.length} field(s) need manual input: {content.placeholderFields.join(', ')}
            </div>
          )}
          <pre className="text-xs bg-slate-50 rounded-lg p-3 overflow-x-auto max-h-96 overflow-y-auto">{JSON.stringify(content.jsonLd, null, 2)}</pre>
        </div>
      );

    case 'internal-links':
      return (
        <div className="space-y-2">
          {content.suggestions.length === 0 && <p className="text-sm text-slate-400">{content.note || 'No suggestions.'}</p>}
          {content.suggestions.map((s, i) => (
            <div key={i} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
              <div className="text-sm"><span className="font-semibold">"{s.anchorText}"</span> → <span className="text-indigo-600 break-all">{s.targetUrl}</span></div>
              <div className="text-xs text-slate-500 mt-1">{s.rationale}</div>
            </div>
          ))}
        </div>
      );

    case 'blog-outline':
      return (
        <div className="space-y-3">
          <Field label="Title">{content.title}</Field>
          <Field label="Meta description">{content.metaDescription}</Field>
          <Field label="Sections">
            <ol className="space-y-2 list-decimal list-inside">
              {content.sections.map((s, i) => (
                <li key={i}><span className="font-semibold">{s.heading}</span> — <span className="text-slate-500">{s.notes}</span></li>
              ))}
            </ol>
          </Field>
          {content.suggestedFaqTopics?.length > 0 && (
            <Field label="Suggested FAQ topics"><span>{content.suggestedFaqTopics.join(' · ')}</span></Field>
          )}
          {content.suggestedInternalLinks?.length > 0 && (
            <Field label="Suggested internal links">
              <ul className="space-y-1">
                {content.suggestedInternalLinks.map((l, i) => (
                  <li key={i}>"{l.anchorText}" → <span className="text-indigo-600 break-all">{l.targetUrl}</span></li>
                ))}
              </ul>
            </Field>
          )}
        </div>
      );

    case 'landing-page':
      return (
        <div className="space-y-3">
          <Field label="Headline">{content.headline}</Field>
          <Field label="Subheadline">{content.subheadline}</Field>
          <Field label="Sections">
            <div className="space-y-2">
              {content.sections.map((s, i) => (
                <div key={i}><span className="font-semibold">{s.heading}</span> — <span className="text-slate-500">{s.body}</span></div>
              ))}
            </div>
          </Field>
          <Field label="CTA">{content.cta}</Field>
          <Field label="Meta title / description">{content.metaTitle} — {content.metaDescription}</Field>
        </div>
      );

    case 'translation':
      return (
        <div className="space-y-3">
          <Field label={`Translated title (${content.targetLanguage})`}>{content.translatedTitle || '—'}</Field>
          <Field label="Translated meta description">{content.translatedMetaDescription || '—'}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Original content"><p className="whitespace-pre-wrap">{content.sourceContent}</p></Field>
            <Field label={`Translated (${content.targetLanguage})`}><p className="whitespace-pre-wrap">{content.translatedContent}</p></Field>
          </div>
        </div>
      );

    default:
      return <pre className="text-xs bg-slate-50 rounded-lg p-3 overflow-x-auto">{JSON.stringify(content, null, 2)}</pre>;
  }
}
