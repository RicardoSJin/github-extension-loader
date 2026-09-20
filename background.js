import {defaults, repoFrom, safeName, settings, chooseAsset, assetKey, projectConfig} from './core.js';
let chain = Promise.resolve();
function serial(fn) { const next = chain.then(fn); chain = next.catch(() => {}); return next; }
async function read() { const {state} = await chrome.storage.local.get('state'); return state || {settings: {...defaults}, projects: [], logs: []}; }
async function save(s) { await chrome.storage.local.set({state:s}); }
function log(s, repo, message) { s.logs.unshift({time:Date.now(), repo, message}); s.logs = s.logs.slice(0,150); }
async function api(path) {
  const response = await fetch('https://api.github.com' + path, {headers:{Accept:'application/vnd.github+json'}, signal:AbortSignal.timeout(25000)});
  if (!response.ok) {
    const e = new Error(response.status === 404 ? '未找到项目或发布版本（第一版仅支持公开仓库）' : `GitHub 请求失败 (${response.status})`);
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
  else release = await api(base + '/releases/latest');
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
  if (p.pending) return;
  const interval = (p.interval || s.settings.interval)*60000;
  try {
    p.latest = await inspect(p); p.checkedAt = Date.now(); p.failures = 0;
    if (!p.latest.url) p.status = p.latest.assets.length ? '请选择发布包或填写唯一匹配规则' : '没有插件发布包，可改为跟踪源码';
    else if (!force && p.latest.key === p.downloadedKey) p.status = '已下载最新版本';
    else if (!download) p.status = '发现可下载版本';
    else {
      const u = new URL(p.latest.url);
      if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('发布包下载地址不受支持');
      const filename = [s.settings.folder,safeName(p.repo.replace('/','_')),safeName(p.latest.version),safeName(p.latest.name)].join('/');
      const id = await chrome.downloads.download({url:p.latest.url, filename, saveAs:false, conflictAction:'uniquify'});
      p.pending = {id,key:p.latest.key,version:p.latest.version}; p.status = '正在下载';
      log(s,p.repo,`开始下载：${p.latest.version}`);
    }
    p.nextCheck = Date.now()+interval;
  } catch(e) {
    p.failures = (p.failures || 0)+1; p.status = e.message;
    p.nextCheck = Math.max(e.retryAt || 0, Date.now()+Math.min(interval,60000*2**Math.min(p.failures,10)));
    if (e.retryAt) s.blockedUntil = e.retryAt;
    log(s,p.repo,e.message);
  }
  await save(s);
}
function enqueue(s, projects, download, force=false, automatic=false) {
  s.queue ||= [];
  for (const p of projects) {
    const existing=s.queue.find(x=>x.repo===p.repo);
    if(existing) {existing.download ||= download; existing.force ||= force; existing.automatic = existing.automatic && automatic;}
    else s.queue.push({repo:p.repo,download,force,automatic});
  }
}
async function drain(s) {
  await reconcile(s);
  s.queue ||= [];
  for (let n=0;n<3 && s.queue.length;n++) {
    if (s.blockedUntil > Date.now()) break;
    const job=s.queue[0];const p=s.projects.find(p=>p.repo===job.repo);
    if(p && (!job.automatic || (s.settings.auto && p.auto))) await check(s,p,job.automatic?s.settings.download:job.download,job.force);
    s.queue.shift();await save(s);
  }
  await save(s);
  if(s.queue.length) await chrome.alarms.create('queue',{when:Math.max(Date.now()+1000,s.blockedUntil||0)});
}
async function setup() {
  if (!await chrome.alarms.get('update-tick')) await chrome.alarms.create('update-tick',{periodInMinutes:1});
}
async function tick() {
  await setup(); const s = await read(); await reconcile(s);
  if (s.settings.auto) enqueue(s,s.projects.filter(p=>p.auto && (!p.nextCheck || p.nextCheck <= Date.now())),s.settings.download,false,true);
  await save(s); await drain(s);
}
chrome.runtime.onInstalled.addListener(()=>serial(tick));
chrome.runtime.onStartup.addListener(()=>serial(tick));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='update-tick') serial(tick);else if(a.name==='queue') serial(async()=>drain(await read()));});
chrome.downloads.onChanged.addListener(d=>{if(d.state) serial(async()=>{const s=await read(); await reconcile(s); await save(s);});});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if (sender.id !== chrome.runtime.id) return;
  serial(async()=>{
    await setup(); const s = await read();
    if (m.type === 'get') { await reconcile(s); await save(s); return s; }
    if (m.type === 'add') {
      const errors=[];
      for(const line of String(m.text).split(/\r?\n/).filter(x=>x.trim())) {
        try { const repo=repoFrom(line); if(!s.projects.some(p=>p.repo.toLowerCase()===repo.toLowerCase())) s.projects.push({...projectConfig({repo}),status:'等待检查',nextCheck:Date.now()}); }
        catch(e){errors.push(`${line}：${e.message}`);}
      }
      await save(s); return {errors};
    }
    if (m.type === 'settings') {s.settings=settings(m.value); for(const p of s.projects) p.nextCheck=Date.now()+(p.interval || s.settings.interval)*60000;}
    if (m.type === 'project') {
      const p=s.projects.find(p=>p.repo===m.repo); if(!p) throw new Error('项目不存在');
      if(p.pending) throw new Error('请等待当前下载完成后再修改项目');
      Object.assign(p,projectConfig({...m.value,repo:p.repo}),{nextCheck:Date.now(),latest:null,status:'设置已保存，等待检查'});
    }
    if (m.type === 'remove') { const p=s.projects.find(p=>p.repo===m.repo); if(p?.pending) throw new Error('下载进行中，请完成后移除'); s.projects=s.projects.filter(p=>p.repo!==m.repo); }
    if (m.type === 'check') { enqueue(s,s.projects.filter(p=>!m.repo || p.repo===m.repo),!!m.download,!!m.force); await save(s); await chrome.alarms.create('queue',{when:Date.now()+100}); return {ok:true}; }
    if (m.type === 'import') {
      if(m.value?.version!==1 || !Array.isArray(m.value.projects) || m.value.projects.length>500) throw new Error('配置格式无效（最多 500 个项目）');
      const imported=m.value.projects.map(projectConfig); const cfg=settings(m.value.settings);
      s.settings=cfg;
      for(const p of imported) if(!s.projects.some(x=>x.repo.toLowerCase()===p.repo.toLowerCase())) s.projects.push({...p,status:'已导入，等待检查',nextCheck:Date.now()});
    }
    if(m.type === 'clearLogs') s.logs=[];
    await save(s); return {ok:true};
  }).then(result=>{if(result!==undefined)reply(result);}).catch(e=>reply({error:e.message}));
  return true;
});
