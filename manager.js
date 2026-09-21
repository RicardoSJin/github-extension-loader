import {projectConfig} from './core.js';
import {directory} from './filesystem.js';
const $=s=>document.querySelector(s); let state; let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',6500);}
async function send(type,data={}){const r=await chrome.runtime.sendMessage({type,...data});if(r?.error)throw new Error(r.error);return r;}
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function date(t){return t?new Date(t).toLocaleString('zh-CN'):'—';}
function button(text,fn){const b=el('button',text);b.type='button';b.onclick=()=>action(fn,b);return b;}
async function action(fn,b){if(b)b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{if(b)b.disabled=false;}}
function input(form,name,label,type,value){const l=el('label',label);const i=el('input');i.name=name;i.type=type;if(type==='checkbox')i.checked=!!value;else i.value=value??'';l.append(i);form.append(l);return i;}
function drawProjects(){
  const root=$('#projects'); root.replaceChildren();$('#count').textContent=state.projects.length;
  if(!state.projects.length)root.append(el('div','还没有项目。粘贴 GitHub 地址，开始建立你的插件库。','empty'));
  for(const p of state.projects){
    const card=el('article',undefined,'project');card.dataset.repo=p.repo;
    const head=el('div',undefined,'project-head');const title=el('div');const a=el('a',p.repo,'repo');a.href='https://github.com/'+p.repo;a.target='_blank';a.rel='noreferrer';title.append(a,el('br'),el('span',p.status||'等待检查','status'));head.append(title);
    const buttons=el('div',undefined,'buttons');
    for(const [label,download,force] of [['检查',false,false],['下载新版',true,false],['重新下载',true,true]])buttons.append(button(label,async()=>{await send('check',{repo:p.repo,download,force});toast('任务已提交');}));
    if(p.lastDownloadId)buttons.append(button('查看文件',()=>chrome.downloads.show(p.lastDownloadId)));
    buttons.append(button('移除',async()=>{if(confirm('从列表移除 '+p.repo+'？已下载文件会保留。')){await send('remove',{repo:p.repo});card.remove();render(await send('get'));}}));head.append(buttons);card.append(head);
    const meta=el('div',undefined,'meta');for(const [k,v]of [['已下载',p.downloadedVersion||'尚未下载'],['最新',p.latest?.version||'尚未检查'],['上次检查',date(p.checkedAt)],['下次检查',state.settings.auto&&p.auto?date(p.nextCheck):'已暂停']]){const d=el('span',k+'  ');d.append(el('strong',v));meta.append(d);}card.append(meta);
    if(p.installPath)card.append(el('p','加载目录：'+p.installPath));
    const details=el('details');details.append(el('summary','项目设置 · 发布包 / 分支 / 更新周期'));const form=el('form');const fields=el('div',undefined,'fields');
    const modeLabel=el('label','下载来源');const mode=el('select');mode.name='mode';for(const [v,t]of [['release','Releases 插件包'],['source','分支源码（可能需要构建）']]){const o=el('option',t);o.value=v;mode.append(o);}mode.value=p.mode;modeLabel.append(mode);fields.append(modeLabel);
    input(fields,'pattern','包名规则（* 代表任意字符）','text',p.pattern).placeholder='例如 *chrome*.zip';input(fields,'branch','源码分支（空白 = 默认分支）','text',p.branch);
    const interval=input(fields,'interval','独立周期 / 分钟（空白 = 全局）','number',p.interval);interval.min=1;interval.max=525600;
    if(p.latest?.assets?.length){const l=el('label','从当前发布包选择');const select=el('select');const blank=el('option','选择后自动填入包名规则');blank.value='';select.append(blank);for(const name of p.latest.assets){const o=el('option',name);o.value=name;select.append(o);}select.onchange=()=>form.elements.pattern.value=select.value;l.append(select);fields.append(l);}
    form.append(fields);const checks=el('div',undefined,'checks');input(checks,'auto','自动检查此项目','checkbox',p.auto);input(checks,'prerelease','包含预发布版本','checkbox',p.prerelease);form.append(checks);const save=el('button','保存项目设置');save.type='submit';form.append(save);
    form.onsubmit=e=>{e.preventDefault();action(async()=>{const f=form.elements;await send('project',{repo:p.repo,value:{mode:f.mode.value,pattern:f.pattern.value,branch:f.branch.value,interval:f.interval.value,auto:f.auto.checked,prerelease:f.prerelease.checked}});toast('项目设置已保存');},save);};details.append(form);card.append(details);root.append(card);
  }
}
function render(s,initial=false){state=s;const editing=[...document.querySelectorAll('.project details[open]')];if(!editing.length)drawProjects();else{for(const card of document.querySelectorAll('.project')){const p=s.projects.find(p=>p.repo===card.dataset.repo);if(p)card.querySelector('.status').textContent=p.status;}}
  if(initial){const f=$('#settings').elements;f.folder.value=s.settings.folder;f.interval.value=s.settings.interval;f.auto.checked=s.settings.auto;f.download.checked=s.settings.download;}
  $('#logs').replaceChildren(...s.logs.slice(0,40).map(l=>{const d=el('div',undefined,'log');d.append(el('time',date(l.time)),el('span',`${l.repo} · ${l.message}`));return d;}));if(!s.logs.length)$('#logs').append(el('small','还没有下载记录。'));
}
$('#add').onclick=()=>action(async()=>{if(!$('#urls').value.trim())throw new Error('请先填写项目地址');const r=await send('add',{text:$('#urls').value});toast(r.errors.length?r.errors.join('\n'):'项目已添加，点击“全部更新”开始下载');if(!r.errors.length)$('#urls').value='';},$('#add'));
$('#settings').onsubmit=e=>{e.preventDefault();action(async()=>{const f=e.target.elements;await send('settings',{value:{folder:f.folder.value,interval:f.interval.value,auto:f.auto.checked,download:f.download.checked}});toast('设置已保存');});};
$('#check').onclick=()=>action(async()=>{await send('check');toast('检查任务已提交');});
$('#download').onclick=()=>action(async()=>{await send('check',{download:true});toast('更新任务已提交');});
$('#clear').onclick=()=>action(()=>send('clearLogs'));
$('#export').onclick=()=>action(async()=>{const value={version:1,settings:state.settings,projects:state.projects.map(projectConfig)};const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=el('a');a.href=u;a.download='github-plugins-config.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);});
$('#import').onclick=()=>$('#file').click();$('#file').onchange=()=>action(async()=>{const file=$('#file').files[0];if(!file)return;if(file.size>1024*1024)throw new Error('配置文件超过 1 MB');await send('import',{value:JSON.parse(await file.text())});render(await send('get'),true);toast('已合并新项目并导入全局设置');$('#file').value='';});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.state)render(changes.state.newValue);});
document.addEventListener('toggle',e=>{if(e.target.matches('.project details')&&!e.target.open&&!document.querySelector('.project details[open]'))drawProjects();},true);
action(async()=>render(await send('get'),true));
const directoryButton=button('选择管理目录',async()=>{
  const handle=await window.showDirectoryPicker({id:'github-plugins',startIn:'downloads',mode:'readwrite'});
  await directory(handle);await send('directoryChanged');toast('已授权：'+handle.name+'。点击“全部更新”即可解压到此目录。');
});
document.querySelector('header').append(directoryButton);
