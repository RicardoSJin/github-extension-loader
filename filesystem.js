import {safeName} from './core.js';
export async function directory(value) {
  const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('plugin-directories',1);r.onupgradeneeded=()=>r.result.createObjectStore('handles');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try {return await new Promise((resolve,reject)=>{const tx=db.transaction('handles',value?'readwrite':'readonly');const r=value?tx.objectStore('handles').put(value,'root'):tx.objectStore('handles').get('root');tx.oncomplete=()=>resolve(value||r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});} finally {db.close();}
}
export async function readyDirectory() {
  const root=await directory();
  if(!root || await root.queryPermission({mode:'readwrite'})!=='granted') throw new Error('请在管理页面点击“选择管理目录”，授权后才能自动解压');
  return root;
}
export async function writeFiles(root,repo,files) {
  const folder=safeName(repo.replace('/','_'));
  const target=await root.getDirectoryHandle(folder,{create:true});
  // Only replace files in this archive. Never recursively delete user directories.
  // Commit manifest last so a failed partial update is not advertised as complete.
  const ordered=[...files].sort((a,b)=>(a.name==='manifest.json')-(b.name==='manifest.json'));
  for(const file of ordered) {
    const parts=file.name.split('/');let parent=target;
    for(const part of parts.slice(0,-1)) parent=await parent.getDirectoryHandle(part,{create:true});
    const handle=await parent.getFileHandle(parts.at(-1),{create:true});const stream=await handle.createWritable();
    try {await stream.write(file.data);await stream.close();} catch(e){await stream.abort().catch(()=>{});throw e;}
  }
  return `${root.name}/${folder}`;
}
