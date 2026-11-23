import fs from 'fs'; import path from 'path';
const E='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/';
const REPO=E+'zennly-marketplace';
const { siteForUrl, areaOf, areaNameOf } = await import(E+'web_analytics/server/implementers/lib/site-areas.js');
const { resolveFile, resolveNotApplicable, resolveNewContentNotApplicable, resolveAdapter } = await import(E+'web_analytics/server/implementers/lib/url-file-map.js');
const live=JSON.parse(fs.readFileSync(fs.readdirSync('.').filter(f=>/^base-8872-live-rev\d+\.json$/.test(f)).sort().pop(),'utf8'));
const PATHLIKE=/^src\/[\w.\-\/$]+\.(njk|md|html|js|json|css)$/;
const prefix=(v,key)=>{ if(typeof v==='string') return (PATHLIKE.test(v)||key==='file'&&v.startsWith('src/'))?'marketing/'+v:v;
  if(Array.isArray(v)) return v.map(x=>prefix(x,key)); if(v&&typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,prefix(x,k)])); return v; };

const liveRoot=live.siteRoot||{};
const bizRoot={}; for(const k of ['layoutTemplate','pageTemplates','componentTemplates','layoutTemplateEvidence','designProfile']) if(k in liveRoot) bizRoot[k]= k==='designProfile'? liveRoot[k] : prefix(liveRoot[k],k);
const NEW_TYPES=['blog-outline','direct-answer','landing-page','cookie-policy','privacy-policy','terms-of-service','translation','missing-page-create'];
const heldBiz='Held on purpose: a business-site page is Eleventy source in marketing/src plus a regenerated copy in public/businesses. Net-new pages open once the mirror-refresh Action is merged in the zennly repo and a target is proven with a real build.';
const bizNewNA=Object.fromEntries(NEW_TYPES.map(t=>[t, ['cookie-policy','privacy-policy','terms-of-service'].includes(t)?`The page already exists at /businesses/${t} and is maintained by hand.`:heldBiz]));
const mktNewNA=Object.fromEntries(NEW_TYPES.map(t=>[t,'The marketplace has no authored content pages: its pages are app screens and studio and collection pages built from data.']));
const nextMeta={ 'meta-title':{id:'nextjs-metadata-export'}, canonical:{id:'nextjs-metadata-export'}, 'open-graph':{id:'nextjs-metadata-export'} };

const next=structuredClone(live);
next.pages={}; next.patterns=[]; delete next.defaults; delete next.renderCapabilities; delete next.newContentTargets;
next.siteRoot={};
next.areas=[
 { name:'business', include:['/businesses'], override:{
    mounts:[{prefix:'/businesses'}], pages:prefix(live.pages), patterns:prefix(live.patterns), defaults:live.defaults,
    siteRoot:bizRoot, newContentTargets:{}, newContentNotApplicable:bizNewNA, renderCapabilities:live.renderCapabilities } },
 { name:'marketplace', include:[], exclude:['/businesses'], override:{
    pages:{ '/':{file:'src/app/page.tsx',adapters:nextMeta}, '/search':{file:'src/app/search/page.tsx',adapters:nextMeta} },
    patterns:[],
    siteRoot:{ layoutTemplate:'src/app/layout.tsx', sitemap:'src/app/sitemap.ts', robotsTxt:'src/app/robots.ts' },
    notApplicable:[
      { match:'^/(account|saved|auth|api)(/|$)', actions:['*'], reason:'Signed-in and app-internal screens are not search pages and must not be optimised.' },
      { match:'^/providers/[^/]+/book', actions:['*'], reason:'The booking steps are a checkout flow, not search pages.' },
      { match:'^/(providers|collections)/[^/]+/?$', actions:['meta-title','canonical','open-graph'], reason:'Their title, description and canonical are built in code from each studio or collection record (generateMetadata), not written in the file. Improve the data, not the template.' },
    ],
    newContentTargets:{}, newContentNotApplicable:mktNewNA,
    renderCapabilities:{ generator:'nextjs', extensions:{'.tsx':{markdown:false}}, derivedFrom:['.tsx: Next.js App Router page files; no markdown rendering'] } } },
];
next._rev=live._rev;
fs.writeFileSync('zennly-8872-areas-map.json',JSON.stringify(next,null,2));

// ---- proof against the real repo files
const site={id:8872,repo_owner:'Zunkireelabs',repo_name:'zennly-marketplace',repo_default_branch:'main',url_file_map:next};
const exists=(f)=>fs.existsSync(path.join(REPO,f));
const out={problems:[],business:{},marketplace:{},routing:[]};
const bizView=siteForUrl(site,'https://zennly.io/businesses/faq');
const bizPages=Object.keys(bizView.url_file_map.pages);
out.business={pages:bizPages.length,missingFiles:bizPages.filter(k=>!exists(bizView.url_file_map.pages[k].file)),withMarker:bizPages.filter(k=>exists(bizView.url_file_map.pages[k].file)&&/SEOAI/.test(fs.readFileSync(path.join(REPO,bizView.url_file_map.pages[k].file),'utf8'))).length};
const patFiles=(bizView.url_file_map.patterns||[]).map(p=>p.file.replace('$1','x').replace(/\/x\.njk$/,''));
out.business.patternDirsMissing=patFiles.filter(d=>!exists(d));
const mktView=siteForUrl(site,'https://zennly.io/');
out.marketplace={pages:Object.keys(mktView.url_file_map.pages).length,missingFiles:Object.values(mktView.url_file_map.pages).map(p=>p.file).filter(f=>!exists(f)),sitemapExists:exists('src/app/sitemap.ts'),robotsExists:exists('src/app/robots.ts'),layoutExists:exists('src/app/layout.tsx')};
for(const [u,act] of [['https://zennly.io/','meta-title'],['https://zennly.io/search','meta-title'],['https://zennly.io/providers/some-studio','meta-title'],['https://zennly.io/providers/some-studio/book/time','faq'],['https://zennly.io/account/profile','meta-title'],['https://zennly.io/businesses','meta-title'],['https://zennly.io/businesses/faq','faq'],['https://zennly.io/businesses/pricing','meta-title'],['https://zennly.io/businesses/blog/daily-reconciliation','meta-title'],['https://zennly.io/businesses/features/booking','meta-title'],['https://zennly.io/businesses/unknown-page','meta-title']]){
  const v=siteForUrl(site,u); const f=resolveFile(v,u); const na=resolveNotApplicable(v,u,act);
  out.routing.push({url:u.replace('https://zennly.io',''),area:areaNameOf(v)||'-',action:act,file:f||null,fileExists:f?exists(f):null,notApplicable:na?na.reason.slice(0,50):null,adapter:resolveAdapter(v,u,act)?.id||null});
}
for(const r of out.routing){ if(r.file&&!r.fileExists) out.problems.push('file missing: '+r.url); }
if(out.business.missingFiles.length) out.problems.push('business files missing: '+out.business.missingFiles.join(','));
if(out.marketplace.missingFiles.length) out.problems.push('marketplace files missing');
if(out.business.patternDirsMissing.length) out.problems.push('pattern dirs missing: '+out.business.patternDirsMissing);
fs.writeFileSync('zennly-8872-areas-proof.json',JSON.stringify(out,null,2));
console.log(JSON.stringify({business:out.business,marketplace:out.marketplace,problems:out.problems},null,1));
console.table(out.routing);
