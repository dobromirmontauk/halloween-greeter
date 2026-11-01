// Replay input validation shared by the CLI, bulk mode, the HTTP route and the engine. Pure.
export const BACKENDS=['gemini','openai','fake'],JUDGE_MODES=['real','fake','recorded'],DETECTOR_MODES=['real','recorded'];
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const SET_KEY=/^[A-Z][A-Z0-9_]{1,63}$/;
// Env keys a replay may not override (they would redirect storage or reach the real devices).
const LOCKED=new Set(['CAMERA_URL','CAMERA_SNAPSHOT_URL','AUDIO_MODE','VOICE_BACKEND','VISITS','VISIT_DIR','VISIT_AUDIO','AUDIO_INPUT_TARGET','AUDIO_OUTPUT_TARGET','MODE_FILE','ONVIF_URL','ONVIF_USERNAME','ONVIF_PASSWORD','DEBUG_SPEAK']);
// What would be sent to a third party, and whether the caller confirmed it. Throws {status:400,code:'CONFIRM_REQUIRED'}.
export function requireConfirm({backend,judges='fake',confirm=false}){
  const sends=backend!=='fake'||judges==='real';
  if(sends&&!confirm)throw fail(400,'This replay sends the recorded frames and voices of visitors (including children) to '+(backend==='gemini'?'Google':backend==='openai'?'OpenAI':'OpenAI (real Judges)')+'. Confirm it explicitly: --send-recorded-media on the CLI, the confirm box in the UI.','CONFIRM_REQUIRED');
  return sends;
}
export function validateSettings(set={}){
  const out={};
  for(const [k,v] of Object.entries(set||{})){
    if(!SET_KEY.test(k))throw fail(400,'Bad setting name: '+String(k).slice(0,40));
    if(LOCKED.has(k))throw fail(400,k+' cannot be set for a replay.');
    out[k]=String(v).slice(0,200);
  }
  return out;
}
