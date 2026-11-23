import fs from 'fs';
import { resolveFile, resolveAdapter } from '/Users/yukta/Projects/web_analytics/server/implementers/lib/url-file-map.js';
import { computeChange } from '/Users/yukta/Projects/web_analytics/server/implementers/adapters/data-array-content.js';
import { execSync } from 'child_process';
const REPO='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/zunkireelabs-web';
const files=new Set(fs.readFileSync('zun-files.txt','utf8').split('\n').filter(Boolean));
const show=(p)=>execSync(`git -C ${REPO} show origin/main:${p}`,{maxBuffer:1e8}).toString();
const base=JSON.parse(fs.readFileSync('base-1.json','utf8'));
const m=structuredClone(base);
const log=[];
// 1. services -> solutions rename (12 stale entries) + homepage
const rename=(u)=>u.replace('/nl/services/','/nl/solutions/').replace(/^\/services\//,'/solutions/').replace(/^\/services$/,'/solutions/');
const renameFile=(f)=>f.replace('src/pages/nl/services/','src/pages/nl/solutions/').replace('src/pages/services/','src/pages/solutions/').replace('src/pages/services.njk','src/pages/solutions.njk');
for (const [u,e] of Object.entries(base.pages)) {
  if (!e.file || files.has(e.file)) continue;
  if (/^\/(nl\/)?services/.test(u)) {
    const nf=renameFile(e.file); if(!files.has(nf)) throw new Error('no replacement '+u);
    const nu=u==='/services/'?'/solutions/':rename(u);
    delete m.pages[u]; m.pages[nu]={...e,file:nf};
    log.push({change:'rekey',from:u,to:nu,file:nf});
  } else if (u==='/') { m.pages['/']={...e,file:'src/pages/homepage-v2.njk'}; log.push({change:'refile',url:'/',file:'src/pages/homepage-v2.njk'}); }
  else if (/^\/products\//.test(u)) { delete m.pages[u]; log.push({change:'remove-dead',url:u,was:e.file,reason:'file gone; URL 301s to a case study'}); }
  else throw new Error('unhandled stale '+u);
}
// 2. new page entries
m.pages['/blog/insights/']={file:'src/blog/insights.njk'}; log.push({change:'add',url:'/blog/insights/',file:'src/blog/insights.njk',note:'listing page; the /blog/<slug> pattern wrongly matched it to a .md that does not exist'});
m.pages['/nl/solutions/ai-ecommerce/']={file:'src/pages/nl/solutions/ai-ecommerce.njk'}; log.push({change:'add',url:'/nl/solutions/ai-ecommerce/',file:'src/pages/nl/solutions/ai-ecommerce.njk'});
// 3. /solutions/ gets the FAQ adapter (page renders servicesFaq)
const sol=m.pages['/solutions/']; sol.adapters={...(sol.adapters||{}),faq:{id:'data-array-content',shape:'flat-array',format:'json-array',dataFile:'src/_data/servicesFaq.json'}};
log.push({change:'adapter',url:'/solutions/',adapter:'faq -> src/_data/servicesFaq.json'});
// 4. product FAQ adapter pattern (Orca, Search, AI CRM)
m.patterns.push({match:'^/products/(orca|search|ai-crm)/?$',adapters:{faq:{id:'data-array-content',format:'js-export-array',idField:'id',dataFile:'src/_data/platformProducts.js',itemsField:'faq'}}});
log.push({change:'pattern',match:'^/products/(orca|search|ai-crm)/?$',adapter:'faq -> src/_data/platformProducts.js (items in `faq`)'});
// ---------- validate
const site={id:1,url_file_map:m};
const problems=[];
for (const [u,e] of Object.entries(m.pages)) if (e.file && !files.has(e.file)) problems.push('missing file after change: '+u+' -> '+e.file);
const origin='https://zunkireelabs.com';
const expect={'/':'src/pages/homepage-v2.njk','/solutions/':'src/pages/solutions.njk','/solutions/app-development/':'src/pages/solutions/app-development.njk','/solutions/custom-software/':'src/pages/solutions/custom-software.njk','/nl/solutions/ai-ecommerce/':'src/pages/nl/solutions/ai-ecommerce.njk','/blog/insights/':'src/blog/insights.njk','/blog/some-post/':'src/blog/some-post.md','/nl/solutions/web-development':'src/pages/nl/solutions/web-development.njk'};
const res={};
for (const [u,f] of Object.entries(expect)) { const got=resolveFile(site,origin+u); res[u]=got; if(got!==f) problems.push(`resolve ${u}: expected ${f} got ${got}`); }
// adapter dry runs
const dry=[];
for (const [page,dataFile,id] of [['/solutions/','src/_data/servicesFaq.json',null],['/products/orca/','src/_data/platformProducts.js','orca'],['/products/search/','src/_data/platformProducts.js','search'],['/products/ai-crm/','src/_data/platformProducts.js','ai-crm']]) {
  const cfg=resolveAdapter(site,origin+page,'faq');
  if(!cfg){problems.push('no faq adapter resolves for '+page);continue;}
  const r=await computeChange(site,{action_type:'faq',content:{page:origin+page,items:[{question:'Dry-run question for '+page+'?',answer:'Dry-run answer, never applied.'}]}},async()=>({content:show(dataFile)}));
  dry.push({page,ok:r.ok,reason:r.ok?undefined:r.reason+': '+String(r.error).slice(0,120)});
  if(!r.ok) problems.push('dry-run failed '+page+': '+r.reason);
}
// the three pages that must stay unmapped / unchanged
for (const u of ['/industries/real-estate/']) if (resolveFile(site,origin+u)) problems.push('should be unmapped: '+u);
m._rev=base._rev; // engine bumps _rev itself on save; kept for the optimistic-concurrency check
fs.writeFileSync('zunkiree-1-proposed-map.json',JSON.stringify(m,null,2));
fs.writeFileSync('zunkiree-1-change-log.json',JSON.stringify({site:1,baseRev:base._rev,repoMain:execSync(`git -C ${REPO} rev-parse --short origin/main`).toString().trim(),changes:log,resolved:res,adapterDryRuns:dry,problems},null,2));
console.log('changes:',log.length,'| problems:',problems.length); console.log(problems.join('\n')); console.table(dry);
