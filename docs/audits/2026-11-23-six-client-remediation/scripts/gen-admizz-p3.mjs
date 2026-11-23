import fs from 'fs'; import { execSync } from 'child_process';
import { resolveFile } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/lib/url-file-map.js';
import { computeChange as pdo } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/adapters/page-data-object.js';
const REPO='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/admizz-web-dev';
const show=(p)=>execSync(`git -C ${REPO} show origin/main:${p}`,{maxBuffer:1e8}).toString();
const O='https://admizzeducation.com';
const base=JSON.parse(fs.readFileSync('admizz-8862-phase2-needs-engine-map.json','utf8')); // == the live map after phase 2 (verified identical)
const live=JSON.parse(fs.readFileSync('base-8862-live-rev48.json','utf8'));
const canon=(v)=>Array.isArray(v)?v.map(canon):(v&&typeof v==='object')?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const a=JSON.stringify(canon({...live,_rev:0})), b=JSON.stringify(canon({...base,_rev:0}));
if(a!==b) throw new Error('base is not the live map; regenerate');
const t=fs.readFileSync('audit-8862-after-phase2.txt','utf8');
const sm=t.match(/-- MARKERS MISSING, FATAL[^\n]*\n([\s\S]*?)(?=\n-- )/)[1];
const rows=sm.split('\n').filter(l=>/^\s*\[faq:/.test(l)).map(l=>l.match(/\] (\S+) -> (\S+)/)).map(m=>({url:new URL(m[1]).pathname,file:m[2]}));
const m=structuredClone(base); const ok=[],refused=[];
for(const r of rows){
  const entry=m.pages[r.url]; if(!entry||entry.file!==r.file){refused.push({...r,why:'no matching explicit page entry'});continue;}
  const trial={id:8862,url_file_map:structuredClone(m)}; trial.url_file_map.pages[r.url].adapters={...(entry.adapters||{}),faq:{id:'page-data-object'}};
  const res=await pdo(trial,{action_type:'faq',content:{page:O+r.url,items:[{question:'Dry-run question?',answer:'Dry-run answer.'}]}},async(s,f)=>({content:show(f)}),'main');
  if(res.ok){ m.pages[r.url].adapters={...(entry.adapters||{}),faq:{id:'page-data-object'}}; ok.push(r.url); } else refused.push({...r,why:res.reason+': '+String(res.error).slice(0,110)});
}
m._rev=live._rev; fs.writeFileSync('admizz-8862-phase3-faq-more-pages-map.json',JSON.stringify(m,null,2));
fs.writeFileSync('admizz-8862-phase3-change-log.json',JSON.stringify({site:8862,baseRev:live._rev,faqRowsInAudit:rows.length,eligible:ok,refused},null,2));
console.log('faq rows in audit:',rows.length,'| eligible & added:',ok.length,'| refused:',refused.length);
const why={}; refused.forEach(r=>why[r.why.split(':')[0]]=(why[r.why.split(':')[0]]||0)+1); console.log('refusal reasons:',why);
console.log('eligible sample:',ok.slice(0,4)); console.log('refused sample:',refused.slice(0,4).map(r=>r.url+' -> '+r.why));
