import fs from 'fs';
import { computeChange } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/adapters/data-array-content.js';
import { resolveNotApplicable, resolveFile } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/lib/url-file-map.js';
const live=JSON.parse(fs.readFileSync(fs.readdirSync('.').find(f=>/^base-1-live-rev\d+\.json$/.test(f)),'utf8'));
const m=structuredClone(live); const problems=[]; const dry=[];
const base={id:'data-array-content',format:'js-export-array',idField:'id',dataFile:'src/_data/industries.js'};
if(m.patterns.some(p=>p.match==='^/industries/([^/]+)/?$')) problems.push('industries pattern already present');
m.patterns.push({match:'^/industries/([^/]+)/?$',adapters:{
  'meta-title':{...base,fields:{title:'title',metaDescription:'description'}},
  faq:{...base,itemsField:'faq'},
  'internal-links':{...base,itemsField:'relatedPosts'},
  'expand-content':{...base,fields:{expandedContent:'expandedContent'}},
  'qa-content':{...base,fields:{qaContent:'qaContentHtml'}},
}});
m.notApplicable=[...(m.notApplicable||[]),
  {match:'^/industries/([^/]+)/?$',actions:['schema'],reason:"The industry template already renders the page's FAQPage, Service and Organization JSON-LD from the entry's own data (faq, title, description), so a schema draft would duplicate it."},
  {match:'^/products/(orca|search|ai-crm)/?$',actions:['schema'],reason:"The product template already renders the page's FAQPage, Service and SoftwareApplication JSON-LD from platformProducts.js, so a schema draft would duplicate it."}];
const site={id:1,url_file_map:m}; const O='https://zunkireelabs.com';
const content=fs.readFileSync('zun-industries-stage.js','utf8');
for(const id of ['education','agencies','healthcare','real-estate']){
  const page=`${O}/industries/${id}/`;
  const drafts={
    'meta-title':{action_type:'meta-title',content:{page,selectedTitle:'Dry-run title for validation only',metaDescription:'Dry-run description.'}},
    faq:{action_type:'faq',content:{page,items:[{question:`Dry-run question for ${id}?`,answer:'Dry-run answer.'}]}},
    'internal-links':{action_type:'internal-links',content:{page,suggestions:[{anchorText:'a',targetUrl:O+'/blog/example-post/',targetTitle:'Example post title'}]}},
    'expand-content':{action_type:'expand-content',content:{page,sections:[{heading:'Dry-run heading',body:'Dry-run body text.'}]}},
    'qa-content':{action_type:'qa-content',content:{page,items:[{question:'Dry-run Q?',answer:'Dry-run A.'}]}},
  };
  for(const [t,d] of Object.entries(drafts)){
    const r=await computeChange(site,d,async()=>({content}),'main'); let note='';
    if(r.ok){ const out=r.newContent;
      if(t==='faq'&&!out.includes(`Dry-run question for ${id}?`)) note='faq not written';
      if(t==='internal-links'&&!(out.includes('title: "Example post title"')&&out.includes('href: "/blog/example-post/"'))) note='related post not written with title/href';
      if(t==='expand-content'&&!out.includes('expandedContent')) note='expandedContent missing';
      if(t==='qa-content'&&!out.includes('qaContentHtml')) note='qaContentHtml missing'; }
    const ok=r.ok&&!note; dry.push({industry:id,action:t,ok,reason:ok?undefined:(r.reason||note)+': '+String(r.error||'').slice(0,100)});
    if(!ok) problems.push(`${id} ${t}: ${r.reason||note} ${String(r.error||'').slice(0,100)}`);
  }
  if(!resolveNotApplicable(site,page,'schema')) problems.push('schema not declared for '+id);
}
for(const p of ['orca','search','ai-crm']) if(!resolveNotApplicable(site,`${O}/products/${p}/`,'schema')) problems.push('schema not declared for '+p);
if(resolveNotApplicable(site,`${O}/products/orca/`,'faq')) problems.push('faq wrongly declared for orca');
m._rev=live._rev; fs.writeFileSync('zunkiree-1-phase2-industries-map.json',JSON.stringify(m,null,2));
fs.writeFileSync('zunkiree-1-phase2-change-log.json',JSON.stringify({site:1,baseRev:live._rev,dryRuns:dry,problems},null,2));
console.log('dry-runs ok:',dry.filter(x=>x.ok).length,'of',dry.length,'| problems:',problems.length); console.log(problems.slice(0,8).join('\n'));
