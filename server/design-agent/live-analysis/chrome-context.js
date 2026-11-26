// WHAT IS PAGE CHROME AND WHAT IS THE ARTICLE. One definition, used by the browser capture (capture.js passes these lists into the page), the profile builder, the
// render guard and the self-repair detector, so they can never disagree.
//
// Why this exists (zennly.io, 2026-11): a mega-menu panel is a TOP-LEVEL <div id="v2Mega-types" class="v2-nav-mega v2-mm" role="region"> beside the <header>,
// not inside it, so the landmark check (`closest('header'|'nav'|'footer')`) called it ordinary content. Its <h4 class="v2-mm__aside-title"> was then recorded as the
// site's article "subheading" class. The article's own headings are bare <h2>/<h3> styled by the layout's stylesheet. A heading is design evidence only if it is
// part of the page's body, never because of its tag or because it is the only one that has a class.

/** Elements that are never article content, whatever their class names. */
export const CHROME_TAGS = Object.freeze(['nav', 'header', 'footer', 'aside', 'dialog']);

/** ARIA roles that mark navigation, banners, dialogs and other furniture. */
export const CHROME_ARIA_ROLES = Object.freeze(['navigation', 'banner', 'contentinfo', 'complementary', 'dialog', 'alertdialog', 'menu', 'menubar', 'tooltip']);

/**
 * Whole class/id TOKENS (split on anything that is not a letter or digit) that name overlay and navigation furniture. Deliberately narrow: a token like `menu`
 * or `nav` alone is NOT here, because a restaurant's "menu" section or a docs site's "nav-card" is real content.
 */
export const CHROME_NAME_TOKENS = Object.freeze(['mega', 'megamenu', 'dropdown', 'flyout', 'popover', 'offcanvas', 'drawer', 'backdrop', 'scrim', 'navbar', 'tooltip', 'modal', 'cookie', 'consent']);

/**
 * The wider set used ONLY on the class string of a heading that was already recorded (the profile evidence), where the question is "does this class name look like it
 * belongs to navigation?": it adds the tokens a menu's own parts carry (`mm`, `aside`, `menu`, `nav`, `sidebar`, `header`, `footer`).
 */
export const CHROME_CLASS_TOKENS = Object.freeze([...CHROME_NAME_TOKENS, 'mm', 'aside', 'menu', 'nav', 'navigation', 'sidebar', 'header', 'footer']);

export const nameTokens = (str) => String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** True when any whole token of `str` is one of `tokens` ('v2-nav-mega' -> v2, nav, mega -> 'mega'). */
export function chromeNameMatch(str, tokens = CHROME_NAME_TOKENS) {
  const set = new Set(tokens);
  return nameTokens(str).some((t) => set.has(t));
}

/** A recorded heading class that reads like navigation furniture ('v2-mm__aside-title'). Used to distrust legacy profile evidence that carries no observation flag. */
export function isChromeLikeClass(classes) {
  return chromeNameMatch(classes, CHROME_CLASS_TOKENS);
}

/** The configuration object handed into the browser (page.evaluate can only pass data, not imports). */
export const chromeConfig = () => ({ tags: [...CHROME_TAGS], roles: [...CHROME_ARIA_ROLES], tokens: [...CHROME_NAME_TOKENS] });

/** Page types whose body headings are the design evidence for the article's own subheadings. */
export const ARTICLE_PAGE_TYPES = Object.freeze(['blog-article', 'legal']);
