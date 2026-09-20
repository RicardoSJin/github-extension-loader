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
