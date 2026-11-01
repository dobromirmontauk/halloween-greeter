// Sidewalk scream: once per group on the first sidewalk frame, a random pre-rendered clip through pw-play, re-armed on EMPTY. Fake spawn, fake clock, no audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createScream,screamOptions,sidewalkScreamTrigger} from '../src/presence/scream.mjs';

const EMPTY={group:{state:'EMPTY',tracks:0}};
const SIDE={persons:[{score:0.9,zone:'sidewalk',dir:'arriving'}],group:{state:'SIDEWALK',count:1}};
const PATH={persons:[{score:0.9,zone:'path',dir:'arriving'}],group:{state:'PATH',count:1}};
function rig({env={},clips=['a.wav','b.wav'],enabled=()=>true}={}){
 const spawned=[],notes=[];let clock=0;
 const spawnImpl=(cmd,args)=>{const c=new EventEmitter();c.cmd=cmd;c.args=args;c.kill=()=>c.emit('exit',null);spawned.push(c);return c;};
 const s=createScream({env,root:'/r',enabled,now:()=>clock,rng:()=>0,spawnImpl,listClips:async()=>clips,note:(k,e)=>notes.push({k,...e})});
 return {s,spawned,notes,tick:ms=>{clock+=ms;},finish:()=>spawned.at(-1).emit('exit',0)};
}

test('screams once on the first sidewalk frame, not again for the same group, again after EMPTY',async()=>{
 const f=rig();
 await f.s.onDetect(SIDE);
 assert.equal(f.spawned.length,1);
 assert.equal(f.spawned[0].cmd,'pw-play');
 assert.deepEqual(f.spawned[0].args,['--volume','1','/r/data/screams/a.wav']);
 assert.deepEqual(f.notes,[{k:'scream',clip:'a.wav'}]);
 f.finish();f.tick(60000);
 await f.s.onDetect(SIDE);await f.s.onDetect(PATH);
 assert.equal(f.spawned.length,1,'same group: no second scream');
 await f.s.onDetect(EMPTY);await f.s.onDetect(SIDE);
 assert.equal(f.spawned.length,2);
 assert.match(f.spawned[1].args.at(-1),/b\.wav$/,'never the same clip twice in a row');
});

test('a group that appears straight on the path does not scream',async()=>{
 const f=rig();await f.s.onDetect(PATH);
 assert.equal(f.spawned.length,0);
});

test('cooldown, disabled modes, SCREAM=off and missing clips',async()=>{
 const f=rig({env:{SCREAM_COOLDOWN_MS:'10000'}});
 await f.s.onDetect(SIDE);f.finish();await f.s.onDetect(EMPTY);f.tick(5000);await f.s.onDetect(SIDE);
 assert.equal(f.spawned.length,1,'inside the cooldown');
 f.tick(6000);await f.s.onDetect(SIDE);
 assert.equal(f.spawned.length,2,'still armed after the cooldown');
 const off=rig({enabled:()=>false});await off.s.onDetect(SIDE);assert.equal(off.spawned.length,0);
 const no=rig({env:{SCREAM:'off'}});await no.s.onDetect(SIDE);assert.equal(no.spawned.length,0);
 const none=rig({clips:[]});await none.s.onDetect(SIDE);
 assert.equal(none.spawned.length,0);assert.match(none.s.status().error,/no clips/);
});

test('weak sidewalk boxes trigger while the debounced state is still EMPTY; options parse',()=>{
 assert.equal(sidewalkScreamTrigger({group:{state:'EMPTY',tracks:0},sidewalk:[{bbox:[0,0,1,1]}]}),true);
 assert.equal(sidewalkScreamTrigger(PATH),false);
 assert.deepEqual(screamOptions({SCREAM_VOLUME:'5',SCREAM_COOLDOWN_MS:'x'}),{on:true,dir:'data/screams',cooldownMs:30000,volume:2});
});

test('dashboard label',async()=>{
 const {screamLabel}=await import('../public/lib.js');
 assert.equal(screamLabel(null),'–');
 assert.equal(screamLabel({on:false}),'Off');
 assert.equal(screamLabel({on:true,error:'no clips in data/screams'}),'⚠ no clips in data/screams');
 assert.equal(screamLabel({on:true,enabled:true,armed:true,clips:4,screams:0}),'Armed · 4 clips');
 assert.equal(screamLabel({on:true,enabled:true,playing:true,clips:4,screams:2,last_at:1000},31000),'Screaming! · 4 clips · 2 so far, last 30 s ago');
 assert.equal(screamLabel({on:true,enabled:false,armed:true,clips:1,screams:0}),'Idle (mode not ON) · 1 clip');
});
