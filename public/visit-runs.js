// Pure helpers for the Runs panel, transcript lanes and audio selection on /visits.html (no DOM).
export const fmtClock=ms=>{const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const sec=ms=>ms==null?'-':(ms/1000).toFixed(1)+'s';
// Transcript fragments [{t,role,text}] -> turns [{t,end,role,text}]: consecutive fragments of one role within gapMs form one turn.
export function mergeTurns(frags=[],gapMs=2500){
  const out=[];
  for(const f of [...frags].filter(x=>x&&x.text&&['user','assistant'].includes(x.role)).sort((a,b)=>a.t-b.t)){
    const last=out.at(-1);
    if(last&&last.role===f.role&&f.t-last.end<=gapMs){last.text+=f.text;last.end=f.t;}else out.push({t:f.t,end:f.t,role:f.role,text:f.text});
  }
  return out;
}
// Turns of the original clip: the saved transcript when it has one, else the (80 character) assistant lines from the speech events.
export function turnsOfMeta(meta){
  if(meta?.transcript?.length)return mergeTurns(meta.transcript);
  return (meta?.speech||[]).filter(e=>e.kind==='assistant_turn_end'&&e.text).map(e=>({t:e.t,end:e.t,role:'assistant',text:e.text}));
}
// Run transcript turns are already merged by the engine ({t,end,role,text}).
export const turnsOfRun=run=>(run?.transcript||[]).filter(x=>x&&x.text);
// Items for a transcript lane: each turn spans until the next one starts (min 800 ms) so labels never overlap.
export function turnSegments(turns,end){
  return turns.map((x,i)=>({t:x.t,end:Math.min(turns[i+1]?turns[i+1].t:end,Math.max(x.t+800,x.end+1500,x.t+Math.min(6000,x.text.length*55))),label:x.text,role:x.role,title:(x.role==='assistant'?'assistant: ':'visitor: ')+x.text}));
}
// One list row for a run summary ({backend,model,started_at,metrics,cost_usd,aborted,state}).
export function runRow(r){
  const m=r.metrics||{};
  const parts=[r.backend+(r.model&&r.model!==r.backend?' '+r.model:''),r.judges?'judges '+r.judges:null,r.started_at?new Date(r.started_at).toLocaleString([],{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}):null,
    m.path_to_welcome_ms!=null?'welcome '+sec(m.path_to_welcome_ms):null,m.path_to_first_audio_ms!=null?'audio '+sec(m.path_to_first_audio_ms):null,m.turns!=null?m.turns+' turns':null,
    m.spoke_while_empty?.count?'spoke empty '+m.spoke_while_empty.count:null,m.visitor_turns_simulated?'visitor '+m.visitor_turns_simulated+' lines':null,m.silence_joke_fired?'silence joke':null,r.cost_usd!=null?'$'+Number(r.cost_usd).toFixed(3):null,r.aborted?r.aborted:null,r.state&&r.state!=='done'&&!r.aborted?r.state:null];
  return parts.filter(Boolean).join('  ');
}
// Which audio sources to play for a selection. sel: none|mic|assistant|both; runId: null = the original assistant track.
export function audioPlan(sel,id,runId,hasAudio){
  const mic=hasAudio&&(sel==='mic'||sel==='both')?`/api/visits/${id}/audio/mic`:null;
  const asst=(sel==='assistant'||sel==='both')?(runId?`/api/visits/${id}/runs/${runId}/audio`:hasAudio?`/api/visits/${id}/audio/assistant`:null):null;
  return {mic,asst};
}
export const needsConfirm=(backend,judges)=>backend!=='fake'||judges==='real';
export const confirmText=(backend,judges)=>`Send the recorded video and voices of visitors (including children) to ${backend==='gemini'?'Google':backend==='openai'?'OpenAI':'OpenAI (real Judges)'}`;
