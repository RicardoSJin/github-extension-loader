import {defaults, repoFrom, safeName, settings, chooseAsset, assetKey, projectConfig, ownerFrom, discoveryTargets, repoKind, discoverConfig, configDiff, sameConfig, extensionManifest, compareVersions, matchExtension, reloadDone} from './core.js';
import {directory,readyDirectory,writeFiles,readManifest} from './filesystem.js';
import {boundedBytes,unpack} from './zip.js';
// Must equal manifest.json version (checked by tests); lets the page detect a stale service worker script.
const WORKER = '1.2.0';
let chain = Promise.resolve();
let quota;
function serial(fn) { const next = chain.then(fn); chain = next.catch(() => {}); return next; }
async function read() { const {state} = await chrome.storage.local.get('state'); return state || {settings: {...defaults}, projects: [], logs: []}; }
async function save(s) { if (quota) s.quota = quota; await chrome.storage.local.set({state:s}); }
function log(s, repo, message) { s.logs.unshift({time:Date.now(), repo, message}); s.logs = s.logs.slice(0,150); }
const clock = t => new Date(t).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
function rate(response) {
  const h = response.headers, left = h?.get?.('x-ratelimit-remaining');
  if (left != null && left !== '') quota = {remaining:Number(left), limit:Number(h.get('x-ratelimit-limit') || 60), reset:Number(h.get('x-ratelimit-reset') || 0)*1000};
}
async function api(path, missing = '未找到项目或发布版本（仅支持公开仓库）') {
  const response = await fetch('https://api.github.com' + path, {headers:{Accept:'application/vnd.github+json'}, signal:AbortSignal.timeout(25000)});
  rate(response);
  if (!response.ok) {
    const e = new Error(response.status === 404 ? missing : `GitHub 请求失败 (${response.status})`); e.status = response.status;
    if (response.status === 403 || response.status === 429) {
      e.message = 'GitHub 限流或拒绝访问，稍后重试';
      e.retryAt = Math.max(Date.now()+60000, Number(response.headers.get('x-ratelimit-reset') || 0)*1000, Date.now()+Number(response.headers.get('retry-after') || 60)*1000);
    }
    throw e;
  }
  return response.json();
}
async function inspect(p) {
  const base = '/repos/' + p.repo;
  if (p.mode === 'source') {
    const branch = p.branch || (await api(base)).default_branch;
    const commit = await api(base + '/commits/' + encodeURIComponent(branch));
    return {key:commit.sha, version:commit.sha.slice(0,12), name:'source.zip', url:`https://github.com/${p.repo}/archive/${commit.sha}.zip`, assets:[], source:true};
  }
  let release;
  if (p.prerelease) release = (await api(base + '/releases?per_page=100')).find(r => !r.draft);
  else release = await api(base + '/releases/latest', '未找到正式版发布（仓库不存在、未公开或只有预发布版本）：可勾选“包含预发布版本”或改为跟踪源码');
  if (!release) throw new Error('没有可用的发布版本，可改为跟踪源码');
  const assets = release.assets.filter(a => /\.(zip|crx|xpi)$/i.test(a.name));
  const asset = chooseAsset(assets, p.pattern);
  return {key:asset ? assetKey(release,asset) : '', version:release.tag_name, name:asset?.name, url:asset?.browser_download_url, assets:assets.map(a=>a.name), source:false};
}
async function reconcile(s) {
  for (const p of s.projects) {
    if (!p.pending) continue;
    const [d] = await chrome.downloads.search({id:p.pending.id});
    if (d?.state === 'in_progress') continue;
    if (d?.state === 'complete') {
      p.downloadedKey = p.pending.key; p.downloadedVersion = p.pending.version; p.lastDownloadId = d.id; p.status = '下载完成';
      log(s,p.repo,`下载完成：${p.pending.version}`);
    } else { p.status = '下载中断，可重新下载'; log(s,p.repo,d?.error || '下载记录已丢失'); }
    delete p.pending;
  }
}
async function check(s,p,download=false,force=false) {
  if (p.pending) return {code:'skipped', message:'下载进行中'};
  const interval = (p.interval || s.settings.interval)*60000; let code, retry = false;
  try {
    // Confirm folder access before spending API quota on projects that will be extracted.
    let root = download && (p.mode === 'source' || /\.zip$/i.test(p.latest?.name || p.pattern || '')) ? await readyDirectory() : null;
    p.latest = await inspect(p); p.checkedAt = Date.now(); p.failures = 0; delete p.errorCode;
    const zip = /\.zip$/i.test(p.latest.name || '');
    if (!p.latest.url) { p.status = p.latest.assets.length ? '请选择发布包或填写唯一匹配规则' : '没有插件发布包，可改为跟踪源码'; code = 'choose'; }
    else if (!force && p.latest.key === p.heldKey) code = 'held';
    else if (!force && p.latest.key === p.downloadedKey && (!zip || p.extractedKey===p.latest.key)) { p.status = p.extractedKey?'已解压最新版本':'已下载最新版本'; code = 'latest'; }
    else if (!download) { p.status = '发现可下载版本'; code = 'available'; }
    else {
      const u = new URL(p.latest.url);
      if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('发布包下载地址不受支持');
      if(zip) {
        root ||= await readyDirectory(); p.status='正在下载并解压'; await save(s);
        const response=await fetch(p.latest.url,{signal:AbortSignal.timeout(25000)});
        if(!response.ok)throw new Error(`压缩包下载失败 (${response.status})`);
        const files=await unpack(await boundedBytes(response.body));
        const m=extensionManifest(files), old=force?null:await readManifest(root,p.repo), path=`${root.name}/${safeName(p.repo.replace('/','_'))}`;
        if(m && old && compareVersions(m.version,old.version)<0) {
          // Never silently downgrade a newer build already in the folder (e.g. a local development copy).
          Object.assign(p,{heldKey:p.latest.key,manifest:old,installPath:path,loadPath:old.dir?path+'/'+old.dir:path,status:`目录中已有更高版本 v${old.version}，未降级为 v${m.version}（可点“重新下载”覆盖）`}); code='held';
        } else {
          p.installPath=await writeFiles(root,p.repo,files); p.manifest=m; p.loadPath=m?.dir?p.installPath+'/'+m.dir:p.installPath; delete p.heldKey;
          p.downloadedKey=p.latest.key;p.extractedKey=p.latest.key;p.downloadedVersion=p.latest.version;
          if(m) p.reload={version:m.version,at:Date.now(),was:p.loaded?.version||''};
          p.status=m?(m.dir?`已解压，请加载子目录 ${m.dir}`:'已解压，可加载项目目录'):'已解压源码/脚本，不能直接作为扩展加载'; code='updated';
        }
        delete p.lastDownloadId;log(s,p.repo,`${p.status}：${p.loadPath}`);
      } else {
      const filename = [s.settings.folder,safeName(p.repo.replace('/','_'))+ '.' + p.latest.name.split('.').at(-1)].join('/');
      const id = await chrome.downloads.download({url:p.latest.url, filename, saveAs:false, conflictAction:'uniquify'});
      p.pending = {id,key:p.latest.key,version:p.latest.version}; p.status = '正在下载'; code = 'downloading';
      log(s,p.repo,`开始下载：${p.latest.version}`);
      }
    }
    p.nextCheck = Date.now()+interval;
  } catch(e) {
    p.failures = (p.failures || 0)+1; p.status = e.message; code = 'failed'; retry = !!e.retryAt;
    if (e.code === 'directory') p.errorCode = 'directory';
    p.nextCheck = Math.max(e.retryAt || 0, Date.now()+Math.min(interval,60000*2**Math.min(p.failures,10)));
    if (e.retryAt) s.blockedUntil = e.retryAt;
    log(s,p.repo,e.message);
  }
  await save(s);
  return {code, message:p.status, retry};
}
function batchStart(s, projects, download) {
  if (!s.batch || s.batch.finished) s.batch = {id:Date.now(), download, repos:[], results:{}, current:'', started:Date.now(), finished:0};
  const b = s.batch; b.download ||= download;
  for (const p of projects) { if (!b.repos.includes(p.repo)) b.repos.push(p.repo); delete b.results[p.repo]; }
  return b.id;
}
function enqueue(s, projects, download, force=false, automatic=false, batch=null) {
  s.queue ||= [];
  for (const p of projects) {
    const existing=s.queue.find(x=>x.repo===p.repo);
    if(existing) {existing.download ||= download; existing.force ||= force; existing.automatic = existing.automatic && automatic; if(batch) existing.batch = batch;}
    else s.queue.push({repo:p.repo,download,force,automatic,...(batch?{batch}:{})});
  }
}
async function drain(s) {
  await reconcile(s);
  s.queue ||= [];
  for (let n=0;n<3 && s.queue.length;n++) {
    if (s.blockedUntil > Date.now()) break;
    const job=s.queue[0];const p=s.projects.find(p=>p.repo===job.repo);
    const b=job.batch && s.batch?.id===job.batch ? s.batch : null;
    if(b){b.current=job.repo;await save(s);}
    const r=p && (!job.automatic || (s.settings.auto && p.auto)) ? await check(s,p,job.automatic?s.settings.download:job.download,job.force) : {code:'skipped',message:p?'自动检查已关闭':'项目已移除'};
    s.queue.shift();
    if(b) {
      b.current='';
      // Rate-limited batch work waits for blockedUntil instead of being reported as failed.
      if(r.retry) s.queue.push(job); else b.results[job.repo]={code:r.code,message:r.message,version:p?.latest?.version||''};
      if(!s.queue.some(x=>x.batch===b.id)) b.finished=Date.now();
    }
    await save(s);
  }
  await refreshLoaded(s); await save(s);
  if(s.queue.length) await chrome.alarms.create('queue',{when:Math.max(Date.now()+1000,s.blockedUntil||0)});
}
function upsert(s, configs, overwrite) {
  const r = {added:0, updated:0, kept:0, busy:0};
  for (const c of configs) {
    const p = s.projects.find(x => x.repo.toLowerCase() === c.repo.toLowerCase());
    if (!p) { s.projects.push({...c, status:'已导入，等待检查', nextCheck:Date.now()}); r.added++; }
    else if (!overwrite || sameConfig(p, c)) r.kept++;
    else if (p.pending) r.busy++;
    else { Object.assign(p, {...c, repo:p.repo}, {nextCheck:Date.now(), latest:null, status:'设置已更新，等待检查'}); delete p.heldKey; r.updated++; }
  }
  return r;
}
async function refreshLoaded(s) {
  if (!chrome.management?.getAll) return;
  let list, root;
  try { list = await chrome.management.getAll(); if (!list.some(e => e.id === chrome.runtime.id)) list.push(await chrome.management.getSelf()); } catch { return; }
  for (const p of s.projects) {
    if (p.manifest === undefined && p.extractedKey) {
      // One-time migration for folders extracted before manifests were recorded.
      if (root === undefined) root = await directory().then(async d => d && await d.queryPermission({mode:'readwrite'}) === 'granted' ? d : null).catch(() => null);
      if (root) {
        p.manifest = await readManifest(root, p.repo).catch(() => null);
        if (p.installPath) p.loadPath = p.manifest?.dir ? p.installPath + '/' + p.manifest.dir : p.installPath;
        if (p.manifest?.dir && /不能直接/.test(p.status || '')) p.status = `已解压，请加载子目录 ${p.manifest.dir}`;
      }
    }
    const e = matchExtension(p, list);
    if (e?.id) { p.extensionId = e.id; p.loaded = {id:e.id, version:e.version, enabled:e.enabled}; }
    else p.loaded = e?.ambiguous ? {ambiguous:e.ambiguous} : null;
    if (p.reload && reloadDone(p.reload, p.loaded)) { delete p.reload; log(s, p.repo, `浏览器已加载 v${p.loaded.version}`); }
  }
}
// Runs outside serial(): network-heavy and read-only for the library; only rate-limit state is committed.
async function discover(value) {
  const owner = ownerFrom(value), s0 = await read();
  if (s0.blockedUntil > Date.now()) throw new Error(`GitHub 限流中，请在 ${clock(s0.blockedUntil)} 后重试`);
  const limit = await fetch('https://api.github.com/rate_limit', {headers:{Accept:'application/vnd.github+json'}, signal:AbortSignal.timeout(15000)}).then(r => r.ok ? r.json() : null).catch(() => null);
  const core = limit?.resources?.core;
  if (core) quota = {remaining:core.remaining, limit:core.limit, reset:core.reset*1000};
  if (core && core.remaining < 1) throw new Error(`GitHub 匿名额度已用完，${clock(core.reset*1000)} 后重试`);
  let calls = 0; const get = (path, missing) => { calls++; return api(path, missing); };
  const repos = [];
  for (let page = 1; page <= 5; page++) { const list = await get(`/users/${owner}/repos?per_page=100&type=owner&sort=pushed&page=${page}`, '未找到该 GitHub 用户或组织'); repos.push(...list); if (list.length < 100) break; }
  const {scan, skipped} = discoveryTargets(repos), candidates = [], unscanned = []; let error = '';
  for (const r of scan) {
    if (error) { unscanned.push(r.full_name); continue; }
    try {
      let tree;
      try { tree = await get(`/repos/${r.full_name}/git/trees/HEAD?recursive=1`); } catch(e) { if (e.status === 409) { skipped.push({repo:r.full_name, reason:'空仓库'}); continue; } throw e; }
      const kind = repoKind((tree.tree || []).filter(x => x.type === 'blob').map(x => x.path));
      if (!kind.kind) { skipped.push({repo:r.full_name, reason:'没有扩展清单或油猴脚本'}); continue; }
      candidates.push(discoverConfig(r, kind, kind.kind === 'extension' ? await get(`/repos/${r.full_name}/releases?per_page=100`) : []));
    } catch(e) {
      if (!e.retryAt) { skipped.push({repo:r.full_name, reason:e.message}); continue; }
      error = `GitHub 限流，${clock(e.retryAt)} 后可继续检测`; unscanned.push(r.full_name);
      await serial(async () => { const s = await read(); s.blockedUntil = e.retryAt; await save(s); });
    }
  }
  const s = await read();
  for (const c of candidates) {
    const p = s.projects.find(x => x.repo.toLowerCase() === c.repo.toLowerCase());
    if (!p) continue;
    // Keep the user's own schedule; discovery only decides where packages come from.
    c.config = {...c.config, auto:p.auto, interval:p.interval}; c.existing = true; c.diff = configDiff(p, c.config);
  }
  await serial(async () => save(await read()));
  return {owner, candidates, skipped, unscanned, error, calls, quota};
}
async function setup() {
  if (!await chrome.alarms.get('update-tick')) await chrome.alarms.create('update-tick',{periodInMinutes:1});
}
async function tick() {
  await setup(); const s = await read(); await reconcile(s); await refreshLoaded(s);
  if (s.settings.auto) enqueue(s,s.projects.filter(p=>p.auto && (!p.nextCheck || p.nextCheck <= Date.now())),s.settings.download,false,true);
  await save(s); await drain(s);
}
chrome.runtime.onInstalled.addListener(()=>serial(async()=>{
  const s=await read(), v=chrome.runtime.getManifest().version;
  for(const p of s.projects) if(p.reload && p.extensionId===chrome.runtime.id && p.reload.version===v) {delete p.reload;log(s,p.repo,`下载器已重新加载 v${v}`);}
  await save(s); await tick();
}));
chrome.runtime.onStartup.addListener(()=>serial(tick));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='update-tick') serial(tick);else if(a.name==='queue') serial(async()=>drain(await read()));});
chrome.downloads.onChanged.addListener(d=>{if(d.state) serial(async()=>{const s=await read(); await reconcile(s); await save(s);});});
for (const name of ['onInstalled','onUninstalled','onEnabled','onDisabled']) chrome.management?.[name]?.addListener(info=>serial(async()=>{
  const s=await read();
  // Reloading an unpacked extension fires onInstalled even when the version is unchanged.
  if(name==='onInstalled') for(const p of s.projects) if(p.reload && p.extensionId===info.id && info.version===p.reload.version) {delete p.reload;log(s,p.repo,`浏览器已重新加载 v${info.version}`);}
  await refreshLoaded(s); await save(s);
}));
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if (sender.id !== chrome.runtime.id) return;
  if (m.type === 'discover') { discover(m.owner).then(reply, e=>reply({error:e.message})); return true; }
  serial(async()=>{
    await setup(); const s = await read();
    if (m.type === 'get') { await reconcile(s); await refreshLoaded(s); await save(s); return {...s, worker:WORKER}; }
    if (m.type === 'add') {
      const errors=[];
      for(const line of String(m.text).split(/\r?\n/).filter(x=>x.trim())) {
        try { const repo=repoFrom(line); if(!s.projects.some(p=>p.repo.toLowerCase()===repo.toLowerCase())) s.projects.push({...projectConfig({repo}),status:'等待检查',nextCheck:Date.now()}); }
        catch(e){errors.push(`${line}：${e.message}`);}
      }
      await save(s); return {errors};
    }
    if (m.type === 'settings') {s.settings=settings(m.value); for(const p of s.projects) p.nextCheck=Date.now()+(p.interval || s.settings.interval)*60000;}
    if (m.type === 'directoryChanged') {
      if (m.same) {
        // Same folder re-authorised: keep extracted results and retry only what failed for lack of access.
        const retry=s.projects.filter(p=>p.errorCode==='directory');
        for(const p of retry){delete p.errorCode;p.status='目录已恢复授权，等待重试';}
        if(retry.length){enqueue(s,retry,true,false,false,batchStart(s,retry,true));await save(s);await chrome.alarms.create('queue',{when:Date.now()+100});}
      } else for(const p of s.projects){for(const k of ['extractedKey','installPath','loadPath','manifest','reload','heldKey','errorCode'])delete p[k];p.nextCheck=Date.now();}
    }
    if (m.type === 'project') {
      const p=s.projects.find(p=>p.repo===m.repo); if(!p) throw new Error('项目不存在');
      if(p.pending) throw new Error('请等待当前下载完成后再修改项目');
      Object.assign(p,projectConfig({...m.value,repo:p.repo}),{nextCheck:Date.now(),latest:null,status:'设置已保存，等待检查'}); delete p.heldKey;
    }
    if (m.type === 'bind') {
      const p=s.projects.find(p=>p.repo===m.repo); if(!p) throw new Error('项目不存在');
      const id=String(m.extensionId||''); if(id && !/^[a-p]{32}$/.test(id)) throw new Error('扩展 ID 无效');
      if(id) p.extensionId=id; else delete p.extensionId;
      await refreshLoaded(s);
    }
    if (m.type === 'reloaded') for(const p of s.projects) if(!m.repo || p.repo===m.repo) delete p.reload;
    if (m.type === 'dismissBatch') delete s.batch;
    if (m.type === 'remove') { const p=s.projects.find(p=>p.repo===m.repo); if(p?.pending) throw new Error('下载进行中，请完成后移除'); s.projects=s.projects.filter(p=>p.repo!==m.repo); }
    if (m.type === 'check') {
      const want=Array.isArray(m.repos)?m.repos.map(r=>String(r).toLowerCase()):null;
      const list=s.projects.filter(p=>want?want.includes(p.repo.toLowerCase()):!m.repo || p.repo===m.repo);
      if(!list.length) return {ok:true,count:0};
      enqueue(s,list,!!m.download,!!m.force,false,m.repo?null:batchStart(s,list,!!m.download)); await save(s); await chrome.alarms.create('queue',{when:Date.now()+100}); return {ok:true,count:list.length};
    }
    if (m.type === 'import') {
      if(m.value?.version!==1 || !Array.isArray(m.value.projects) || m.value.projects.length>500) throw new Error('配置格式无效（最多 500 个项目）');
      const imported=m.value.projects.map(projectConfig), apply=m.applySettings ?? true;
      if(apply && !m.value.settings) throw new Error('配置缺少 settings，无法导入全局设置');
      const cfg=apply?settings(m.value.settings):null;
      const r=upsert(s,imported,!!m.overwrite); if(cfg) s.settings=cfg;
      await save(s); return {...r,settings:!!cfg};
    }
    if(m.type === 'clearLogs') s.logs=[];
    await save(s); return {ok:true};
  }).then(result=>{if(result!==undefined)reply(result);}).catch(e=>reply({error:e.message}));
  return true;
});
