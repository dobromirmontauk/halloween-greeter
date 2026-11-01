// Heckling setting: on|off, default off (HECKLING env), persisted to a small JSON file so it survives a restart.
// Off: greet only when someone is on the path approaching the house. On: call out to people on the sidewalk too.
import {readFileSync} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';

export const parseHeckling=v=>{
  if(typeof v==='boolean')return v;
  const s=String(v??'').trim().toLowerCase();
  if(['on','true','1','yes'].includes(s))return true;
  if(['off','false','0','no'].includes(s))return false;
  return null;
};

export function createHeckling({env={},file=null}={}){
  let value=parseHeckling(env.HECKLING)??false,error=null,chain=Promise.resolve();
  if(file){try{const v=parseHeckling(JSON.parse(readFileSync(file,'utf8')).heckling);if(v!==null)value=v;}catch{}}
  const persist=async()=>{
    if(!file)return;
    await mkdir(dirname(file),{recursive:true,mode:0o700});
    const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify({heckling:value?'on':'off'})+'\n',{mode:0o600});await rename(tmp,file);
  };
  return {
    get:()=>value,
    status:()=>({heckling:value,persisted:!!file,error}),
    async set(next){
      const v=parseHeckling(next);
      if(v===null)throw Object.assign(new Error('Send {"heckling":"on"|"off"}.'),{status:400});
      value=v;
      chain=chain.then(persist).then(()=>{error=null;},e=>{error='Could not save heckling: '+(e.code||e.message);});
      await chain;return value;
    },
  };
}
