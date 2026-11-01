import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COSTUME_CATALOG,COSTUME_FALLBACKS} from '../src/presence/costumes.mjs';
import {presenceRequest,motionRequest,costumeRequest,parsePresence,parseMotion,parseCostume,mergeRead,CameraDirector} from '../src/presence/decisions.mjs';
const a=(name,choice,confidence=0.99)=>({type:'choice',name,choice,confidence});
// Director fixtures: a merged read from a Presence result; a legacy camera_action answer only drives the dormant framing code.
const parseDecision=result=>{const d=mergeRead({presence:parsePresence(result)});const action=result.answers.find(x=>x.name==='camera_action');return action&&action.confidence>=0.75?{...d,action:d.visitor_count===0?'stop':action.choice}:d;};
const answers=(count='1',action='centered',interval='5000',confidence=0.99)=>({answers:[{type:'choice',name:'real_people_count',choice:count,confidence},{type:'choice',name:'camera_action',choice:action,confidence},{type:'choice',name:'next_capture_ms',choice:interval,confidence}]});
test('Presence is a single count question with the prop exclusions; 4_5 and 6_plus map to numbers',()=>{
 const body=presenceRequest({bytes:Buffer.from([1,2]),at:1});assert.equal(body.model,'gpt-6-luna');assert.equal(body.input[0].content[1].image_url,'data:image/jpeg;base64,AQI=');
 assert.deepEqual(body.questions.map(q=>q.name),['real_people_count','closest_person_location']);assert.deepEqual(body.questions[1].choices.map(c=>c.value),['sidewalk','path','porch','none','uncertain']);assert.deepEqual(body.questions[0].choices.map(c=>c.value),['0','1','2','3','4_5','6_plus','uncertain']);
 assert.match(body.input[0].content[0].text,/Count living visitors/);assert.match(body.input[0].content[0].text,/skeleton/);assert.match(body.questions[0].instructions,/mannequins, reflections and every figure wearing a reflective/);
 assert.equal(JSON.stringify(body).includes('camera_action'),false);
 assert.deepEqual(parsePresence(answers('2')),{visitor_count:2,count_label:'2',confidence:0.99,location:'uncertain',location_confidence:0});assert.equal(parsePresence(answers('4_5')).visitor_count,4);assert.equal(parsePresence(answers('6_plus')).visitor_count,6);
 assert.equal(parseDecision(answers('0')).action,'stop');assert.throws(()=>parsePresence(answers('1','x','x',0.74)),{code:'UNCERTAIN_PEOPLE_COUNT'});assert.throws(()=>parsePresence(answers('uncertain')));assert.throws(()=>parsePresence({answers:[{type:'refusal',name:'real_people_count'}]}));
 assert.equal(parseDecision(answers('1','x','x',0.75)).visitor_count,1);
});
test('adaptive capture delay comes from Decisions and motion forces1s; stop cancels pending action',async()=>{
 const moves=[],delays=[];let director,observations=0;
 director=new CameraDirector({capture:async()=>({at:Date.now(),bytes:Buffer.from([1])}),decide:async()=>{observations++;return parseDecision(answers('1',observations===1?'left':'centered','5000'));},control:{status:async()=>({pan:0,tilt:0}),command:async a=>moves.push(a)},delay:async ms=>{delays.push(ms);if(delays.length===2)await director.stop();}});
 await director.start(true);await new Promise(r=>setImmediate(r));assert.ok(delays[0]<=1000);assert.ok(delays[1]<=1000&&delays[1]>0);assert.deepEqual(moves.slice(0,2),['left','stop']);
});
test('Decisions count is authoritative for30s absence and uncertain counts reset',async()=>{
 let now=1000;const director=new CameraDirector({now:()=>now});director.accept(parseDecision(answers('0','stop','5000')),{at:now});now=16000;director.accept(parseDecision(answers('0','stop','5000')),{at:now});assert.equal(director.status().absence_close,false);now=31000;director.accept(parseDecision(answers('0','stop','5000')),{at:now});assert.equal(director.status().absence_close,true);director.uncertain();assert.equal(director.status().absence_close,false);director.accept(parseDecision(answers('1')),{at:now});assert.equal(director.status().absent_since,null);
});

test('framing is removed from the read path: no camera_action question, fixed cadence 1000 present / 5000 empty',()=>{
 for(const body of [presenceRequest({bytes:Buffer.from([1])}),motionRequest({bytes:Buffer.from([1]),at:0},{bytes:Buffer.from([2]),at:1000}),costumeRequest({bytes:Buffer.from([1])})])assert.equal(body.questions.some(q=>q.name==='camera_action'||q.name==='next_capture_ms'),false);
 assert.equal(mergeRead({presence:parsePresence(answers('1'))}).next_capture_ms,1000);assert.equal(mergeRead({presence:parsePresence(answers('0'))}).next_capture_ms,5000);
 assert.equal(mergeRead({presence:parsePresence(answers('1'))}).action,'uncertain');
});
test('first positive presence episode frames even after an uncertain startup count',async()=>{
 let tick=0,director;const moves=[];
 director=new CameraDirector({autoTrack:true,capture:async()=>({at:Date.now()}),decide:async()=>{if(tick++===0)throw Error('Uncertain people count');return parseDecision(answers('1','up','1000'));},control:{status:async()=>({pan:0,tilt:-0.9}),command:async a=>moves.push(a)},delay:async()=>{if(tick>=2)await director.stop();}});await director.start(false);await new Promise(r=>setImmediate(r));assert.ok(moves.includes('up'));assert.equal(moves.filter(a=>a==='up').length,1);
});

test('reported tilt direction is independent of motor sign for mechanical limits',async()=>{
 for(const tilt of [-1,1]){
  const commands=[];const director=new CameraDirector({control:{status:async()=>({pan:0,tilt,position_pan_direction:1,position_tilt_direction:-1}),command:async action=>commands.push(action)}});director.origin={pan:0,tilt};director.state.tracking=true;
  if(tilt===-1){await assert.rejects(director.safeMove('up'),/mechanical limit/);assert.deepEqual(commands,[]);}else{await director.safeMove('up');assert.deepEqual(commands,['up']);}
 }
});

test('Motion sends both frames labelled earlier/later with the real gap and per-person questions',()=>{
 const body=motionRequest({bytes:Buffer.from([1]),at:1000},{bytes:Buffer.from([2]),at:2400});const c=body.input[0].content;
 assert.deepEqual(c.map(x=>x.type),['input_text','input_text','input_image','input_text','input_image']);
 assert.match(c[1].text,/EARLIER frame, captured 1\.4 seconds before the later frame/);assert.match(c[3].text,/LATER \(current\) frame/);
 assert.equal(c[2].image_url,'data:image/jpeg;base64,AQ==');assert.equal(c[4].image_url,'data:image/jpeg;base64,Ag==');
 assert.deepEqual(body.questions.map(q=>q.name),['person_1_motion','person_1_face_or_mask_visible','person_1_location','person_2_motion','person_2_face_or_mask_visible','person_2_location','person_3_motion','person_3_face_or_mask_visible','person_3_location']);
 const q=Object.fromEntries(body.questions.map(x=>[x.name,x]));assert.deepEqual(q.person_1_motion.choices.map(x=>x.value),['arriving','present','leaving','not_visible','uncertain']);assert.deepEqual(q.person_2_face_or_mask_visible.choices.map(x=>x.value),['yes','no','not_visible']);
 assert.match(q.person_1_motion.instructions,/nearest to the greeting area first, then left to right/);assert.match(q.person_1_motion.instructions,/face or the front of their mask AND/);assert.match(q.person_1_motion.instructions,/back or the back of their head/);assert.match(q.person_1_motion.instructions,/side profile alone is uncertain/);assert.match(q.person_1_motion.instructions,/skeleton props/);
 assert.deepEqual(q.person_2_location.choices.map(c=>c.value),['sidewalk','path','porch','not_visible','uncertain']);assert.match(q.person_2_location.instructions,/public sidewalk or street edge at the property line/);assert.match(q.person_2_location.instructions,/walkway, yard or steps/);assert.equal(q.visitor_location,undefined);
});
test('location flows into camera status and becomes uncertain when observations expire',()=>{
 let now=1000;const director=new CameraDirector({now:()=>now});const motion=parseMotion({answers:[a('person_1_motion','present'),a('person_1_face_or_mask_visible','yes'),a('person_1_location','path')]},1);director.accept(mergeRead({presence:parsePresence(answers('1')),motion}),{at:now});assert.equal(director.status().visitor_location,'path');now=32000;assert.equal(director.status().visitor_location,'uncertain');director.uncertain();assert.equal(director.status().visitor_location,'uncertain');
 assert.equal(parseMotion({answers:[a('person_1_location','sidewalk',0.79)]},1).visitor_location,'uncertain');
});

test('partial-view count uncertainty stops motors but resumes movement within the original framing budget',async()=>{
 let now=0,tick=0,reads=0,director;const commands=[];
 director=new CameraDirector({autoTrack:true,now:()=>now,capture:async()=>({at:now}),decide:async()=>{tick++;return parseDecision(answers('1',tick===3?'down':'centered','1000',tick===2?0.4:0.99));},control:{status:async()=>{reads++;return {pan:0,tilt:0};},command:async action=>commands.push(action)},delay:async ms=>{now+=ms;if(tick>=3)await director.stop();}});
 await director.start(false);await new Promise(r=>setImmediate(r));assert.equal(commands.filter(action=>action==='down').length,1);assert.equal(reads,2);assert.equal(director.trackingStarted,0);assert.equal(director.presenceEpisode,true);
});
test('repeated uncertain counts cannot extend the original thirty-second movement window',async()=>{
 let now=0,tick=0,director,expired;const commands=[];
 director=new CameraDirector({now:()=>now,capture:async()=>({at:now}),decide:async()=>{tick++;return parseDecision(answers('1','down','1000',0.4));},control:{status:async()=>({pan:0,tilt:0}),command:async action=>commands.push(action)},delay:async ms=>{now+=ms;if(now>=30000){expired=director.status();if(now>=31000)await director.stop();}}});
 await director.start(true);await new Promise(r=>setImmediate(r));assert.ok(tick>=30);assert.equal(expired.tracking,false);assert.equal(director.trackingStarted,0);assert.equal(commands.some(action=>action==='down'),false);
});


test('seventy costume choices have observable descriptions, three slots and separate fallbacks',()=>{
 assert.equal(COSTUME_CATALOG.length,70);assert.equal(new Set(COSTUME_CATALOG.map(x=>x.label)).size,70);
 assert.ok(COSTUME_CATALOG.every(x=>/^[a-z0-9]+(_[a-z0-9]+)*$/.test(x.label)));
 assert.ok(!COSTUME_CATALOG.some(x=>COSTUME_FALLBACKS.some(f=>f.label===x.label)));
 assert.match(COSTUME_FALLBACKS[0].description,/outside the 70 categories/);
 assert.deepEqual(COSTUME_FALLBACKS.map(x=>x.label),['other_costume','no_evident_costume','uncertain','not_visible']);
 assert.ok(COSTUME_CATALOG.every(x=>x.description.length>20));
 assert.ok(COSTUME_CATALOG.every(x=>!/construction|reflective|vest/.test(x.label)));
 const body=costumeRequest({bytes:Buffer.from([1])});const slots=body.questions;
 assert.equal(slots.length,3);assert.deepEqual(slots.map(q=>q.name),['costume_1','costume_2','costume_3']);assert.ok(slots.every(q=>q.choices.length===74));
 for(const l of ['kpop_demon_hunters','woody','buzz_lightyear','jessie','dolly_parton','michael_jackson','ghostface','princess_peach','bowser','grogu','ash_ketchum','pomni','scooby_doo','skeletor','green_lantern','he_man','michael_myers','minecraft','hockey_player','inflatable_costume'])assert.ok(slots.every(q=>q.choices.some(x=>x.value===l)),l);
 assert.ok(slots.every(q=>q.choices.find(x=>x.value==='witch').description.includes('Pointed')));
 assert.match(slots[0].instructions,/nearest.*left-to-right/);assert.match(slots[0].instructions,/Every reflective.*prop/);assert.match(slots[0].instructions,/never classify a visitor who is leaving/);
 assert.match(body.input[0].content[0].text,/actual human faces and human anatomy/);
});


test('costume reads preserve independent confidence and cap output at three actual people',()=>{
 const result={answers:[a('costume_1','witch',.93),a('costume_2','vampire',.84),a('costume_3','invented_label',.99),a('costume_4','pirate',1)]};
 assert.deepEqual(parseCostume(result,11),[{label:'witch',confidence:.93},{label:'uncertain',confidence:.84},{label:'uncertain',confidence:.99}]);
 assert.deepEqual(parseCostume(result,1),[{label:'witch',confidence:.93}]);assert.deepEqual(parseCostume(result,0),[]);
 result.answers[1]={type:'refusal',name:'costume_2'};assert.deepEqual(parseCostume(result,2),[{label:'witch',confidence:.93},{label:'uncertain',confidence:0}]);
});


test('per-person motion is counted into exactly one bucket at the 0.80 cutoff; arriving needs a visible face; persons beyond 3 are not bucketed',()=>{
 const m=(n,motion,c=.9)=>a(`person_${n}_motion`,motion,c),f=(n,v='yes',c=.9)=>a(`person_${n}_face_or_mask_visible`,v,c);
 let d=parseMotion({answers:[m(1,'arriving'),f(1),m(2,'present'),f(2),m(3,'leaving'),f(3,'no')]},3);
 assert.deepEqual([d.arriving,d.present,d.leaving,d.unresolved,d.unbucketed],[1,1,1,0,0]);assert.deepEqual(d.persons.map(p=>p.motion),['arriving','present','leaving']);
 d=parseMotion({answers:[m(1,'arriving'),f(1,'no')]},1);assert.equal(d.persons[0].motion,'uncertain');assert.equal(d.arriving,null,'zero is not confident while a person is unresolved');assert.equal(d.unresolved,1);
 d=parseMotion({answers:[m(1,'arriving'),f(1,'yes',.79)]},1);assert.equal(d.persons[0].motion,'uncertain');
 d=parseMotion({answers:[m(1,'present',.79),f(1),m(2,'uncertain'),f(2)]},2);assert.deepEqual([d.present,d.unresolved,d.arriving,d.leaving],[null,2,null,null]);
 d=parseMotion({answers:[m(1,'present'),f(1),m(2,'present'),f(2),m(3,'present'),f(3)]},6);assert.equal(d.present,3);assert.equal(d.unbucketed,3);assert.equal(d.arriving,null);assert.equal(d.persons.length,3);
 d=parseMotion({answers:[m(1,'present'),f(1)]},1);assert.deepEqual([d.arriving,d.present,d.leaving],[0,1,0]);
 const z=mergeRead({presence:parsePresence(answers('0'))});assert.deepEqual([z.arriving,z.present,z.leaving,z.visitor_location],[0,0,0,'none']);
 const failed=mergeRead({presence:parsePresence(answers('2'))});assert.deepEqual([failed.arriving,failed.present,failed.leaving],[null,null,null]);
 assert.equal('party_motion' in failed,false);
});


test('uncertain reads never reset absent_since or count as empty; only a positive count resets it',()=>{
 let now=1000;const director=new CameraDirector({now:()=>now});
 director.accept(parseDecision(answers('0','stop','5000')),{at:now});assert.equal(director.state.absent_since,1000);
 now=20000;director.uncertain();assert.equal(director.state.absent_since,1000);assert.equal(director.state.absence_close,false);
 now=40000;director.accept(parseDecision(answers('0','stop','5000')),{at:now});assert.equal(director.state.absence_close,true);
 now=41000;director.accept(parseDecision(answers('1')),{at:now});assert.equal(director.state.absent_since,null);
});
test('uncertain count error notifies the judge callback only for count uncertainty',async()=>{
 let calls=0,tick=0,director;
 director=new CameraDirector({onUncertainRead:()=>calls++,capture:async()=>({at:Date.now()}),decide:async()=>{tick++;if(tick===1)throw Object.assign(Error('u'),{code:'UNCERTAIN_PEOPLE_COUNT'});throw Error('net');},delay:async()=>{if(tick>=2)await director.stop();}});
 await director.start();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});

test('positive visitors read at one second; empty scene reads at five seconds',async()=>{
 for(const count of ['1','0']){
  let director;const delays=[];
  director=new CameraDirector({capture:async()=>({at:Date.now()}),decide:async()=>parseDecision(answers(count,'centered','10000')),delay:async ms=>{delays.push(ms);await director.stop();}});
  await director.start();await new Promise(r=>setImmediate(r));
  assert.ok(delays[0]<=(count==='1'?1000:5000));assert.ok(delays[0]>(count==='1'?0:4000));
 }
 const director=new CameraDirector({now:()=>100});director.setPartyActive(true);director.accept(parseDecision(answers('0','stop','10000')),{at:100});assert.equal(director.status().next_capture_ms,1000);assert.equal(director.status().tracking,false);
});


test('snapshot timestamp publishes before slow or uncertain Decisions result',async()=>{
 let resolveDecision;const pending=new Promise(resolve=>{resolveDecision=resolve;});
 const director=new CameraDirector({now:()=>100,capture:async()=>({at:99}),decide:async()=>pending,delay:async()=>{}});
 await director.start();await new Promise(r=>setImmediate(r));
 assert.equal(director.status().last_snapshot_at,99);assert.equal(director.status().observed_at,undefined);
 await director.stop();resolveDecision(parseDecision(answers('1')));await new Promise(r=>setImmediate(r));
 assert.equal(director.status().visitor_count,null);
});

test('uncertain counting retains the analysis snapshot cue while clearing stale party facts',async()=>{
 let director;
 director=new CameraDirector({now:()=>100,capture:async()=>({at:99}),decide:async()=>parseDecision(answers('1','stop','1000',.4)),delay:async()=>{await director.stop();}});
 await director.start();await new Promise(r=>setImmediate(r));
 assert.equal(director.status().last_snapshot_at,99);assert.equal(director.status().visitor_count,null);assert.deepEqual(director.status().costume_slots,[]);
});

import {describeRead} from '../src/presence/decisions.mjs';
test('answers expose the top three choices from the API probabilities, or null when none are returned',()=>{
 const probs=[['0',0.01],['1',0.62],['2',0.3],['3',0.05],['4_5',0.02]].map(([value,probability])=>({value,probability}));
 const [withTop,without]=describeRead({answers:[{...a('real_people_count','1',0.9),probabilities:probs},a('person_1_motion','present')]});
 assert.deepEqual(withTop.top,[{choice:'1',confidence:0.62},{choice:'2',confidence:0.3},{choice:'3',confidence:0.05}]);
 assert.equal(without.top,null,'no distribution in the response: null, never invented');
});
