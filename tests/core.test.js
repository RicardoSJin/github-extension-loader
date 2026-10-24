import test from 'node:test';
import assert from 'node:assert/strict';
import {repoFrom,safeName,settings,defaults,chooseAsset,projectConfig,assetKey} from '../core.js';
test('normalize repository and reject invalid origins',()=>{
  assert.equal(repoFrom('https://github.com/owner/repo.git'),'owner/repo');
  assert.equal(repoFrom('https://github.com/owner/repo/releases'),'owner/repo');
  for(const s of ['https://github.com.evil.test/a/b','http://github.com/a/b','file:///a/b','https://github.com/a','https://user:pass@github.com/a/b'])assert.throws(()=>repoFrom(s));
});
test('safe Windows path and validated intervals',()=>{
  assert.equal(safeName('v1/a:b'),'v1_a_b');assert.equal(safeName('CON'),'_CON');
  for(const folder of ['../x','C:\\Downloads','NUL','x.'])assert.throws(()=>settings({...defaults,folder}));
  for(const interval of [0,-1,Infinity,'oops'])assert.throws(()=>settings({...defaults,interval}));
  assert.equal(projectConfig({repo:'a/b',interval:''}).interval,null);
});
test('ambiguous assets require choice; wildcard is literal except star',()=>{
  const assets=[{name:'chrome-v1.zip'},{name:'firefox-v1.zip'},{name:'source.tar.gz'}];
  assert.equal(chooseAsset(assets),null);assert.equal(chooseAsset(assets,'chrome*.zip'),assets[0]);
  assert.equal(chooseAsset(assets,'*.zip'),null);assert.equal(chooseAsset(assets,'chrome.*.zip'),null);
  assert.equal(chooseAsset([{name:'x[1].zip'}],'x[1].zip').name,'x[1].zip');
  assert.notEqual(assetKey({id:1},{id:2,updated_at:'a',size:1}),assetKey({id:1},{id:2,updated_at:'b',size:1}));
});
import {readFileSync} from 'node:fs';
import {ownerFrom,discoveryTargets,repoKind,derivePattern,pickAsset,releasePlan,discoverConfig,configDiff,sameConfig,extensionManifest,compareVersions,matchExtension,reloadDone,batchSummary} from '../core.js';
import {text,manifest} from './fixtures.js';
const release=(tag,names,prerelease=false,draft=false)=>({id:tag.length,tag_name:tag,prerelease,draft,assets:names.map((name,id)=>({id,name,updated_at:'t',size:1}))});
// Asset names copied from the real RicardoSJin releases.
const real={
  'github-extension-loader':[release('v1.2.0',['github-extension-loader-v1.2.0.zip','RicardoSJin-github-plugins.json','SHA256SUMS.txt']),release('v1.1.2',['github-extension-loader-v1.1.2.zip','RicardoSJin-github-plugins.json'])],
  'edge-chrome-sync':[release('v1.1.1',['edge-chrome-sync-v1.1.1.zip','SHA256SUMS.txt'],true),release('v1.1.0',['edge-chrome-sync-v1.1.0.zip'],true)],
  'youtube-new-tab':[release('v1.0.0',['youtube-new-tab-v1.0.0.zip','youtube-new-tab-source-v1.0.0.zip','SHA256SUMS.txt'],true)],
  'bilibili-markdown-notes':[release('v0.9.0',['bilibili-markdown-notes.zip'])],
  'ustc-auto-login':[release('v1.2.0',['ustc-auto-login-v1.2.0.zip'])],
  'chatgpt-web-enhancer':[release('v0.8.3',['chatgpt-web-enhancer-0.8.3.zip']),release('v0.8.2',['chatgpt-web-enhancer-0.8.2.zip'])],
  'deeplearning-ai-assistant':[]
};
test('owner input forms',()=>{
  for(const v of ['RicardoSJin','@RicardoSJin','https://github.com/RicardoSJin','https://github.com/RicardoSJin/repo?tab=x'])assert.equal(ownerFrom(v),'RicardoSJin');
  for(const v of ['','-x','a--b'.repeat(20),'http://github.com/x','https://evil.test/x','a/b'])assert.throws(()=>ownerFrom(v));
});
test('discovery filters repositories with reasons and detects extension layouts',()=>{
  const {scan,skipped}=discoveryTargets([{full_name:'a/js',language:'JavaScript'},{full_name:'a/none',language:null},{full_name:'a/f',fork:true},{full_name:'a/old',archived:true},{full_name:'a/py',language:'Python'}]);
  assert.deepEqual(scan.map(r=>r.full_name),['a/js','a/none']);assert.deepEqual(skipped.map(x=>x.reason),['派生仓库','已归档','语言 Python']);
  assert.deepEqual(repoKind(['manifest.json','a.js']),{kind:'extension',dir:''});
  assert.deepEqual(repoKind(['README.md','extension/manifest.json','extension/a.js']),{kind:'extension',dir:'extension'});
  assert.deepEqual(repoKind(['public/manifest.json','index.html']),{kind:''});
  assert.deepEqual(repoKind(['src/manifest.json','dist/manifest.json']),{kind:'extension',dir:'dist'});
  assert.equal(repoKind(['deeplearning-ai.user.js']).kind,'userscript');assert.equal(repoKind(['a/b/c.user.js']).kind,'');
});
test('release plans derive unique patterns from real releases',()=>{
  assert.equal(derivePattern('chatgpt-web-enhancer-0.8.3.zip','v0.8.3'),'chatgpt-web-enhancer-*.zip');
  assert.equal(derivePattern('x-1.2.3-chrome.zip','release'),'x-*-chrome.zip');assert.equal(derivePattern('plain.zip','v1'),'plain*.zip');
  assert.equal(pickAsset([{name:'x-chrome.zip'},{name:'x-edge.crx'}]).name,'x-chrome.zip');
  assert.deepEqual(pickAsset([{name:'a-chrome.zip'},{name:'b-chrome.zip'}]),{ambiguous:2});
  assert.equal(pickAsset([{name:'x-firefox.zip'},{name:'x.xpi'}]),null);
  assert.equal(releasePlan([release('v2',['x-2.zip'],false,true),release('v1',['x-1.zip'])]).tag,'v1','drafts are ignored');
  assert.equal(releasePlan([release('v2',['x-2.zip'],true),release('v1',['x-1.zip'])]).prerelease,false,'stable releases win');
  assert.equal(releasePlan([release('v1',['notes.pdf'])]),null);
  const example=JSON.parse(readFileSync(new URL('../examples/RicardoSJin-github-plugins.json',import.meta.url)));
  assert.equal(example.projects.length,7);
  for(const p of example.projects){
    const name=p.repo.split('/')[1],releases=real[name],kind=name==='deeplearning-ai-assistant'?{kind:'userscript'}:{kind:'extension',dir:''};
    assert.deepEqual(discoverConfig({full_name:p.repo,default_branch:'main'},kind,releases).config,projectConfig(p),name);
    for(const r of releases.filter(r=>p.prerelease===r.prerelease))assert.ok(chooseAsset(r.assets,p.pattern),`${name} ${r.tag_name} must match exactly one asset`);
  }
});
test('config differences are labelled',()=>{
  const a=projectConfig({repo:'a/b',pattern:'x-*.zip'}),b={...a,pattern:'x-v*.zip',prerelease:true};
  assert.ok(sameConfig(a,{...a}));assert.deepEqual(configDiff(a,b),['包名规则 x-*.zip → x-v*.zip','包含预发布 否 → 是']);
});
test('extension manifests at root or in one subfolder',()=>{
  const f=(name,data)=>({name,data:text(data)});
  assert.deepEqual(extensionManifest([f('manifest.json',manifest('A','1.0'))]),{dir:'',name:'A',version:'1.0'});
  assert.deepEqual(extensionManifest([f('extension/manifest.json','\uFEFF'+manifest('B','2.0')),f('package.json','{}')]),{dir:'extension',name:'B',version:'2.0'});
  assert.equal(extensionManifest([f('a/manifest.json',manifest('A','1')),f('b/manifest.json',manifest('B','1'))]),null);
  assert.equal(extensionManifest([f('manifest.json','{"name":"PWA","start_url":"/"}')]),null);
  assert.equal(extensionManifest([f('manifest.json',manifest('__MSG_app__','1',{default_locale:'zh_CN'})),f('_locales/zh_CN/messages.json','{"App":{"message":"名称"}}')]).name,'名称');
});
test('versions, extension matching, reload state and batch summary',()=>{
  assert.equal(compareVersions('1.10.0','1.9.9'),1);assert.equal(compareVersions('1.0','1.0.0'),0);assert.equal(compareVersions('1.0.2','1.1.1'),-1);assert.equal(compareVersions('1.0-beta','2'),0);
  const list=[{id:'a'.repeat(32),name:'X',version:'1',installType:'development'},{id:'b'.repeat(32),name:'X',version:'2',installType:'normal'},{id:'c'.repeat(32),name:'Y',version:'1',installType:'development'},{id:'d'.repeat(32),name:'Y',version:'2',installType:'development'}];
  assert.equal(matchExtension({manifest:{name:'X'}},list).id,'a'.repeat(32),'store copies are ignored');
  assert.deepEqual(matchExtension({manifest:{name:'Y'}},list),{ambiguous:2});
  assert.equal(matchExtension({manifest:{name:'Y'},extensionId:'d'.repeat(32)},list).version,'2');
  assert.equal(matchExtension({manifest:{name:'Y'},extensionId:'e'.repeat(32)},list).ambiguous,2,'stale binding falls back to name');
  assert.equal(matchExtension({},list),null);
  assert.ok(reloadDone({version:'2',was:'1'},{version:'2'}));assert.ok(!reloadDone({version:'2',was:'2'},{version:'2'}));assert.ok(!reloadDone({version:'2',was:''},null));
  assert.deepEqual(batchSummary({repos:['a','b','c'],results:{a:{code:'updated'},b:{code:'updated'},c:{code:'failed'}}}),{done:3,total:3,text:'已更新 2 · 失败 1'});
});
test('service worker version constant matches manifest',()=>{
  const version=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url))).version;
  assert.equal(readFileSync(new URL('../background.js',import.meta.url),'utf8').match(/const WORKER = '([^']+)'/)[1],version);
});
