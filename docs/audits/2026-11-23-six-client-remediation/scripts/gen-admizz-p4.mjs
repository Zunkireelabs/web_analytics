import fs from 'fs'; import { execSync } from 'child_process';
import { computeChange as pdo } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/adapters/page-data-object.js';
const REPO='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/admizz-web-dev';
const show=(p)=>execSync(`git -C ${REPO} show origin/main:${p}`,{maxBuffer:1e8}).toString();
const O='https://admizzeducation.com';
const live=JSON.parse(fs.readFileSync('base-8862-live-rev49.json','utf8'));
const m=structuredClone(live); const log=[]; const problems=[];
for (const [url,city] of [['/birgunj','birgunj'],['/janakpur','janakpur']]) {
  const e=m.pages[url]; if(!e){problems.push('no entry '+url);continue;}
  e.adapters={...(e.adapters||{}),faq:{id:'page-data-object',dataFile:`src/data/cities/${city}.ts`,exportName:`${city}Data`,itemsPath:['faq','items'],itemKeys:{question:'q',answer:'a'}}};
  const site={id:8862,url_file_map:m};
  const r=await pdo(site,{action_type:'faq',content:{page:O+url,items:[{question:'Dry-run question?',answer:'Dry-run answer.'}]}},async(s,f)=>({content:show(f)}),'main');
  log.push({url,ok:r.ok,file:r.filePath,reason:r.ok?undefined:r.reason+': '+r.error});
  if(!r.ok) problems.push(url+' '+r.reason+' '+r.error);
  else if(!/q: "Dry-run question\?", a: "Dry-run answer\."/.test(r.newContent)) problems.push(url+' wrote the wrong item keys');
}
m._rev=live._rev; fs.writeFileSync('admizz-8862-phase4-city-data-faq-map.json',JSON.stringify(m,null,2));
fs.writeFileSync('admizz-8862-phase4-change-log.json',JSON.stringify({site:8862,baseRev:live._rev,dryRuns:log,problems},null,2));
console.log(JSON.stringify(log,null,1)); console.log('problems:',problems.length,problems.join('\n'));
