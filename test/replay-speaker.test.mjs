// Mac-local replay pieces: the speaker sink per platform (fake ffplay/afplay), pulling a clip over HTTP into a private cache, live transcript lines.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {createSpeaker} from '../src/replay/replay-speaker.mjs';
import {fetchClip} from '../src/replay/replay-remote.mjs';
import {parseWav} from '../src/visits/visit-audio.mjs';
import {parseArgs} from '../scripts/replay/run.mjs';

function fakeSpawn(){
  const calls=[];
  const spawnImpl=(cmd,args)=>{const p=new EventEmitter(),got=[];p.stdin=new PassThrough();p.stdin.on('data',b=>got.push(b));p.cmd=cmd;p.args=args;p.got=got;calls.push(p);return p;};
  return {spawnImpl,calls};
}

test('darwin: the speaker pipes 24 kHz s16le mono PCM to ffplay when it exists',async()=>{
  const {spawnImpl,calls}=fakeSpawn();
  const sp=createSpeaker({platform:'darwin',spawnImpl,has:c=>c==='ffplay'});
  assert.equal(sp.kind,'ffplay');assert.equal(calls[0].cmd,'ffplay');
  const a=calls[0].args;assert.ok(a.includes('-nodisp'));assert.deepEqual(a.slice(a.indexOf('-f'),a.indexOf('-f')+2),['-f','s16le']);assert.equal(a[a.indexOf('-ar')+1],'24000');assert.equal(a[a.indexOf('-ch_layout')+1],'mono');assert.equal(a.at(-1),'-');
  sp.write(Buffer.alloc(480));await sp.end();await new Promise(r=>setImmediate(r));
  assert.equal(Buffer.concat(calls[0].got).length,480);
});

test('darwin without ffplay: one temp WAV per turn through afplay, removed afterwards',async()=>{
  const {spawnImpl,calls}=fakeSpawn();const timers=[];
  const sp=createSpeaker({platform:'darwin',spawnImpl,has:()=>false,schedule:fn=>{timers.push(fn);return timers.length;},cancel:()=>{}});
  assert.equal(sp.kind,'afplay');assert.equal(calls.length,0,'nothing spawned until a turn ends');
  const pcm=Buffer.alloc(4800,1);sp.write(pcm.subarray(0,2400));sp.write(pcm.subarray(2400));timers.at(-1)(); // 500 ms of quiet: the turn is over
  await new Promise(r=>setImmediate(r));
  assert.equal(calls[0].cmd,'afplay');const f=calls[0].args[0];assert.ok(/\.wav$/.test(f));
  const w=parseWav(readFileSync(f));assert.equal(w.rate,24000);assert.equal(w.pcm.length,4800);assert.equal(statSync(f).mode&0o777,0o600);
  calls[0].emit('close',0);await sp.end();assert.equal(existsSync(f),false);
});

test('linux keeps the PipeWire path',()=>{
  const {spawnImpl,calls}=fakeSpawn();const sp=createSpeaker({platform:'linux',spawnImpl,has:()=>false});
  assert.equal(sp.kind,'pw-play');assert.equal(calls[0].cmd,'pw-play');assert.ok(calls[0].args.includes('24000'));
});

test('--from pulls meta, video and the mic track with read-only GETs into a private cache; --cleanup removes it',async()=>{
  const id='20261026-182115-91e4f6',seen=[];
  const fetchImpl=async(url,opts)=>{const u=new URL(url);seen.push([opts.method,u.pathname]);
    if(u.pathname.endsWith('/meta'))return new Response(JSON.stringify({id,fps:6,video_ms:1000}));
    if(u.pathname.endsWith('/video'))return new Response(Buffer.from('mp4'));
    if(u.pathname.endsWith('/audio/mic'))return new Response('nope',{status:404});
    return new Response('x',{status:500});};
  const c=await fetchClip({from:'http://192.0.2.10:3031',clipId:id,fetchImpl});
  assert.deepEqual(seen.map(s=>s.join(' ')),[`GET /api/visits/${id}/meta`,`GET /api/visits/${id}/video`,`GET /api/visits/${id}/audio/mic`]);
  assert.equal(c.has_mic,false);assert.equal(statSync(c.visitsDir).mode&0o777,0o700);assert.equal(JSON.parse(readFileSync(c.clipDir+'/visit.json','utf8')).fps,6);assert.equal(statSync(c.clipDir+'/video.mp4').mode&0o777,0o600);
  c.remove();assert.equal(existsSync(c.visitsDir),false);
  await assert.rejects(fetchClip({from:'ftp://x',clipId:id,fetchImpl}),/http/);await assert.rejects(fetchClip({from:'http://x',clipId:'../etc',fetchImpl}),/Bad clip/);
  await assert.rejects(fetchClip({from:'http://x',clipId:id,fetchImpl:async()=>new Response('no',{status:404})}),/HTTP 404/);
});

test('CLI flags: --detections, --from, --cleanup, --gemini-mode parse',()=>{
  const a=parseArgs(['--from','http://d:3031','--clip','c','--backend','gemini','--gemini-mode','all-gemini','--detections','recorded','--speaker','--send-recorded-media','--max-cost','0.25','--cleanup','--set','A=1']);
  assert.equal(a.from,'http://d:3031');assert.equal(a['gemini-mode'],'all-gemini');assert.equal(a.detections,'recorded');assert.equal(a.cleanup,true);assert.equal(a.speaker,true);assert.equal(a.set.A,'1');
});
