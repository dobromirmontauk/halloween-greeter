// Visit audio: pre-roll ring, nothing on disk while EMPTY, two named audio streams in the MP4, VISIT_AUDIO=off, assistant playback timeline, transcripts.
// Synthetic tones only. The MP4 test needs ffmpeg/ffprobe and is skipped without them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createVisitAudio,createPcmTrack,parseWav,pcmLevels,toWav,resamplePcm} from '../src/visits/visit-audio.mjs';
import {createVisitRecorder,visitConfig} from '../src/visits/visit-recorder.mjs';
import {createLinuxAudio} from '../src/voice/linux-audio.mjs';

const BASE=Date.UTC(2026,9,26,18,0,0);
const has=c=>spawnSync(c,['-version'],{stdio:'ignore'}).status===0;
const HAVE_FF=has('ffmpeg')&&has('ffprobe');
const tone=(ms,rate,hz=440,amp=8000)=>{const n=Math.round(ms/1000*rate),b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*hz*i/rate)*amp),i*2);return b;};
const rms=(pcm,from=0,to=pcm.length>>1)=>{let s=0;for(let i=from;i<to;i++){const v=pcm.readInt16LE(i*2);s+=v*v;}return Math.sqrt(s/Math.max(1,to-from));};
function jpegFrame(){const r=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=64x48:rate=1','-frames:v','1','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{maxBuffer:1<<20});return r.stdout;}

// Recorder + audio hub on one simulated clock. Mic chunks (100 ms of tone) arrive continuously; frames ~6 fps; detections 4/s.
function harness({withAudio=true,real=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'vaud-'));let clk=BASE;
  const audio=withAudio?createVisitAudio({preRollMs:3000,now:()=>clk}):null;
  const jpg=real?jpegFrame():Buffer.from([255,216,255,217]),encodes=[];
  const rec=createVisitRecorder({dir,now:()=>clk,audio,zones:()=>[],freeBytes:()=>50*1024**3,tickMs:3600000,...(real?{}:{encodeImpl:async o=>{encodes.push(o);return {ms:1};}})});
  let nextFrame=0,nextDet=0,nextMic=0;
  const run=(from,to,person)=>{
    for(let t=from;t<to;t+=50){
      clk=BASE+t;
      if(t>=nextMic){nextMic=t+100;audio?.mic(tone(100,16000),clk);}
      if(t>=nextFrame){nextFrame=t+166;rec.onFrame({bytes:jpg,at:clk});}
      if(t>=nextDet){nextDet=t+250;rec.onDetect({at:clk,persons:person(t)?[{bbox:[0.4,0.5,0.5,0.9],score:0.9,zone:'path'}]:[],group:{state:person(t)?'PATH':'EMPTY',count:person(t)?1:0}});}
    }
  };
  return {dir,rec,audio,run,encodes,clock:()=>clk,done:async()=>{rec.finalizeNow('test');await rec.flush();await rec.flush();}};
}

test('pre-roll ring: audio before a visit is held in memory only (a few seconds), nothing is written while EMPTY, the visit starts with its pre-roll',async()=>{
  const h=harness();
  h.run(0,10000,()=>false);
  assert.deepEqual(readdirSync(h.dir),[],'no files while EMPTY');
  const ring=h.audio.status().ring_ms.mic;assert.ok(ring>=3000&&ring<=5600,'ring holds about the pre-roll, not everything: '+ring);
  h.run(10000,14000,t=>t>=10000);h.run(14000,22000,()=>false);await h.done();
  const [id]=readdirSync(h.dir);const wav=parseWav(readFileSync(join(h.dir,id,'mic.wav')));
  assert.equal(wav.rate,16000);
  assert.ok(rms(wav.pcm,0,1600)>2000,'the first 100 ms of the clip already has the pre-roll tone');
  const meta=JSON.parse(readFileSync(join(h.dir,id,'visit.json'),'utf8'));
  assert.equal(wav.pcm.length/2/16000*1000|0,meta.video_ms|0,'mic track is exactly as long as the video');
  assert.ok(meta.video_ms<10000,'post-roll ends the audio too: '+meta.video_ms);
  assert.equal(meta.audio.mic.file,'mic.wav');assert.equal(meta.audio.assistant.rate,24000);
  assert.deepEqual(h.encodes[0].audio.map(a=>a.title),['mic','assistant']);
  assert.equal((statSync(join(h.dir,id,'mic.wav')).mode&0o777),0o600);
  h.rec.close();rmSync(h.dir,{recursive:true,force:true});
});

test('VISIT_AUDIO=off records nothing: no tracks, no wav files, no audio inputs to the encoder',async()=>{
  assert.equal(visitConfig({VISIT_AUDIO:'off'}).audio,false);assert.equal(visitConfig({}).audio,true);
  const h=harness({withAudio:false});h.run(0,5000,()=>false);h.run(5000,9000,t=>t>=5000);h.run(9000,16000,()=>false);await h.done();
  const [id]=readdirSync(h.dir);assert.deepEqual(readdirSync(join(h.dir,id)).filter(n=>n.endsWith('.wav')),[]);
  assert.equal(JSON.parse(readFileSync(join(h.dir,id,'visit.json'),'utf8')).audio,null);assert.deepEqual(h.encodes[0].audio,[]);
  assert.equal(h.rec.status().audio,false);
  h.rec.close();rmSync(h.dir,{recursive:true,force:true});
});

test('mode OFF / disabled drops the ring',()=>{
  const a=createVisitAudio({now:()=>BASE});a.mic(tone(1000,16000),BASE);assert.ok(a.status().ring_ms.mic>0);a.clear();assert.equal(a.status().ring_ms.mic,0);
});

test('the MP4 has two named mono audio streams (mic, assistant) next to the video',{skip:!HAVE_FF,timeout:60000},async()=>{
  const h=harness({real:true});
  h.run(0,3000,()=>false);
  for(let t=3000;t<7000;t+=50){h.run(t,t+50,()=>true);if(t===4000)h.audio.out(tone(1500,24000,880),h.clock());}
  h.run(7000,14000,()=>false);await h.done();
  const [id]=readdirSync(h.dir);const mp4=join(h.dir,id,'video.mp4');assert.ok(existsSync(mp4));
  const probe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_streams','-of','json',mp4],{encoding:'utf8'}).stdout);
  const audio=probe.streams.filter(s=>s.codec_type==='audio'),video=probe.streams.filter(s=>s.codec_type==='video');
  assert.equal(video.length,1);assert.equal(audio.length,2);
  assert.deepEqual(audio.map(s=>s.tags?.title||s.tags?.handler_name),['mic','assistant']);assert.ok(audio.every(s=>s.channels===1&&s.codec_name==='aac'));
  const asst=parseWav(readFileSync(join(h.dir,id,'assistant.wav')));assert.equal(asst.rate,24000);
  const meta=JSON.parse(readFileSync(join(h.dir,id,'visit.json'),'utf8'));
  assert.ok(rms(asst.pcm,0,2400)<10,'the assistant track is silent until it speaks');
  const at=Math.round((4000-(3000-3000))/1000*24000);assert.ok(rms(asst.pcm,at+2400,at+4800)>2000,'assistant tone sits on the clip clock');
  assert.ok(meta.encode.video_bytes>0);
  h.rec.close();rmSync(h.dir,{recursive:true,force:true});
});

test('assistant track is on the PLAYBACK timeline: bursts queue behind each other; a dropped speaker queue is cut',()=>{
  const t=createPcmTrack({rate:24000,mode:'playback',now:()=>1000});
  const a=t.push(tone(1000,24000),1000),b=t.push(tone(1000,24000),1000);
  assert.equal(a.start,1000);assert.equal(b.start,2000,'second burst plays after the first');
  t.flush(2500); // barge-in at 2.5 s: only half of b was played
  assert.equal(t.segs().length,2);assert.equal(Math.round(t.segs()[1].end),2500);assert.equal(t.segs()[1].bytes.length,24000);
  const c=t.push(tone(100,24000),2600);assert.equal(c.start,2600);
  // through the hub tap: flush reaches the clip collector too
  let now=0;const hub=createVisitAudio({now:()=>now});const col=hub.begin(0);
  now=100;hub.out(tone(2000,24000),now);now=600;hub.flush(now);
  const r=col.render(3000).assistant;assert.ok(rms(r,2400,14000)>2000);assert.ok(rms(r,Math.round(0.7*24000),Math.round(2.0*24000))<5,'nothing after the flush point');
});

test('linux-audio taps: output bytes go to the tap only while a player exists; killing the player flushes the speaker queue',()=>{
  const out=[];let flushed=0;const spawnImpl=()=>{const c=new EventEmitter();c.stdin={write(){return true;},destroy(){},on(){}};c.stdout=new EventEmitter();c.stderr={resume(){}};c.kill=()=>{};c.exitCode=null;return c;};
  const au=createLinuxAudio({spawnImpl,tap:{out:b=>out.push(b.length),flush:()=>flushed++}});
  au.write(Buffer.alloc(10));assert.deepEqual(out,[],'no player, nothing reaches the speaker');
  au.beginPlayer();au.write(Buffer.alloc(10));assert.deepEqual(out,[10]);au.killPlayer();assert.equal(flushed,1);
});

test('transcript fragments (assistant and visitor) are saved with the clip on the clip clock; levels and resampling helpers',async()=>{
  const h=harness();h.run(0,3000,()=>false);
  h.run(3000,4000,()=>true);h.rec.noteTranscript({role:'assistant',text:'Evening folks.',at:BASE+3500});h.rec.noteTranscript({role:'user',text:'Trick or treat!',at:BASE+4200});h.rec.noteTranscript({role:'system',text:'x'});
  h.run(4000,12000,()=>false);await h.done();
  const [id]=readdirSync(h.dir);const meta=JSON.parse(readFileSync(join(h.dir,id,'visit.json'),'utf8'));
  assert.deepEqual(meta.transcript.map(x=>[x.role,x.text]),[['assistant','Evening folks.'],['user','Trick or treat!']]);assert.ok(meta.transcript[0].t>=3400&&meta.transcript[0].t<=4000);
  const lv=pcmLevels(tone(500,16000),16000,100);assert.equal(lv.length,5);assert.ok(lv[0]>10);
  assert.equal(resamplePcm(tone(100,16000),16000,24000).length,Math.floor(1600*1.5)*2);
  assert.equal(parseWav(toWav(tone(10,16000),16000)).pcm.length,320);
  h.rec.close();rmSync(h.dir,{recursive:true,force:true});
});
