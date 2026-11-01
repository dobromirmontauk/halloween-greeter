// Sidewalk scream: when someone first appears on the sidewalk, play a pre-rendered clip (terrified scream, a laugh, "Happy Halloween! Come get some candy!")
// through pw-play. The clips are rendered once by scripts/scream/generate.mjs with OpenAI TTS (never the Live voice) into SCREAM_DIR; this module only plays files.
//  - SCREAM=on|off (default on), SCREAM_DIR (default data/screams), SCREAM_COOLDOWN_MS (30000), SCREAM_VOLUME (1.0, pw-play --volume).
//  - Once per group: armed when the group goes EMPTY, fires on the first frame in the SIDEWALK state (nobody on the path yet), then waits for EMPTY again.
//  - Never in OFF / DATA_CAPTURE / rehearsal / DEBUG_SPEAK (`enabled()` is false there). A random clip, not the same one twice in a row.
// Pure orchestration: clock, clip listing and the player spawn are injected.
import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

export function screamOptions(env={}){
 const ms=Number(env.SCREAM_COOLDOWN_MS),vol=Number(env.SCREAM_VOLUME);
 return {on:env.SCREAM!=='off',dir:env.SCREAM_DIR||'data/screams',cooldownMs:Number.isFinite(ms)&&ms>=0?ms:30000,volume:Number.isFinite(vol)&&vol>0?Math.min(vol,2):1};
}
// The first frame of a group that is on the sidewalk only: the debounced state, or a sidewalk box while nobody is on the path/porch.
export function sidewalkScreamTrigger(r){
 const g=r?.group;if(!g)return false;
 if(g.state==='SIDEWALK')return true;
 if(g.state&&g.state!=='EMPTY')return false;
 return (r?.sidewalk?.length>0)||(r?.persons||[]).some(p=>p.zone==='sidewalk');
}
export function createScream({env={},root='.',enabled=()=>true,now=Date.now,rng=Math.random,note=()=>{},spawnImpl=spawn,
  listClips=async dir=>(await readdir(dir)).filter(f=>/\.wav$/i.test(f)).sort()}={}){
 const opt=screamOptions(env),dir=join(root,opt.dir);
 let armed=true,lastAt=null,lastClip=null,playing=null,screams=0,error=null,clipCount=null;
 const refresh=async()=>{try{const c=await listClips(dir);clipCount=c.length;error=c.length?null:'no clips in '+opt.dir;return c;}catch{clipCount=0;error='no clips in '+opt.dir;return [];}};
 if(opt.on){refresh().catch(()=>{});const t=setInterval(()=>refresh().catch(()=>{}),60000);t.unref?.();}
 async function play(){
  const clips=await refresh();
  if(!clips.length)return false;
  const pool=clips.length>1?clips.filter(c=>c!==lastClip):clips;
  const clip=pool[Math.floor(rng()*pool.length)%pool.length];
  const args=['--volume',String(opt.volume),...(env.AUDIO_OUTPUT_TARGET?['--target',env.AUDIO_OUTPUT_TARGET]:[]),join(dir,clip)];
  const child=spawnImpl('pw-play',args,{env,stdio:['ignore','ignore','pipe']});
  child.stderr?.resume();
  playing=child;lastClip=clip;error=null;
  child.on('error',()=>{error='pw-play could not start';if(playing===child)playing=null;});
  child.on('exit',()=>{if(playing===child)playing=null;});
  return clip;
 }
 async function onDetect(r){
  const g=r?.group;if(!g)return;
  if(g.state==='EMPTY'&&!(g.tracks>0)&&!sidewalkScreamTrigger(r)){armed=true;return;}
  if(!opt.on||!armed||playing||!enabled()||!sidewalkScreamTrigger(r))return;
  const t=now();if(lastAt!==null&&t-lastAt<opt.cooldownMs)return;
  armed=false;lastAt=t;
  const clip=await play();
  if(clip){screams++;note('scream',{clip});}
 }
 return {onDetect,status:()=>({on:opt.on,enabled:Boolean(enabled()),clips:clipCount,dir:opt.dir,cooldown_ms:opt.cooldownMs,volume:opt.volume,armed,playing:Boolean(playing),screams,last_at:lastAt,last_clip:lastClip,error}),opts:opt,
  stop:()=>{if(playing){try{playing.kill('SIGTERM');}catch{}playing=null;}}};
}
