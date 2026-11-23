import fs from 'fs';
import { execSync } from 'child_process';
import { resolveFile, resolveAdapter } from '/Users/yukta/Projects/web_analytics/server/implementers/lib/url-file-map.js';
import { computeChange as metaChange } from '/Users/yukta/Projects/web_analytics/server/implementers/adapters/nextjs-metadata-export.js';
import { computeChange as pdoChange } from '/Users/yukta/Projects/web_analytics/server/implementers/adapters/page-data-object.js';
const REPO='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/admizz-web-dev';
const show=(p)=>execSync(`git -C ${REPO} show origin/main:${JSON.stringify(p).slice(1,-1)}`,{maxBuffer:1e8}).toString();
const files=new Set(fs.readFileSync('adm-files.txt','utf8').split('\n').filter(Boolean));
const base=JSON.parse(fs.readFileSync('base-8862.json','utf8'));
const O='https://admizzeducation.com';
const nm={id:'nextjs-metadata-export'};
const metaAdapters={canonical:nm,'meta-title':nm,'open-graph':nm};
const p1=structuredClone(base); const log=[]; const problems=[];
// F1 events page
p1.pages['/events/uk-education-expo-oct-2026']={...p1.pages['/events/uk-education-expo-oct-2026'],adapters:{canonical:nm,'meta-title':nm,'open-graph':nm}};
log.push({id:'F1',url:'/events/uk-education-expo-oct-2026',change:'add canonical, meta-title, open-graph adapters (nextjs-metadata-export)'});
// F2 faq adapter on 10 template pages
const f2=['/study-in-canada','/study-in-germany','/study-in-newzealand','/study-in-south-korea','/study-in-dubai-from-nepal','/study-in-finland-from-nepal','/study-in-india-from-nepal','/study-in-uae-from-nepal','/study-in-uk-from-nepal','/study-in-australia-from-nepal'];
for (const u of f2) { const e=p1.pages[u]; if(!e){problems.push('F2 missing key '+u);continue;} e.adapters={...(e.adapters||{}),faq:{id:'page-data-object'}}; log.push({id:'F2',url:u,change:'add faq adapter page-data-object'}); }
// F4a south-korea-from-nepal points at a docs file, not the route
const sk='/study-in-south-korea-from-nepal'; const skFile='src/app/study-in-south-korea-from-nepal/page.tsx';
if(!files.has(skFile)) problems.push('no own page for '+sk);
log.push({id:'F4a',url:sk,change:`file ${p1.pages[sk].file} -> ${skFile}`}); p1.pages[sk].file=skFile;
// F4b own-folder pages that today resolve to the shared [slug] file
const mism=JSON.parse(fs.readFileSync('adm-mismatch.json','utf8')).filter(x=>x.d!=='study-in-south-korea-from-nepal');
const own=[];
for (const x of mism) { const u='/'+x.d; if(p1.pages[u]||p1.pages[u+'/']) { problems.push('already has entry '+u); continue; } const f=`src/app/${x.d}/page.tsx`; if(!files.has(f)){problems.push('no file '+f);continue;} p1.pages[u]={file:f,adapters:structuredClone(metaAdapters)}; own.push(u); }
log.push({id:'F4b',change:`add ${own.length} page entries pointing each own-folder page at its own file (+ the same 3 metadata adapters the trailing-slash pattern already uses)`});
// phase 2 = phase 1 + faq for {...post} pages (needs the engine change deployed)
const p2=structuredClone(p1);
p2.patterns[3].adapters={...p2.patterns[3].adapters,faq:{id:'page-data-object'}};
const f3=['/australia-student-visa-english-test-scores-ielts-pte-toefl-2026','/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india','/germany-blocked-account-2026-nepali-students','/how-to-get-your-noc-from-nepal-for-study-abroad','/study-abroad-from-nepal','/study-in-germany-from-nepal-costs-intakes-visa-2026','/uk-student-visa-cost-2027','/uk-student-visa-from-nepal'];
const log2=[{id:'F3',change:'patterns[3] (/answers/*) gains faq page-data-object adapter'}];
for (const u of f3) { const e=p2.pages[u]; if(!e){problems.push('F3 missing key '+u);continue;} e.adapters={...(e.adapters||{}),faq:{id:'page-data-object'}}; log2.push({id:'F3',url:u,change:'add faq adapter page-data-object'}); }
// ---------- validation
const site1={id:8862,url_file_map:p1}, site2={id:8862,url_file_map:p2};
for (const u of [...own,...f2.filter(x=>p1.pages[x]),sk,'/events/uk-education-expo-oct-2026']) {
  const want=p1.pages[u].file;
  for (const form of [u,u+'/']) { const got=resolveFile(site1,O+form); if(got!==want) problems.push(`resolve ${form}: want ${want} got ${got}`); }
}
const dry={meta:{ok:0,refused:{}},faqF2:{ok:0,refused:{}},faqF3:{ok:0,refused:{}},events:{}};
const tally=(bucket,r)=>{ if(r.ok) bucket.ok++; else bucket.refused[r.reason]=(bucket.refused[r.reason]||0)+1; };
for (const u of own) { const r=await metaChange(site1,{action_type:'meta-title',content:{page:O+u,selectedTitle:'Dry-run title for validation only',metaDescription:'Dry-run description.'}},async(s,f)=>({content:show(f)}),'main'); tally(dry.meta,r); }
for (const u of f2) { if(!p1.pages[u]) continue; const r=await pdoChange(site1,{action_type:'faq',content:{page:O+u,items:[{question:'Dry-run question?',answer:'Dry-run answer.'}]}},async(s,f)=>({content:show(f)}),'main'); tally(dry.faqF2,r); }
for (const u of f3) { const r=await pdoChange(site2,{action_type:'faq',content:{page:O+u,items:[{question:'Dry-run question?',answer:'Dry-run answer.'}]}},async(s,f)=>({content:show(f)}),'main'); tally(dry.faqF3,r); if(!r.ok) dry.faqF3.refused[u]=r.reason; }
for (const t of ['canonical','meta-title','open-graph']) { const r=await metaChange(site1,{action_type:t,content:t==='meta-title'?{page:O+'/events/uk-education-expo-oct-2026',selectedTitle:'Dry run',metaDescription:'d'}:t==='canonical'?{page:O+'/events/uk-education-expo-oct-2026',canonicalUrl:O+'/events/uk-education-expo-oct-2026'}:{page:O+'/events/uk-education-expo-oct-2026',ogTitle:'Dry run',ogDescription:'d'}},async(s,f)=>({content:show(f)}),'main'); dry.events[t]=r.ok?'ok':r.reason+': '+String(r.error).slice(0,90); }
p1._rev=base._rev; p2._rev=base._rev;
fs.writeFileSync('admizz-8862-phase1-config-only-map.json',JSON.stringify(p1,null,2));
fs.writeFileSync('admizz-8862-phase2-needs-engine-map.json',JSON.stringify(p2,null,2));
fs.writeFileSync('admizz-8862-change-log.json',JSON.stringify({site:8862,baseRev:base._rev,repoMain:execSync(`git -C ${REPO} rev-parse --short origin/main`).toString().trim(),phase1:log,phase2AddsOnTop:log2,ownFolderPagesAdded:own,dryRuns:dry,problems},null,2));
console.log('own-folder entries added:',own.length,'| problems:',problems.length); console.log(problems.join('\n')); console.log(JSON.stringify(dry,null,1));
