// Real-time speaker sink for `--speaker`: streams the backend's 24 kHz s16le mono output to the machine running the replay. Never touches the microphone.
//   linux   pw-play (PipeWire), like the device
//   darwin  ffplay -nodisp -f s16le -ar 24000 -ch_layout mono - (ffplay 7+ dropped -ac for raw input)  (if ffplay exists), else afplay with a temp WAV per turn
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {toWav} from '../visits/visit-audio.mjs';

export const hasCommand=(cmd,{spawnSyncImpl=spawnSync}={})=>{try{return spawnSyncImpl(cmd,['-version'],{stdio:'ignore'}).status===0||spawnSyncImpl('which',[cmd],{stdio:'ignore'}).status===0;}catch{return false;}};

export function createSpeaker({platform=process.platform,spawnImpl=spawn,has=hasCommand,turnGapMs=500,rate=24000,schedule=(fn,ms)=>{const h=setTimeout(fn,ms);h.unref?.();return h;},cancel=clearTimeout}={}){
  let proc=null,kind=null,pending=[],timer=null,chain=Promise.resolve(),closed=false;
  const pipe=(cmd,args)=>{
    const p=spawnImpl(cmd,args,{stdio:['pipe','ignore','ignore']});
    p.on?.('error',()=>{if(proc===p)proc=null;});p.stdin?.on?.('error',()=>{});return p;
  };
  if(platform==='linux'){kind='pw-play';proc=pipe('pw-play',['--format','s16','--rate',String(rate),'--channels','1','-']);}
  else if(platform==='darwin'&&has('ffplay')){kind='ffplay';proc=pipe('ffplay',['-nodisp','-loglevel','quiet','-autoexit','-f','s16le','-ar',String(rate),'-ch_layout','mono','-i','-']);}
  else if(platform==='darwin'){kind='afplay';}
  else if(has('ffplay')){kind='ffplay';proc=pipe('ffplay',['-nodisp','-loglevel','quiet','-autoexit','-f','s16le','-ar',String(rate),'-ch_layout','mono','-i','-']);}
  // afplay: one temp WAV per turn (a turn ends after turnGapMs without new audio), played one after the other.
  const playTurn=()=>{
    timer=null;if(!pending.length)return;
    const pcm=Buffer.concat(pending);pending=[];
    chain=chain.then(()=>new Promise(resolve=>{
      let dir;try{dir=mkdtempSync(join(tmpdir(),'greeter-say-'));const f=join(dir,'turn.wav');writeFileSync(f,toWav(pcm,rate),{mode:0o600});
        const p=spawnImpl('afplay',[f],{stdio:'ignore'});const done=()=>{try{rmSync(dir,{recursive:true,force:true});}catch{}resolve();};p.on?.('error',done);p.on?.('close',done);}
      catch{try{if(dir)rmSync(dir,{recursive:true,force:true});}catch{}resolve();}
    }));
  };
  return {kind,
    write(bytes){
      if(closed||!bytes?.length)return;
      if(kind==='afplay'){pending.push(Buffer.from(bytes));if(timer)cancel(timer);timer=schedule(playTurn,turnGapMs);return;}
      try{proc?.stdin?.write(bytes);}catch{}
    },
    async end(){closed=true;if(timer){cancel(timer);playTurn();}try{proc?.stdin?.end();}catch{}await chain;}};
}
