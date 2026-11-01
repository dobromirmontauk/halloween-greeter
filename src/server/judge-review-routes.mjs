// Review routes; origin/host checks already ran in server.mjs before this is called.
// Returns true when the request was handled. opts: {captures, env}.
import {listReads,saveLabel,saveAiLabels,readImage,thresholds} from './review-reads.mjs';
const AI_BODY_MAX=2*1024*1024;
const readText=async(req,fail)=>{let data='';for await(const c of req){data+=c;if(data.length>AI_BODY_MAX)throw fail(413,'Body too large.');}return data;};
const readBody=async(req,fail)=>{
 let data='';for await(const c of req){data+=c;if(data.length>8192)throw fail(400,'Label too large.');}
 try{return JSON.parse(data);}catch{throw fail(400,'Invalid label.');}
};
export async function handleReview(log,fail,req,res,path,send,{captures=null,env={}}={}){
 if(!log.enabled&&!captures?.enabled)throw fail(404,'Judge log is disabled.');
 const q=new URL(req.url,'http://localhost').searchParams,deps={log,captures};
 // Unified list: GET /api/review/reads?tier=borderline|people|no_people&labeled=no|yes|all&source=judge|capture&from=&to=&limit=&offset=&high=&low=&sample=&seed=&visits=1&visits=1
 if(req.method==='GET'&&path==='/api/review/reads'){
  const labeled=q.get('labeled');
  send(200,await listReads(deps,{tier:q.get('tier'),labeled,source:q.get('source'),from:q.get('from'),to:q.get('to'),limit:q.get('limit'),offset:q.get('offset'),sample:q.get('sample'),seed:q.get('seed'),visits:q.get('visits'),ai:q.get('ai'),human_vs_ai:q.get('human_vs_ai'),false_positive_cause:q.get('false_positive_cause'),sort:q.get('sort'),provisional:q.get('provisional')},thresholds(env,q)));return true;
 }
 if(req.method==='GET'&&path==='/api/review/read-image'){const b=await readImage(deps,q.get('key'),q.get('prev'));if(!b)throw fail(404,'Image not found.');send(200,b,'image/jpeg');return true;}
 // POST /api/review/ai-labels: JSON array or NDJSON of {key,labeler,people_present,count?,notes?,false_positive_cause?,labeled_at?}, max 2000, all-or-nothing.
 if(req.method==='POST'&&path==='/api/review/ai-labels'){send(200,await saveAiLabels(deps,await readText(req,fail)));return true;}
 if(req.method==='POST'&&path==='/api/review/read-label'){send(200,await saveLabel(deps,await readBody(req,fail)));return true;}
 if(!log.enabled)return false;
 if(req.method==='GET'&&path==='/api/review/list'){
  const filter=['unlabeled','disagreements','uncertain'].includes(q.get('filter'))?q.get('filter'):'all',date=/^\d{4}-\d{2}-\d{2}$/.test(q.get('date')||'')?q.get('date'):null;
  send(200,await log.list({offset:Math.max(0,Number(q.get('offset'))||0),limit:Math.min(50,Math.max(1,Number(q.get('limit'))||20)),filter,date}));return true;
 }
 if(req.method==='GET'&&path==='/api/review/entry'){const e=await log.get(q.get('key'));if(!e)throw fail(404,'Read not found.');send(200,e);return true;}
 if(req.method==='GET'&&path==='/api/review/image'){const b=await log.image(q.get('key'),{prev:q.get('frame')==='prev'});if(!b)throw fail(404,'Image not found.');send(200,b,'image/jpeg');return true;}
 if(req.method==='POST'&&path==='/api/review/label'){send(200,await log.addLabel(await readBody(req,fail)));return true;}
 return false;
}
