import {spawn} from 'node:child_process';
// Spoken debug mode: speaks each Judge event phrase through speech-dispatcher (spd-say).
// No shell; args array only. One utterance at a time, at most one pending.
export function createDebugSpeaker({spawnImpl=spawn,command='spd-say'}={}){
 let busy=false,pending=null,error=null,spoken=0,current=null;
 const repeat=event=>event.type==='NO_VISITORS'||event.type==='UNCERTAIN'||event.type==='STATUS';
 function run(event){
  busy=true;current=event.phrase;let done=false;
  const finish=(ok,message)=>{
   if(done)return;done=true;busy=false;current=null;
   if(ok){spoken++;error=null;}else error=message;
   const next=pending;pending=null;if(next)run(next);
  };
  try{
   const child=spawnImpl(command,['--wait',event.phrase],{stdio:'ignore'});
   child.on('error',()=>finish(false,'spd-say could not start'));
   child.on('exit',code=>finish(code===0,`spd-say exited with code ${code}`));
  }catch{finish(false,'spd-say could not start');}
 }
 function speak(event){
  if(!event?.phrase||event.silent)return false;
  if(!busy){run(event);return true;}
  if(repeat(event))return false; // stale repeats are dropped while busy
  pending=event;return true;
 }
 return {speak,status:()=>({command,speaking:busy,current,pending:pending?.phrase||null,spoken,error})};
}
