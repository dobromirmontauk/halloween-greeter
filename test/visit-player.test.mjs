import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {makeClock,contentRect,detAt,stateAt,countAt,costumeAt,eventsOf,dirSegments,summaryOf,countSegments} from '../public/visit-time.js';
import {arrowOf} from '../public/box-arrow.js';
import {ffmpegEncode} from '../src/visits/visit-recorder.mjs';

const meta={video_ms:9667,end_ms:11000,fps:6,frame_times:[0,100,300,1500,3000,4800],initial_state:'EMPTY',
  timeline:[{t:0,state:'EMPTY',count:0},{t:500,state:'SIDEWALK',count:1},{t:5000,state:'PATH',count:2}],
  detections:[{t:0,boxes:[]},{t:500,boxes:[{b:[0,0,1,1],s:0.9,zone:'sidewalk',dir:'arriving',v:[0.01,0]},{b:[0,0,1,1],s:0.3,zone:'other',weak:true}]},{t:1000,boxes:[{b:[0,0,1,1],s:0.9,zone:'path',dir:'present'}]}],
  judge_reads:[{t:6000,judges:{costume:{answers:[{name:'c',choice:'witch',confidence:0.92,accepted:true},{name:'c2',choice:'ghost',confidence:0.4,accepted:false}]}}},{t:8000,judges:{motion:{error:'timeout',answers:[]}}}]};

test('contentRect is the object-fit:contain picture rect (the old canvas used the element box and a stale bitmap height)',()=>{
  assert.deepEqual(contentRect(960,540,1920,1080),{x:0,y:0,w:960,h:540});
  const r=contentRect(960,700,1920,1080);assert.equal(r.w,960);assert.equal(r.h,540);assert.equal(r.y,80);
  const p=contentRect(500,500,100,200);assert.equal(p.h,500);assert.equal(p.w,250);assert.equal(p.x,125);
});
test('clock: real-time encodes are identity; constant-fps encodes map frame index through frame_times',()=>{
  const real=makeClock(meta,9.6);assert.equal(real.real,true);assert.equal(real.toWall(2500),2500);assert.equal(real.toVideo(2500),2500);
  const old=makeClock(meta,1.0); // 6 frames at 6 fps = 1 s, but captured over 4.8 s
  assert.equal(old.real,false);assert.equal(old.toWall(0),0);assert.equal(old.toWall(500),1500); // frame 3
  assert.equal(old.toWall(990),4800);assert.ok(Math.abs(old.toVideo(1500)-500)<5);assert.ok(Math.abs(old.toVideo(4000)-(4/6*1000))<5);
  assert.equal(makeClock({...meta,encode:{timing:'real'}},1.0).real,true);
});
test('lookups at the playhead',()=>{
  assert.equal(stateAt(meta,100).state,'EMPTY');assert.equal(stateAt(meta,700).state,'SIDEWALK');assert.equal(stateAt(meta,9000).state,'PATH');
  assert.equal(countAt(meta,9000),2);assert.equal(costumeAt(meta,5000),null);assert.equal(costumeAt(meta,7000),'witch 0.92');
  assert.equal(detAt(meta.detections,600).t,500);assert.equal(detAt(meta.detections,3000),null);
  assert.deepEqual(countSegments(meta).map(s=>[s.t,s.end,s.count]),[[0,500,0],[500,5000,1],[5000,11000,2]]);
});
test('events, direction segments and list summary degrade gracefully',()=>{
  assert.deepEqual(eventsOf(meta).map(e=>e.kind+':'+e.label),['state:SIDEWALK','dir:arriving','state:PATH','costume:witch 0.92','error:motion error']);
  const noExtras={video_ms:1000,end_ms:1000,timeline:[],detections:[{t:0,boxes:[{b:[0,0,1,1],s:1,zone:'path'}]}]};
  assert.deepEqual(dirSegments(noExtras),[]);assert.deepEqual(eventsOf({}),[]);assert.equal(stateAt({},5).state,'EMPTY');
  assert.deepEqual(summaryOf(meta),{peak_count:2,costumes:['witch']});
});
test('arrow: from the foot point along v, min length when moving, dot only when present, nothing without fields',()=>{
  const rect={x:0,y:0,w:1000,h:500};
  const a=arrowOf([0.4,0.2,0.6,0.6],[0.05,0],'arriving',rect);assert.equal(a.x,500);assert.equal(a.y,300);assert.equal(a.tx,580,'capped at 80 px');assert.equal(a.ty,300);const q=arrowOf([0.4,0.2,0.6,0.6],[0.01,0],'arriving',rect);assert.equal(q.tx-q.x,40);
  const s=arrowOf([0.4,0.2,0.6,0.6],[0.001,0],'leaving',rect);assert.ok(Math.hypot(s.tx-s.x,s.ty-s.y)>=17.9);
  assert.equal(arrowOf([0.4,0.2,0.6,0.6],[0.05,0],'present',rect).dot,true);
  assert.equal(arrowOf([0.4,0.2,0.6,0.6],null,undefined,rect),null);
  assert.equal(arrowOf([0.4,0.2,0.6,0.6],null,'arriving',rect).dot,true);
});
const hasFfmpeg=spawnSync('ffmpeg',['-version']).status===0;
test('encode uses real per-frame durations: video length equals wall time of irregular frames',{skip:!hasFfmpeg},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'venc-'));mkdirSync(join(dir,'frames'));
  try{
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc=size=160x90:rate=1','-frames:v','4',join(dir,'frames','%d.jpg')]);
    const times=[0,100,1500,4000];
    await ffmpegEncode({dir,frames:times.map((t,i)=>({name:`${i+1}.jpg`,t})),fps:6,crf:35});
    const out=execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',join(dir,'video.mp4')]).toString();
    assert.ok(Math.abs(Number(out)*1000-(4000+1000/6))<200,'duration '+out);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('clock: real-time encode that starts at the first saved frame (not wall 0) is offset, not frame-indexed',()=>{
  // Real clip 20261026-183455: frames captured 645..4771 ms, MP4 4.33 s, video_ms 4938, 11 frames at fps 6.
  const m={fps:6,video_ms:4938,end_ms:6244,frame_times:[645,1004,1249,1853,2000,2149,2912,3200,3746,4057,4771]};
  const c=makeClock(m,4.333);assert.equal(c.real,true);
  assert.equal(c.toWall(0),645);assert.equal(c.toWall(1000),1645);assert.equal(c.toVideo(2645),2000);
  assert.equal(c.toVideo(100),0);assert.ok(c.toVideo(6244)<=4333);
});
