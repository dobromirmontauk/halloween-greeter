// Real cost accounting from billed usage. Prices verified 2026-10-25 from official OpenAI pages.
import {mkdir,writeFile,readFile,rename,chmod} from 'node:fs/promises';
import {join} from 'node:path';

const LUNA_SRC='https://developers.openai.com/api/docs/models/gpt-6-luna';
const LIVE_SRC='https://developers.openai.com/api/docs/models/gpt-live-1';
const GEMINI_SRC='https://ai.google.dev/gemini-api/docs/pricing';
// One table. `verified` is null (API shows status 'unverified') when a price could not be confirmed.
export const PRICING=[
  {model:'gpt-6-luna',kind:'input',unit:'USD per 1M input tokens (images count as input tokens)',price:0.10,source:LUNA_SRC,verified:'2026-10-25'},
  {model:'gpt-6-luna',kind:'cached_input',unit:'USD per 1M cached input tokens',price:0.01,source:LUNA_SRC,verified:'2026-10-25'},
  {model:'gpt-6-luna',kind:'output',unit:'USD per 1M output tokens',price:0.50,source:LUNA_SRC,verified:'2026-10-25'},
  {model:'gpt-live-1',kind:'minute',unit:'USD per minute, billed per second',price:0.05,source:LIVE_SRC,verified:'2026-10-25'},
  // Gemini 3.8 Live, paid tier (free tier trains on data and is not allowed). No promotional expiry listed on the page.
  {model:'gemini-3.8-live',kind:'audio_in_minute',unit:'USD per minute of audio input ($3.00/1M tokens)',price:0.005,source:GEMINI_SRC,verified:'2026-10-26'},
  {model:'gemini-3.8-live',kind:'video_in_minute',unit:'USD per minute of image/video input ($1.00/1M tokens)',price:0.002,source:GEMINI_SRC,verified:'2026-10-26'},
  {model:'gemini-3.8-live',kind:'audio_out_minute',unit:'USD per minute of audio output ($12.00/1M tokens)',price:0.018,source:GEMINI_SRC,verified:'2026-10-26'},
];
export const pricingForApi=(table=PRICING)=>table.map(({model,unit,price,source,verified})=>({model,unit,price,source,verified:verified||null,...(verified?{}:{status:'unverified'})}));
const rate=(table,model,kind)=>table.find(p=>p.model===model&&p.kind===kind);

export const categoryOf=purpose=>/^judge|^decisions$/.test(purpose||'')?'judge':/^(scene|luna)/.test(purpose||'')?'scene':'other';
const round=n=>Math.round(n*1e8)/1e8;
const newTok=()=>({usd:0,calls:0,input_tokens:0,output_tokens:0,cached_tokens:0});
export const emptyBucket=()=>({total_usd:0,by_category:{judge:{...newTok(),by_purpose:{}},scene:{...newTok(),by_purpose:{}},live:{usd:0,seconds:0,sessions:0,estimated_seconds:0,by_backend:{},prewarm:{sessions:0,used_sessions:0,wasted_sessions:0,seconds:0,wasted_seconds:0,usd:0,wasted_usd:0}}},by_model:{}});

export function tokenCostUsd(model,{input=0,output=0,cached=0},table=PRICING){
  const pi=rate(table,model,'input'),po=rate(table,model,'output'),pc=rate(table,model,'cached_input');
  if(!pi||!po)return null;
  const c=Math.min(cached,input);
  return ((input-c)*pi.price+c*(pc?pc.price:pi.price)+output*po.price)/1e6;
}
export function liveCostUsd(seconds,table=PRICING){const p=rate(table,'gpt-live-1','minute');return p?seconds/60*p.price:null;}
// parts: {audio_in_seconds, video_seconds, audio_out_seconds}; text tokens (instructions, prompts, transcripts) are negligible and not counted.
export function geminiCostUsd(parts={},table=PRICING,model='gemini-3.8-live'){
  const a=rate(table,model,'audio_in_minute'),v=rate(table,model,'video_in_minute'),o=rate(table,model,'audio_out_minute');
  if(!a||!v||!o)return 0;
  return ((parts.audio_in_seconds||0)*a.price+(parts.video_seconds||0)*v.price+(parts.audio_out_seconds||0)*o.price)/60;
}
export function usageTokens(u={}){
  return {input:u.input_tokens??u.prompt_tokens??0,output:u.output_tokens??u.completion_tokens??0,cached:u.input_tokens_details?.cached_tokens??u.prompt_tokens_details?.cached_tokens??0};
}

export function createCosts({dir=null,now=Date.now,debounceMs=2000,pricing=PRICING,sessionId=()=>null}={}){
  const day=t=>{const d=new Date(t);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const since=emptyBucket();let today=emptyBucket(),todayKey=day(now());
  const sessionBuckets=new Map();const sessBucket=()=>{let id;try{id=sessionId();}catch{}if(!id)return null;if(!sessionBuckets.has(id)){sessionBuckets.set(id,emptyBucket());if(sessionBuckets.size>50)sessionBuckets.delete(sessionBuckets.keys().next().value);}return sessionBuckets.get(id);};
  const events=[],liveSeen=new Map();let timer=null,dirty=false,writing=Promise.resolve();
  const file=k=>join(dir,k+'.json');
  const merge=saved=>{const b=emptyBucket();if(!saved||typeof saved!=='object')return b;
    b.total_usd=Number.isFinite(saved.total_usd)?saved.total_usd:0;
    for(const c of ['judge','scene'])if(saved.by_category?.[c])Object.assign(b.by_category[c],saved.by_category[c],{by_purpose:saved.by_category[c].by_purpose||{}});
    if(saved.by_category?.live)Object.assign(b.by_category.live,saved.by_category.live,{by_backend:saved.by_category.live.by_backend||{},prewarm:{...b.by_category.live.prewarm,...(saved.by_category.live.prewarm||{})}});
    b.by_model=saved.by_model||{};return b;};
  const loaded=(async()=>{if(!dir)return;try{const s=JSON.parse(await readFile(file(todayKey),'utf8'));today=merge(s.totals);}catch{}})();
  const persist=(k,b)=>{if(!dir)return writing;writing=writing.then(async()=>{try{await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);const tmp=file(k)+'.tmp';await writeFile(tmp,JSON.stringify({date:k,saved_at:new Date(now()).toISOString(),totals:b},null,1),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,file(k));}catch{}});return writing;};
  const roll=()=>{const k=day(now());if(k!==todayKey){const old=todayKey,oldB=today;todayKey=k;today=emptyBucket();persist(old,oldB);}};
  const schedule=()=>{dirty=true;if(timer||!dir)return;timer=setTimeout(()=>{timer=null;if(dirty){dirty=false;persist(todayKey,today);}},debounceMs);timer.unref?.();};
  const model=(b,m)=>b.by_model[m]||(b.by_model[m]={usd:0,calls:0,input_tokens:0,output_tokens:0,cached_tokens:0,seconds:0});
  const addEvent=usd=>{events.push({t:now(),usd});const cut=now()-3600e3;while(events.length&&events[0].t<cut)events.shift();};

  // Billed usage of one Responses/Decisions call. purpose: judge-presence|judge-motion|judge-costume|decisions|scene|...
  function recordResponse({model:m,purpose,usage}){
    if(!usage||!m)return null;roll();
    const tk=usageTokens(usage),usd=tokenCostUsd(m,tk,pricing),cat=categoryOf(purpose),p=purpose||'unknown';
    for(const b of [since,today,sessBucket()].filter(Boolean)){
      const c=b.by_category[cat]||(b.by_category[cat]={...newTok(),by_purpose:{}});
      const pp=c.by_purpose[p]||(c.by_purpose[p]=newTok());
      for(const t of [c,pp]){t.calls++;t.input_tokens+=tk.input;t.output_tokens+=tk.output;t.cached_tokens+=tk.cached;t.usd=round(t.usd+(usd||0));}
      const mm=model(b,m);mm.calls++;mm.input_tokens+=tk.input;mm.output_tokens+=tk.output;mm.cached_tokens+=tk.cached;mm.usd=round(mm.usd+(usd||0));if(usd===null)mm.unpriced=true;
      b.total_usd=round(b.total_usd+(usd||0));
    }
    addEvent(usd||0);schedule();return usd;
  }
  // `seconds` is the cumulative billable duration of one Live session. Real usage replaces an earlier estimate.
  function recordLive({sessionId,seconds,estimated=false,backend='openai',model:liveModel='gpt-live-1',usd:billedUsd,parts,idle=false}){
    if(!(seconds>=0))return null;roll();
    const key=sessionId||'unknown',prev=liveSeen.get(key)||{seconds:0,estimated:false,seen:false};
    let delta=seconds-prev.seconds;
    if(!(prev.estimated&&!estimated))delta=Math.max(0,delta); // only real usage may correct an estimate downward
    // A backend that prices by modality reports its own cumulative usd; the delta is what is new.
    const usd=Number.isFinite(billedUsd)?Math.max(0,billedUsd-(prev.usd||0)):(liveCostUsd(delta,pricing)||0);
    const estShift=(estimated?delta:0)-(prev.estimated&&!estimated?prev.seconds:0);
    for(const b of [since,today,sessBucket()].filter(Boolean)){
      const l=b.by_category.live;if(!prev.seen&&!idle)l.sessions++;
      l.seconds=round(l.seconds+delta);l.usd=round(l.usd+usd);l.estimated_seconds=Math.max(0,round(l.estimated_seconds+estShift));
      const bb=l.by_backend[backend]||(l.by_backend[backend]={usd:0,seconds:0,sessions:0});if(!prev.seen&&!idle)bb.sessions++;if(parts){const g=bb.parts||(bb.parts={connected_seconds:0,audio_in_seconds:0,video_seconds:0,audio_out_seconds:0});for(const k of Object.keys(g))g[k]=round(g[k]+Math.max(0,(parts[k]||0)-(prev.parts?.[k]||0)));}bb.seconds=round(bb.seconds+delta);bb.usd=round(bb.usd+usd);l.backend=backend;
      const mm=model(b,liveModel);if(!prev.seen)mm.calls++;mm.seconds=round(mm.seconds+delta);mm.usd=round(mm.usd+usd);
      b.total_usd=round(b.total_usd+usd);
    }
    liveSeen.set(key,{seconds,estimated,seen:true,parts:parts||null,usd:Number.isFinite(billedUsd)?billedUsd:0});
    if(usd>0)addEvent(usd);schedule();return usd;
  }
  // Attribution only (never added to total_usd: the session's seconds already arrive through recordLive). `seconds` = connected-but-silent pre-warm time; used=false means nobody reached the path and the session was closed (wasted).
  function recordPrewarm({seconds,used,usd:given}){
    if(!(seconds>=0))return null;roll();const usd=Number.isFinite(given)?given:(liveCostUsd(seconds,pricing)||0);
    for(const b of [since,today,sessBucket()].filter(Boolean)){
      const p=b.by_category.live.prewarm||(b.by_category.live.prewarm={sessions:0,used_sessions:0,wasted_sessions:0,seconds:0,wasted_seconds:0,usd:0,wasted_usd:0});
      p.sessions++;p.seconds=round(p.seconds+seconds);p.usd=round(p.usd+usd);
      if(used)p.used_sessions++;else{p.wasted_sessions++;p.wasted_seconds=round(p.wasted_seconds+seconds);p.wasted_usd=round(p.wasted_usd+usd);}
    }
    schedule();return usd;
  }
  const snapshot=()=>{roll();const cutoff=now()-600e3,sum=events.filter(e=>e.t>=cutoff).reduce((a,e)=>a+e.usd,0);
    return {as_of:new Date(now()).toISOString(),pricing:pricingForApi(pricing),since_start:structuredClone(since),today:{date:todayKey,...structuredClone(today)},session:(()=>{let id;try{id=sessionId();}catch{}return id&&sessionBuckets.has(id)?{id,...structuredClone(sessionBuckets.get(id))}:id?{id,...emptyBucket()}:null;})(),rate_usd_per_hour_last_10min:round(sum*6)};};
  const flush=async()=>{await loaded;clearTimeout(timer);timer=null;dirty=false;await persist(todayKey,today);};
  return {recordResponse,recordLive,recordPrewarm,snapshot,flush,ready:()=>loaded};
}
