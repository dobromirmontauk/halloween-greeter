// Simulated visitor for replays: old clips have no mic audio, so nobody ever talks back. A "scripted" visitor fakes a kid at the porch.
//   waits for the group to reach PATH, then (after the first greeting, or an assistant turn that ends in a question) speaks one short reply 0.8-2.0 s later
//   (seeded random), through the backend's mic input (createReplayAudio().inject). At most `maxLines` per visit, only while the state is PATH or PORCH.
// TTS is local only (macOS `say`, Linux espeak-ng) -> ffmpeg -> 16 kHz mono s16le; temp files live in the run's tmp dir and are deleted. Nothing is sent anywhere.
import {execFile,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const VISITOR_MODES=['silent','clip-mic','scripted'];
export const REPLY_DELAY_MS=[800,2000];
export const MAX_LINES=4;
export function mulberry32(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
export const seedOf=str=>{let h=2166136261;for(const c of String(str)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;};

const CANDY=['Snickers!','Skittles!','Kit Kats!','Reese\'s!'],COSTUME=['I\'m a ninja!','a witch!'],OTHER=['yeah!','thank you!'];
// Reply to the assistant's last line. first = the first greeting: always "trick or treat!". Returns null when the line needs no reply (a statement after the greeting).
export function pickReply(text,{first=false,rng=Math.random,n=0}={}){
  if(first)return 'trick or treat!';
  const t=String(text||'').trim();if(!/\?["')\]]*$/.test(t))return null;
  if(/candy|treat|sweet|chocolate|favou?rite/i.test(t))return CANDY[Math.floor(rng()*CANDY.length)];
  if(/costume|dressed|supposed to be|you are|what are you|who are you/i.test(t))return COSTUME[Math.floor(rng()*COSTUME.length)];
  return OTHER[n%OTHER.length];
}

// silentAfter: after this many replies the visitor goes quiet (0 = never speaks). inject(pcm16k), record({t,text,dur_ms}) are provided by the caller.
export function createVisitor({tts,inject,record=()=>{},tNow=()=>0,rng=Math.random,silentAfter=null,maxLines=MAX_LINES,
  schedule=(fn,ms)=>{const h=setTimeout(fn,ms);h.unref?.();return h;},cancel=clearTimeout}={}){
  const away=()=>state!=='PATH'&&state!=='PORCH'; // the kid only talks up close (on the street they're out of earshot and the mic is gated)
  let state='EMPTY',reachedPath=false,replies=0,greeted=false,buf='',pending=null,busy=false;
  const limit=Math.min(maxLines,silentAfter==null?Infinity:silentAfter);
  const clear=()=>{if(pending){cancel(pending);pending=null;}};
  const plan=text=>{
    if(replies>=limit||busy)return;
    const delay=REPLY_DELAY_MS[0]+rng()*(REPLY_DELAY_MS[1]-REPLY_DELAY_MS[0]);
    clear();
    pending=schedule(async()=>{
      pending=null;if(away()||replies>=limit)return;
      busy=true;
      try{
        const pcm=await tts(text);
        if(away()||!pcm?.length)return;
        replies++;inject(pcm);record({t:tNow(),text,dur_ms:Math.round(pcm.length/2/16)});
      }catch(e){record({t:tNow(),error:String(e.message||e).slice(0,120)});}
      finally{busy=false;}
    },Math.round(delay));
  };
  return {
    onDetect(st){if(!st)return;state=st;if(st==='PATH')reachedPath=true;if(st==='EMPTY'){clear();reachedPath=false;greeted=false;buf='';}},
    onTranscript(ev){if(ev?.role==='assistant')buf+=String(ev.text??ev.delta??'');},
    onSpeech(ev){
      if(ev.kind==='assistant_turn_start')clear(); // she talks again: the kid waits
      else if(ev.kind==='assistant_turn_end'){
        const text=buf.trim()||String(ev.text||'');buf='';
        if(!reachedPath||away())return;
        if(!greeted){greeted=true;plan(pickReply(text,{first:true}));return;}
        const reply=pickReply(text,{rng,n:replies});if(reply)plan(reply);
      }
    },
    stop:clear,count:()=>replies
  };
}

// ---- local TTS: text -> 16 kHz mono s16le PCM ----
export function ttsAvailable({platform=process.platform,spawnSyncImpl=spawnSync}={}){
  const has=cmd=>{try{return spawnSyncImpl('which',[cmd],{stdio:'ignore'}).status===0;}catch{return false;}};
  if(platform==='darwin')return has('say')?{ok:true,engine:'say'}:{ok:false,message:'The scripted visitor needs the macOS `say` command.'};
  return has('espeak-ng')?{ok:true,engine:'espeak-ng'}:{ok:false,message:'The scripted visitor needs espeak-ng on Linux (apt install espeak-ng), or use --visitor silent.'};
}
const run=(cmd,args,{buffer=false}={})=>new Promise((res,rej)=>execFile(cmd,args,{encoding:buffer?'buffer':'utf8',maxBuffer:32*1024*1024,timeout:60000},(e,out)=>e?rej(e):res(out)));
export function createTts({platform=process.platform,ffmpegPath='ffmpeg',voice=process.env.REPLAY_VISITOR_VOICE||'Junior',runImpl=run}={}){
  const dir=mkdtempSync(join(tmpdir(),'greeter-visitor-'));let n=0;
  const tts=async text=>{
    const clean=String(text).replace(/[^\w !?.,'-]/g,'').slice(0,200),file=join(dir,`line${n++}.${platform==='darwin'?'aiff':'wav'}`);
    if(platform==='darwin'){try{await runImpl('say',['-v',voice,'-o',file,'--',clean]);}catch{await runImpl('say',['-o',file,'--',clean]);}}
    else await runImpl('espeak-ng',['-v','en-us+f3','-p','75','-w',file,'--',clean]);
    return runImpl(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-i',file,'-ar','16000','-ac','1','-f','s16le','pipe:1'],{buffer:true});
  };
  tts.cleanup=()=>{try{rmSync(dir,{recursive:true,force:true});}catch{}};
  return tts;
}
export const scalePcm=(pcm,gain)=>{const out=Buffer.alloc(pcm.length-pcm.length%2);for(let i=0;i<out.length;i+=2)out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(pcm.readInt16LE(i)*gain))),i);return out;};
export function mixPcm(a,b){
  if(!a||!a.length)return b;if(!b||!b.length)return a;
  const len=Math.max(a.length,b.length)&~1,out=Buffer.alloc(len);
  for(let i=0;i<len;i+=2){const x=i<a.length?a.readInt16LE(i):0,y=i<b.length?b.readInt16LE(i):0;out.writeInt16LE(Math.max(-32768,Math.min(32767,x+y)),i);}
  return out;
}
