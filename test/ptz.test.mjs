import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PtzController} from '../src/presence/ptz.mjs';

function fixture({moveFails=false,stopFails=false,home}={}) {
  const calls=[];
  const client={status:async()=>({pan:0.1,tilt:-0.5,moving:'IDLE'}),move:async(x,y)=>{calls.push(['move',x,y]);if(moveFails)throw Error('private-camera-url');},stop:async()=>{calls.push(['stop']);if(stopFails)throw Error('private-password');},home:async(...args)=>calls.push(['home',...args])};
  return {calls,controller:new PtzController(client,{home,delay:async()=>{calls.push(['delay']);}})};
}
test('fixed directional pulse always stops, including failed movement',async()=>{
  const f=fixture();await f.controller.command('left');assert.deepEqual(f.calls,[['move',-0.25,0],['delay'],['stop']]);
  const failed=fixture({moveFails:true});await assert.rejects(failed.controller.command('up'));assert.deepEqual(failed.calls,[['move',0,0.25],['stop']]);
});
test('invalid action and unconfigured home never move camera',async()=>{
  const f=fixture();await assert.rejects(f.controller.command('track'),{status:400});await assert.rejects(f.controller.command('home'),{status:409});assert.deepEqual(f.calls,[]);
});
test('home verifies configured position with feedback and stop stays independent',async()=>{
  const f=fixture({home:{pan:0.1,tilt:-0.5}});await f.controller.command('home');await f.controller.command('stop');assert.deepEqual(f.calls,[['stop'],['stop']]);
});
test('overlapping move is rejected while emergency Stop can interrupt',async()=>{
  let release;const calls=[];const controller=new PtzController({move:async()=>calls.push('move'),stop:async()=>calls.push('stop')},{delay:()=>new Promise(r=>{release=r;})});
  const first=controller.command('right');await new Promise(r=>setImmediate(r));await assert.rejects(controller.command('up'),{status:409});await controller.command('stop');release();await first;assert.deepEqual(calls,['move','stop','stop']);
});

import {AutoFramer} from '../src/presence/framing.mjs';
test('auto framing centers visible target and stops; pending vision cannot move after Stop',async()=>{
  let resolveVision;const actions=[];const control={status:async()=>({pan:0,tilt:0}),command:async a=>actions.push(a)};
  const framer=new AutoFramer({control,observe:()=>new Promise(r=>{resolveVision=r;})});await framer.start();await new Promise(r=>setImmediate(r));await framer.stop();resolveVision({captured_at:Date.now(),target:{head_visible:true,head_clipped:false,head_bbox:{x1:0.4,y1:0.28,x2:0.6,y2:0.48},visible:true,confidence:1,x:0.9,y:0.5}});await new Promise(r=>setImmediate(r));assert.deepEqual(actions,['stop']);assert.equal(framer.status().active,false);
});
test('auto framing stops without motion for uncertain, centered or stale scene',async()=>{
  for(const result of [{captured_at:Date.now(),target:{visible:false,confidence:0,x:0.5,y:0.5}},{captured_at:Date.now(),target:{head_visible:true,head_clipped:false,head_bbox:{x1:0.4,y1:0.28,x2:0.6,y2:0.48},visible:true,confidence:0.9,x:0.5,y:0.5}},{captured_at:0,target:{head_visible:true,head_clipped:false,head_bbox:{x1:0.4,y1:0.28,x2:0.6,y2:0.48},visible:true,confidence:1,x:1,y:1}}]){
    const actions=[];const framer=new AutoFramer({control:{status:async()=>({pan:0,tilt:0}),command:async a=>actions.push(a)},observe:async()=>result});await framer.start();await new Promise(r=>setImmediate(r));assert.deepEqual(actions,['stop']);assert.equal(framer.status().active,false);
  }
});
test('auto framing bounded loop moves toward visible target and stops at range limit',async()=>{
 const actions=[];let reads=0;const framer=new AutoFramer({control:{status:async()=>({pan:reads++>1?0.21:0,tilt:0}),command:async a=>actions.push(a)},observe:async()=>({captured_at:Date.now(),target:{head_visible:true,head_clipped:false,head_bbox:{x1:0.4,y1:0.28,x2:0.6,y2:0.48},visible:true,confidence:1,x:0.9,y:0.5,head_bbox:{x1:0.8,y1:0.28,x2:0.95,y2:0.48}}}),delay:async()=>{}});await framer.start();await new Promise(r=>setImmediate(r));assert.deepEqual(actions,['right','stop']);assert.equal(framer.status().active,false);
});

test('clipped head overrides centered torso and mechanical limit cannot report centered',async()=>{
 const actions=[];let reads=0;const framer=new AutoFramer({control:{status:async()=>({pan:0,tilt:reads++>1?1:0}),command:async a=>actions.push(a)},observe:async()=>({captured_at:Date.now(),target:{visible:true,confidence:0.99,x:0.5,y:0.5,head_visible:false,head_clipped:true,clipped_edge:'top',head_bbox:null,body_bbox:{x1:0.4,y1:0,x2:0.6,y2:0.8}}}),delay:async()=>{}});await framer.start();await new Promise(r=>setImmediate(r));assert.deepEqual(actions,['up','stop']);assert.doesNotMatch(framer.status().action,/centered/);
});

import {createPtz} from '../src/presence/ptz.mjs';
test('calibrated position polarity is reported separately and does not reverse motor commands',async()=>{
 const commands=[];const controller=new PtzController({status:async()=>({pan:0,tilt:1}),move:async(x,y)=>commands.push([x,y]),stop:async()=>{}},{positionTiltDirection:-1,invertTilt:false,delay:async()=>{}});
 const status=await controller.status();assert.equal(status.position_tilt_direction,-1);assert.equal(status.motor_tilt_direction,1);await controller.command('up');assert.deepEqual(commands,[[0,0.25]]);
 const env={ONVIF_URL:'http://camera:2020/onvif/device_service',ONVIF_USERNAME:'camera',ONVIF_PASSWORD:'secret',PTZ_POSITION_TILT_DIRECTION:'-1'};assert.equal(createPtz(env).positionTiltDirection,-1);assert.throws(()=>createPtz({...env,PTZ_POSITION_TILT_DIRECTION:'0'}),/must be 1 or -1/);
});


function feedbackFixture({pan=0,tilt=0,target={pan:.12,tilt:-.22},invertPan=false,invertTilt=false,stuck=false,maxPulses=20,timeoutMs=12000}={}){
 let time=0,lastMove=[0,0];const calls=[];
 const client={status:async()=>({pan,tilt,moving:'IDLE'}),move:async(x,y)=>{lastMove=[x,y];calls.push(['move',x,y]);},stop:async()=>{calls.push(['stop']);lastMove=[0,0];},home:async()=>assert.fail('AbsoluteMove must never be used')};
 const delay=async ms=>{time+=ms;calls.push(['delay',ms]);if(!stuck){pan+=lastMove[0]*(invertPan?-1:1)/.25*.03*ms/350;tilt-=lastMove[1]*(invertTilt?-1:1)/.25*.078*ms/350;}};
 const controller=new PtzController(client,{home:target,invertPan,invertTilt,positionPanDirection:1,positionTiltDirection:-1,delay,now:()=>time,homeMaxPulses:maxPulses,homeTimeoutMs:timeoutMs});
 return {controller,calls,position:()=>({pan,tilt}),elapsed:()=>time};
}

test('feedback home converges on both axes using calibrated negative reported tilt polarity',async()=>{
 for(const invertTilt of [false,true]){
  const f=feedbackFixture({invertTilt});const result=await f.controller.command('home');
  assert.equal(result.home_reached,true);assert.ok(Math.abs(f.position().pan-.12)<=.02);assert.ok(Math.abs(f.position().tilt+.22)<=.02);assert.ok(result.pulses<=20);assert.ok(f.elapsed()<=12000);
  assert.ok(f.calls.filter(x=>x[0]==='move').every(x=>Math.abs(x[1])<=.25&&Math.abs(x[2])<=.25));
  const vertical=f.calls.find(x=>x[0]==='move'&&x[2]!==0);assert.equal(Math.sign(vertical[2]),invertTilt?-1:1);
  assert.equal(f.calls.at(-1)[0],'stop');
 }
});

test('feedback home rejects nonprogress and exhausted budgets with a final Stop',async()=>{
 const stuck=feedbackFixture({stuck:true});await assert.rejects(stuck.controller.command('home'),/no progress/);assert.equal(stuck.calls.filter(x=>x[0]==='move').length,2);assert.equal(stuck.calls.at(-1)[0],'stop');
 const budget=feedbackFixture({maxPulses:1});await assert.rejects(budget.controller.command('home'),/movement budget/);assert.equal(budget.calls.filter(x=>x[0]==='move').length,1);assert.equal(budget.calls.at(-1)[0],'stop');
 const timeout=feedbackFixture({timeoutMs:100});await assert.rejects(timeout.controller.command('home'),/time budget/);assert.equal(timeout.calls.at(-1)[0],'stop');
});

test('emergency Stop cancels a pending Home pulse and prevents any later pulses',async()=>{
 let release;const calls=[];
 const controller=new PtzController({status:async()=>({pan:0,tilt:0}),move:async(x,y)=>calls.push(['move',x,y]),stop:async()=>calls.push(['stop'])},{home:{pan:.1,tilt:-.2},positionTiltDirection:-1,delay:()=>new Promise(resolve=>{release=resolve;})});
 const pending=controller.command('home');await new Promise(r=>setImmediate(r));assert.equal(calls.filter(x=>x[0]==='move').length,1);
 await controller.command('stop');release();await assert.rejects(pending,/cancelled/);assert.equal(calls.filter(x=>x[0]==='move').length,1);assert.equal(calls.at(-1)[0],'stop');
});

test('Home waits for an earlier directional pulse to finish, then reads position',async()=>{
 let release,firstDelay=true;const calls=[];
 const controller=new PtzController({status:async()=>{calls.push('status');return {pan:.1,tilt:-.2};},move:async()=>calls.push('move'),stop:async()=>calls.push('stop')},{home:{pan:.1,tilt:-.2},delay:async()=>{if(firstDelay){firstDelay=false;await new Promise(resolve=>{release=resolve;});}}});
 const moving=controller.command('right');await new Promise(r=>setImmediate(r));const home=controller.command('home');await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['move']);release();await moving;assert.equal((await home).home_reached,true);assert.deepEqual(calls,['move','stop','status','stop']);
});

import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('private saved Home overrides legacy environment and rejects malformed coordinates',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'camera-home-')),path=join(directory,'camera-home.json');
 const env={ONVIF_URL:'http://camera:2020/onvif/device_service',ONVIF_USERNAME:'camera',ONVIF_PASSWORD:'secret',CAMERA_HOME_FILE:path,PTZ_HOME_PAN:'.9',PTZ_HOME_TILT:'.8'};
 try{
  assert.deepEqual(createPtz(env).home,{pan:.9,tilt:.8});
  await writeFile(path,JSON.stringify({pan:-.146825,tilt:-.265625,saved_at:'2026-10-26T05:03:38Z'}));assert.deepEqual(createPtz(env).home,{pan:-.146825,tilt:-.265625});
  for(const bad of [{pan:null,tilt:0},{pan:2,tilt:0},{pan:'0.1',tilt:0}]){await writeFile(path,JSON.stringify(bad));assert.throws(()=>createPtz(env),/Saved camera Home is invalid/);}
  await writeFile(path,'invalid json');assert.throws(()=>createPtz(env),/Saved camera Home is invalid/);
 }finally{await rm(directory,{recursive:true,force:true});}
});


test('home stops after the first movement in the wrong reported-position direction',async()=>{
 let tilt=0;const calls=[];
 const controller=new PtzController({status:async()=>({pan:0,tilt}),move:async(x,y)=>{calls.push('move');tilt+=.08;},stop:async()=>calls.push('stop')},{home:{pan:0,tilt:-.2},positionTiltDirection:-1,delay:async()=>{}});
 await assert.rejects(controller.command('home'),/moved away/);assert.equal(calls.filter(x=>x==='move').length,1);assert.equal(calls.at(-1),'stop');
});

test('waiting for idle is bounded without cancelling the existing pulse',async()=>{
 let release;const controller=new PtzController({move:async()=>{},stop:async()=>{}},{delay:()=>new Promise(resolve=>{release=resolve;})});
 const moving=controller.command('left');await new Promise(r=>setImmediate(r));await assert.rejects(controller.whenIdle(2),/still moving/);assert.equal(controller.busy,true);release();await moving;await controller.whenIdle();
});
