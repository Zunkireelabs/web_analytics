import fs from 'fs'; import { execSync } from 'child_process';
const E='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/web_analytics/server/implementers/';
const { resolveTargetAndBody, checkPostContract, computeGeneratedPostsManifestUpdate } = await import(E+'frontend.js');
const { resolveNewContentUrl, resolveNewContentNotApplicable } = await import(E+'lib/url-file-map.js');
const { slugifyTitle } = await import(E+'lib/newpage-render.js').catch(()=>({}));
const REPO='/private/tmp/claude-501/-Users-yukta-Projects-web-analytics/6ce57582-420a-4d55-bfa7-0c0f3316501a/scratchpad/clones/admizz-web-dev';
const live=JSON.parse(fs.readFileSync(fs.readdirSync('.').filter(f=>/^base-8862-live-rev\d+\.json$/.test(f)).sort().pop(),'utf8'));
const m=structuredClone(live); const problems=[];
const T=m.newContentTargets;
// 1) corrected targets
T['blog-outline']={...T['blog-outline'],dir:'src/app',urlPattern:'/{slug}',
  collisionChecks:['src/app/{slug}/page.tsx','src/content/blog/posts/{slug}.json'],
  manifestRequired:['title','excerpt','imageUrl','publishedAt','href','categories'],
  postContract:{requiredContent:['quickAnswer','faqItems','sources']}};
T['direct-answer']={dir:'src/app/answers',layout:null,filename:'page.tsx',extension:'.tsx',urlPattern:'/answers/{slug}'};
// 2) stale targets: these pages exist / are hand-built, so they can never be created
for (const k of ['landing-page','cookie-policy','terms-of-service']) delete T[k];
m.newContentNotApplicable={
  'landing-page':'Landing pages on this site are built by hand (campaign, campaign-uk, the city pages). It has no generated landing-page component, so SuperRank does not create them.',
  'cookie-policy':'The page already exists at /cookie-policy and is maintained by hand.',
  'terms-of-service':'The page already exists at /terms-of-service and is maintained by hand.',
  'privacy-policy':'The page already exists at /privacy-policy and is maintained by hand.',
  translation:'The site has no locale routes (a single English site), so there is nowhere to put a translated page.',
};
const site={id:8862,repo_owner:'Zunkireelabs',repo_name:'admizz-web-dev',repo_default_branch:'main',website_domain:'https://admizzeducation.com/',url_file_map:m};
for (const t of ['landing-page','cookie-policy','terms-of-service','privacy-policy','translation']) if(!resolveNewContentNotApplicable(site,t)) problems.push('not declared: '+t);
if (T['landing-page']||T['cookie-policy']||T['terms-of-service']) problems.push('stale targets remain');
// 3) end to end: a real blog post and a real direct answer through the engine's own functions
const img=JSON.parse(fs.readFileSync(REPO+'/src/data/generated-posts.json','utf8'))[0].imageUrl;
const show=async(s,p)=>{try{return {content:execSync(`git -C ${REPO} show origin/main:${p}`,{maxBuffer:1e8,stdio:['ignore','pipe','ignore']}).toString()}}catch{return null}};
const blog={action_type:'blog-outline',content:{title:'Engine Check Post for Admizz Validation',topic:'x',
  sections:[{heading:'What it costs',body:'The fee depends on the course length and the country. Check the official site before you pay.'}],
  quickAnswer:'This post checks that a generated post passes the Admizz content rules and builds.',
  faqItems:[{question:'Is this a real post?',answer:'No. It is a build check and is never published.'}],
  sources:[{label:'Admizz Education',url:'https://admizzeducation.com/'}],
  metaDescription:'A build check for a generated Admizz post.',categories:[{slug:'visa-guides',title:'Visa Guides'}],
  featuredImage:{url:img,alt:'Cover'},publishedAt:'2026-11-23T10:00:00.000Z'}};
const r1=await resolveTargetAndBody(site,blog,{fetchFile:show});
if(!r1.ok) problems.push('blog: '+r1.reason+' '+r1.error);
const pc=checkPostContract(site,blog.content); if(!pc.ok) problems.push('contract: '+pc.error);
const slug='engine-check-post-for-admizz-validation'; const href=resolveNewContentUrl(site,'blog-outline',blog.content.title);
const man=await computeGeneratedPostsManifestUpdate(site,{slug,title:blog.content.title,excerpt:blog.content.metaDescription,imageUrl:img,imageAlt:'Cover',categories:blog.content.categories,publishedAt:blog.content.publishedAt,href},show,'main',{ownFilePath:r1.filePath});
if(!man||!man.ok) problems.push('manifest: '+(man?.reason||'null')+' '+(man?.error||''));
const ans={action_type:'direct-answer',content:{title:'What GPA do I need for Canada',query:'What GPA do I need for Canada',directAnswer:'Most Canadian colleges ask for about a 2.5 GPA, and competitive programs ask for more.',supportingSections:[{heading:'By level',body:'Requirements differ for undergraduate and postgraduate study.'}]}};
const r2=await resolveTargetAndBody(site,ans,{fetchFile:show});
if(!r2.ok) problems.push('answer: '+r2.reason+' '+r2.error);
const out={blogFile:r1.filePath,blogHref:href,answerFile:r2.filePath};
if(r1.ok&&man?.ok&&r2.ok){
  fs.mkdirSync(REPO+'/'+r1.filePath.replace(/\/page\.tsx$/,''),{recursive:true}); fs.writeFileSync(REPO+'/'+r1.filePath,r1.body);
  fs.writeFileSync(REPO+'/'+man.filePath,man.newContent);
  fs.mkdirSync(REPO+'/'+r2.filePath.replace(/\/page\.tsx$/,''),{recursive:true}); fs.writeFileSync(REPO+'/'+r2.filePath,r2.body);
}
m._rev=live._rev; fs.writeFileSync('admizz-8862-phase5-targets-map.json',JSON.stringify(m,null,2));
fs.writeFileSync('admizz-8862-phase5-change-log.json',JSON.stringify({site:8862,baseRev:live._rev,generated:out,problems},null,2));
console.log(JSON.stringify(out)); console.log('problems:',problems.length); console.log(problems.join('\n'));
