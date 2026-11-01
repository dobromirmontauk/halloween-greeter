import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';
import {createAppMode,parseSchedule,createSchedule,parseUntil,DEFAULT_SCHEDULE} from '../src/server/app-mode.mjs';

// Pacific is UTC-7 (PDT) until 2026-11-01, UTC-8 (PST) after.
const T=iso=>Date.parse(iso);
const clk={t:0};const clock=()=>clk.t;
const sched=()=>createAppMode({env:{MODE_SCHEDULE:'default'},now:clock});

test('default schedule: windows, gaps are OFF, start inclusive / end exclusive',()=>{
  const m=sched();const at=iso=>{clk.t=T(iso);return m.get();};
  assert.equal(at('2026-10-25T14:59:00Z'),'OFF');
  assert.equal(at('2026-10-25T15:00:00Z'),'ON');
  assert.equal(at('2026-10-25T15:59:59Z'),'ON');
  assert.equal(at('2026-10-25T16:00:00Z'),'DATA_CAPTURE');
  assert.equal(at('2026-10-25T21:59:00Z'),'DATA_CAPTURE');
  assert.equal(at('2026-10-25T22:00:00Z'),'ON');
  assert.equal(at('2026-10-26T04:59:00Z'),'ON');
  assert.equal(at('2026-10-26T05:00:00Z'),'OFF');
  assert.equal(at('2026-10-26T12:00:00Z'),'OFF');
  assert.deepEqual(parseSchedule(DEFAULT_SCHEDULE).map(w=>w.start+'-'+w.end+'='+w.mode),['08:00-09:00=ON','09:00-15:00=DATA_CAPTURE','15:00-22:00=ON']);
});

test('status reports source, scheduled mode, next change and the schedule',()=>{
  const m=sched();clk.t=T('2026-10-25T17:00:00Z');
  const s=m.status();
  assert.equal(s.mode,'DATA_CAPTURE');assert.equal(s.source,'schedule');assert.equal(s.scheduled_mode,'DATA_CAPTURE');
  assert.equal(s.next_change_at,'2026-10-25T22:00:00.000Z');assert.equal(s.next_mode,'ON');assert.equal(s.override_until,null);
  assert.equal(s.schedule.length,3);assert.equal(s.timezone,'America/Los_Angeles');
  clk.t=T('2026-10-26T06:00:00Z');
  const o=m.status();assert.equal(o.mode,'OFF');assert.equal(o.next_change_at,'2026-10-26T15:00:00.000Z');assert.equal(o.next_mode,'ON');
});

test('a manual override holds until the next boundary, then the schedule resumes',async()=>{
  const m=sched();clk.t=T('2026-10-25T17:00:00Z');
  await m.set('OFF');
  const s=m.status();assert.equal(s.mode,'OFF');assert.equal(s.source,'manual');assert.equal(s.override_until,'2026-10-25T22:00:00.000Z');assert.equal(s.scheduled_mode,'DATA_CAPTURE');
  clk.t=T('2026-10-25T21:59:59Z');assert.equal(m.get(),'OFF');
  clk.t=T('2026-10-25T22:00:00Z');assert.equal(m.get(),'ON');assert.equal(m.status().source,'schedule');
  await m.set('OFF',{until:T('2026-10-25T22:30:00Z')});assert.equal(m.get(),'OFF');
  clk.t=T('2026-10-25T22:30:00Z');assert.equal(m.get(),'ON');
  await m.set('DATA_CAPTURE',{until:null});assert.equal(m.status().override_until,'indefinite');
  clk.t=T('2026-10-27T12:00:00Z');assert.equal(m.get(),'DATA_CAPTURE');
  await m.set('SCHEDULE');assert.equal(m.get(),'OFF');assert.equal(m.status().source,'schedule');
});

test('an override survives a restart until it expires',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mode-'));const file=join(dir,'mode.json');
  const make=()=>createAppMode({env:{MODE_SCHEDULE:'default'},file,now:clock});
  clk.t=T('2026-10-25T17:00:00Z');await make().set('OFF');
  clk.t=T('2026-10-25T20:00:00Z');assert.equal(make().get(),'OFF');
  clk.t=T('2026-10-25T22:00:01Z');const after=make();assert.equal(after.get(),'ON');assert.equal(after.status().source,'schedule');
  await rm(dir,{recursive:true,force:true});
});

test('DST days: boundaries follow local wall-clock time',()=>{
  const s=createSchedule({schedule:DEFAULT_SCHEDULE});
  const next=iso=>new Date(s.nextChange(T(iso)).at).toISOString();
  assert.equal(next('2026-03-08T07:00:00Z'),'2026-03-08T15:00:00.000Z'); // spring forward: 08:00 PDT
  assert.equal(s.modeAt(T('2026-03-08T15:00:00Z')),'ON');assert.equal(s.modeAt(T('2026-03-08T14:59:00Z')),'OFF');
  assert.equal(next('2026-11-01T06:00:00Z'),'2026-11-01T16:00:00.000Z'); // fall back: 08:00 PST
  assert.equal(s.modeAt(T('2026-11-01T16:00:00Z')),'ON');assert.equal(s.modeAt(T('2026-11-01T15:59:00Z')),'OFF');
  assert.equal(next('2026-11-02T04:00:00Z'),'2026-11-02T06:00:00.000Z'); // 22:00 PST
});

test('schedule config: custom windows, gaps OFF, off disables, bad input rejected',()=>{
  assert.deepEqual(createAppMode({env:{MODE_SCHEDULE:'off'}}).schedule.windows,[]);
  assert.equal(createAppMode({env:{}}).status().schedule_enabled,false);
  const m=createAppMode({env:{MODE_SCHEDULE:'10:00-11:00=DATA_CAPTURE',MODE_TZ:'UTC'},now:clock});
  clk.t=T('2026-10-25T10:30:00Z');assert.equal(m.get(),'DATA_CAPTURE');
  clk.t=T('2026-10-25T11:00:00Z');assert.equal(m.get(),'OFF');
  assert.throws(()=>parseSchedule('09:00-08:00=ON'));assert.throws(()=>parseSchedule('08:00-09:00=LOUD'));assert.throws(()=>parseSchedule('08:00-10:00=ON,09:00-11:00=OFF'));
  assert.equal(parseUntil('indefinite',{now:1}),null);assert.equal(parseUntil(undefined,{now:1}),undefined);
  assert.throws(()=>parseUntil('yesterday',{now:1}));assert.throws(()=>parseUntil('1970-01-01T00:00:00Z',{now:5}));
});

test('regression: next_mode during a manual override is the schedule mode at the override end, not the current one',async()=>{
  const m=sched();clk.t=T('2026-10-26T05:59:00Z'); // 22:59 PDT, gap until 08:00
  assert.equal(m.status().next_mode,'ON');
  await m.set('ON');
  const s=m.status();
  assert.equal(s.source,'manual');assert.equal(s.scheduled_mode,'OFF');
  assert.equal(s.override_until,'2026-10-26T15:00:00.000Z');assert.equal(s.next_change_at,'2026-10-26T15:00:00.000Z');assert.equal(s.next_mode,'ON');
  await m.set('SCHEDULE');clk.t=T('2026-10-25T21:00:00Z'); // 14:00 PDT DATA_CAPTURE, next ON at 15:00
  assert.equal(m.status().next_mode,'ON');
});

test('regression: a restart at 22:59 PT with AUTO_START=true follows the schedule and never creates an override',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mode-'));const file=join(dir,'mode.json');
  clk.t=T('2026-10-26T05:59:00Z');const urls=[];
  const server=createServer({
    env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',AUTO_START:'true',MODE_SCHEDULE:'default',MODE_FILE:file,SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'},
    modeClock:clock,captureImpl:async()=>Buffer.from([255,216,255,217]),
    fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>({answers:[]})};}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    await new Promise(r=>setTimeout(r,1500));
    const s=await (await fetch(base+'/api/mode')).json();
    assert.equal(s.mode,'OFF');assert.equal(s.source,'schedule');assert.equal(s.override_until,null);assert.equal(s.next_mode,'ON');
    assert.deepEqual(urls,[],'no Judge calls while OFF');
    await assert.rejects(()=>readFile(file,'utf8'),'no override file written');
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('server follows the schedule with an injected clock and accepts {mode, until}',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mode-'));
  clk.t=T('2026-10-25T21:59:58Z');
  const urls=[];
  const server=createServer({
    env:{CAMERA_URL:'rtsp://camera/stream2',OPENAI_API_KEY:'test',AUDIO_MODE:'linux',MODE_SCHEDULE:'default',MODE_FILE:join(dir,'mode.json'),SESSIONS_DIR:join(dir,'s'),JUDGE_LOG:'false'},
    modeClock:clock,captureImpl:async()=>Buffer.from([255,216,255,217]),
    fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>({answers:[{type:'choice',name:'real_people_count',choice:'0',confidence:0.99}]})};}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{Origin:base}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json()};};
  try{
    const r=await call('/api/mode');assert.equal(r.json.mode,'DATA_CAPTURE');assert.equal(r.json.source,'schedule');
    clk.t=T('2026-10-25T22:00:01Z');assert.equal((await call('/api/mode')).json.mode,'ON');
    const o=await call('/api/mode','POST',{mode:'OFF',until:'2026-10-25T23:00:00Z'});assert.equal(o.json.override_until,'2026-10-25T23:00:00.000Z');assert.equal(o.json.mode,'OFF');
    assert.equal((await call('/api/mode','POST',{mode:'ON',until:'bogus'})).status,400);
    assert.equal((await call('/api/mode','POST',{mode:'ON',until:'2020-01-01T00:00:00Z'})).status,400);
    clk.t=T('2026-10-25T23:00:00Z');assert.equal((await call('/api/mode')).json.mode,'ON');
  }finally{await server.stopAutomation();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
