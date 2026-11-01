// Mock operator API for UI screenshots. Synthetic data and synthetic frames only: never touches a camera.
// Usage: node scripts/ui-mock.mjs [port]   then GET /__scenario/<NAME> to switch the banner state.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const pub=resolve(dirname(fileURLToPath(import.meta.url)),'..','public');
const port=Number(process.argv[2])||3939;
const now=()=>Date.now();
const frameSvg=(label,hue)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},35%,18%)"/><stop offset="1" stop-color="hsl(${hue},30%,8%)"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><rect x="40" y="250" width="560" height="6" fill="#ffffff22"/><circle cx="260" cy="150" r="34" fill="#e8892b"/><rect x="226" y="184" width="68" height="110" rx="14" fill="#e8892b99"/><circle cx="390" cy="170" r="26" fill="#9bbf6b"/><rect x="364" y="196" width="52" height="98" rx="12" fill="#9bbf6b88"/><text x="20" y="342" fill="#ffffff88" font-family="sans-serif" font-size="18">synthetic ${label}</text></svg>`;
const T=(m)=>now()-m*60000;
const scenarios={
  OFF:{app_state:'OFF',greeter:false,mode:'live',visitor_count:null},
  WATCHING:{app_state:'WATCHING',greeter:true,mode:'live',visitor_count:0},
  WATCHING_SIDEWALK:{app_state:'WATCHING',greeter:true,mode:'live',visitor_count:2,group_state:'SIDEWALK',group_label:'PEOPLE ON SIDEWALK'},
  WATCHING_PATH:{app_state:'WATCHING',greeter:true,mode:'live',visitor_count:2,group_state:'PATH',group_label:'PEOPLE ON PATH'},
  LIVE_ACTIVE:{app_state:'LIVE_ACTIVE',greeter:true,mode:'live',visitor_count:2,live_phase:'COSTUMES',elapsed_seconds:134,limit_seconds:1800,last_event:{type:'COSTUMES',phrase:'Costumes: witch, pirate.',at:now()-20000}},
  CLOSING:{app_state:'CLOSING',greeter:true,mode:'live',visitor_count:0,live_phase:'GOODBYE',elapsed_seconds:221,limit_seconds:1800,absence_seconds_left:19,last_event:{type:'LEAVING',phrase:'Party leaving.',at:now()-40000}},
  DEBUG_SPEAKING:{app_state:'DEBUG_SPEAKING',greeter:true,mode:'debug',visitor_count:2,phrase:'New party approaching, 2 people.',last_event:{type:'NEW_PARTY',phrase:'New party approaching, 2 people.',at:now()-1000}},
  ERROR:{app_state:'ERROR',greeter:true,mode:'live',visitor_count:1,message:'Linux capture exited unexpectedly'},
  CAPTURING:{app_state:'WATCHING',greeter:true,mode:'live',visitor_count:1}
};
let scenario='LIVE_ACTIVE';
const modeFor=()=>scenario==='OFF'?'OFF':scenario==='CAPTURING'?'DATA_CAPTURE':'ON';
const schedule=[{start:'08:00',end:'09:00',mode:'ON'},{start:'09:00',end:'15:00',mode:'DATA_CAPTURE'},{start:'15:00',end:'22:00',mode:'ON'}];
const judge=()=>({last_read:{read_id:412,captured_at:now()-3000,decided_at:now()-1900,uncertain:false,buckets:{arriving:0,present:2,leaving:0},persons:[{n:1,motion:'arriving',motion_confidence:0.91,location:'path',location_confidence:0.88,face_or_mask_visible:'yes'},{n:2,motion:'present',motion_confidence:0.84,location:'sidewalk',location_confidence:0.8,face_or_mask_visible:'no'}],judges:{
  presence:{inference_ms:640,error:null,answers:[{name:'real_people_count',choice:'2',confidence:0.93,accepted:true},{name:'present_count',choice:'2',confidence:0.88,accepted:true}]},
  motion:{inference_ms:710,error:null,answers:[{name:'arriving_count',choice:'0',confidence:0.9,accepted:true},{name:'leaving_count',choice:'0',confidence:0.62,accepted:false}]},
  costume:{inference_ms:980,error:null,answers:[{name:'costume_1',choice:'witch',confidence:0.91,accepted:true},{name:'costume_2',choice:'pirate',confidence:0.78,accepted:false}]}}}});
const detail={id:'s1',started_at:T(4),ended_at:null,open:true,duration_ms:4*60000,peak_people:2,mode:'live',live_seconds:134,costumes:['witch','pirate'],event_count:6,
  events:[{type:'SESSION_START',at:T(4),phrase:'1 person'},{type:'NEW_PARTY',at:T(3.9),phrase:'New party approaching, 1 person.'},{type:'PHASE',at:T(3.8),phrase:'GREETING'},{type:'COSTUMES',at:T(1),phrase:'Costumes: witch, pirate.'},{type:'PHASE',at:T(0.9),phrase:'COSTUMES'}],
  turns:[{role:'assistant',text:'Happy Halloween! Come meet the skeleton crew.'},{role:'user',text:'Trick or treat!'},{role:'assistant',text:'A witch and a pirate. Finally, someone with a retirement plan.'}],
  reads:[]};
const sessions=[{id:'s1',started_at:T(4),ended_at:null,open:true,duration_ms:4*60000,peak_people:2,mode:'live',live_seconds:134,costumes:[],live_session_ids:['l1'],event_count:6},
  {id:'s0',started_at:T(40),ended_at:T(37),open:false,duration_ms:3*60000+12000,peak_people:3,mode:'live',live_seconds:160,costumes:[],live_session_ids:['l0'],event_count:9},
  {id:'sd',started_at:T(70),ended_at:T(69),open:false,duration_ms:65000,peak_people:1,mode:'debug',live_seconds:0,costumes:[],live_session_ids:[],event_count:3}];
const costs={as_of:now(),pricing:[{model:'gpt-live-1',unit:'1M tokens',price:'mock',source:'mock',verified:false}],rate_usd_per_hour_last_10min:2.4,
  today:{total_usd:3.18,by_category:{judge:{usd:0.92,calls:412,input_tokens:900000,output_tokens:40000},scene:{usd:0.41,calls:37,input_tokens:60000,output_tokens:9000},live:{usd:1.85,seconds:1240,sessions:6}},by_model:{'gpt-6-luna':{usd:1.33},'gpt-live-1':{usd:1.85}}},
  since_start:{total_usd:7.4,by_category:{judge:{usd:2.1,calls:1100,input_tokens:2400000,output_tokens:90000},scene:{usd:0.9,calls:80,input_tokens:130000,output_tokens:20000},live:{usd:4.4,seconds:2950,sessions:11}},by_model:{}}};

http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x'),p=url.pathname;
  const json=(v,s=200)=>{res.writeHead(s,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
  const svg=t=>{res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});res.end(t);};
  let m;
  if(m=p.match(/^\/__scenario\/(\w+)$/)){scenario=scenarios[m[1]]?m[1]:scenario;return json({scenario});}
  if(p==='/__phone'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<body style="margin:0;background:#000"><iframe src="/" style="width:390px;height:1800px;border:0"></iframe>');}
  if(p==='/api/state')return json({...scenarios[scenario],server_time:now(),session:null});
  if(p==='/api/status')return json({deployment_commit:'0123456789abcdef'});
  if(p==='/api/judge/status')return json(judge());
  if(p==='/api/mode')return json({mode:modeFor(),source:'schedule',scheduled_mode:modeFor(),next_change_at:'15:00',next_mode:'ON',schedule,capture:scenario==='CAPTURING'?{recording:true,clip_id:'c0412',frames:1180,bytes:31*1048576}:{recording:false}});
  if(p==='/api/costs')return json(costs);
  if(p==='/api/captures')return json({clips:scenario==='CAPTURING'?[{id:'c0412',started_at:T(8),frames:1180,bytes:31*1048576,recording:true}]:[]});
  if(p==='/api/sessions')return json(scenario==='CAPTURING'?[]:sessions);
  if(m=p.match(/^\/api\/sessions\/(\w+)$/))return json({...detail,id:m[1]});
  if(p==='/api/video'||p==='/api/frame')return svg(frameSvg('video',28));
  if(m=p.match(/^\/api\/judge\/frame\/\d+\/(prev|now)$/))return svg(frameSvg(m[1],m[1]==='prev'?200:28));
  if(p==='/api/review/image')return svg(frameSvg('thumb',100));
  if(p==='/api/review/read-image')return svg(frameSvg('thumb',100));
  if(p==='/api/review/read-label'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{}');}
  if(p==='/api/review/reads'){ // synthetic reads only
    const tier=url.searchParams.get('tier')||'borderline',high=Number(url.searchParams.get('high'))||0.9,low=Number(url.searchParams.get('low'))||0.1;
    const mk=(i,pp,extra={})=>({key:'j:2026-10-25/mock'+i,source:i%3?'judge':'capture',captured_at:T(60-i),p_people:pp,winner:pp>0.5?'1':'0',top:[{choice:'1',confidence:pp},{choice:'0',confidence:1-pp}],detector_count:pp>0.5?1:0,detector_disagree:false,uncertain:false,has_prev:i%2===0,prev_index:1,label:null,labeled:false,people_label:null,...extra});
    const all=[0.5,0.62,0.75,0.8,0.35,0.97,0.99,0.93,0.02,0.04,0.01].map((pp,i)=>mk(i,pp,i===3?{detector_disagree:true,detector_count:0}:{}));
    const t=v=>v.uncertain||v.detector_disagree?'borderline':v.p_people>=high?'people':v.p_people<=low?'no_people':'borderline';
    const counts=Object.fromEntries(['borderline','people','no_people'].map(k=>{const n=all.filter(v=>t(v)===k).length;return [k,{total:n,labeled:0,unlabeled:n}];}));
    const table=[0.3,0.4,0.5,0.6,0.7,0.75,0.8,0.9].map(c=>({cutoff:c,precision:0.9,recall:0.8,accuracy:0.85,fp:2,fn:3}));
    const items=all.filter(v=>t(v)===tier).sort((a,b)=>Math.abs(a.p_people-0.75)-Math.abs(b.p_people-0.75));
    return json({thresholds:{high,low,cutoff:0.75},tier,labeled:'no',total:items.length,counts,finder:{labeled:12,min_labels:30,needed:18,meaningful:false,current_cutoff:0.75,best:0.6,table},items,sample:null});
  }
  if(p==='/api/ptz'||p.startsWith('/api/audio/'))return json({ok:true});
  const file={'/':'index.html'}[p]||p.slice(1);
  try{const body=readFileSync(resolve(pub,file));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(body);}
  catch{json({error:'Not found'},404);}
}).listen(port,'127.0.0.1',()=>console.log('ui mock on http://127.0.0.1:'+port));
