// dir = street-relative motion: leaving = up the image (toward the sidewalk), arriving = down, lateral = present; 1 s hold; group goodbye needs a real exit. Overlay box filter.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPresenceTracker} from '../src/presence/presence-tracker.mjs';
import {createJudgeEvents} from '../src/presence/judge-events.mjs';
import {arrivalTrack} from '../src/presence/arrival.mjs';
import {keepBox,labelOf} from '../public/box-filter.js';

const zones=[
 {name:'sidewalk',kind:'sidewalk',points:[[0,0],[1,0],[1,0.3],[0,0.3]]},
 {name:'path',kind:'path',points:[[0,0.3],[1,0.3],[1,0.88],[0,0.88]]},
 {name:'porch',kind:'porch',points:[[0.3,0.88],[0.7,0.88],[0.7,1],[0.3,1]]}
];
const P=(x,y)=>({bbox:[x-0.025,y-0.2,x+0.025,y],score:0.9});
const STEP=250;
function run(path){
 const tr=createPresenceTracker({});const out=[];
 path.forEach(([x,y],i)=>{const g=tr.update([P(x,y)],i*STEP,zones);out.push({dir:g.motion?.persons[0]?.dir,g});});
 return {tr,out};
}
const line=(n,f)=>[...Array(n)].map((_,i)=>f(i));

test('lateral crossing of the porch is present: never leaving, no LEAVING event',()=>{
 const {out}=run(line(20,i=>[0.32+0.018*i,0.95]));
 assert.ok(out.every(o=>o.dir!=='leaving'),JSON.stringify(out.map(o=>o.dir)));
 assert.ok(out.slice(4).every(o=>o.dir==='present'));
 assert.ok(out.every(o=>!o.g.leaveGroup));
 let t=0;const ev=[];const j=createJudgeEvents({now:()=>t,onEvent:e=>ev.push(e)});
 out.forEach((o,i)=>{if(i%4===3){t+=1000;const m=o.g.motion;j.feed({visitor_count:o.g.count,visitor_location:o.g.location,arriving:m.arriving,present:m.present,leaving:m.leaving,presence_source:'detector',leaveGroup:o.g.leaveGroup,costume_slots:[]});}});
 assert.equal(ev.filter(e=>e.type==='LEAVING').length,0);
});

test('walking up the path toward the sidewalk is leaving only after the hold',()=>{
 const {out}=run(line(16,i=>[0.5,0.8-0.04*i]));
 const first=out.findIndex(o=>o.dir==='leaving');
 assert.ok(first>0,'becomes leaving');
 assert.ok(out.slice(0,first).every(o=>o.dir!=='leaving'));
 assert.ok(first*STEP>=1000,'held ~1 s before flipping: '+first);
 assert.equal(out[first].g.leaveGroup,true,'everybody on the path is leaving');
});

test('walking down the path is arriving promptly and the welcome trigger fires',()=>{
 const {out}=run(line(10,i=>[0.5,0.4+0.04*i]));
 const first=out.findIndex(o=>o.dir==='arriving');
 assert.ok(first>0&&first<=4,'arriving within ~1 s: '+first);
 assert.equal(arrivalTrack(out[first+1].g),true);
 assert.equal(out.at(-1).g.leaveGroup,false);
});

test('a standing person with jitter stays present',()=>{
 const rnd=i=>((i*7919)%13-6)/6*0.006;
 const {out}=run(line(40,i=>[0.5+rnd(i+3),0.6+rnd(i)]));
 assert.ok(out.every(o=>o.dir!=='leaving'&&o.dir!=='arriving'));
});

test('stepping off sideways onto the lawn is not a group goodbye',()=>{
 const {out}=run([...line(8,()=>[0.5,0.6]),...line(14,i=>[0.5+0.04*i,0.6])]);
 assert.ok(out.every(o=>!o.g.leaveGroup));
});

test('group walking back out to the sidewalk latches the goodbye',()=>{
 const {out}=run(line(30,i=>[0.5,0.7-0.025*i]));
 assert.ok(out.some(o=>o.g.leaveGroup));
});

test('judge-events: leaveGroup=false suppresses LEAVING, true fires it',()=>{
 for(const [lg,want] of [[false,0],[true,1]]){
  let t=0;const ev=[];const j=createJudgeEvents({now:()=>t,onEvent:e=>ev.push(e)});
  for(let i=0;i<4;i++){t+=1000;j.feed({visitor_count:2,visitor_location:'path',arriving:0,present:1,leaving:1,presence_source:'detector',leaveGroup:lg,costume_slots:[]});}
  assert.equal(ev.filter(e=>e.type==='LEAVING').length,want);
 }
});

test('overlay filter hides weak/static boxes unless the toggle is on; far label',()=>{
 assert.equal(keepBox({score:0.26,src:'band'}),false);
 assert.equal(keepBox({score:0.41,src:'band'}),true);
 assert.equal(keepBox({score:0.8,src:'band',suppressed:true}),false);
 assert.equal(keepBox({score:0.8,suppressed:true}),false);
 assert.equal(keepBox({score:0.3,weak:true}),false);
 assert.equal(keepBox({score:0.9}),true);
 assert.equal(keepBox({score:0.26,src:'band'},true),true);
 assert.equal(keepBox({score:0.8,suppressed:true},true),true);
 assert.equal(labelOf({src:'band',score:0.41}),'far 0.41');
 assert.equal(labelOf({score:0.9},'path'),'path 0.90');
});
