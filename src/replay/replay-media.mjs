// Replay media sources: a recorded clip stands in for the RTSP camera and the porch microphone, at real speed.
//   createFileCamera   same surface as camera-stream.mjs (start/stop/subscribe/snapshot/latest/...), frames come from the clip MP4 and are published at their clip timestamps
//   createReplayAudio  a fake `spawn` for linux-audio.mjs: "pw-record" streams the clip's mic track (from the replay clock), "pw-play" is a sink (the run captures the assistant audio through the audio tap)
//   extractFrames      ffmpeg: clip MP4 -> JPEG buffers
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {resamplePcm} from '../visits/visit-audio.mjs';
import {mixPcm} from './replay-visitor.mjs';

const SOI=Buffer.from([0xff,0xd8]),EOI=Buffer.from([0xff,0xd9]);

// All JPEG frames of the clip video (it is a CFR encode at `fps`, so frame k is at k*1000/fps ms from the clip start).
export function extractFrames(video,{ffmpegPath='ffmpeg',fps=6,spawnImpl=spawn,timeoutMs=120000,maxFrames=6000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-i',video,'-an','-vf',`fps=${fps}`,'-c:v','mjpeg','-q:v','4','-f','image2pipe','pipe:1'],{stdio:['ignore','pipe','ignore']});
    const frames=[];let buf=Buffer.alloc(0);
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},timeoutMs);timer.unref?.();
    child.stdout.on('data',chunk=>{
      buf=buf.length?Buffer.concat([buf,chunk]):chunk;
      for(;;){
        const s=buf.indexOf(SOI);if(s<0){buf=Buffer.alloc(0);break;}if(s)buf=buf.subarray(s);
        const e=buf.indexOf(EOI,2);if(e<0)break;
        if(frames.length<maxFrames)frames.push(Buffer.from(buf.subarray(0,e+2)));
        buf=buf.subarray(e+2);
      }
    });
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Cannot run ffmpeg to read the clip video.'));});
    child.on('close',code=>{clearTimeout(timer);if(!frames.length)reject(new Error('ffmpeg produced no frames from the clip video (exit '+code+').'));else resolve(frames.map((bytes,k)=>({bytes,t:Math.round(k*1000/fps)})));});
  });
}

// frames: [{bytes,t}] (t = ms from the clip start). play() starts the clock; each frame is published at t0+t (in order, never skipped; a late one goes out immediately).
export function createFileCamera({frames=[],now=Date.now,schedule=(fn,ms)=>{const h=setTimeout(fn,ms);return h;},cancel=clearTimeout,onEnd=()=>{}}={}){
  const subs=new Set(),nativeSubs=new Set(),waiters=new Set();
  let running=false,t0=null,idx=0,timer=null,latest=null,published=0,ended=false;
  const publish=f=>{
    latest={bytes:f.bytes,at:now()};published++;
    for(const w of [...waiters]){waiters.delete(w);clearTimeout(w.timer);w.resolve(latest);}
    for(const fn of subs){try{fn(latest);}catch{}}
  };
  function pump(){
    timer=null;if(!running||t0==null)return;
    while(idx<frames.length&&t0+frames[idx].t<=now()){publish(frames[idx++]);}
    if(idx>=frames.length){if(!ended){ended=true;try{onEnd();}catch{}}return;}
    timer=schedule(pump,Math.max(0,t0+frames[idx].t-now()));timer?.unref?.();
  }
  return {
    start:()=>{running=true;if(t0!=null&&!timer)pump();return status();},
    stop:()=>{running=false;cancel(timer);timer=null;for(const w of waiters){clearTimeout(w.timer);w.reject(new Error('Camera stream stopped'));}waiters.clear();return status();},
    // Begin playback at `startAt` (default now). Frame times are relative to it.
    play:(startAt=now())=>{t0=startAt;idx=0;ended=false;if(running)pump();return t0;},
    subscribe:fn=>{subs.add(fn);return()=>subs.delete(fn);},
    subscribeNative:fn=>{nativeSubs.add(fn);return()=>nativeSubs.delete(fn);},
    latest:()=>latest,latestNative:()=>null,configureNative:()=>status(),
    snapshot:()=>latest?Promise.resolve(latest):new Promise((resolve,reject)=>{const w={resolve,reject,timer:null};w.timer=setTimeout(()=>{waiters.delete(w);reject(new Error('Timed out waiting for a camera frame'));},12000);w.timer.unref?.();waiters.add(w);}),
    status,done:()=>ended,t0:()=>t0,total:()=>frames.length
  };
  function status(){return {state:running?'streaming':'stopped',running,connected:running,fps:6,last_frame_at:latest?.at??null,frames:published,width:960,error:null,native:{enabled:false,fps:0,frames:0}};}
}

// Fake child processes for linux-audio.mjs. tNow() = ms since the replay clock started. The mic child delivers the clip's audio as it would arrive live: from "now" on, in ~20 ms chunks.
// mic: {pcm,rate} | null (old clips without audio replay one-sided: the mic child stays silent). sink(bytes): optional copy of the playback bytes (--speaker).
export function createReplayAudio({mic=null,tNow=()=>0,chunkMs=20,sink=null,setIntervalImpl=setInterval}={}){
  const cache=new Map(),children=new Set();
  let queue=Buffer.alloc(0);
  const pcmAt=rate=>{if(!mic)return null;if(!cache.has(rate))cache.set(rate,resamplePcm(mic.pcm,mic.rate,rate));return cache.get(rate);};
  const spawnImpl=(command,args=[])=>{
    const c=new EventEmitter();c.exitCode=null;c.stderr=new PassThrough();children.add(c);
    const done=()=>{if(c.exitCode===null){c.exitCode=0;children.delete(c);queueMicrotask(()=>c.emit('exit',0));}};
    c.kill=()=>{clearInterval(c.timer);done();return true;};
    if(String(command).includes('record')){
      c.stdout=new PassThrough();c.stdin=null;
      const rate=Number(args[args.indexOf('--rate')+1])||16000,pcm=pcmAt(rate);let sent=Math.floor(tNow()*rate/1000);
      c.timer=setIntervalImpl(()=>{
        const target=Math.floor(tNow()*rate/1000);
        if(!pcm&&!queue.length){sent=Math.max(sent,target);return;}
        const upto=pcm?Math.min(pcm.length>>1,target):target;
        let chunk=pcm&&upto>sent?pcm.subarray(sent*2,upto*2):null;
        if(queue.length){ // a simulated visitor speaking: mixed over the clip's own mic (if any), in real time
          const want=Math.max(0,target-Math.max(sent,0))*2,q=queue.subarray(0,Math.max(want,2));queue=queue.subarray(q.length);
          chunk=mixPcm(chunk,q);sent=Math.max(sent,target);
        }
        if(chunk?.length)c.stdout.write(chunk);
        if(!queue.length&&pcm)sent=Math.max(sent,upto);else if(!pcm)sent=Math.max(sent,target);
      },chunkMs);c.timer.unref?.();
    }else{
      c.stdout=null;
      c.stdin=new Writable({write(chunk,enc,cb){try{sink?.(chunk);}catch{}cb();}});
    }
    return c;
  };
  // inject(pcm16k): mic audio spoken by a simulated visitor, delivered at real time from now.
  const inject=(pcm,rate=16000)=>{const p=rate===16000?pcm:resamplePcm(pcm,rate,16000);queue=Buffer.concat([queue,p.subarray(0,p.length&~1)]);};
  return {spawnImpl,inject,close:()=>{for(const c of [...children])c.kill();}};
}
