import {safeName,extensionManifest} from './core.js';
export async function directory(value) {
  const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('plugin-directories',1);r.onupgradeneeded=()=>r.result.createObjectStore('handles');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try {return await new Promise((resolve,reject)=>{const tx=db.transaction('handles',value?'readwrite':'readonly');const r=value?tx.objectStore('handles').put(value,'root'):tx.objectStore('handles').get('root');tx.oncomplete=()=>resolve(value||r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});} finally {db.close();}
}
function directoryError(message){const e=new Error(message);e.code='directory';return e;}
export async function readyDirectory() {
  const root=await directory();
  if(!root) throw directoryError('请在管理页面点击“选择管理目录”，授权后才能自动解压');
  if(await root.queryPermission({mode:'readwrite'})!=='granted') throw directoryError('目录授权已失效，请在管理页面点击“恢复目录授权”');
  return root;
}
export async function writeFiles(root,repo,files) {
  const folder=safeName(repo.replace('/','_'));
  const target=await root.getDirectoryHandle(folder,{create:true});
  // Only replace files in this archive. Never recursively delete user directories.
  // Commit manifests (root or subfolder) last so a failed partial update is not advertised as complete.
  const last=f=>/(^|\/)manifest\.json$/.test(f.name);
  const ordered=[...files].sort((a,b)=>last(a)-last(b));
  for(const file of ordered) {
    const parts=file.name.split('/');let parent=target;
    for(const part of parts.slice(0,-1)) parent=await parent.getDirectoryHandle(part,{create:true});
    const handle=await parent.getFileHandle(parts.at(-1),{create:true});const stream=await handle.createWritable();
    try {await stream.write(file.data);await stream.close();} catch(e){await stream.abort().catch(()=>{});throw e;}
  }
  return `${root.name}/${folder}`;
}
async function fileBytes(dir,path){
  try{let d=dir;const parts=path.split('/');for(const part of parts.slice(0,-1))d=await d.getDirectoryHandle(part);const file=await (await d.getFileHandle(parts.at(-1))).getFile();return file.size>1024*1024?null:new Uint8Array(await file.arrayBuffer());}catch{return null;}
}
// Reads the manifest already on disk (root or one subfolder) without writing anything.
export async function readManifest(root,repo) {
  let folder;try{folder=await root.getDirectoryHandle(safeName(repo.replace('/','_')));}catch{return null;}
  const files=[];const add=async path=>{const data=await fileBytes(folder,path);if(data)files.push({name:path,data});return data;};
  if(!await add('manifest.json')) for await(const [name,handle] of folder.entries()) if(handle.kind==='directory') await add(name+'/manifest.json');
  for(const f of [...files]){try{const locale=JSON.parse(new TextDecoder().decode(f.data)).default_locale;if(/^[\w-]+$/.test(locale||''))await add(f.name.replace(/manifest\.json$/,'')+`_locales/${locale}/messages.json`);}catch{}}
  return extensionManifest(files);
}
