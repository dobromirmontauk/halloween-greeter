// Server-owned app mode: OFF | ON | DATA_CAPTURE, optionally driven by a daily wall-clock schedule.
//  OFF          no automation (Judge loop stopped, Live closed). Camera video may still stream.
//  ON           Judge -> Luna scene -> Live (or debug speech).
//  DATA_CAPTURE Judge + clip capture only. NEVER Luna scene analysis, NEVER Live.
// A manual change is an override that holds until the next schedule boundary (or an explicit `until`, or forever).
import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';

export const MODES=Object.freeze(['OFF','ON','DATA_CAPTURE']);
export const normalizeMode=value=>{const v=String(value??'').trim().toUpperCase().replace(/[\s-]+/g,'_');return MODES.includes(v)?v:null;};
export const allowsLive=mode=>mode==='ON';
export const runsJudge=mode=>mode==='ON'||mode==='DATA_CAPTURE';

export const DEFAULT_SCHEDULE='08:00-09:00=ON,09:00-15:00=DATA_CAPTURE,15:00-22:00=ON';
export const DEFAULT_TZ='America/Los_Angeles';
const hhmm=min=>String(Math.floor(min/60)).padStart(2,'0')+':'+String(min%60).padStart(2,'0');

// "08:00-09:00=ON,..." -> [{start,end,mode,start_min,end_min}]. Gaps are OFF. 'off'/'none'/'' -> []. 'default' -> DEFAULT_SCHEDULE.
export function parseSchedule(text){
  const raw=String(text??'').trim();
  if(!raw||/^(off|none|disabled)$/i.test(raw))return [];
  const spec=/^default$/i.test(raw)?DEFAULT_SCHEDULE:raw;
  const out=[];
  for(const part of spec.split(',')){
    const m=part.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})=([A-Za-z_ -]+)$/);
    const mode=m&&normalizeMode(m[5]);
    if(!m||!mode)throw new Error('Invalid MODE_SCHEDULE entry: '+part.trim());
    const a=Number(m[1])*60+Number(m[2]),b=Number(m[3])*60+Number(m[4]);
    if(Number(m[1])>24||Number(m[3])>24||Number(m[2])>59||Number(m[4])>59||a>=b||b>1440)throw new Error('Invalid MODE_SCHEDULE window: '+part.trim());
    out.push({start:hhmm(a),end:b===1440?'24:00':hhmm(b),mode,start_min:a,end_min:b});
  }
  out.sort((x,y)=>x.start_min-y.start_min);
  for(let i=1;i<out.length;i++)if(out[i].start_min<out[i-1].end_min)throw new Error('MODE_SCHEDULE windows overlap');
  return out;
}

function makeClock(tz){
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  return ms=>{const p=fmt.formatToParts(new Date(ms));return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);};
}

// Pure schedule math over local wall-clock minutes; DST-safe because boundaries are located by converting back from local time.
export function createSchedule({schedule,tz=DEFAULT_TZ}={}){
  const windows=Array.isArray(schedule)?schedule:parseSchedule(schedule);
  const localMin=makeClock(tz);
  const bounds=[...new Set(windows.flatMap(w=>[w.start_min,w.end_min%1440]))].sort((a,b)=>a-b);
  const modeAtMinute=m=>windows.find(w=>m>=w.start_min&&m<w.end_min)?.mode||'OFF';
  const wrap=d=>((d+720)%1440+1440)%1440-720;
  const nextBoundary=t=>{
    const t0=Math.floor(t/60000)*60000,lm=localMin(t0);let best=Infinity;
    for(const b of bounds){
      let c=t0+(((b-lm+1440)%1440)||1440)*60000;
      for(let k=0;k<3;k++){const diff=wrap(b-localMin(c));if(!diff)break;c+=diff*60000;}
      if(c>t&&c<best)best=c;
    }
    return Number.isFinite(best)?best:null;
  };
  return {
    enabled:windows.length>0,windows,tz,
    modeAt:ms=>windows.length?modeAtMinute(localMin(ms)):null,
    // Next instant at which the scheduled mode actually differs from the current one.
    nextChange(ms){
      if(!windows.length)return null;
      const cur=modeAtMinute(localMin(ms));let t=ms;
      for(let i=0;i<16;i++){const n=nextBoundary(t);if(n==null)return null;const m=modeAtMinute(localMin(n));if(m!==cur)return {at:n,mode:m};t=n;}
      return null;
    },
  };
}

// Without a schedule: persisted override, then START_MODE, then AUTO_START=true -> ON, else OFF.
const baseMode=env=>normalizeMode(env.START_MODE)||(env.AUTO_START==='true'?'ON':'OFF');
const iso=ms=>ms==null?null:new Date(ms).toISOString();

export function parseUntil(value,{now,fail=msg=>Object.assign(new Error(msg),{status:400})}={}){
  if(value===undefined||value===null||value==='')return undefined; // default: next boundary
  if(value==='indefinite')return null;
  const ms=Date.parse(value);
  if(!Number.isFinite(ms)||typeof value!=='string')throw fail('until must be an ISO time or "indefinite".');
  if(ms<=now)throw fail('until must be in the future.');
  return ms;
}

export function createAppMode({env={},file=null,now=Date.now}={}){
  const tz=env.MODE_TZ||DEFAULT_TZ;
  const sched=createSchedule({schedule:env.MODE_SCHEDULE===undefined?'':env.MODE_SCHEDULE,tz});
  let override=null,changedAt=null,error=null,chain=Promise.resolve();
  if(file){try{const o=JSON.parse(readFileSync(file,'utf8')).override;const m=normalizeMode(o?.mode);
    if(m&&(o.until===null||(Number.isFinite(o.until)&&o.until>now())))override={mode:m,until:o.until,set_at:o.set_at??null};}catch{}}
  const active=()=>{if(override&&override.until!==null&&now()>=override.until)override=null;return override;};
  const scheduled=()=>sched.enabled?sched.modeAt(now()):baseMode(env);
  const get=()=>active()?.mode||scheduled();
  const persist=async()=>{
    if(!file)return;
    await mkdir(dirname(file),{recursive:true,mode:0o700});
    const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify({override})+'\n',{mode:0o600});await chmod(tmp,0o600).catch(()=>{});await rename(tmp,file);
  };
  const save=()=>{chain=chain.then(persist).then(()=>{error=null;},e=>{error='Could not save mode: '+(e.code||e.message);});return chain;};
  const status=()=>{
    const ov=active(),t=now(),next=sched.nextChange(t);
    // While an override holds, the next change is when it ends (if sooner) or the next schedule boundary.
    return {mode:get(),automatic:get()!=='OFF',source:ov?'manual':'schedule',scheduled_mode:scheduled(),
      next_change_at:iso(ov&&ov.until!==null?ov.until:next?.at??null),next_mode:ov?(ov.until!==null?(sched.enabled?sched.modeAt(ov.until):baseMode(env)):null):next?.mode??null,
      override_until:ov?(ov.until===null?'indefinite':iso(ov.until)):null,
      schedule:sched.windows.map(({start,end,mode})=>({start,end,mode})),schedule_enabled:sched.enabled,timezone:tz,
      changed_at:changedAt,persisted:!!file,error};
  };
  return {
    get,status,schedule:sched,
    // In-memory override only (server shutdown / startAutomation).
    setVolatile(next){const m=normalizeMode(next);if(!m)throw new Error('Invalid mode');override={mode:m,until:null,set_at:now()};return m;},
    // Manual change. until: undefined -> hold until the next schedule boundary (forever with no schedule); null -> indefinite; ms -> that time.
    // mode 'SCHEDULE' clears the override.
    set(next,{until}={}){
      if(String(next).toUpperCase()==='SCHEDULE'){override=null;changedAt=now();return save().then(get);}
      const m=normalizeMode(next);if(!m)return Promise.reject(Object.assign(new Error('Mode must be OFF, ON, DATA_CAPTURE or SCHEDULE.'),{status:400}));
      const t=now();const end=until===undefined?(sched.nextChange(t)?.at??null):until;
      override={mode:m,until:end,set_at:t};changedAt=t;
      return save().then(get);
    },
  };
}
