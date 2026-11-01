import {test} from 'node:test';import assert from 'node:assert/strict';
import {PartyController} from '../src/voice/party-flow.mjs';
import {createArrival} from '../src/presence/arrival.mjs';
const seen=(extra={})=>({visitor_count:1,visitor_location:'path',arriving:1,present:0,leaving:0,costume_slots:[{label:'pirate',confidence:0.99}],...extra});

test('a video-capable voice (Gemini) sees costumes itself: no describe call, judge labels only as a hint',async()=>{
 let now=0;const prompts=[];let described=0;
 const flow=new PartyController({voice:{seesCostumes:()=>true,start:async()=>{},sendPrompt:(kind,text)=>{prompts.push([kind,text]);return true;},stop:async()=>{}},describe:async()=>{described++;return 'A pirate.';},now:()=>now,schedule:()=>({}),cancel:()=>{}});
 for(let i=1;i<=3;i++){now=i*1000;await flow.observe({at:now},seen());}
 assert.equal(described,0);const costume=prompts.find(p=>p[0]==='costume');assert.ok(costume);assert.match(costume[1],/camera/);assert.match(costume[1],/pirate/);
 await flow.close();
});

test('arrival pre-warm is a no-op for an always-on voice',async()=>{
 let prewarmed=0;const voice=async()=>({alwaysOn:true,prewarm:async()=>{prewarmed++;},status:()=>({})});
 const arrival=createArrival({env:{PREWARM:'on'},voice,party:async()=>({active:false,locked:false}),enabled:()=>true,busy:()=>false});
 assert.equal(arrival.opts.prewarm,true);
 await arrival.onDetect({at:1,group:{state:'SIDEWALK',tracks:1,count:1,tracks_list:[]},sidewalk:[{box:[0.1,0.1,0.2,0.3],score:0.4}]});
 assert.equal(prewarmed,0);
 // control: the same detector frame does pre-warm a per-visit voice
 const control=createArrival({env:{PREWARM:'on'},voice:async()=>({prewarm:async()=>{prewarmed++;},status:()=>({})}),party:async()=>({active:false,locked:false}),enabled:()=>true,busy:()=>false});
 await control.onDetect({at:1,group:{state:'SIDEWALK',tracks:1,count:1,tracks_list:[]},sidewalk:[{box:[0.1,0.1,0.2,0.3],score:0.4}]});
 assert.equal(prewarmed,1);
});
