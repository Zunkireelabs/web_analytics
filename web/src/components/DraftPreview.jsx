import {
  Check,
  Info,
  FileCode,
  Link2,
  ListOrdered,
  PanelTop,
  Globe2,
  Sparkles,
  HelpCircle,
  ArrowRight,
  Bookmark
} from 'lucide-react';
import MarkdownReport from './MarkdownReport.jsx';

function Field({ label, icon: Icon, children }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
        {Icon && <Icon size={12} className="text-slate-400" />}
        <span>{label}</span>
      </div>
      <div className="text-xs text-slate-700 leading-relaxed bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
        {children}
      </div>
    </div>
  );
}

export default function DraftPreview({ actionType, content, onSelectTitle }) {
  switch (actionType) {
    case 'meta-title':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <Bookmark size={12} />
              <span>Title Proposals (Select One)</span>
            </div>
            <ul className="space-y-2.5">
              {content.titles.map((t, i) => {
                const selected = content.selectedTitle === t;
                return (
                  <li key={i}
                    onClick={() => onSelectTitle && onSelectTitle(t)}
                    className={`rounded-2xl border px-4 py-3 flex items-center justify-between gap-3 cursor-pointer transition-all duration-200 ${
                      selected 
                        ? 'border-emerald-300 bg-emerald-50/50 shadow-sm shadow-emerald-50' 
                        : 'border-slate-200/60 bg-white hover:bg-slate-50/50 hover:border-slate-300'
                    }`}
                  >
                    <span className={`text-xs font-semibold ${selected ? 'text-emerald-800 font-extrabold' : 'text-slate-700'}`}>{t}</span>
                    {selected ? (
                      <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 flex items-center gap-0.5">
                        <Check size={8} strokeWidth={3} /> Selected
                      </span>
                    ) : (
                      onSelectTitle && (
                        <span className="text-[9px] font-black uppercase tracking-wider text-indigo-500 hover:text-indigo-700 opacity-0 group-hover:opacity-100 transition-opacity">
                          Use This
                        </span>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          
          <Field label="Meta Description" icon={FileCode}>
            <p className="font-medium text-slate-750">{content.metaDescription}</p>
          </Field>
          
          {!content.selectedTitle && onSelectTitle && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100/50 rounded-2xl p-4 leading-relaxed flex items-center gap-2">
              <Info size={14} className="text-amber-500 shrink-0" />
              <span>Select one proposed title card above before this draft can be pushed to staging.</span>
            </div>
          )}
        </div>
      );

    case 'faq':
      return (
        <div className="space-y-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <HelpCircle size={12} />
            <span>Structured Q&A Sections ({content.items.length})</span>
          </div>
          <div className="space-y-3">
            {content.items.map((qa, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow-md transition duration-200">
                <div className="text-xs font-black text-slate-900 flex items-start gap-1.5 leading-snug">
                  <span className="text-indigo-500">Q:</span>
                  <span>{qa.question}</span>
                </div>
                <div className="text-xs text-slate-600 mt-2.5 pl-4 border-l-2 border-indigo-100 leading-relaxed font-semibold">
                  {qa.answer}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case 'schema':
      return (
        <div className="space-y-4">
          {content.placeholderFields?.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100/50 rounded-2xl p-4 leading-relaxed flex items-center gap-2">
              <Info size={14} className="text-amber-500 shrink-0" />
              <span>Manual review required: {content.placeholderFields.join(', ')}</span>
            </div>
          )}
          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <FileCode size={12} />
              <span>JSON-LD Schema Payload</span>
            </div>
            <div className="rounded-2xl bg-slate-950 border border-slate-800 p-4 overflow-hidden relative">
              <div className="absolute top-2 right-3 text-[8px] font-mono font-black text-slate-600 uppercase">JSON-LD</div>
              <pre className="text-[11px] font-mono text-emerald-400/90 leading-relaxed overflow-x-auto max-h-96 overflow-y-auto custom-scrollbar whitespace-pre">{JSON.stringify(content.jsonLd, null, 2)}</pre>
            </div>
          </div>
        </div>
      );

    case 'internal-links':
      return (
        <div className="space-y-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <Link2 size={12} />
            <span>Link Building Recommendations</span>
          </div>
          {content.suggestions.length === 0 && (
            <p className="text-xs text-slate-400 italic bg-white border border-slate-100 rounded-2xl p-4 text-center">
              {content.note || 'No suggestions logged.'}
            </p>
          )}
          <div className="space-y-3">
            {content.suggestions.map((s, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow-md transition-all duration-200">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="font-extrabold text-indigo-700 bg-indigo-50 border border-indigo-100/50 rounded-lg px-2 py-0.5">
                    "{s.anchorText}"
                  </span>
                  <ArrowRight size={12} className="text-slate-450 shrink-0" />
                  <a href={s.targetUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-650 hover:underline break-all font-semibold font-mono text-[11px]">
                    {s.targetUrl}
                  </a>
                </div>
                <div className="text-[11px] font-medium text-slate-500 mt-2.5 leading-relaxed bg-slate-50/50 border border-slate-100 rounded-xl p-2.5">
                  <span className="font-extrabold text-slate-600">Rationale:</span> {s.rationale}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case 'blog-outline':
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Blog Title" icon={Sparkles}>{content.title}</Field>
            <Field label="Outline Meta Description" icon={FileCode}>{content.metaDescription}</Field>
          </div>
          
          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <ListOrdered size={12} />
              <span>Section Hierarchy</span>
            </div>
            <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm space-y-4">
              {content.sections.map((s, i) => (
                <div key={i} className="flex items-start gap-3.5 group">
                  <span className="w-6 h-6 rounded-lg grid place-items-center bg-indigo-500/10 text-indigo-600 font-mono text-xs font-black shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h5 className="text-xs font-black text-slate-900 group-hover:text-indigo-600 transition-colors leading-tight">{s.heading}</h5>
                    <p className="text-[11px] font-medium text-slate-500 mt-1 leading-relaxed">{s.notes}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {content.suggestedFaqTopics?.length > 0 && (
            <Field label="Suggested FAQ Topics" icon={HelpCircle}>
              <div className="flex flex-wrap gap-1.5">
                {content.suggestedFaqTopics.map((topic, i) => (
                  <span key={i} className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 font-extrabold tracking-tight">
                    {topic}
                  </span>
                ))}
              </div>
            </Field>
          )}

          {content.suggestedInternalLinks?.length > 0 && (
            <Field label="Suggested Internal Link Insertions" icon={Link2}>
              <div className="space-y-2">
                {content.suggestedInternalLinks.map((l, i) => (
                  <div key={i} className="text-xs border-b border-slate-100 last:border-0 pb-2 last:pb-0 flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-800 bg-indigo-50/50 rounded px-1.5">"{l.anchorText}"</span>
                    <ArrowRight size={10} className="text-slate-400" />
                    <span className="text-indigo-650 font-mono text-[10px] break-all">{l.targetUrl}</span>
                  </div>
                ))}
              </div>
            </Field>
          )}
        </div>
      );

    case 'landing-page':
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Headline Title" icon={PanelTop}>{content.headline}</Field>
            <Field label="Subheadline Subtitle" icon={PanelTop}>{content.subheadline}</Field>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <ListOrdered size={12} />
              <span>Proposed Site Sections</span>
            </div>
            <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm space-y-4">
              {content.sections.map((s, i) => (
                <div key={i} className="border-b border-slate-100 last:border-none pb-4 last:pb-0">
                  <h5 className="text-xs font-black text-slate-900 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
                    {s.heading}
                  </h5>
                  <p className="text-[11px] font-medium text-slate-500 mt-2 pl-3.5 leading-relaxed border-l border-slate-200">{s.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Call-To-Action CTA button" icon={Sparkles}>{content.cta}</Field>
            <Field label="Page SEO Metadata" icon={FileCode}>{content.metaTitle} — {content.metaDescription}</Field>
          </div>
        </div>
      );

    case 'llms-txt':
      return (
        <div className="space-y-4">
          {content.placeholderCount > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100/50 rounded-2xl p-4 leading-relaxed flex items-center gap-2">
              <Info size={14} className="text-amber-500 shrink-0" />
              <span>Needs manual check: {content.placeholderCount} placeholders.</span>
            </div>
          )}
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <FileCode size={12} />
                <span>llms.txt content</span>
              </div>
              <div className="rounded-2xl bg-slate-950 border border-slate-800 p-4 relative">
                <pre className="text-[11px] font-mono text-emerald-400/90 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar whitespace-pre-wrap">{content.llmsTxt}</pre>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <FileCode size={12} />
                <span>robots.txt additions</span>
              </div>
              <div className="rounded-2xl bg-slate-950 border border-slate-800 p-4 relative">
                <pre className="text-[11px] font-mono text-emerald-400/90 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar whitespace-pre-wrap">{content.robotsDirectives}</pre>
              </div>
            </div>
          </div>

          {content.keyPages?.length > 0 && (
            <Field label="Key Reference Pages Included" icon={Link2}>
              <ul className="space-y-1">
                {content.keyPages.map((p, i) => (
                  <li key={i} className="text-xs text-indigo-700 hover:underline truncate" title={p.title || p.url}>
                    {p.title || p.url}
                  </li>
                ))}
              </ul>
            </Field>
          )}
        </div>
      );

    case 'sitemap':
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label={`Added URLs (${content.addedUrls?.length || 0})`} icon={Link2}>
              {content.addedUrls?.length ? (
                <ul className="space-y-1">
                  {content.addedUrls.map((url, i) => <li key={i} className="truncate" title={url}>{url}</li>)}
                </ul>
              ) : '—'}
            </Field>
            <Field label={`Existing Entries Kept Unchanged (${content.existingCount ?? 0})`} icon={Check}>
              Every existing sitemap entry — and its lastmod/priority/changefreq — is preserved as-is.
            </Field>
          </div>

          {content.orphanedUrls?.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100/50 rounded-2xl p-4 leading-relaxed flex items-start gap-2">
              <Info size={14} className="text-amber-500 shrink-0 mt-0.5" />
              <span>{content.orphanedUrls.length} existing sitemap URL(s) weren't reached by the crawl — review manually, not removed automatically: {content.orphanedUrls.join(', ')}</span>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <FileCode size={12} />
              <span>{content.sitemapPath}</span>
            </div>
            <div className="rounded-2xl bg-slate-950 border border-slate-800 p-4 relative">
              <pre className="text-[11px] font-mono text-emerald-400/90 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar whitespace-pre-wrap">{content.sitemapXml}</pre>
            </div>
          </div>
        </div>
      );

    case 'translation':
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Source Translated Title" icon={Globe2}>{content.translatedTitle || '—'}</Field>
            <Field label={`Meta Description (${content.targetLanguage})`} icon={FileCode}>{content.translatedMetaDescription || '—'}</Field>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <Globe2 size={12} />
              <span>Comparative Language View</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-50/50 border border-slate-200 rounded-3xl p-4 flex flex-col justify-between">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 pb-2 border-b border-slate-200/50 mb-2">Original English</div>
                  <p className="text-xs font-semibold text-slate-650 whitespace-pre-wrap leading-relaxed">{content.sourceContent}</p>
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-3xl p-4 flex flex-col justify-between shadow-sm">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-widest text-indigo-500 pb-2 border-b border-slate-100 mb-2">Target Language: {content.targetLanguage}</div>
                  <p className="text-xs font-extrabold text-slate-800 whitespace-pre-wrap leading-relaxed">{content.translatedContent}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      );

    case 'geo-audit':
      return (
        <div className="space-y-4">
          {content.score ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Overall AI Visibility Score" icon={Globe2}>
                <span className="text-lg font-black text-slate-900">{content.score.overall}/100</span>
                <span className="text-[11px] text-slate-400 font-semibold ml-2">
                  {content.pagesAnalyzed} page{content.pagesAnalyzed === 1 ? '' : 's'} analyzed · {content.start} to {content.end}
                </span>
              </Field>
              <Field label="Category Breakdown" icon={FileCode}>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(content.score.categories).map(([cat, val]) => (
                    <span key={cat} className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 font-extrabold tracking-tight">
                      {cat}: {val}/100
                    </span>
                  ))}
                </div>
              </Field>
            </div>
          ) : (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100/50 rounded-2xl p-4 leading-relaxed flex items-center gap-2">
              <Info size={14} className="text-amber-500 shrink-0" />
              <span>No pages could be scored in this run — not enough GSC traffic in range, or llms.txt/robots.txt couldn't be checked.</span>
            </div>
          )}

          {content.findings?.length > 0 && (
            <Field label={`Recommendations Mapped To Generators (${content.findings.length})`} icon={ListOrdered}>
              Every recommendation below is also a one-click action in Action Center's Recommendations tab.
            </Field>
          )}

          <MarkdownReport content={content.report} />
        </div>
      );

    default:
      return (
        <div className="rounded-2xl bg-slate-950 border border-slate-800 p-4">
          <pre className="text-xs font-mono text-emerald-400/90 leading-relaxed overflow-x-auto whitespace-pre">{JSON.stringify(content, null, 2)}</pre>
        </div>
      );
  }
}
