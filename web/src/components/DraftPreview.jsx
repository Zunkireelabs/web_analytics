import { Info } from 'lucide-react';
import Badge from './Badge.jsx';
import MarkdownReport from './MarkdownReport.jsx';

const FIELD_RING = { boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' };
const CODE_RING = { boxShadow: 'inset 0 0 0 1px var(--border-2)' };

// Label above a read-only value, as in the .fld look.
function Field({ label, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-fg mb-2">{label}</div>
      <div className="rounded-control px-3 py-2.5 text-sm leading-[21px] text-fg bg-white" style={FIELD_RING}>
        {children}
      </div>
    </div>
  );
}

// Label above free-form content (lists, code) that has its own container.
function Group({ label, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-fg mb-2">{label}</div>
      {children}
    </div>
  );
}

function Notice({ tone = 'warning', children }) {
  const cls = tone === 'success' ? 'bg-[#e8f7ee] text-[#1a7f4b]' : tone === 'info' ? 'bg-muted text-text' : 'bg-[#fdf3e1] text-[#8a5300]';
  return (
    <div className={`rounded-control px-3.5 py-3 text-[13px] flex items-start gap-2 ${cls}`}>
      <Info size={14} className="shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

function Code({ children, wrap = false }) {
  return (
    <div className="rounded-control bg-[#fcfcfb] p-3 overflow-x-auto" style={CODE_RING}>
      <pre className={`font-mono text-xs leading-5 text-fg max-h-96 overflow-y-auto custom-scrollbar ${wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'}`}>{children}</pre>
    </div>
  );
}

const Chips = ({ items }) => (
  <div className="flex flex-wrap gap-1.5">
    {items.map((topic, i) => <Badge key={i} tone="outline">{topic}</Badge>)}
  </div>
);

const LinkInsertions = ({ links }) => (
  <div>
    {links.map((l, i) => (
      <div key={i} className="text-sm py-2.5 border-b border-border last:border-0 flex items-center gap-2 flex-wrap">
        <span className="font-medium text-fg">"{l.anchorText}"</span>
        <span className="text-faint">→</span>
        <span className="font-mono text-xs text-text break-all">{l.targetUrl}</span>
      </div>
    ))}
  </div>
);

// Hairline list of heading + body sections.
const Sections = ({ sections, numbered = false }) => (
  <div className="rounded-control bg-white px-3.5" style={FIELD_RING}>
    {sections.map((s, i) => (
      <div key={i} className="py-2.5 border-b border-border last:border-0">
        <h5 className="text-sm font-medium text-fg">{numbered ? `${i + 1}. ` : ''}{s.heading}</h5>
        <p className="text-sm text-text mt-1 leading-[21px] whitespace-pre-wrap">{s.body}</p>
      </div>
    ))}
  </div>
);

export default function DraftPreview({ actionType, content, onSelectTitle }) {
  switch (actionType) {
    case 'meta-title':
      return (
        <div className="space-y-5">
          <Group label="Title proposals (select one)">
            <div role="radiogroup" aria-label="Title proposals">
              {content.titles.map((t, i) => {
                const selected = content.selectedTitle === t;
                return (
                  <button key={i} type="button" role="radio" aria-checked={selected}
                    onClick={() => onSelectTitle && onSelectTitle(t)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-3 rounded-control text-sm text-left mt-2 bg-white"
                    style={{ boxShadow: selected ? '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' : '0 0 0 1px var(--input)' }}>
                    <span className="w-3.5 h-3.5 rounded-full shrink-0"
                      style={{ boxShadow: selected ? 'inset 0 0 0 4px var(--primary)' : 'inset 0 0 0 1px #c9c9c9' }} />
                    <span className={selected ? 'text-fg font-medium' : 'text-fg'}>{t}</span>
                    {selected && <Badge tone="green" className="ml-auto shrink-0">Selected</Badge>}
                  </button>
                );
              })}
            </div>
          </Group>

          <Field label="Meta description">
            <p>{content.metaDescription}</p>
          </Field>

          {!content.selectedTitle && onSelectTitle && (
            <Notice>Select one proposed title card above before this draft can be pushed to staging.</Notice>
          )}
        </div>
      );

    case 'faq':
      return (
        <Group label={`Structured Q&A sections (${content.items.length})`}>
          <div className="rounded-control bg-white px-3.5" style={FIELD_RING}>
            {content.items.map((qa, i) => (
              <div key={i} className="py-2.5 border-b border-border last:border-0">
                <div className="text-sm font-medium text-fg">{qa.question}</div>
                <div className="text-sm text-text mt-1 leading-[21px]">{qa.answer}</div>
              </div>
            ))}
          </div>
        </Group>
      );

    case 'schema':
      return (
        <div className="space-y-5">
          {content.placeholderFields?.length > 0 && (
            <Notice>Manual review required: {content.placeholderFields.join(', ')}</Notice>
          )}
          <Group label="JSON-LD schema payload">
            <Code>{JSON.stringify(content.jsonLd, null, 2)}</Code>
          </Group>
        </div>
      );

    case 'internal-links':
      return (
        <Group label="Link building recommendations">
          {content.suggestions.length === 0 && (
            <p className="text-sm text-faint text-center py-3">
              {content.note || 'No suggestions logged.'}
            </p>
          )}
          <div className="rounded-control bg-white px-3.5" style={FIELD_RING}>
            {content.suggestions.map((s, i) => (
              <div key={i} className="py-2.5 border-b border-border last:border-0">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-medium text-fg">"{s.anchorText}"</span>
                  <span className="text-faint">→</span>
                  <a href={s.targetUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all font-mono text-xs">
                    {s.targetUrl}
                  </a>
                </div>
                <div className="text-[13px] text-text mt-1.5">
                  <span className="font-medium text-fg">Rationale:</span> {s.rationale}
                </div>
              </div>
            ))}
          </div>
        </Group>
      );

    case 'blog-outline':
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Blog title">{content.title}</Field>
            <Field label="Meta description">{content.metaDescription}</Field>
          </div>

          <Group label="Article sections">
            <Sections sections={content.sections} numbered />
          </Group>

          {content.suggestedFaqTopics?.length > 0 && (
            <Group label="Suggested FAQ topics"><Chips items={content.suggestedFaqTopics} /></Group>
          )}

          {content.suggestedInternalLinks?.length > 0 && (
            <Group label="Suggested internal link insertions"><LinkInsertions links={content.suggestedInternalLinks} /></Group>
          )}
        </div>
      );

    case 'direct-answer':
      return (
        <div className="space-y-5">
          <Field label="Heading (matches the real query's phrasing)">
            <span className="font-medium">{content.heading}</span>
          </Field>

          <Field label="Direct answer">
            <p>{content.directAnswer}</p>
          </Field>

          {content.supportingSections?.length > 0 && (
            <Group label="Supporting sections">
              <Sections sections={content.supportingSections} />
            </Group>
          )}

          {content.suggestedFaqTopics?.length > 0 && (
            <Group label="Suggested FAQ topics"><Chips items={content.suggestedFaqTopics} /></Group>
          )}

          {content.suggestedInternalLinks?.length > 0 && (
            <Group label="Suggested internal link insertions"><LinkInsertions links={content.suggestedInternalLinks} /></Group>
          )}
        </div>
      );

    case 'landing-page':
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Headline title">{content.headline}</Field>
            <Field label="Subheadline subtitle">{content.subheadline}</Field>
          </div>

          <Group label="Proposed site sections">
            <Sections sections={content.sections} />
          </Group>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Call-to-action button">{content.cta}</Field>
            <Field label="Page SEO metadata">{content.metaTitle} — {content.metaDescription}</Field>
          </div>
        </div>
      );

    case 'cookie-policy':
    case 'privacy-policy':
    case 'terms-of-service':
      return (
        <div className="space-y-5">
          {content.disclaimer && <Notice>{content.disclaimer}</Notice>}

          <Field label="Page title">{content.headline}</Field>

          <Group label="Proposed sections">
            <Sections sections={content.sections} />
          </Group>

          <Field label="Page SEO metadata">{content.metaTitle} — {content.metaDescription}</Field>
        </div>
      );

    case 'llms-txt':
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Group label="llms.txt content">
              <Code wrap>{content.llmsTxt}</Code>
            </Group>

            <Group label="robots.txt additions">
              {content.robotsDirectives ? (
                <Code wrap>{content.robotsDirectives}</Code>
              ) : (
                <Notice tone="success">robots.txt already allows all AI crawlers — no changes needed.</Notice>
              )}
            </Group>
          </div>

          {content.keyPages?.length > 0 && (
            <Group label="Key reference pages included">
              <div className="rounded-control bg-white px-3.5" style={FIELD_RING}>
                {content.keyPages.map((p, i) => (
                  <div key={i} className="text-sm text-fg py-2.5 border-b border-border last:border-0 truncate" title={p.title || p.url}>
                    {p.title || p.url}
                  </div>
                ))}
              </div>
            </Group>
          )}
        </div>
      );

    case 'sitemap':
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label={`Added URLs (${content.addedUrls?.length || 0})`}>
              {content.addedUrls?.length ? (
                <ul className="space-y-1">
                  {content.addedUrls.map((url, i) => <li key={i} className="truncate" title={url}>{url}</li>)}
                </ul>
              ) : '—'}
            </Field>
            <Field label={`Existing entries kept unchanged (${content.existingCount ?? 0})`}>
              Every existing sitemap entry — and its lastmod/priority/changefreq — is preserved as-is.
            </Field>
          </div>

          {content.orphanedUrls?.length > 0 && (
            <Notice>{content.orphanedUrls.length} existing sitemap URL(s) weren't reached by the crawl — review manually, not removed automatically: {content.orphanedUrls.join(', ')}</Notice>
          )}

          <Group label={content.sitemapPath}>
            <Code wrap>{content.sitemapXml}</Code>
          </Group>
        </div>
      );

    case 'translation':
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Source translated title">{content.translatedTitle || '—'}</Field>
            <Field label={`Meta description (${content.targetLanguage})`}>{content.translatedMetaDescription || '—'}</Field>
          </div>

          <Group label="Comparative language view">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-control bg-[#fcfcfb] p-3" style={CODE_RING}>
                <div className="text-xs text-faint pb-2 border-b border-border mb-2">Original English</div>
                <p className="text-sm text-text whitespace-pre-wrap leading-[21px]">{content.sourceContent}</p>
              </div>
              <div className="rounded-control bg-white p-3" style={FIELD_RING}>
                <div className="text-xs text-faint pb-2 border-b border-border mb-2">Target language: {content.targetLanguage}</div>
                <p className="text-sm text-fg whitespace-pre-wrap leading-[21px]">{content.translatedContent}</p>
              </div>
            </div>
          </Group>
        </div>
      );

    case 'geo-audit':
      return (
        <div className="space-y-5">
          {content.score ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Overall AI visibility score">
                <span className="text-lg font-medium text-fg tnum">{content.score.overall}/100</span>
                <span className="text-xs text-faint ml-2">
                  {content.pagesAnalyzed} page{content.pagesAnalyzed === 1 ? '' : 's'} analyzed · {content.start} to {content.end}
                </span>
              </Field>
              <Field label="Category breakdown">
                <Chips items={Object.entries(content.score.categories).map(([cat, val]) => `${cat}: ${val}/100`)} />
              </Field>
            </div>
          ) : (
            <Notice>No pages could be scored in this run — not enough GSC traffic in range, or llms.txt/robots.txt couldn't be checked.</Notice>
          )}

          {content.findings?.length > 0 && (
            <Field label={`Recommendations mapped to generators (${content.findings.length})`}>
              Every recommendation below is also a one-click action in Action Center's Recommendations tab.
            </Field>
          )}

          <MarkdownReport content={content.report} />
        </div>
      );

    case 'duplicate-id-fix':
      return (
        <div className="space-y-5">
          <Notice>{content.instructions}</Notice>
          {(content.fixPlan || []).map((f) => (
            <Group key={f.id} label={`id="${f.id}" — used ${f.count} times`}>
              <div className="rounded-control bg-white px-3.5" style={FIELD_RING}>
                {f.occurrences.map((occ, i) => (
                  <div key={i} className="py-2.5 border-b border-border last:border-0">
                    <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
                      <span className="font-medium" style={{ color: occ.keep ? 'var(--green)' : '#b42318' }}>
                        {occ.keep ? 'Keep as-is' : `Rename to id="${occ.suggestedId}"`}
                      </span>
                      <span className="text-faint font-mono">&lt;{occ.tag?.toLowerCase()}&gt;</span>
                    </div>
                    <code className="text-xs font-mono text-text break-all">{occ.snippet}</code>
                  </div>
                ))}
              </div>
            </Group>
          ))}
        </div>
      );

    default:
      return <Code>{JSON.stringify(content, null, 2)}</Code>;
  }
}
