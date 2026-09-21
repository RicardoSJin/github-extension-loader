import test from 'node:test';
import assert from 'node:assert/strict';
const events={};let stored;let nextId=1;const downloads=new Map();const alarms=new Map();let requests=0;let fail=false;
const event=name=>({addListener:fn=>events[name]=fn});
globalThis.chrome={
 storage:{local:{get:async()=>({state:structuredClone(stored)}),set:async({state})=>{stored=structuredClone(state);}}},
 alarms:{get:async name=>alarms.get(name),create:async(name,v)=>alarms.set(name,v),onAlarm:event('alarm')},
 downloads:{search:async({id})=>downloads.has(id)?[downloads.get(id)]:[],download:async options=>{const id=nextId++;downloads.set(id,{id,state:'in_progress',...options});return id;},onChanged:event('download')},
 runtime:{id:'test',onInstalled:event('installed'),onStartup:event('startup'),onMessage:event('message'),openOptionsPage:async()=>{}},action:{onClicked:event('action')}
};
globalThis.fetch=async url=>{requests++;if(fail)return {ok:false,status:429,headers:new Headers({'retry-after':'120'})};return {ok:true,json:async()=>({id:10,tag_name:'v1.0',assets:[{id:20,name:'chrome.crx',updated_at:'2026-01-01',size:5,browser_download_url:'https://github.com/a/b/releases/download/v1/chrome.crx'}]})};};
await import('../background.js');
const send=(type,data={})=>new Promise(resolve=>events.message({type,...data},{id:'test'},resolve));
const flush=()=>send('get');
test('persistent queue, download completion, deduplication, retry and limits',async()=>{
 await send('add',{text:'https://github.com/a/b\nhttps://github.com/A/B\nhttps://evil.test/a/b'});
 assert.equal((await flush()).projects.length,1);
 await send('check',{download:true});assert.equal(stored.queue.length,1);assert.equal(requests,0);
 events.alarm({name:'queue'});await flush();let p=stored.projects[0];assert.ok(p.pending);assert.equal(p.downloadedKey,undefined);assert.equal(downloads.size,1);
 downloads.get(p.pending.id).state='complete';events.download({state:{current:'complete'}});await flush();p=stored.projects[0];assert.equal(p.downloadedVersion,'v1.0');assert.equal(p.pending,undefined);
 await send('check',{download:true});events.alarm({name:'queue'});await flush();assert.equal(downloads.size,1,'same version must not redownload');
 await send('check',{download:true,force:true});events.alarm({name:'queue'});await flush();p=stored.projects[0];assert.equal(downloads.size,2);
 downloads.get(p.pending.id).state='interrupted';events.download({state:{current:'interrupted'}});await flush();assert.equal(stored.projects[0].pending,undefined);assert.match(stored.projects[0].status,/中断/);
 const before=structuredClone(stored);const invalid=await send('import',{value:{version:1,settings:{folder:'../escape',interval:5},projects:[]}});assert.ok(invalid.error);assert.deepEqual(stored,before);
 fail=true;await send('check');events.alarm({name:'queue'});await flush();assert.ok(stored.blockedUntil>Date.now());assert.match(stored.projects[0].status,/限流/);
});
test('startup recovers completed download and drains persisted tasks',async()=>{
 fail=false;stored.blockedUntil=0;
 stored.settings.auto=false;
 stored.projects[0].pending={id:900,key:'recovered',version:'v2'};
 downloads.set(900,{id:900,state:'complete'});
 stored.queue=[{repo:'a/b',download:false,force:false,automatic:false}];
 events.startup();await flush();assert.equal(stored.projects[0].downloadedVersion,'v2');assert.equal(stored.queue.length,0);
 const count=requests;
 stored.queue=[{repo:'a/b',download:true,force:false,automatic:true}];
 events.alarm({name:'queue'});await flush();assert.equal(requests,count,'disabled automation must skip previously queued automatic work');
});
