// Visit audio (VISIT_AUDIO=on|off): two mono PCM tracks synced to the clip clock (same absolute ms as the detector frames).
//   mic        the porch microphone (16 kHz s16), fed by the server's own capture child; independent of the Live backends (Gemini's always-on mic can be paused, this still runs)
//   assistant  the assistant's output exactly as it was sent to the speaker (24 kHz s16), placed on the PLAYBACK timeline (audio arrives faster than real time; the speaker plays it back to back)
// PRIVACY: the ring below only ever lives in memory. Nothing touches the disk outside a visit: a clip collector is created by begin() when the visit recorder opens a clip (3 s pre-roll comes from the ring),
// stops with the video (post-roll included), and is rendered to mic.wav / assistant.wav by the recorder at finalize. While the app is OFF or the recorder is disabled clear() empties the ring.
import {Buffer} from 'node:buffer';

export const MIC_RATE=16000,ASSISTANT_RATE=24000;
const bytesFor=(ms,rate)=>Math.max(0,Math.round(ms/1000*rate))*2;

export function wavHeader(dataBytes,rate){
  const h=Buffer.alloc(44);
  h.write('RIFF',0);h.writeUInt32LE(36+dataBytes,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);
  h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(dataBytes,40);
  return h;
}
export const toWav=(pcm,rate)=>Buffer.concat([wavHeader(pcm.length,rate),pcm]);
// Mono 16-bit PCM wav -> {rate, pcm}. Tolerates extra chunks. Null when it is not a mono s16 wav.
export function parseWav(buf){
  if(!Buffer.isBuffer(buf)||buf.length<44||buf.toString('ascii',0,4)!=='RIFF'||buf.toString('ascii',8,12)!=='WAVE')return null;
  let i=12,rate=null,ok=false;
  while(i+8<=buf.length){
    const id=buf.toString('ascii',i,i+4),size=buf.readUInt32LE(i+4);
    if(id==='fmt '){ok=buf.readUInt16LE(i+8)===1&&buf.readUInt16LE(i+10)===1&&buf.readUInt16LE(i+22)===16;rate=buf.readUInt32LE(i+12);}
    else if(id==='data'){if(!ok)return null;const end=Math.min(buf.length,i+8+size);const len=(end-i-8)-((end-i-8)%2);return {rate,pcm:buf.subarray(i+8,i+8+len)};}
    i+=8+size+(size%2);
  }
  return null;
}
// Linear-interpolation resample of s16 mono PCM (replay only: clip mic -> the rate a backend asked pw-record for).
export function resamplePcm(pcm,from,to){
  if(from===to||!pcm.length)return pcm;
  const n=pcm.length>>1,m=Math.max(1,Math.floor(n*to/from)),out=Buffer.alloc(m*2);
  for(let j=0;j<m;j++){
    const x=j*from/to,i=Math.floor(x),f=x-i,a=pcm.readInt16LE(Math.min(i,n-1)*2),b=pcm.readInt16LE(Math.min(i+1,n-1)*2);
    out.writeInt16LE(Math.round(a+(b-a)*f),j*2);
  }
  return out;
}
// RMS level per bin (0..100, perceptual sqrt scale) for the UI's level lane.
export function pcmLevels(pcm,rate,binMs=100){
  const per=Math.max(1,Math.round(rate*binMs/1000)),out=[];
  for(let s=0;s<pcm.length>>1;s+=per){
    let sum=0,c=0;const e=Math.min(pcm.length>>1,s+per);
    for(let i=s;i<e;i++){const v=pcm.readInt16LE(i*2)/32768;sum+=v*v;c++;}
    out.push(Math.min(100,Math.round(Math.sqrt(c?sum/c:0)*100*2.5)));
  }
  return out;
}

// A sequence of placed PCM segments on one clock (absolute ms). mode 'capture' (mic): a chunk that ends now. mode 'playback' (assistant): queued behind what is still playing.
export function createPcmTrack({rate,mode='capture',now=Date.now}={}){
  let segs=[],playhead=-Infinity,lastEnd=-Infinity;
  const dur=bytes=>bytes.length/2/rate*1000;
  function push(bytes,at=now()){
    if(!bytes?.length)return null;
    const b=bytes.length%2?bytes.subarray(0,bytes.length-1):bytes;if(!b.length)return null;
    const d=dur(b);let start;
    if(mode==='playback'){start=Math.max(at,playhead);playhead=start+d;}
    else{start=Math.max(at-d,lastEnd);lastEnd=start+d;}
    const seg={start,end:start+d,bytes:Buffer.from(b)};segs.push(seg);return seg;
  }
  // The speaker queue was dropped at `at` (barge-in, mute): audio that had not played yet never reaches the room.
  function flush(at=now()){
    let kept=[];
    for(const s of segs){
      if(s.start>=at)continue;
      if(s.end>at){const keep=bytesFor(at-s.start,rate);s.bytes=s.bytes.subarray(0,Math.min(s.bytes.length,keep));s.end=s.start+dur(s.bytes);}
      kept.push(s);
    }
    segs=kept;playhead=Math.min(playhead,at);return segs;
  }
  return {push,flush,segs:()=>segs,prune:cut=>{segs=segs.filter(s=>s.end>=cut);},clear:()=>{segs=[];playhead=-Infinity;lastEnd=-Infinity;},rate,mode};
}
// Place segments into a silent buffer covering [startAt, startAt+durMs).
export function renderSegments(segs,rate,startAt,durMs){
  const out=Buffer.alloc(bytesFor(durMs,rate));
  for(const s of segs){
    let off=Math.round((s.start-startAt)/1000*rate)*2,src=0;
    if(off<0){src=-off;off=0;}
    if(src>=s.bytes.length||off>=out.length)continue;
    s.bytes.copy(out,off,src,Math.min(s.bytes.length,src+out.length-off));
  }
  return out;
}

// The recorder-facing hub. mic()/out()/flush() are the taps; begin(startAt) opens a clip collector (seeded from the pre-roll ring).
export function createVisitAudio({preRollMs=3000,now=Date.now}={}){
  const mic=createPcmTrack({rate:MIC_RATE,mode:'capture',now}),asst=createPcmTrack({rate:ASSISTANT_RATE,mode:'playback',now});
  let active=null,fed={mic:0,assistant:0};
  const ringCut=()=>now()-preRollMs-2000;
  function micIn(bytes,at){const s=mic.push(bytes,at);if(!s)return;fed.mic+=bytes.length;if(active?.recording)active.mic.push(s);else mic.prune(ringCut());}
  function out(bytes,at){const s=asst.push(bytes,at);if(!s)return;fed.assistant+=bytes.length;if(active?.recording)active.assistant.push(s);else asst.prune(ringCut());}
  function flush(at=now()){
    asst.flush(at);
    if(active){active.assistant=active.assistant.filter(s=>s.end>0&&s.start<at);} // segments past `at` were dropped from the track; the shared ones that survived are already trimmed
    const live=new Set(asst.segs());if(active)active.assistant=active.assistant.filter(s=>live.has(s));
  }
  function begin(startAt){
    const c={startAt,recording:true,mic:mic.segs().filter(s=>s.end>startAt),assistant:asst.segs().filter(s=>s.end>startAt),
      stop(){this.recording=false;if(active===this)active=null;},
      // PCM for exactly durMs from startAt (silence where nothing was captured).
      render(durMs){return {mic:renderSegments(this.mic,MIC_RATE,this.startAt,durMs),assistant:renderSegments(this.assistant,ASSISTANT_RATE,this.startAt,durMs)};}};
    active=c;return c;
  }
  const clear=()=>{mic.clear();asst.clear();if(active){active.recording=false;active=null;}};
  return {mic:micIn,out,flush,begin,clear,status:()=>({ring_ms:{mic:Math.round(mic.segs().reduce((a,s)=>a+(s.end-s.start),0)),assistant:Math.round(asst.segs().reduce((a,s)=>a+(s.end-s.start),0))},recording:Boolean(active),fed_bytes:{...fed}}),
    // For callers that need the tap interface linux-audio expects.
    tap:{out,flush,mic:micIn}};
}
