import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {displayKey,personLine,answerLabel,HOLD_MS,UNREACHABLE_AFTER,reducePoll,isUnreachable,makeSnapshot,stepDisplay,isHeldView,recentItems,normalizeRead,stateView,costStrip,costRows,sessionHeader,captureView,fmtClock} from '../public/lib.js';
import {scheduleView,minutesPT} from '../public/schedule.js';

const flat={read_id:7,captured_at:1000,decided_at:1900,inference_ms:900,uncertain:false,answers:[
  {name:'real_people_count',choice:'2',confidence:0.92},{name:'costume_1',choice:'witch',confidence:0.5}]};
const multi={read_id:8,captured_at:1000,decided_at:1800,uncertain:false,buckets:{arriving:1,present:0,leaving:0},persons:[{n:1,motion:'approaching',face_or_mask_visible:true}],judges:{
  costume:{inference_ms:700,error:null,answers:[{name:'costume_1',choice:'witch',confidence:0.9,accepted:true}]},
  presence:{inference_ms:400,error:null,answers:[{name:'real_people_count',choice:'1',confidence:0.6,accepted:false}]},
  motion:{inference_ms:null,error:'timeout',answers:[]}}};

test('flat last_read shape renders as one group with computed cutoffs', () => {
  const r=normalizeRead(flat);
  assert.equal(r.multi,false);assert.equal(r.groups.length,1);
  assert.equal(r.groups[0].inference_ms,900);
  assert.deepEqual(r.groups[0].rows.map(x=>[x.pct,x.accepted]),[[92,true],[50,false]]);
});

test('grouped last_read shape orders judges, keeps server accepted flags and errors', () => {
  const r=normalizeRead(multi);
  assert.deepEqual(r.groups.map(g=>g.judge),['presence','motion','costume']);
  assert.equal(r.groups[0].rows[0].accepted,false);
  assert.equal(r.groups[1].error,'timeout');
  assert.equal(r.persons[0].n,1);
});

test('missing or odd last_read never throws', () => {
  assert.equal(normalizeRead(null),null);
  assert.doesNotThrow(()=>normalizeRead({}));
  assert.doesNotThrow(()=>normalizeRead({judges:{presence:{}}}));
});

test('banner view per state', () => {
  assert.equal(stateView(null).key,'UNREACHABLE');
  assert.equal(stateView({app_state:'OFF'},{unreachable:true}).key,'UNREACHABLE');
  const live=stateView({app_state:'LIVE_ACTIVE',live_phase:'COSTUMES',elapsed_seconds:134,limit_seconds:1800});
  assert.equal(live.label,'LIVE · COSTUMES');assert.equal(live.detail,'talk now');assert.equal(live.talkNow,true);assert.equal(live.clock,'2:14 / 30:00');
  assert.deepEqual(live.steps.map(s=>s.status),['done','current','todo']);
  assert.equal(stateView({app_state:'CLOSING',absence_seconds_left:12}).detail,'12s of 30');
  assert.equal(stateView({app_state:'DEBUG_SPEAKING',phrase:'Party leaving.'}).detail,'Party leaving.');
  assert.equal(stateView({app_state:'ERROR',message:'boom'}).detail,'boom');
  assert.equal(stateView({app_state:'WATCHING'}).tone,'watching');
});

test('capturing banner shows clip, frames and MB, or waiting', () => {
  const on=stateView({app_state:'WATCHING'},{mode:'DATA_CAPTURE',capture:{recording:true,clip_id:'c12',frames:340,bytes:5*1048576}});
  assert.equal(on.key,'CAPTURING');assert.equal(on.recording,true);assert.equal(on.detail,'clip c12 · 340 frames · 5.0 MB');
  const idle=stateView({app_state:'WATCHING'},{mode:'DATA_CAPTURE',capture:{recording:false}});
  assert.equal(idle.detail,'waiting');assert.equal(idle.recording,false);
  assert.equal(captureView(null).text,'waiting');
});

test('cost strip and rows tolerate partial data and flag unverified prices', () => {
  assert.equal(costStrip(null),null);
  const c={pricing:[{model:'m',unit:'1M',price:1,verified:false}],rate_usd_per_hour_last_10min:1.5,
    today:{total_usd:2.5,by_category:{judge:{usd:1,calls:10,input_tokens:1000,output_tokens:100},scene:{usd:0.5},live:{usd:1,seconds:90,sessions:1}}},
    since_start:{total_usd:3,by_category:{judge:{usd:2,calls:20}}}};
  const s=costStrip(c);
  assert.deepEqual(s.parts.map(p=>p[1]),['$2.50','$1.00','$0.50','$1.00','$1.50/hr']);
  assert.deepEqual(s.flags,['unverified']);
  assert.equal(costRows(c).length,3);
  assert.doesNotThrow(()=>costStrip({today:{}}));
});

test('session header: start, duration, peak, Live m:ss or debug, optional cost', () => {
  const time=()=>'21:03:58';
  assert.deepEqual(sessionHeader({started_at:1,duration_ms:192000,peak_people:2,mode:'live',live_seconds:160},{time}).parts,['21:03:58','3m12s','2 ppl','Live 2:40']);
  assert.equal(sessionHeader({started_at:1,duration_ms:5000,peak_people:1,mode:'debug',live_seconds:0},{time}).parts[3],'debug');
  assert.equal(sessionHeader({started_at:1,duration_ms:5000,peak_people:1,mode:'live',live_seconds:0,cost:{total_usd:0.4}},{time}).parts.at(-1),'$0.40');
  assert.equal(fmtClock(75),'1:15');
});

test('schedule view: scheduled vs manual text, resume mode and day bar', () => {
  const schedule=[{start:'08:00',end:'09:00',mode:'ON'},{start:'09:00',end:'15:00',mode:'DATA_CAPTURE'},{start:'15:00',end:'22:00',mode:'ON'}];
  const at=Date.parse('2026-10-26T20:30:00Z'); // 13:30 PDT
  const s=scheduleView({mode:'DATA_CAPTURE',source:'schedule',scheduled_mode:'DATA_CAPTURE',next_change_at:'15:00',next_mode:'ON',schedule},at);
  assert.equal(s.text,'Scheduled · DATA_CAPTURE until 15:00 → ON');assert.equal(s.manual,false);
  assert.equal(s.segments.length,3);assert.ok(Math.abs(s.nowPct-(13.5*60/14.4))<0.01);
  const m=scheduleView({mode:'ON',source:'manual',scheduled_mode:'DATA_CAPTURE',override_until:'15:00',schedule},at);
  assert.equal(m.text,'Manual · ON until 15:00 (then DATA_CAPTURE)');assert.equal(m.manual,true);assert.equal(m.resumeMode,'DATA_CAPTURE');
  assert.equal(scheduleView(null),null);assert.equal(minutesPT('08:30'),510);
});

test('app.js only imports lib names that exist', async () => {
  const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  for(const [,names,file] of js.matchAll(/^import \{([^}]+)\} from '\.\/([a-z]+\.js)'/gm)){
    const mod=await import('../public/'+file);
    assert.deepEqual(names.split(',').map(s=>s.trim()).filter(n=>!(n in mod)),[],file);
  }
});

test('answers show top-3 choices as plain numbers with the winner marked; null top falls back to the winner', async () => {
  const {topChoices,answerLabel}=await import('../public/lib.js');
  const top=topChoices({choice:'1',confidence:0.92,top:[{choice:'1',confidence:0.92},{choice:'2',confidence:0.06},{choice:'0',confidence:0.02},{choice:'3',confidence:0}]});
  assert.deepEqual(top.map(t=>`${t.choice} ${t.pct}%`),['1 92%','2 6%','0 2%']);
  assert.deepEqual(top.map(t=>t.winner),[true,false,false]);
  assert.deepEqual(topChoices({choice:'2',confidence:0.7,top:null}),[{choice:'2',pct:70,winner:true}]);
  assert.equal(topChoices({choice:'x',confidence:0.5,top:[{choice:'y',confidence:0.3},{choice:'x',confidence:0.5}]}).find(t=>t.winner).choice,'x');
  const grouped=normalizeRead({read_id:1,judges:{presence:{answers:[{name:'real_people_count',choice:'1',confidence:0.6,accepted:false,top:[{choice:'1',confidence:0.6},{choice:'2',confidence:0.3}]}]}}});
  assert.equal(grouped.groups[0].rows[0].top.length,2);assert.equal(grouped.groups[0].rows[0].accepted,false);
  assert.equal(normalizeRead(flat).groups[0].rows[0].top.length,1);
  assert.equal(answerLabel('person_1_motion'),'P1 motion');assert.equal(answerLabel('motion_2'),'P2 motion');assert.equal(answerLabel('real_people_count'),'real_people_count');
});

test('Resume schedule clears the override with mode SCHEDULE, not a new manual mode', async () => {
  const {RESUME_SCHEDULE}=await import('../public/schedule.js');
  assert.deepEqual(RESUME_SCHEDULE,{mode:'SCHEDULE'});
  const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(js,/resume-schedule'\)\.onclick=.*call\('\/api\/mode',RESUME_SCHEDULE\)/);
});

// ---- banner stability ----
const mk=(app_state,extra={},appMode='ON')=>{const state={app_state,greeter:true,...extra};const snap=makeSnapshot(state,{mode:appMode});const view=stateView(state,{mode:snap.appMode,capture:snap.capture});return {key:displayKey(view),hold:isHeldView(view),appMode:snap.appMode,snap,view};};

test('a non-critical change shows only after holding 1.5 s', () => {
  let d=stepDisplay(null,mk('WATCHING'),0);
  d=stepDisplay(d,mk('PARTY_DETECTED'),100);assert.equal(d.shown.key,'WATCHING');
  d=stepDisplay(d,mk('PARTY_DETECTED'),100+HOLD_MS-1);assert.equal(d.shown.key,'WATCHING');
  d=stepDisplay(d,mk('PARTY_DETECTED'),100+HOLD_MS);assert.equal(d.shown.key,'PARTY_DETECTED');
  assert.deepEqual(d.history.map(x=>x.key),['PARTY_DETECTED','WATCHING']);
});

test('flapping faster than the hold never reaches the banner or history', () => {
  let d=stepDisplay(null,mk('WATCHING'),0);
  for(let t=500;t<10000;t+=500)d=stepDisplay(d,mk(t/500%2?'PARTY_DETECTED':'WATCHING'),t);
  assert.equal(d.shown.key,'WATCHING');assert.equal(d.history.length,1);
});

test('LIVE_ACTIVE, ERROR, OFF, forced (operator) and mode changes show immediately', () => {
  const d=stepDisplay(null,mk('WATCHING'),0);
  assert.equal(stepDisplay(d,mk('LIVE_ACTIVE',{live_phase:'GREETING'}),10).shown.key,'LIVE_ACTIVE');
  assert.equal(stepDisplay(d,mk('ERROR',{message:'x'}),10).shown.key,'ERROR');
  assert.equal(stepDisplay(d,mk('OFF',{greeter:false},'OFF'),10).shown.key,'OFF');
  assert.equal(stepDisplay(d,mk('PARTY_DETECTED'),10,true).shown.key,'PARTY_DETECTED');
  assert.equal(stepDisplay(d,mk('WATCHING',{},'DATA_CAPTURE'),10).shown.key,'CAPTURING');
});

test('CAPTURING while waiting is held, while recording is not', () => {
  assert.equal(isHeldView({key:'CAPTURING',recording:false}),true);
  assert.equal(isHeldView({key:'CAPTURING',recording:true}),false);
  assert.equal(isHeldView({key:'LIVE_ACTIVE'}),false);
});

test('leaving UNREACHABLE shows the recovered state at once', () => {
  const d=stepDisplay(null,{key:'UNREACHABLE',hold:false,appMode:null,snap:null,view:stateView(null,{unreachable:true})},0);
  assert.equal(stepDisplay(d,mk('WATCHING'),10).shown.key,'WATCHING');
});

test('an app mode that is not known yet is not a mode change', () => {
  const d=stepDisplay(null,mk('WATCHING',{},null),0);
  assert.equal(stepDisplay(d,mk('PARTY_DETECTED',{},'ON'),10).shown.key,'WATCHING');
});

test('a single failed poll changes nothing; UNREACHABLE needs consecutive failures', () => {
  let m=reducePoll({state:null,fails:0},{ok:true,data:{app_state:'WATCHING',greeter:true}});
  const good=m.state;
  m=reducePoll(m,{ok:false,status:0,data:null});
  assert.equal(m.state,good);assert.equal(isUnreachable(m),false);
  m=reducePoll(m,{ok:true,data:{app_state:'WATCHING',greeter:true}});assert.equal(m.fails,0);
  for(let i=0;i<UNREACHABLE_AFTER-1;i++)m=reducePoll(m,{ok:false});
  assert.equal(isUnreachable(m),false);
  m=reducePoll(m,{ok:false});assert.equal(isUnreachable(m),true);
});

test('snapshot takes app mode and capture from the same state response', () => {
  const s=makeSnapshot({app_state:'WATCHING',app_mode:'DATA_CAPTURE',capture:{recording:true,clip_id:'c1'}},{mode:'ON',capture:null});
  assert.equal(s.appMode,'DATA_CAPTURE');assert.equal(s.capture.clip_id,'c1');
  assert.equal(makeSnapshot({app_state:'OFF'},{mode:'OFF'}).appMode,'OFF');
  assert.equal(makeSnapshot(null),null);
});

test('recent states list newest first, capped at 5', () => {
  let d=null;
  for(let i=0;i<8;i++)d=stepDisplay(d,mk(i%2?'LIVE_ACTIVE':'OFF',{greeter:i%2===1},i%2?'ON':'OFF'),i*1000);
  assert.equal(recentItems(d.history).length,5);
});

// ---- sidewalk / path group ----
test('banner carries the sidewalk/path group on WATCHING and CAPTURING only', () => {
  const w=stateView({app_state:'WATCHING',group_state:'SIDEWALK',group_label:'PEOPLE ON SIDEWALK'});
  assert.equal(w.group,'SIDEWALK');assert.equal(w.full,'WATCHING · PEOPLE ON SIDEWALK');assert.equal(w.tone,'watching');
  assert.equal(stateView({app_state:'WATCHING',group_state:'PATH',group_label:'PEOPLE ON PATH'}).full,'WATCHING · PEOPLE ON PATH');
  const c=stateView({app_state:'WATCHING',group_state:'PATH'},{mode:'DATA_CAPTURE',capture:{recording:true,clip_id:'c1'}});
  assert.equal(c.full,'CAPTURING · PEOPLE ON PATH');
  assert.equal(stateView({app_state:'WATCHING',group_state:'EMPTY',group_label:null}).group,null);
  assert.equal(stateView({app_state:'WATCHING',group_state:'EMPTY'}).full,'WATCHING');
  assert.equal(stateView({app_state:'LIVE_ACTIVE',group_state:'PATH'}).group,null);
  assert.equal(stateView(null).group,null);
});
test('group transitions are held 1.5 s, listed in recent states, and never flap', () => {
  const w=g=>mk('WATCHING',{group_state:g});
  let d=stepDisplay(null,w('EMPTY'),0);
  d=stepDisplay(d,w('SIDEWALK'),100);assert.equal(d.shown.view.group,null);
  d=stepDisplay(d,w('SIDEWALK'),100+HOLD_MS-1);assert.equal(d.shown.view.group,null);
  d=stepDisplay(d,w('SIDEWALK'),100+HOLD_MS);assert.equal(d.shown.view.group,'SIDEWALK');
  assert.equal(recentItems(d.history)[0].label,'WATCHING · PEOPLE ON SIDEWALK');
  for(let t=2000;t<6000;t+=500)d=stepDisplay(d,w(t/500%2?'PATH':'SIDEWALK'),t);
  assert.equal(d.shown.view.group,'SIDEWALK');
  d=stepDisplay(d,mk('LIVE_ACTIVE',{group_state:'PATH',live_phase:'GREETING'}),7000);assert.equal(d.shown.key,'LIVE_ACTIVE');
});
test('per-person line and location answer labels', () => {
  assert.equal(personLine({n:1,motion:'arriving',motion_confidence:.91,location:'path',location_confidence:.88,face_or_mask_visible:'yes'}),'P1 arriving 91% · path 88% · face yes');
  assert.equal(personLine({n:2,motion:'present',motion_confidence:.8,location:'uncertain'}),'P2 present 80% · uncertain');
  assert.equal(answerLabel('person_2_location'),'P2 location');assert.equal(answerLabel('closest_person_location'),'closest location');
});
