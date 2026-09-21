const LIMIT=100*1024*1024;
export function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function validPath(name){
  if(!name || name.includes('\\') || name.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new Error('压缩包包含不安全路径');
  return name;
}
export async function boundedBytes(stream,limit=LIMIT){const reader=stream.getReader();const chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('压缩包或解压内容超过 100 MB 限制');chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}const out=new Uint8Array(size);let pos=0;for(const chunk of chunks){out.set(chunk,pos);pos+=chunk.length;}return out;}
export async function unpack(bytes){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
  for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--)if(v.getUint32(n,true)===0x06054b50 && n+22+v.getUint16(n+20,true)===bytes.length){end=n;break;}
  if(end<0)throw new Error('不是有效的 ZIP 压缩包');
  const count=v.getUint16(end+10,true);let pos=v.getUint32(end+16,true);
  if(v.getUint16(end+4,true)||v.getUint16(end+6,true)||count===65535||count>5000)throw new Error('不支持分卷、ZIP64 或超过 5000 文件的压缩包');
  const files=[];let total=0;
  for(let n=0;n<count;n++){
    if(pos+46>end||v.getUint32(pos,true)!==0x02014b50)throw new Error('ZIP 目录损坏');
    const flags=v.getUint16(pos+8,true),method=v.getUint16(pos+10,true),crc=v.getUint32(pos+16,true),size=v.getUint32(pos+20,true),raw=v.getUint32(pos+24,true),len=v.getUint16(pos+28,true),offset=v.getUint32(pos+42,true);
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(pos+46,pos+46+len));
    const mode=v.getUint32(pos+38,true)>>>16;
    pos+=46+len+v.getUint16(pos+30,true)+v.getUint16(pos+32,true);
    if(flags&1 || (mode&0xf000)===0xa000)throw new Error('不支持加密压缩包或符号链接');
    validPath(name.endsWith('/')?name.slice(0,-1):name);
    if(name.endsWith('/'))continue;
    total+=raw;if(total>LIMIT)throw new Error('解压内容超过 100 MB 限制');
    if(offset+30>bytes.length||v.getUint32(offset,true)!==0x04034b50)throw new Error('ZIP 文件头损坏');
    const start=offset+30+v.getUint16(offset+26,true)+v.getUint16(offset+28,true);
    if(start+size>bytes.length)throw new Error('ZIP 文件内容不完整');
    let data=bytes.slice(start,start+size);
    if(method===8)data=await boundedBytes(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')),Math.min(raw,LIMIT));
    else if(method!==0)throw new Error('不支持此 ZIP 压缩算法');
    if(data.length!==raw||crc32(data)!==crc)throw new Error('ZIP 内容校验失败');
    files.push({name,data});
  }
  if(!files.length)throw new Error('压缩包为空');
  // Strip wrapper folders, but retain resource paths inside the actual project.
  while(files.every(f=>f.name.includes('/')&&f.name.split('/')[0]===files[0].name.split('/')[0]))for(const f of files)f.name=f.name.slice(f.name.indexOf('/')+1);
  const names=new Set();for(const f of files){const key=f.name.toLowerCase();if(names.has(key))throw new Error('压缩包包含重名文件');names.add(key);}
  for(const f of files){const parts=f.name.toLowerCase().split('/');for(let i=1;i<parts.length;i++)if(names.has(parts.slice(0,i).join('/')))throw new Error('压缩包文件路径冲突');}
  return files;
}
