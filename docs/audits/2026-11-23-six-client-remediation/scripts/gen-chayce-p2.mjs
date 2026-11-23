import fs from 'fs';
import { computeChange } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/adapters/data-array-content.js';
import { resolveNotApplicable } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/lib/url-file-map.js';
const live=JSON.parse(fs.readFileSync(fs.readdirSync('.').find(f=>/^base-8864-live-rev\d+\.json$/.test(f)),'utf8'));
const m=structuredClone(live); const problems=[]; const dry=[];
const cityIdx=m.patterns.findIndex(p=>/elderly-removals-\(kettering/.test(p.match||''));
if(cityIdx<0) throw new Error('city pattern not found');
const base={id:'data-array-content',format:'json-array',idField:'slug',idPrefix:'elderly-removals-',dataFile:'src/_data/localAreas.json'};
const ad=m.patterns[cityIdx].adapters;
ad.faq={...base,itemsField:'localFaqs',itemKeys:{question:'q',answer:'a'}};
ad['internal-links']={...base,itemsField:'relatedPosts'};
ad['expand-content']={...base,fields:{expandedContent:'expandedContent'}};
ad['qa-content']={...base,fields:{qaContent:'qaContentHtml'}};
m.notApplicable=[...(m.notApplicable||[]),{match:m.patterns[cityIdx].match,actions:['schema'],reason:"The city template renders the Service and FAQPage JSON-LD from the entry's own data (name, county, localFaqs), so a schema draft would duplicate it."}];
m.notApplicable.push({match:'^/(care-home-removals|how-it-works|elderly-move-manager-uk|probate-house-clearance|storage-during-your-move)/?$',actions:['faq','schema'],reason:"These pages render their visible FAQ (8 to 12 items) and its FAQPage JSON-LD from the page's own front matter (faqs), so a generated FAQ or schema block would duplicate them."});
const site={id:8864,url_file_map:m}; const O='https://chayceproperties.com';
const content=fs.readFileSync('chayce-localAreas.json','utf8');
const cities=['kettering','corby','wellingborough','daventry','rushden','milton-keynes','market-harborough','leicester'];
for(const c of cities){
  const page=`${O}/elderly-removals-${c}/`;
  const drafts={
    faq:{action_type:'faq',content:{page,items:[{question:`Dry-run question for ${c}?`,answer:'Dry-run answer.'}]}},
    'internal-links':{action_type:'internal-links',content:{page,suggestions:[{anchorText:'a',targetUrl:O+'/blog/when-to-downsize-uk/',targetTitle:'When to downsize'}]}},
    'expand-content':{action_type:'expand-content',content:{page,sections:[{heading:'Dry-run heading',body:'Dry-run body text.'}]}},
    'qa-content':{action_type:'qa-content',content:{page,items:[{question:'Dry-run Q?',answer:'Dry-run A.'}]}},
  };
  for(const [t,d] of Object.entries(drafts)){
    const r=await computeChange(site,d,async()=>({content}),'main');
    let note='';
    if(r.ok){ const o=JSON.parse(r.newContent).find(x=>x.slug===c);
      if(t==='faq'&&!(o.localFaqs.some(x=>x.q?.startsWith('Dry-run')&&x.a))) note='faq not written with q/a';
      if(t==='internal-links'&&!(o.relatedPosts?.[0]?.href==='/blog/when-to-downsize-uk/')) note='related posts wrong';
      if(t==='expand-content'&&!o.expandedContent) note='expandedContent missing';
      if(t==='qa-content'&&!o.qaContentHtml) note='qaContentHtml missing';
    }
    const ok=r.ok&&!note; dry.push({city:c,action:t,ok,reason:ok?undefined:(r.reason||note)+': '+String(r.error||'').slice(0,100)});
    if(!ok) problems.push(`${c} ${t}: ${r.reason||note} ${String(r.error||'').slice(0,100)}`);
  }
  if(!resolveNotApplicable(site,page,'schema')) problems.push('schema not declared for '+c);
}
for (const u of ['care-home-removals','how-it-works','elderly-move-manager-uk','probate-house-clearance','storage-during-your-move']) for (const a of ['faq','schema']) { if(!resolveNotApplicable(site,`${O}/${u}/`,a)) problems.push('not declared: '+u+' '+a); }
for (const a of ['meta-title','internal-links','expand-content','qa-content']) { if(resolveNotApplicable(site,`${O}/care-home-removals/`,a)) problems.push('over-declared: '+a); }
m._rev=live._rev; fs.writeFileSync('chayce-8864-phase2-city-actions-map.json',JSON.stringify(m,null,2));
fs.writeFileSync('chayce-8864-phase2-change-log.json',JSON.stringify({site:8864,baseRev:live._rev,cities,dryRuns:dry,problems},null,2));
console.log('dry-runs ok:',dry.filter(x=>x.ok).length,'of',dry.length,'| problems:',problems.length); console.log(problems.slice(0,8).join('\n'));
