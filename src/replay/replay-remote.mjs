// Pull a clip from a running greeter over HTTP (read-only GETs of /api/visits/:id/{meta,video,audio/mic}) into a private cache dir, so a replay can run on another machine (e.g. a Mac).
// The cache is 0700 under the OS tmp dir; remove() deletes it (--cleanup). Nothing is ever written to the device.
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validVisitIdLocal} from './replay-ids.mjs';

const fail=(m,status=400)=>Object.assign(new Error(m),{status});
export async function fetchClip({from,clipId,fetchImpl=fetch,cacheRoot=tmpdir(),maxBytes=300*1024*1024}={}){
  if(!validVisitIdLocal(clipId))throw fail('Bad clip id.');
  let base;try{base=new URL(from);}catch{throw fail('--from must be a URL like http://192.0.2.10:3031');}
  if(!/^https?:$/.test(base.protocol))throw fail('--from must be http(s).');
  const root=mkdtempSync(join(cacheRoot,'greeter-replay-cache-'));chmodSync(root,0o700);
  const dir=join(root,clipId);mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const remove=()=>{try{rmSync(root,{recursive:true,force:true});}catch{}};
  const get=async(p,{optional=false}={})=>{
    const res=await fetchImpl(new URL(`/api/visits/${clipId}/${p}`,base),{method:'GET'});
    if(!res.ok){if(optional&&res.status===404)return null;throw fail(`GET ${p} failed (HTTP ${res.status}).`,502);}
    const buf=Buffer.from(await res.arrayBuffer());if(buf.length>maxBytes)throw fail(p+' is too large.');return buf;
  };
  try{
    const meta=JSON.parse((await get('meta')).toString('utf8'));
    writeFileSync(join(dir,'visit.json'),JSON.stringify(meta),{mode:0o600});
    writeFileSync(join(dir,'video.mp4'),await get('video'),{mode:0o600});
    const mic=await get('audio/mic',{optional:true});if(mic)writeFileSync(join(dir,'mic.wav'),mic,{mode:0o600});
    return {visitsDir:root,clipDir:dir,has_mic:Boolean(mic),remove};
  }catch(e){remove();throw e;}
}
