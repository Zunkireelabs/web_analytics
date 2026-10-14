import { getFileContent, defaultBranchName } from '../../github/client.js';

// Pre-generation contract for directory-routed (Next.js App Router) tenants.
//
// For these sites a net-new blog post / direct answer / translation is a tiny
// page.tsx that hands props to a hand-written shared component in the
// CLIENT'S repo (GeneratedBlogPost etc., newpage-render.js). If that
// component does not exist, the page cannot build — and today that is only
// discovered at apply/PR time, after a paid generation. Same waste
// expand-content-structural-fit.js was written to stop, same fix: ask first.
//
// A real pixel gate for these pages is not achievable in-process (rendering
// needs the client's own Next build), so this is deliberately the cheaper,
// deterministic layer: does the component exist, and does its source even
// mention the props we will pass.
//
// Tri-state, copied from checkExpandContentStructuralFit:
//   { ok: true, warnings? } — proceed
//   { ok: false, reason, detail } — will fail; refuse before generating
//   null — could not check (no repo, not a directory-routed tenant, fetch
//          failed); proceed unchanged. An inability to look is not a refusal.

export const COMPONENT_BY_ACTION = Object.freeze({
  'blog-outline': { name: 'GeneratedBlogPost', props: ['title', 'slug', 'sections', 'featuredImage', 'categories', 'publishedAt'] },
  'direct-answer': { name: 'GeneratedDirectAnswer', props: ['heading', 'directAnswer', 'supportingSections', 'featuredImage'] },
  translation: { name: 'GeneratedTranslation', props: [] },
});

// The page imports from "@/components/X"; `@` is conventionally src/, but a
// repo may keep components at the root, so both are tried.
export function candidatePaths(name) {
  return ['tsx', 'jsx', 'ts', 'js'].flatMap((ext) => [`src/components/${name}.${ext}`, `components/${name}.${ext}`]);
}

export function isDirectoryRouted(site, actionType) {
  return Boolean(site?.url_file_map?.siteRoot?.newContentTargets?.[actionType]?.filename
    || site?.url_file_map?.newContentTargets?.[actionType]?.filename);
}

export function missingPropMentions(source, props) {
  return props.filter((p) => !new RegExp(`\\b${p}\\b`).test(source));
}

export async function checkGeneratedComponentContract(site, actionType, { getFile = getFileContent } = {}) {
  const spec = COMPONENT_BY_ACTION[actionType];
  if (!spec || !isDirectoryRouted(site, actionType)) return null;
  if (!site?.repo_owner || !site?.repo_name) return null;

  const ref = defaultBranchName(site);
  let found = null;
  let sawError = false;
  for (const path of candidatePaths(spec.name)) {
    try {
      const file = await getFile(site, path, ref);
      if (file) { found = { path, content: String(file.content ?? '') }; break; }
    } catch { sawError = true; }
  }
  // A fetch error anywhere means "not found" cannot be trusted.
  if (!found) {
    if (sawError) return null;
    return {
      ok: false, reason: 'component-missing',
      detail: `This site routes ${actionType} pages by directory and hands their content to a shared ${spec.name} component, but no ${spec.name} file exists in its repo (looked in src/components and components). Pages generated now could not build. Add the component first — that is the client's own design, not something to scaffold for them.`,
    };
  }

  const unmentioned = missingPropMentions(found.content, spec.props);
  return unmentioned.length
    ? { ok: true, warnings: [`${found.path} never mentions prop(s): ${unmentioned.join(', ')} — they would be passed and ignored.`] }
    : { ok: true };
}
