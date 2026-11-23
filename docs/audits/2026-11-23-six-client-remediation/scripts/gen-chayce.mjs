import fs from 'fs';
import { resolveFile } from '/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/lib/url-file-map.js';
const files=new Set(fs.readFileSync('chayce-files.txt','utf8').split('\n').filter(Boolean));
const base=JSON.parse(fs.readFileSync('base-8864.json','utf8'));
const m=structuredClone(base); const problems=[];
const pat={match:'^/blog/([^/]+)/?$',file:'src/blog/$1.md'};
if(m.patterns.some(p=>p.match===pat.match)) problems.push('pattern already present');
m.patterns.push(pat);
const site={id:8864,url_file_map:m}, O='https://chayceproperties.com';
const posts=[...files].filter(f=>/^src\/blog\/[^/]+\.md$/.test(f)).map(f=>f.slice(9,-3));
let viaPattern=0,explicit=0; const newlyCovered=[];
for(const slug of posts){
  const u=`/blog/${slug}/`; const had=resolveFile({id:8864,url_file_map:base},O+u); const got=resolveFile(site,O+u);
  if(got!==`src/blog/${slug}.md`) problems.push('wrong file for '+u+': '+got);
  if(!had){viaPattern++;newlyCovered.push(u)} else explicit++;
}
// nothing outside /blog/ may change; city pages stay unmapped
for(const u of ['/elderly-removals-corby/','/elderly-removals-leicester/','/about-chayce/','/services/']){
  const a=resolveFile({id:8864,url_file_map:base},O+u), b=resolveFile(site,O+u); if(a!==b) problems.push('unrelated URL changed: '+u);
}
for(const u of ['/blog/','/blog/page/2/','/blog/nonexistent-post/']){ const g=resolveFile(site,O+u); if(g && !files.has(g)) console.log('  note: '+u+' -> '+g+' (file missing; harmless, no such URL is audited)'); }
m._rev=base._rev; fs.writeFileSync('chayce-8864-proposed-map.json',JSON.stringify(m,null,2));
console.log('blog posts in repo:',posts.length,'| already explicit:',explicit,'| newly covered by the pattern:',viaPattern,'| problems:',problems.length); console.log(problems.join('\n')); console.log('newly covered:',newlyCovered.length);
fs.writeFileSync('chayce-8864-change-log.json',JSON.stringify({site:8864,baseRev:base._rev,change:'append pattern '+JSON.stringify(pat),newlyCovered,problems},null,2));
