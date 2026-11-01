// Daily mode schedule (Pacific time) view helpers. Pure, DOM-free.
const TZ='America/Los_Angeles';
// Minutes since midnight PT for an "HH:MM" string, an hour number, or a timestamp.
export function minutesPT(v){
  if(typeof v==='number'&&v<=24&&v>=0)return v*60;
  if(typeof v==='string'&&/^\d{1,2}(:\d{2})?$/.test(v)){const [h,m='0']=v.split(':');return Number(h)*60+Number(m);}
  const d=new Date(v);if(Number.isNaN(+d))return null;
  const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
  return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);
}
export const clockPT=v=>{const m=minutesPT(v);return m==null?'–':`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};

// {mode, source, scheduled_mode, next_change_at, next_mode, override_until, schedule:[{start,end,mode}]} -> short text + day bar.
export function scheduleView(info,now=Date.now()){
  if(!info||typeof info!=='object'||!info.mode)return null;
  const manual=info.source==='manual';
  const until=manual?(info.override_until??info.next_change_at):info.next_change_at;
  const untilText=until?` until ${clockPT(until)}`:'';
  let text;
  if(manual){const then=info.scheduled_mode&&info.scheduled_mode!==info.mode?info.scheduled_mode:info.next_mode;text=`Manual · ${info.mode}${untilText}${then?` (then ${then})`:''}`;}
  else text=`Scheduled · ${info.mode}${untilText}${info.next_mode?` → ${info.next_mode}`:''}`;
  const segments=(info.schedule||[]).map(s=>{const a=minutesPT(s.start),b0=minutesPT(s.end),b=b0===0?1440:b0;
    return a==null||b==null?null:{mode:s.mode,left:a/14.4,width:Math.max(0,(b-a)/14.4),label:`${clockPT(s.start)}–${clockPT(s.end)} ${s.mode}`};}).filter(Boolean);
  return {text,manual,resumeMode:info.scheduled_mode||null,segments,nowPct:minutesPT(now)/14.4};
}

// POSTed to /api/mode to clear a manual override and return to the schedule.
export const RESUME_SCHEDULE=Object.freeze({mode:'SCHEDULE'});
