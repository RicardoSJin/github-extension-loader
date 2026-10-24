import {projectConfig,batchSummary,outcomes} from './core.js';
import {directory} from './filesystem.js';
const $=s=>document.querySelector(s); let state; let toastTimer; let discovered; let installed=[];
$('#app-version').textContent='v'+chrome.runtime.getManifest().version;
function toast(message){$('#toast').textContent=message;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',6500);}
async function send(type,data={}){const r=await chrome.runtime.sendMessage({type,...data});if(r?.error)throw new Error(r.error);return r;}
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function date(t){return t?new Date(t).toLocaleString('zh-CN'):'—';}
function clock(t){return new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});}
function button(text,fn,cls){const b=el('button',text,cls);b.type='button';b.onclick=()=>action(fn,b);return b;}
async function action(fn,b){if(b)b.disabled=true;try{await fn();}catch(e){if(e?.name!=='AbortError')toast(e.message);}finally{if(b)b.disabled=false;}}
function input(form,name,label,type,value){const l=el('label',label);const i=el('input');i.name=name;i.type=type;if(type==='checkbox')i.checked=!!value;else i.value=value??'';l.append(i);form.append(l);return i;}
async function refresh(initial=false){const v=chrome.runtime.getManifest().version;let s=await send('get');
  // Right after a reload the previous worker may still answer once; confirm before warning.
  if(s.worker!==v){await new Promise(r=>setTimeout(r,1500));s=await send('get');}
  $('#worker').hidden=s.worker===v;$('#worker-version').textContent=v;render(s,initial);}
$('#worker-reload').onclick=()=>chrome.runtime.reload();
function busy(){return !!(state?.queue?.length||state?.projects.some(p=>p.pending)||(state?.batch&&!state.batch.finished));}
async function loadInstalled(){installed=(await chrome.management?.getAll().catch(()=>[])||[]).filter(e=>e.type==='extension');}
async function openExtensions(id){const url='chrome://extensions/'+(id?'?id='+id:'');try{await chrome.tabs.create({url});}catch{await navigator.clipboard.writeText(url).catch(()=>{});toast('浏览器不允许直接打开，请在地址栏粘贴：'+url);}}
// Directory bar: the handle lives in IndexedDB; permission usually falls back to "prompt" after a browser restart.
async function drawDirectory(){
  const handle=await directory().catch(()=>null);const permission=handle?await handle.queryPermission({mode:'readwrite'}).catch(()=>'prompt'):'';
  const buttons=$('#directory-buttons');buttons.replaceChildren();$('#directory').classList.toggle('warn',permission!=='granted');
  if(!handle){$('#directory-text').textContent='尚未选择管理目录。首次使用请点击“选择管理目录”，在“下载”中选择或新建存放插件的文件夹并允许写入。';buttons.append(button('选择管理目录',chooseDirectory,'primary'));}
  else if(permission!=='granted'){$('#directory-text').textContent=`浏览器需要重新确认“${handle.name}”的写入权限（通常在浏览器重启后）。恢复授权不会重新下载已解压的插件。`;buttons.append(button('恢复目录授权',restoreDirectory,'primary'),button('更换目录',chooseDirectory));}
  else{$('#directory-text').textContent=`管理目录：${handle.name} · 已授权。ZIP 解压到“${handle.name}/作者_项目”，更新后需在扩展管理页重新加载。`;buttons.append(button('更换目录',chooseDirectory));}
}
async function chooseDirectory(){
  const old=await directory().catch(()=>null);
  const handle=await window.showDirectoryPicker({id:'github-plugins',startIn:'downloads',mode:'readwrite'});
  const same=old?await old.isSameEntry(handle).catch(()=>false):false;
  await directory(handle);await send('directoryChanged',{same});await drawDirectory();
  toast(same?`已重新授权：${handle.name}，已解压的插件保持不变。`:`已授权：${handle.name}。点击“全部更新”即可解压到此目录。`);
}
async function restoreDirectory(){
  const handle=await directory();if(!handle)return chooseDirectory();
  if(await handle.requestPermission({mode:'readwrite'})!=='granted')throw new Error('未授予写入权限，请重试或更换目录');
  await send('directoryChanged',{same:true});await drawDirectory();toast('已恢复目录授权；因授权失效而失败的项目会自动重试。');
}
function owners(){const c={};for(const p of state?.projects||[]){const o=p.repo.split('/')[0];c[o]=(c[o]||0)+1;}return Object.entries(c).sort((a,b)=>b[1]-a[1])[0]?.[0];}
function drawQuota(){const q=state?.quota;$('#quota').textContent=(q?`GitHub 匿名额度：剩余 ${q.remaining}/${q.limit}，${clock(q.reset)} 重置。`:'GitHub 匿名额度为每小时 60 次。')+'检测约消耗 1 + 仓库数 + 插件数 次请求。';}
function drawCandidates(){
  const root=$('#candidates');root.replaceChildren();const d=discovered;if(!d)return;
  root.append(el('p',`${d.owner}：检测到 ${d.candidates.length} 个插件，跳过 ${d.skipped.length} 个仓库 · 本次请求 ${d.calls} 次`+(d.quota?`，剩余 ${d.quota.remaining}/${d.quota.limit}`:''),'summary'));
  if(d.error)root.append(el('p',`${d.error}。未检测：${d.unscanned.join('、')}`,'error'));
  const list=el('div',undefined,'candidates');const head=el('div',undefined,'candidate head');for(const t of ['','项目','类型','来源','包名规则','状态'])head.append(el('span',t));list.append(head);
  for(const c of d.candidates){
    const row=el('label',undefined,'candidate');const box=el('input');box.type='checkbox';box.dataset.repo=c.repo;
    const same=c.existing&&!c.diff.length;box.checked=!c.existing;box.disabled=same;box.onchange=countSelected;
    const a=el('a',c.repo);a.href='https://github.com/'+c.repo;a.target='_blank';a.rel='noreferrer';const name=el('span');name.append(a);
    const source=c.config.mode==='source'?`分支源码 ${c.config.branch}`:`Releases ${c.tag}${c.config.prerelease?' · 含预发布':''}`;
    const status=!c.existing?'新增':same?'已在项目库 · 设置相同':`已在项目库 · 勾选则覆盖：${c.diff.join('；')}`;
    row.append(box,name,el('span',c.kind==='userscript'?'油猴脚本':'扩展'),el('span',source),el('code',c.config.pattern||'—'),el('span',[status,c.note].filter(Boolean).join(' · '),c.existing&&!same?'warn-text':''));list.append(row);
  }
  root.append(list);
  if(d.skipped.length){const details=el('details');details.append(el('summary',`已跳过 ${d.skipped.length} 个仓库`));const ul=el('ul');for(const x of d.skipped)ul.append(el('li',`${x.repo}：${x.reason}`));details.append(ul);root.append(details);}
  if(d.candidates.length){const row=el('div',undefined,'row');const l=el('label');const now=el('input');now.type='checkbox';now.id='discover-now';now.checked=true;l.append(now,' 添加后立即下载检测到的全部插件');const add=button('',addDiscovered,'primary');add.id='discover-add';row.append(l,add);root.append(row);countSelected();}
}
function selected(){return [...document.querySelectorAll('#candidates input[data-repo]:checked')].map(b=>discovered.candidates.find(c=>c.repo===b.dataset.repo));}
function countSelected(){const b=$('#discover-add');if(b)b.textContent=`添加 / 更新选中的 ${selected().length} 个项目`;}
async function addDiscovered(){
  const chosen=selected(),now=$('#discover-now').checked;
  if(!chosen.length&&!now)throw new Error('请至少选择一个项目');
  const r=chosen.length?await send('import',{value:{version:1,projects:chosen.map(c=>c.config)},overwrite:true,applySettings:false}):{added:0,updated:0};
  if(now)await send('check',{repos:discovered.candidates.map(c=>c.repo),download:true});
  toast(`新增 ${r.added}，更新 ${r.updated}${r.busy?`，${r.busy} 个下载中未修改`:''}${now?'；已开始下载，进度见项目库':''}`);
  discovered=null;drawCandidates();
}
$('#discover-form').onsubmit=e=>{e.preventDefault();action(async()=>{
  const owner=$('#owner').value.trim();localStorage.setItem('owner',owner);discovered=null;$('#candidates').replaceChildren(el('p','正在检测仓库，请稍候…'));
  try{discovered=await send('discover',{owner});}catch(error){$('#candidates').replaceChildren(el('p',error.message,'error'));throw error;}
  drawCandidates();
},$('#discover'));};
const tone={updated:'ok',latest:'ok',downloading:'ok',held:'warn',choose:'warn',available:'warn',failed:'fail'};
function drawBatch(){
  const box=$('#batch'),b=state.batch;box.replaceChildren();box.hidden=!b;if(!b)return;
  const sum=batchSummary(b),head=el('div',undefined,'section-head');head.append(el('strong',`${b.download?'批量更新':'批量检查'} · ${sum.done}/${sum.total}`));if(b.finished)head.append(button('关闭',()=>send('dismissBatch')));
  const bar=el('progress');bar.max=sum.total||1;bar.value=sum.done;
  const line=b.finished?`完成：${sum.text||'无结果'} · 用时 ${Math.max(1,Math.round((b.finished-b.started)/1000))} 秒`:state.blockedUntil>Date.now()?`GitHub 限流，${clock(state.blockedUntil)} 后自动继续`:`正在处理 ${b.current||'队列'}…${sum.text?' · '+sum.text:''}`;
  const list=el('div',undefined,'results');
  for(const repo of b.repos){const r=b.results[repo];const row=el('div',undefined,'result');row.append(el('span',repo),el('span',r?outcomes[r.code]||r.code:repo===b.current?'处理中':'等待','badge '+(r&&tone[r.code]||'wait')),el('span',r?[r.version,r.code==='latest'?'':r.message].filter(Boolean).join(' · '):''));list.append(row);}
  box.append(head,bar,el('p',line),list);
}
function drawReload(){
  const box=$('#reload'),items=state.projects.filter(p=>p.reload);box.replaceChildren();box.hidden=!items.length;if(!items.length)return;
  const head=el('div',undefined,'section-head'),top=el('div',undefined,'buttons');head.append(el('strong',`待加载 / 待重新加载 (${items.length})`));top.append(button('打开扩展管理页',()=>openExtensions()),button('全部标记为已处理',()=>send('reloaded')));head.append(top);
  box.append(head,el('p','已加载的点击“重新加载”；尚未加载的用“加载已解压的扩展程序”选择下方目录。浏览器加载新版本后会自动移出列表。'));
  for(const p of items){
    const row=el('div',undefined,'reload-item'),info=el('div'),buttons=el('div',undefined,'buttons');
    const text=p.loaded?.version?`浏览器 v${p.loaded.version} → 目录 v${p.reload.version} · 待重新加载`:p.loaded?.ambiguous?`有 ${p.loaded.ambiguous} 个同名扩展，请在项目设置中指定`:`尚未加载 · 目录 v${p.reload.version}`;
    info.append(el('strong',p.repo),el('span',text),el('small','加载目录：'+(p.loadPath||p.installPath||'')));
    if(p.extensionId===chrome.runtime.id){const b=button('立即重新加载下载器',()=>chrome.runtime.reload(),'primary');b.disabled=busy();if(b.disabled)b.title='等待当前任务完成后再重新加载';buttons.append(b);}
    else if(p.loaded?.id)buttons.append(button('打开此扩展',()=>openExtensions(p.loaded.id)));
    buttons.append(button('我已重新加载',()=>send('reloaded',{repo:p.repo})));row.append(info,buttons);box.append(row);
  }
}
function loadedText(p){
  if(p.loaded?.ambiguous)return `有 ${p.loaded.ambiguous} 个同名扩展`;
  if(p.loaded?.version){const disk=p.manifest?.version||p.reload?.version;return `v${p.loaded.version} · `+(!p.loaded.enabled?'已停用':p.reload||disk&&disk!==p.loaded.version?`未重新加载（目录 v${disk}）`:'已是最新');}
  return p.manifest?'未加载':'—';
}
function drawProjects(){
  const root=$('#projects'); root.replaceChildren();$('#count').textContent=state.projects.length;
  if(!state.projects.length)root.append(el('div','还没有项目。用上方“一键同步全部插件”，或粘贴 GitHub 地址开始建立你的插件库。','empty'));
  for(const p of state.projects){
    const card=el('article',undefined,'project');card.dataset.repo=p.repo;
    const head=el('div',undefined,'project-head');const title=el('div');const a=el('a',p.repo,'repo');a.href='https://github.com/'+p.repo;a.target='_blank';a.rel='noreferrer';title.append(a,el('br'),el('span',p.status||'等待检查','status'));head.append(title);
    const buttons=el('div',undefined,'buttons');
    for(const [label,download,force] of [['检查',false,false],['下载新版',true,false],['重新下载',true,true]])buttons.append(button(label,async()=>{await send('check',{repo:p.repo,download,force});toast('任务已提交');}));
    if(p.lastDownloadId)buttons.append(button('查看文件',()=>chrome.downloads.show(p.lastDownloadId)));
    buttons.append(button('移除',async()=>{if(confirm('从列表移除 '+p.repo+'？已下载文件会保留。')){await send('remove',{repo:p.repo});card.remove();await refresh();}}));head.append(buttons);card.append(head);
    const meta=el('div',undefined,'meta');for(const [k,v]of [['已下载',p.downloadedVersion||'尚未下载'],['最新',p.latest?.version||'尚未检查'],['浏览器已加载',loadedText(p)],['上次检查',date(p.checkedAt)],['下次检查',state.settings.auto&&p.auto?date(p.nextCheck):'已暂停']]){const d=el('span',k+'  ');d.append(el('strong',v));meta.append(d);}card.append(meta);
    if(p.loadPath||p.installPath)card.append(el('p','加载目录：'+(p.loadPath||p.installPath)));
    const details=el('details');details.append(el('summary','项目设置 · 发布包 / 分支 / 更新周期 / 对应扩展'));const form=el('form');const fields=el('div',undefined,'fields');
    const modeLabel=el('label','下载来源');const mode=el('select');mode.name='mode';for(const [v,t]of [['release','Releases 插件包'],['source','分支源码（可能需要构建）']]){const o=el('option',t);o.value=v;mode.append(o);}mode.value=p.mode;modeLabel.append(mode);fields.append(modeLabel);
    input(fields,'pattern','包名规则（* 代表任意字符）','text',p.pattern).placeholder='例如 *chrome*.zip';input(fields,'branch','源码分支（空白 = 默认分支）','text',p.branch);
    const interval=input(fields,'interval','独立周期 / 分钟（空白 = 全局）','number',p.interval);interval.min=1;interval.max=525600;
    if(p.latest?.assets?.length){const l=el('label','从当前发布包选择');const select=el('select');const blank=el('option','选择后自动填入包名规则');blank.value='';select.append(blank);for(const name of p.latest.assets){const o=el('option',name);o.value=name;select.append(o);}select.onchange=()=>form.elements.pattern.value=select.value;l.append(select);fields.append(l);}
    const bindLabel=el('label','对应的浏览器扩展');const bind=el('select');const auto=el('option','自动按名称匹配（已解压的扩展）');auto.value='';bind.append(auto);
    for(const e of installed){const o=el('option',`${e.name} v${e.version}${e.installType==='development'?' · 已解压':''}`);o.value=e.id;bind.append(o);}
    bind.value=installed.some(e=>e.id===p.extensionId)?p.extensionId:'';bind.onchange=()=>action(async()=>{await send('bind',{repo:p.repo,extensionId:bind.value});toast('已更新对应的浏览器扩展');});bindLabel.append(bind);fields.append(bindLabel);
    form.append(fields);const checks=el('div',undefined,'checks');input(checks,'auto','自动检查此项目','checkbox',p.auto);input(checks,'prerelease','包含预发布版本','checkbox',p.prerelease);form.append(checks);const save=el('button','保存项目设置');save.type='submit';form.append(save);
    form.onsubmit=e=>{e.preventDefault();action(async()=>{const f=form.elements;await send('project',{repo:p.repo,value:{mode:f.mode.value,pattern:f.pattern.value,branch:f.branch.value,interval:f.interval.value,auto:f.auto.checked,prerelease:f.prerelease.checked}});toast('项目设置已保存');},save);};details.append(form);card.append(details);root.append(card);
  }
}
function render(s,initial=false){state=s;$('#copy-config').disabled=false;const editing=[...document.querySelectorAll('.project details[open]')];if(!editing.length)drawProjects();else{for(const card of document.querySelectorAll('.project')){const p=s.projects.find(p=>p.repo===card.dataset.repo);if(p)card.querySelector('.status').textContent=p.status;}}
  drawBatch();drawReload();drawQuota();
  if(initial){const f=$('#settings').elements;f.folder.value=s.settings.folder;f.interval.value=s.settings.interval;f.auto.checked=s.settings.auto;f.download.checked=s.settings.download;$('#owner').value||=localStorage.getItem('owner')||owners()||'RicardoSJin';}
  $('#logs').replaceChildren(...s.logs.slice(0,40).map(l=>{const d=el('div',undefined,'log');d.append(el('time',date(l.time)),el('span',`${l.repo} · ${l.message}`));return d;}));if(!s.logs.length)$('#logs').append(el('small','还没有下载记录。'));
}
$('#add').onclick=()=>action(async()=>{if(!$('#urls').value.trim())throw new Error('请先填写项目地址');const r=await send('add',{text:$('#urls').value});toast(r.errors.length?r.errors.join('\n'):'项目已添加，点击“全部更新”开始下载');if(!r.errors.length)$('#urls').value='';},$('#add'));
$('#settings').onsubmit=e=>{e.preventDefault();action(async()=>{const f=e.target.elements;await send('settings',{value:{folder:f.folder.value,interval:f.interval.value,auto:f.auto.checked,download:f.download.checked}});toast('设置已保存');});};
$('#check').onclick=()=>action(async()=>{const r=await send('check');toast(r.count?'检查任务已提交，进度见下方':'项目库为空');},$('#check'));
$('#download').onclick=()=>action(async()=>{const r=await send('check',{download:true});toast(r.count?'更新任务已提交，进度见下方':'项目库为空');},$('#download'));
$('#clear').onclick=()=>action(()=>send('clearLogs'));
function configurationText(){if(!state)throw new Error('配置尚未加载，请稍后重试');return JSON.stringify({version:1,settings:state.settings,projects:state.projects.map(projectConfig)},null,2);}
$('#export').onclick=()=>action(async()=>{const u=URL.createObjectURL(new Blob([configurationText()],{type:'application/json'}));const a=el('a');a.href=u;a.download='github-plugins-config.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);});
$('#copy-config').onclick=()=>action(async()=>{
  const text=configurationText();
  try{await navigator.clipboard.writeText(text);toast('配置已复制，可直接粘贴导入（未保存的修改不包含在内）');}
  catch{$('#copy-text').value=text;$('#copy-dialog').showModal();$('#copy-text').focus();$('#copy-text').select();}
},$('#copy-config'));
$('#copy-close').onclick=()=>$('#copy-dialog').close();
function openImport(text){$('#config-error').textContent='';if(text!==undefined)$('#config-text').value=text;$('#config-overwrite').checked=false;$('#config-settings').checked=!state?.projects.length;if(!$('#config-dialog').open)$('#config-dialog').showModal();$('#config-text').focus();}
async function importText(text){
  const clean=text.trim().replace(/^\uFEFF/,'');
  if(!clean)throw new Error('请先粘贴配置内容');
  if(new TextEncoder().encode(clean).length>1024*1024)throw new Error('配置内容超过 1 MB');
  let value;try{value=JSON.parse(clean);}catch{throw new Error('JSON 格式不正确，请粘贴完整配置，不要包含代码块标记。');}
  if(!value || value.version!==1 || !Array.isArray(value.projects))throw new Error('配置需要包含 version: 1 和 projects 字段');
  const applySettings=$('#config-settings').checked;if(applySettings&&!value.settings)throw new Error('配置中没有 settings，请取消勾选“使用配置中的全局设置”');
  const r=await send('import',{value,overwrite:$('#config-overwrite').checked,applySettings});await refresh(true);
  toast(`新增 ${r.added}，更新 ${r.updated}，保留 ${r.kept}${r.busy?`，${r.busy} 个下载中未修改`:''}；全局设置${r.settings?'已更新':'未改变'}`);
}
async function readFile(input){try{const file=input.files[0];if(!file)return;if(file.size>1024*1024)throw new Error('配置文件超过 1 MB');openImport(await file.text());}finally{input.value='';}}
$('#import').onclick=()=>$('#file').click();$('#file').onchange=()=>action(()=>readFile($('#file')));
$('#config-file').onclick=()=>$('#config-file-input').click();$('#config-file-input').onchange=()=>action(()=>readFile($('#config-file-input')));
$('#paste').onclick=()=>openImport();
$('#config-cancel').onclick=()=>$('#config-dialog').close();
$('#config-form').onsubmit=async e=>{e.preventDefault();const submit=$('#config-submit');submit.disabled=true;$('#config-error').textContent='';try{await importText($('#config-text').value);$('#config-text').value='';$('#config-dialog').close();}catch(error){$('#config-error').textContent=error.message;}finally{submit.disabled=false;}};
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.state)render(changes.state.newValue);});
document.addEventListener('toggle',e=>{if(e.target.matches('.project details')&&!e.target.open&&!document.querySelector('.project details[open]'))drawProjects();},true);
window.addEventListener('focus',()=>action(async()=>{await drawDirectory();await loadInstalled();await refresh();}));
action(async()=>{await loadInstalled();await refresh(true);await drawDirectory();});
