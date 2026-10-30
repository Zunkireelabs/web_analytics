import titleTag from './seo/titleTag.js';
import metaDescription from './seo/metaDescription.js';
import headings from './seo/headings.js';
import canonical from './seo/canonical.js';
import hreflang from './seo/hreflang.js';
import langAttribute from './seo/langAttribute.js';
import viewport from './seo/viewport.js';
import favicon from './seo/favicon.js';
import openGraph from './seo/openGraph.js';
import twitterCard from './seo/twitterCard.js';
import schemaOrg from './seo/schemaOrg.js';
import noindex from './seo/noindex.js';
import imageAlt from './seo/imageAlt.js';
import links from './seo/links.js';
import friendlyUrl from './seo/friendlyUrl.js';
import ampFlash from './seo/ampFlash.js';
import robotsTxt from './seo/robotsTxt.js';
import xmlSitemap from './seo/xmlSitemap.js';
import httpsRedirect from './seo/httpsRedirect.js';
import dnsRecords from './seo/dnsRecords.js';
import analyticsTracking from './seo/analyticsTracking.js';
import facebookPixel from './seo/facebookPixel.js';
import socialProfiles from './seo/socialProfiles.js';
import inlineStyles from './seo/inlineStyles.js';
import iframes from './seo/iframes.js';
import emailPrivacy from './seo/emailPrivacy.js';
import deprecatedHtml from './seo/deprecatedHtml.js';
import compression from './seo/compression.js';
import pageWeight from './seo/pageWeight.js';
import contentAmount from './seo/contentAmount.js';
import keywordConsistency from './seo/keywordConsistency.js';

import llmsTxt from './aeo/llmsTxt.js';
import identitySchema from './aeo/identitySchema.js';
import structuredDataRich from './aeo/structuredDataRich.js';
import answerability from './aeo/answerability.js';
import localBusinessSchema from './aeo/localBusinessSchema.js';
import aiCrawlerAccess from './aeo/aiCrawlerAccess.js';
import jsRenderGap from './aeo/jsRenderGap.js';

import websiteLoadSpeed from './seo/websiteLoadSpeed.js';
import resourceBreakdown from './seo/resourceBreakdown.js';
import jsErrors from './seo/jsErrors.js';

import accessibleLabels from './agentic/accessibleLabels.js';
import llmsTxtRecommendations from './agentic/llmsTxtRecommendations.js';
import webmcpDetection from './agentic/webmcpDetection.js';
import layoutStability from './agentic/layoutStability.js';

import reviewRatingSchema from './geo/reviewRatingSchema.js';
import comparisonContent from './geo/comparisonContent.js';
import externalCitations from './geo/externalCitations.js';
import freshnessSignals from './geo/freshnessSignals.js';
import authorExpertise from './geo/authorExpertise.js';
import geoLlmsTxt from './geo/llmsTxt.js';
import entityMentions from './geo/entityMentions.js';
import qaContent from './geo/qaContent.js';

const seoChecks = [
  titleTag,
  metaDescription,
  headings,
  canonical,
  hreflang,
  langAttribute,
  viewport,
  favicon,
  openGraph,
  twitterCard,
  schemaOrg,
  noindex,
  imageAlt,
  links,
  friendlyUrl,
  ampFlash,
  robotsTxt,
  xmlSitemap,
  httpsRedirect,
  dnsRecords,
  analyticsTracking,
  facebookPixel,
  socialProfiles,
  inlineStyles,
  iframes,
  emailPrivacy,
  deprecatedHtml,
  compression,
  pageWeight,
  contentAmount,
  keywordConsistency,
];

const aeoChecks = [llmsTxt, identitySchema, structuredDataRich, answerability, localBusinessSchema, aiCrawlerAccess];

const agenticChecks = [accessibleLabels, llmsTxtRecommendations, webmcpDetection];

const geoChecks = [reviewRatingSchema, comparisonContent, externalCitations, freshnessSignals, authorExpertise, geoLlmsTxt, entityMentions, qaContent];

// Only run when renderMode === 'js' — they read the shared pageData.render
// object populated by a single Playwright pass (see runAudit.js).
const optionalRenderChecks = [jsRenderGap, websiteLoadSpeed, resourceBreakdown, jsErrors, layoutStability];

export { seoChecks, aeoChecks, agenticChecks, geoChecks, optionalRenderChecks };
