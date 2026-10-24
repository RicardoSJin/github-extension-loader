import {deflateRawSync} from 'node:zlib';
import {crc32} from '../zip.js';
export function zip(entries){let offset=0;const locals=[],central=[];for(const [name,body]of entries){const n=Buffer.from(name),data=Buffer.from(body),compressed=deflateRawSync(data),l=Buffer.alloc(30),c=Buffer.alloc(46);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(8,8);l.writeUInt32LE(crc32(data),14);l.writeUInt32LE(compressed.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(8,10);c.writeUInt32LE(crc32(data),16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);locals.push(l,n,compressed);central.push(c,n);offset+=l.length+n.length+compressed.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,end]);}
// In-memory File System Access directory: tree values are Uint8Array (files) or objects (folders).
export function memoryDir(name,tree,access={permission:'granted'}){
  const missing=()=>Object.assign(new Error('not found'),{name:'NotFoundError'});
  return {kind:'directory',name,tree,access,
    async queryPermission(){return access.permission;},async requestPermission(){return access.permission=access.grant||'granted';},async isSameEntry(o){return o?.tree===tree;},
    async getDirectoryHandle(n,o={}){if(!(n in tree)){if(!o.create)throw missing();tree[n]={};}if(tree[n] instanceof Uint8Array)throw new TypeError('file');return memoryDir(n,tree[n],access);},
    async getFileHandle(n,o={}){if(!(n in tree)){if(!o.create)throw missing();tree[n]=new Uint8Array();}return {kind:'file',name:n,
      async getFile(){const d=tree[n];return {size:d.length,arrayBuffer:async()=>d.buffer.slice(d.byteOffset,d.byteOffset+d.byteLength)};},
      async createWritable(){const chunks=[];return {write:async c=>chunks.push(Buffer.from(c)),close:async()=>{tree[n]=new Uint8Array(Buffer.concat(chunks));},abort:async()=>{}};}};},
    async *entries(){for(const [k,v] of Object.entries(tree))yield [k,v instanceof Uint8Array?{kind:'file',name:k}:memoryDir(k,v,access)];}};
}
export const text=s=>new TextEncoder().encode(s);
export const manifest=(name,version,extra={})=>JSON.stringify({manifest_version:3,name,version,...extra});
