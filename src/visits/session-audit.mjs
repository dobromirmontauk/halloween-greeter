import {mkdir,appendFile,readFile} from 'node:fs/promises';import {join} from 'node:path';
export function createSessionAudit({directory='data/events'}={}){
 const pending=new Map();const path=id=>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('Invalid session ID');return join(directory,id+'.jsonl');};
 const read=async id=>{await pending.get(id);try{return (await readFile(path(id),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const append=async(id,event)=>{
  const operation=(pending.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
   let prior=[];try{prior=(await readFile(path(id),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(prior.some(entry=>entry.kind===event.kind)||!['welcome','costume','goodbye'].includes(event.kind))return false;
   const source=event.decision_response;
   const record={session_id:id,kind:event.kind,trigger:event.trigger,manual:event.trigger==='manual',decision_response:source?{source_query_id:source.source_query_id,captured_at:source.captured_at,response:{answers:source.response?.answers||[],usage:source.response?.usage||null}}:null,live_prompt:String(event.live_prompt),sent_at:event.sent_at||new Date().toISOString()};
   await mkdir(directory,{recursive:true,mode:0o700});await appendFile(path(id),JSON.stringify(record)+'\n',{mode:0o600});return true;
  });pending.set(id,operation);try{return await operation;}finally{if(pending.get(id)===operation)pending.delete(id);}
 };
 return {append,read};
}
