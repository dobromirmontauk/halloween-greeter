import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boxesAt,readSegments,costumeSegments,motionSegments,costumeAt,costumeMarkers,motionMarkers,fitLabels,summaryOf,snapToFrame} from '../public/visit-time.js';
import {replayMeta} from '../src/visits/visit-replay.mjs';
import {createPersonDetector} from '../src/presence/person-detector.mjs';
import {arrowOf} from '../public/box-arrow.js';
import {createServer} from '../server.mjs';

const box=(x,extra={})=>({b:[x,0.2,x+0.1,0.6],s:0.9,zone:'path',...extra});

test('boxesAt interpolates between the bracketing detections of one track and hides when none is near',()=>{
  const dets=[{t:1000,boxes:[box(0.2,{track:1})]},{t:1500,boxes:[box(0.4,{track:1})]},{t:4000,boxes:[box(0.8,{track:1})]}];
  let r=boxesAt(dets,1250);assert.equal(r.length,1);assert.ok(Math.abs(r[0].b[0]-0.3)<1e-9,'halfway');assert.ok(Math.abs(r[0].b[2]-0.4)<1e-9);
  r=boxesAt(dets,1000);assert.ok(Math.abs(r[0].b[0]-0.2)<1e-9,'exactly at a detection');
  r=boxesAt(dets,1700);assert.ok(Math.abs(r[0].b[0]-0.4)<1e-9,'only the earlier detection is within 300 ms: its box, not stale-extrapolated');
  assert.deepEqual(boxesAt(dets,2500),[],'nothing within 300 ms: no box');
  assert.equal(boxesAt(dets,3800).length,1);assert.deepEqual(boxesAt(dets,500),[],'before the first detection by more than 300 ms');
  assert.deepEqual(boxesAt([],10),[]);assert.deepEqual(boxesAt(undefined,10),[]);
});
test('boxesAt matches by IoU when there are no track ids, keeps tracks apart, and shows an unmatched box only from the nearer detection',()=>{
  const dets=[{t:0,boxes:[box(0.1),box(0.7)]},{t:400,boxes:[box(0.15),box(0.75),box(0.45)]}];
  const r=boxesAt(dets,100);const xs=r.map(b=>b.b[0]).sort((a,b)=>a-b);
  assert.equal(r.length,2,'the box that only exists later is not shown yet');assert.ok(Math.abs(xs[0]-0.1125)<1e-9);assert.ok(Math.abs(xs[1]-0.7125)<1e-9);
  assert.equal(boxesAt(dets,300).length,3,'closer to the later detection: its new box appears');
  const two=[{t:0,boxes:[box(0.1,{track:1}),box(0.7,{track:2})]},{t:400,boxes:[box(0.12,{track:1}),box(0.72,{track:2})]}];
  const m=boxesAt(two,200).sort((a,b)=>a.track-b.track);assert.ok(Math.abs(m[0].b[0]-0.11)<1e-9&&Math.abs(m[1].b[0]-0.71)<1e-9);
});

const read=(t,answers,judge='costume')=>({t,judges:{[judge]:{answers}}});
const ans=(name,choice,accepted=true,confidence=0.9,extra={})=>({name,choice,accepted,confidence,...extra});
test('non-costumes never appear as costumes (not_visible, no_evident_costume, uncertain, other_costume without detail)',()=>{
  const m={judge_reads:[
    read(1000,[ans('costume_1','no_evident_costume'),ans('costume_2','not_visible')]),
    read(2000,[ans('costume_1','uncertain')]),read(3000,[ans('costume_1','other_costume')]),
    read(4000,[ans('costume_1','other_costume',true,0.8,{detail:'dinosaur'})]),read(5000,[ans('costume_1','witch'),ans('costume_2','not_visible')]),
    read(6000,[ans('costume_1','pirate',false)])]};
  assert.deepEqual(costumeMarkers(m).map(x=>x.label),['dinosaur 0.80','witch 0.90']);
  assert.equal(costumeAt(m,1500),'no costume seen','shown only because that was the accepted answer');
  assert.equal(costumeAt(m,2500),'no costume seen','an uncertain read says nothing: the previous accepted answer holds');
  assert.equal(costumeAt(m,5500),'witch 0.90');assert.equal(costumeAt(m,500),null);
  assert.ok(!costumeSegments(m).some(s=>/not visible|uncertain|other costume|evident/.test(s.label)));
  assert.deepEqual(summaryOf({...m,video_ms:1,end_ms:1}).costumes,['dinosaur','witch']);
  const unaccepted={judge_reads:[read(1000,[ans('costume_1','no_evident_costume',false)])]};assert.equal(costumeAt(unaccepted,2000),null);
});
test('motion row only takes the motion answers (not face / location), without not_visible or uncertain',()=>{
  const m={judge_reads:[read(1000,[ans('person_1_motion','arriving'),ans('person_1_face_or_mask_visible','yes'),ans('person_1_location','path'),ans('person_2_motion','not_visible')],'motion'),
    read(2000,[ans('person_1_motion','uncertain')],'motion')]};
  assert.deepEqual(motionMarkers(m).map(x=>x.label),['arriving 0.90']);
});
test('consecutive reads with the same value collapse into one segment',()=>{
  const m={judge_reads:[read(1000,[ans('costume_1','witch')]),read(1400,[ans('costume_1','witch')]),read(1800,[ans('costume_1','witch',true,0.95)]),
    read(2200,[ans('costume_1','uncertain')]),read(2600,[ans('costume_1','pirate')]),read(3000,[ans('costume_1','pirate')])]};
  const s=costumeSegments(m,5000);
  assert.deepEqual(s.map(x=>[x.label,x.t,x.end,x.reads]),[['witch',1000,2600,3],['pirate',2600,5000,2]]);
  assert.equal(s[0].conf,0.95);
  const mo={judge_reads:[read(0,[ans('person_1_motion','leaving')],'motion'),read(500,[ans('person_1_motion','leaving')],'motion')]};
  assert.deepEqual(motionSegments(mo).map(x=>[x.label,x.t,x.end]),[['leaving',0,1500]]);assert.deepEqual(readSegments({},'costume'),[]);
});
test('fitLabels shows a label only when it fits its own span, so adjacent labels never overlap',()=>{
  const items=[{t:0,end:100,label:'witch'},{t:100,end:9000,label:'a longer costume name'},{t:9000,end:10000,label:'x'}];
  const r=fitLabels(items,10000,300,s=>s.length*6);
  assert.deepEqual(r.map(x=>x.show),[false,true,true]);
  for(const [i,x] of r.entries())if(x.show)assert.ok((x.end-x.t)/10000*300>=x.label.length*6,'item '+i);
});

test('replay with the current tracker: one walker with a flickering twin box counts 1, and boxes get track/v/dir',()=>{
  const zones=[{kind:'path',points:[[0.3,0.3],[0.9,0.3],[0.9,1],[0.3,1]]},{kind:'porch',points:[[0.45,0.0],[0.7,0.0],[0.7,0.3],[0.45,0.3]]}];
  const dets=[];for(let i=0;i<14;i++){const t=i*400,x=0.4+i*0.01;
    const boxes=[{b:[x,0.4,x+0.1,0.9],s:0.9,zone:'path'}];if(i%3===1)boxes.push({b:[x+0.01,0.38,x+0.11,0.88],s:0.8,zone:'path'});
    boxes.push({b:[0.0,0.0,0.05,0.1],s:0.3,zone:'other',weak:true});dets.push({t,boxes});}
  const meta={presence_score:0.5,zones,detections:dets,timeline:[{t:0,state:'PATH',count:2}],counts:[{t:0,count:2}]};
  const r=replayMeta(meta,{env:{}});
  assert.equal(r.replayed,true);assert.equal(r.timeline.at(-1).state,'PATH');
  assert.equal(r.counts[0].count,0,'EMPTY shows nobody');assert.ok(r.counts.every(c=>c.count<=1),'the old double count is gone: '+JSON.stringify(r.counts));
  const b=r.detections[8].boxes[0];assert.ok(Number.isInteger(b.track));assert.ok(['arriving','leaving','present'].includes(b.dir));assert.ok(Array.isArray(b.v));
  assert.equal(r.detections[3].boxes.at(-1).track,undefined,'weak boxes are not tracked');assert.equal(meta.detections[8].boxes[0].track,undefined,'input untouched');
});

test('GET /api/visits/:id/replay returns the replayed timelines',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'visits-replay-'));const id='20261026-120000-abcdef',d=join(dir,id);mkdirSync(d,{recursive:true});
  const zones=[{kind:'sidewalk',points:[[0,0],[1,0],[1,1],[0,1]]}];
  const dets=[];for(let i=0;i<8;i++)dets.push({t:i*500,boxes:[{b:[0.3,0.3,0.4,0.8],s:0.9,zone:'sidewalk'}]});
  writeFileSync(join(d,'visit.json'),JSON.stringify({id,started_at:'2026-10-26T12:00:00.000Z',end_ms:4000,video_ms:4000,frame_count:3,max_state:'PATH',timeline:[{t:0,state:'PATH'}],zones,presence_score:0.5,detections:dets,video:'video.mp4'}));
  const server=createServer({env:{VISIT_DIR:dir,DETECTOR:'off',CAMERA_URL:'rtsp://x/s',OPENAI_API_KEY:'t'}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const r=await (await fetch(`${base}/api/visits/${id}/replay`)).json();
    assert.equal(r.replayed,true);assert.deepEqual(r.timeline.map(e=>e.state),['EMPTY','SIDEWALK']);assert.equal(r.detections.length,8);assert.equal(r.detections[4].boxes[0].dir,'present');
    assert.equal((await fetch(`${base}/api/visits/nope/replay`)).status,404);
  }finally{await new Promise(r=>server.close(r));server.closeAllConnections?.();rmSync(dir,{recursive:true,force:true});}
});

test('detector results are stamped with the frame CAPTURE time, not the time the result arrived',async()=>{
  const sidecar={status:()=>({state:'ready'}),start(){},stop(){},call:async()=>{await new Promise(r=>setTimeout(r,40));return {persons:[{bbox:[0.4,0.3,0.5,0.9],score:0.9}],ms:30};}};
  let clock=100000;const d=createPersonDetector({env:{DETECTOR_FPS:'15'},sidecar,zonesFile:null,now:()=>clock});
  d.start();const p=d.onFrame({bytes:Buffer.from([1]),at:99000});clock=100500;const r=await p;
  assert.equal(r.at,99000);assert.equal(r.group&&r.at,99000);d.stop();
});

test('boxes are looked up at the capture time of the picture on screen (step function), not the playhead',()=>{
  const ft=[0,370,740,1100];
  assert.equal(snapToFrame(ft,0),0);assert.equal(snapToFrame(ft,369),0);assert.equal(snapToFrame(ft,371),370);assert.equal(snapToFrame(ft,900),740);assert.equal(snapToFrame(ft,5000),1100);
  assert.equal(snapToFrame(ft,-5),-5);assert.equal(snapToFrame([],500),500);assert.equal(snapToFrame(undefined,500),500);
  const dets=[{t:0,boxes:[box(0.8,{track:1})]},{t:370,boxes:[box(0.5,{track:1})]}];
  assert.ok(Math.abs(boxesAt(dets,snapToFrame(ft,300),300)[0].b[0]-0.8)<1e-9,'a walker is not boxed ahead of the frame being shown');
});

test('live overlay path: SSE detector results carry track/v/dir per person, and the overlay arrow geometry exists for them',async()=>{
  const dir=[0.40,0.42,0.44,0.46,0.48];let i=0;
  const sidecar={status:()=>({state:'ready'}),start(){},stop(){},call:async()=>{const x=dir[i++];return {persons:[{bbox:[x,0.3,x+0.1,0.95],score:0.9}],ms:5};}};
  const d=createPersonDetector({env:{DETECTOR_FPS:'100'},sidecar,zonesFile:null,now:()=>0});
  const seen=[];d.subscribe(r=>seen.push(r));d.start();
  for(let k=0;k<5;k++){await d.onFrame({bytes:Buffer.from([1]),at:1000+k*300},{force:true});}
  const last=seen.at(-1).persons[0];
  assert.ok(Number.isInteger(last.track));assert.ok(['arriving','leaving','present'].includes(last.dir));assert.equal(last.v.length,2);
  const a=arrowOf(last.bbox,last.v,last.dir,{x:0,y:0,w:960,h:540});assert.ok(a&&Number.isFinite(a.tx));
  d.stop();
});
