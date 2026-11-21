import { planEleventyPagination } from './eleventy-recipe.js';
import { planAstroPagination } from './astro-recipe.js';
import { planNextjsPagination } from './nextjs-recipe.js';

// One recipe per framework. A framework without an entry gets no draft: the recommendation says why, and a person decides. Adding a stack is
// one new recipe here, held to the same acceptance test (lib/pagination-acceptance.js) as every other.
export const RECIPES = Object.freeze({
  eleventy: Object.freeze({ id: 'eleventy', plan: planEleventyPagination }),
  astro: Object.freeze({ id: 'astro', plan: planAstroPagination }),
  nextjs: Object.freeze({ id: 'nextjs', plan: planNextjsPagination }),
});

export const recipeSupported = (framework) => Boolean(framework && Object.prototype.hasOwnProperty.call(RECIPES, framework));
export const supportedFrameworks = () => Object.keys(RECIPES);

// The pager reuses the SITE'S OWN buttons (its design profile), never another client's: `secondary` for the page links and `primary` for the
// current page when the site has both, so the current page stands out in the site's own look. null when the profile has neither.
export function pagerClassesFromDesignProfile(profile) {
  const button = profile?.components?.button;
  const primary = typeof button?.primary === 'string' && button.primary.trim() ? button.primary.trim() : null;
  const secondary = typeof button?.secondary === 'string' && button.secondary.trim() ? button.secondary.trim() : null;
  if (!primary && !secondary) return { buttonClass: null, currentClass: null };
  return { buttonClass: secondary || primary, currentClass: primary || secondary };
}
