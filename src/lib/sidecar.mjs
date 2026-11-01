// Line-delimited JSON client for a local Python sidecar process (the person detector). Never touches the network.
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

// Line-delimited JSON over the child's stdin/stdout. Restarts with backoff after a crash; a fatal start error (missing models/Python) disables it.
export function createSidecarClient({command,args,env,spawnImpl=spawn,timeoutMs=10000,restartBaseMs=1000,restartMaxMs=60000,onState=()=>{}}={}){
 let child=null,buf='',seq=0,failures=0,restartTimer=null,stopped=true,state='stopped',error=null,ready=false;
 const pending=new Map();
 const setState=(s,e=null)=>{state=s;error=e;try{onState(s,e);}catch{}};
 const rejectAll=message=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}pending.clear();};
 function onLine(line){
  let msg;try{msg=JSON.parse(line);}catch{return;}
  if(msg.id==null){
   if(msg.ready){ready=true;failures=0;setState('ready');}
   else if(msg.fatal){stopped=true;setState('disabled',String(msg.error||'sidecar failed to start').slice(0,160));try{child?.kill?.('SIGTERM');}catch{}}
   return;
  }
  const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);
  if(msg.ok)p.resolve(msg);else p.reject(new Error(String(msg.error||'sidecar error').slice(0,160)));
 }
 function launch(){
  restartTimer=null;if(stopped||child)return;
  setState('starting');ready=false;buf='';
  let proc;
  try{proc=spawnImpl(command,args,{env,stdio:['pipe','pipe','ignore']});}
  catch{stopped=true;setState('disabled','Cannot start the face sidecar (Python missing?)');return;}
  child=proc;
  proc.stdout.on('data',chunk=>{if(child!==proc)return;buf+=chunk.toString();let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(line)onLine(line);}});
  proc.stdin?.on?.('error',()=>{});
  proc.on('error',()=>{if(child!==proc)return;child=null;rejectAll('sidecar failed');stopped=true;setState('disabled','Cannot start the face sidecar (Python missing?)');});
  proc.on('exit',()=>{
   if(child!==proc)return;child=null;rejectAll('sidecar exited');
   if(stopped){if(state!=='disabled')setState('stopped',error);return;}
   const delay=Math.min(restartMaxMs,restartBaseMs*2**Math.min(failures++,10));
   setState('restarting','Face sidecar exited; restarting');
   restartTimer=setTimeout(launch,delay);restartTimer.unref?.();
  });
 }
 const start=()=>{if(!stopped)return;stopped=false;failures=0;launch();};
 const stop=()=>{stopped=true;clearTimeout(restartTimer);restartTimer=null;rejectAll('sidecar stopped');const c=child;if(c){try{c.stdin.write(JSON.stringify({cmd:'shutdown'})+'\n');}catch{}try{c.stdin.end?.();}catch{}try{c.kill('SIGTERM');}catch{}}if(state!=='disabled')setState('stopped');};
 const call=(cmd,payload={})=>new Promise((res,rej)=>{
  if(!child||!ready)return rej(new Error('face sidecar not ready'));
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);rej(new Error('face sidecar timed out'));},timeoutMs);timer.unref?.();
  pending.set(id,{resolve:res,reject:rej,timer});
  try{child.stdin.write(JSON.stringify({id,cmd,...payload})+'\n');}catch{pending.delete(id);clearTimeout(timer);rej(new Error('face sidecar write failed'));}
 });
 return {start,stop,call,status:()=>({state,error,ready})};
}
