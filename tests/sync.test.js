import test from 'node:test';
import assert from 'node:assert/strict';
import {zip,memoryDir,manifest} from './fixtures.js';
const events={},alarms=new Map(),idb={},routes={};let stored,calls=[];let extensions=[];
const event=name=>({addListener:fn=>events[name]=fn});
const SELF='p'.repeat(32),ROOT='a'.repeat(32);
globalThis.chrome={
 storage:{local:{get:async()=>({state:structuredClone(stored)}),set:async({state})=>{stored=structuredClone(state);}}},
 alarms:{get:async name=>alarms.get(name),create:async(name,v)=>alarms.set(name,v),onAlarm:event('alarm')},
 downloads:{search:async()=>[],download:async()=>1,onChanged:event('download')},
 runtime:{id:SELF,getManifest:()=>({version:'1.2.0'}),onInstalled:event('installed'),onStartup:event('startup'),onMessage:event('message'),openOptionsPage:async()=>{}},action:{onClicked:event('action')},
 management:{getAll:async()=>structuredClone(extensions),getSelf:async()=>({id:SELF,name:'GitHub 插件下载器',version:'1.2.0',installType:'development',enabled:true}),onInstalled:event('m.installed'),onUninstalled:event('m.uninstalled'),onEnabled:event('m.enabled'),onDisabled:event('m.disabled')}
};
globalThis.indexedDB={open(){const req={};queueMicrotask(()=>{req.result={createObjectStore(){},close(){},transaction(){const tx={objectStore:()=>({put:(v,k)=>{idb[k]=v;return {};},get:k=>({result:idb[k]})})};queueMicrotask(()=>tx.oncomplete?.());return tx;}};req.onsuccess?.();});return req;}};
const headers={'x-ratelimit-remaining':'40','x-ratelimit-limit':'60','x-ratelimit-reset':'2000000000'};
globalThis.fetch=async url=>{url=String(url);if(!url.endsWith('/rate_limit'))calls.push(url);const route=routes[url];if(!route)return new Response('{}',{status:404});const r=await route();return r instanceof Response?r:new Response(JSON.stringify(r),{headers});};
const api='https://api.github.com',repo=(name,language,extra={})=>({full_name:'u/'+name,default_branch:'main',language,...extra});
const asset=(r,tag,name)=>({id:tag.length*10+name.length,name,updated_at:tag,size:1,browser_download_url:`https://github.com/u/${r}/releases/download/${tag}/${name}`});
const rel=(r,tag,names,prerelease=false)=>({id:tag.length,tag_name:tag,draft:false,prerelease,assets:names.map(n=>asset(r,tag,n))});
const serve=(r,tag,name,files)=>{routes[`https://github.com/u/${r}/releases/download/${tag}/${name}`]=()=>new Response(zip(files));};
routes[api+'/rate_limit']=()=>({resources:{core:{limit:60,remaining:41,reset:2000000000}}});
routes[api+'/users/u/repos?per_page=100&type=owner&sort=pushed&page=1']=()=>[repo('root-ext','JavaScript'),repo('sub-ext',null),repo('script','JavaScript'),repo('fork','JavaScript',{fork:true}),repo('py','Python'),repo('empty',null),repo('site','HTML')];
const tree=(name,paths)=>routes[`${api}/repos/u/${name}/git/trees/HEAD?recursive=1`]=()=>({tree:paths.map(path=>({path,type:'blob'}))});
tree('root-ext',['manifest.json','a.js']);tree('sub-ext',['package.json','extension/manifest.json']);tree('script',['a.user.js']);tree('site',['index.html']);
routes[`${api}/repos/u/empty/git/trees/HEAD?recursive=1`]=()=>new Response('{}',{status:409});
let rootRelease=rel('root-ext','v1.1.0',['root-ext-v1.1.0.zip','notes.json']);
routes[`${api}/repos/u/root-ext/releases?per_page=100`]=()=>[rootRelease];routes[`${api}/repos/u/root-ext/releases/latest`]=()=>rootRelease;
serve('root-ext','v1.1.0','root-ext-v1.1.0.zip',[['manifest.json',manifest('Root Ext','1.1.0')],['a.js','new']]);
const subRelease=rel('sub-ext','v2.0.0',['sub-ext-v2.0.0.zip','sub-ext-source-v2.0.0.zip'],true);
routes[`${api}/repos/u/sub-ext/releases?per_page=100`]=()=>[subRelease];
serve('sub-ext','v2.0.0','sub-ext-v2.0.0.zip',[['sub/package.json','{}'],['sub/extension/manifest.json',manifest('Sub Ext','2.0.0')]]);
routes[`${api}/repos/u/script/commits/main`]=()=>({sha:'f'.repeat(40)});
routes[`https://github.com/u/script/archive/${'f'.repeat(40)}.zip`]=()=>new Response(zip([['script-fff/a.user.js','// ==UserScript==']]));
await import('../background.js');
const send=(type,data={})=>new Promise(resolve=>events.message({type,...data},{id:SELF},resolve));
const flush=()=>send('get');const drain=async()=>{events.alarm({name:'queue'});await flush();};
const project=name=>stored.projects.find(p=>p.repo==='u/'+name);
const disk={},access={permission:'granted'};let discovered;
test('discovery finds extensions and userscripts within 1 + scanned + detected API calls',async()=>{
 await flush();calls=[];
 discovered=await send('discover',{owner:'https://github.com/u'});
 assert.equal(discovered.error,'');assert.equal(calls.length,1+5+2);assert.equal(discovered.calls,8);assert.equal(stored.quota.remaining,40);
 const by=Object.fromEntries(discovered.candidates.map(c=>[c.repo.split('/')[1],c]));
 assert.deepEqual(Object.keys(by).sort(),['root-ext','script','sub-ext']);
 assert.equal(by['root-ext'].config.pattern,'root-ext-v*.zip');assert.equal(by['root-ext'].config.prerelease,false);
 assert.equal(by['sub-ext'].config.pattern,'sub-ext-v*.zip','source package is not chosen');assert.equal(by['sub-ext'].config.prerelease,true);
 assert.deepEqual([by.script.config.mode,by.script.config.branch,by.script.kind],['source','main','userscript']);
 assert.deepEqual(Object.fromEntries(discovered.skipped.map(x=>[x.repo,x.reason])),{'u/fork':'派生仓库','u/py':'语言 Python','u/empty':'空仓库','u/site':'没有扩展清单或油猴脚本'});
});
test('import from discovery keeps global settings and batch without folder spends no API calls',async()=>{
 await send('settings',{value:{folder:'Mine',interval:60,auto:false,download:true}});
 const r=await send('import',{value:{version:1,projects:discovered.candidates.map(c=>c.config)},overwrite:true,applySettings:false});
 assert.deepEqual([r.added,r.updated,r.settings],[3,0,false]);assert.equal(stored.settings.folder,'Mine');
 calls=[];await send('check',{repos:discovered.candidates.map(c=>c.repo.toUpperCase()),download:true});
 assert.deepEqual(stored.batch.repos.length,3);await drain();
 assert.equal(calls.length,0,'missing folder must fail before GitHub requests');
 assert.ok(stored.batch.finished);assert.ok(stored.projects.every(p=>p.errorCode==='directory'&&/选择管理目录/.test(p.status)));
});
test('restoring the same folder retries failed projects; subfolder manifests set the load path',async()=>{
 idb.root=memoryDir('browser_extensions',disk,access);calls=[];extensions=[{id:ROOT,name:'Root Ext',version:'1.0.0',installType:'development',enabled:true,type:'extension'}];
 await send('directoryChanged',{same:true});assert.equal(stored.queue.length,3);events.alarm({name:'queue'});await send('noop');
 assert.equal(project('root-ext').loaded.version,'1.0.0','loaded versions refresh right after extraction');await flush();
 assert.equal(calls.filter(u=>u.startsWith(api)).length,3);
 const b=stored.batch;assert.ok(b.finished);assert.deepEqual(Object.values(b.results).map(r=>r.code),['updated','updated','updated']);
 assert.equal(project('root-ext').loadPath,'browser_extensions/u_root-ext');
 assert.equal(project('sub-ext').loadPath,'browser_extensions/u_sub-ext/extension');assert.match(project('sub-ext').status,/子目录 extension/);
 assert.equal(project('script').manifest,null);assert.match(project('script').status,/不能直接/);assert.equal(project('script').reload,undefined);
 assert.equal(new TextDecoder().decode(disk['u_root-ext']['a.js']),'new');
 assert.deepEqual(project('root-ext').reload,{version:'1.1.0',at:project('root-ext').reload.at,was:''});
});
test('management API reports loaded versions and clears reload items',async()=>{
 extensions=[{id:ROOT,name:'Root Ext',version:'1.0.0',installType:'development',enabled:true,type:'extension'}];
 await flush();assert.deepEqual(project('root-ext').loaded,{id:ROOT,version:'1.0.0',enabled:true});assert.ok(project('root-ext').reload,'old version still loaded');
 assert.equal(project('sub-ext').loaded,null);
 extensions[0].version='1.1.0';events['m.installed']({id:ROOT,version:'1.1.0'});await flush();
 assert.equal(project('root-ext').reload,undefined);assert.equal(project('root-ext').extensionId,ROOT);
 await send('reloaded',{repo:'u/sub-ext'});assert.equal(project('sub-ext').reload,undefined);
 assert.ok((await send('bind',{repo:'u/sub-ext',extensionId:'bad'})).error);
});
test('newer folder version is never downgraded unless forced; same-version reload uses onInstalled',async()=>{
 rootRelease=rel('root-ext','v1.0.5',['root-ext-v1.0.5.zip']);serve('root-ext','v1.0.5','root-ext-v1.0.5.zip',[['manifest.json',manifest('Root Ext','1.0.5')],['a.js','older']]);
 await send('check',{repo:'u/root-ext',download:true});await drain();
 assert.ok(project('root-ext').heldKey);assert.match(project('root-ext').status,/未降级/);assert.equal(new TextDecoder().decode(disk['u_root-ext']['a.js']),'new');
 await send('check',{repo:'u/root-ext',download:true});await drain();assert.equal(new TextDecoder().decode(disk['u_root-ext']['a.js']),'new','held release stays held');
 await send('check',{repo:'u/root-ext',download:true,force:true});await drain();
 assert.equal(new TextDecoder().decode(disk['u_root-ext']['a.js']),'older');assert.equal(project('root-ext').heldKey,undefined);
 extensions[0].version='1.0.5';events['m.installed']({id:ROOT,version:'1.0.5'});await flush();assert.equal(project('root-ext').reload,undefined);
 await send('check',{repo:'u/root-ext',download:true,force:true});await drain();await flush();
 assert.equal(project('root-ext').reload.was,'1.0.5');assert.ok(project('root-ext').reload,'same version needs an explicit reload signal');
 events['m.installed']({id:ROOT,version:'1.0.5'});await flush();assert.equal(project('root-ext').reload,undefined);
});
test('self reload, import overwrite modes and switching folders',async()=>{
 const p=project('root-ext');stored.projects.push({...p,repo:'u/self',extensionId:SELF,reload:{version:'1.2.0',was:'1.1.2'}});
 events.installed();await flush();assert.equal(project('self').reload,undefined);
 const changed={...discovered.candidates[0].config,pattern:'other-*.zip'};
 let r=await send('import',{value:{version:1,projects:[changed]},overwrite:false,applySettings:false});assert.deepEqual([r.added,r.updated,r.kept],[0,0,1]);
 r=await send('import',{value:{version:1,projects:[changed]},overwrite:true,applySettings:false});assert.equal(r.updated,1);assert.equal(project('root-ext').pattern,'other-*.zip');assert.equal(project('root-ext').extractedKey!==undefined,true,'download record is kept');
 assert.ok((await send('import',{value:{version:1,projects:[]},applySettings:true})).error,'settings required when applying them');
 await send('directoryChanged',{same:false});assert.ok(stored.projects.every(p=>!p.extractedKey&&!p.loadPath&&p.manifest===undefined));
 await send('dismissBatch');assert.equal(stored.batch,undefined);
});
test('rate limit during discovery returns partial results and pauses the queue',async()=>{
 routes[`${api}/repos/u/sub-ext/git/trees/HEAD?recursive=1`]=()=>new Response('{}',{status:403,headers:{'retry-after':'120'}});
 const d=await send('discover',{owner:'u'});
 assert.match(d.error,/限流/);assert.deepEqual(d.candidates.map(c=>c.repo),['u/root-ext']);assert.deepEqual(d.unscanned,['u/sub-ext','u/script','u/empty','u/site']);
 assert.ok(stored.blockedUntil>Date.now());assert.match((await send('discover',{owner:'u'})).error,/限流中/);
 assert.ok(d.candidates[0].existing);assert.ok(d.candidates[0].diff.length,'library pattern differs from discovered one');
});
