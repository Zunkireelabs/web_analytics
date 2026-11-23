import fs from 'fs';
import { resolveFile } from '/Users/yukta/Projects/web_analytics/server/implementers/lib/url-file-map.js';
const files=new Set(fs.readFileSync('adm-files.txt','utf8').split('\n').filter(Boolean));
const base=JSON.parse(fs.readFileSync('base-8862.json','utf8'));
const site={id:8862,url_file_map:base}; const O='https://admizzeducation.com';
const dirs=[...new Set([...files].map(f=>f.match(/^src\/app\/([a-z0-9-]+)\/page\.tsx$/i)?.[1]).filter(Boolean))];
const mism=[];
for (const d of dirs) {
  const own=`src/app/${d}/page.tsx`;
  const entry=base.pages['/'+d]||base.pages['/'+d+'/'];
  const got=resolveFile(site,O+'/'+d), gotSlash=resolveFile(site,O+'/'+d+'/');
  if (entry && entry.file===own) continue;
  if (got!==own) mism.push({d,noSlash:got,withSlash:gotSlash,hasEntry:!!entry,entryFile:entry?.file});
}
console.log('own-folder pages:',dirs.length,'| not resolving to their own file (no trailing slash):',mism.length);
for (const x of mism) console.log(' ',x.d.padEnd(70),'->',String(x.noSlash).padEnd(30),x.hasEntry?('ENTRY file='+x.entryFile):'');
fs.writeFileSync('adm-mismatch.json',JSON.stringify(mism,null,1));
// map entries whose file is missing
const miss=Object.entries(base.pages).filter(([u,e])=>e.file&&!files.has(e.file)).map(([u,e])=>u+' -> '+e.file);
console.log('\nmapped pages whose file is missing in repo:',miss.length); miss.forEach(x=>console.log(' ',x));
