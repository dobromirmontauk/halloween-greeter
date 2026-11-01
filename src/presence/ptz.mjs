// ONVIF SOAP protocol adapted from the existing local store_observability PTZ integration.
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
const DEVICE='http://www.onvif.org/ver10/device/wsdl',MEDIA='http://www.onvif.org/ver10/media/wsdl',PTZ='http://www.onvif.org/ver20/ptz/wsdl';
const PREFIX='(?:[\\w-]+:)?';
const blocks=(xml,name)=>xml.match(new RegExp(`<${PREFIX}${name}\\b[^>]*>[\\s\\S]*?</${PREFIX}${name}>`,'g'))||[];
const text=(xml,name)=>xml.match(new RegExp(`<${PREFIX}${name}\\b[^>]*>([^<]*)</${PREFIX}${name}>`))?.[1].trim();
const tag=(xml,name)=>xml.match(new RegExp(`<${PREFIX}${name}\\b[^>]*>`))?.[0]||'';
const attr=(xml,name)=>xml.match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1];
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const finite=value=>value!==undefined&&Number.isFinite(Number(value))?Number(value):null;

export class OnvifClient {
  constructor({url,username,password,fetchImpl=fetch}) {this.url=url;this.username=username;this.password=password;this.fetch=fetchImpl;this.offset=0;}
  async call(url,body,authenticated=true) {
    let header='';
    if(authenticated){
      const nonce=randomBytes(16),created=new Date(Date.now()+this.offset).toISOString().replace(/\.\d{3}Z$/,'Z');
      const digest=createHash('sha1').update(Buffer.concat([nonce,Buffer.from(created),Buffer.from(this.password)])).digest('base64');
      header=`<s:Header><wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${escape(this.username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
    }
    try{
      const response=await this.fetch(url,{method:'POST',headers:{'Content-Type':'application/soap+xml; charset=utf-8'},body:`<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="${DEVICE}" xmlns:trt="${MEDIA}" xmlns:tptz="${PTZ}" xmlns:tt="http://www.onvif.org/ver10/schema">${header}<s:Body>${body}</s:Body></s:Envelope>`,signal:AbortSignal.timeout(5000)});
      const xml=await response.text();
      if(response.status<200||response.status>=300||blocks(xml,'Fault').length)throw Error('ONVIF rejected request');
      return xml;
    }catch{throw fail(502,'Camera control failed. Check ONVIF connectivity and camera account credentials.');}
  }
  async initialize() {
    if(this.initialized)return;
    if(!this.initializing)this.initializing=(async()=>{
      const clock=await this.call(this.url,'<tds:GetSystemDateAndTime/>',false),utc=blocks(clock,'UTCDateTime')[0]||'';
      const parts=['Year','Month','Day','Hour','Minute','Second'].map(n=>finite(text(utc,n)));
      if(parts.every(p=>p!==null)){const [y,m,d,h,min,s]=parts;this.offset=Date.UTC(y,m-1,d,h,min,s)-Date.now();}
      const services=await this.call(this.url,'<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>');
      const found={};
      for(const service of blocks(services,'Service'))found[text(service,'Namespace')]=text(service,'XAddr');
      // Camera-announced services must stay on the configured device origin.
      const serviceURL=(ns,path)=>{const url=new URL(found[ns]||path,this.url);if(url.origin!==new URL(this.url).origin)throw fail(502,'Camera announced an unexpected ONVIF service address.');return url.href;};
      this.ptzURL=serviceURL(PTZ,'/onvif/ptz_service');
      const profiles=await this.call(serviceURL(MEDIA,'/onvif/media_service'),'<trt:GetProfiles/>');
      const chosen=blocks(profiles,'Profiles').find(p=>blocks(p,'PTZConfiguration').length);
      this.profile=chosen&&attr(tag(chosen,'Profiles'),'token');
      if(!this.profile)throw fail(503,'This camera exposes no ONVIF pan/tilt profile.');
      this.initialized=true;
    })();
    try{await this.initializing;}finally{this.initializing=null;}
  }
  async ptz(action,content='') {await this.initialize();return this.call(this.ptzURL,`<tptz:${action}><tptz:ProfileToken>${escape(this.profile)}</tptz:ProfileToken>${content}</tptz:${action}>`);}
  async status(){const xml=await this.ptz('GetStatus'),position=blocks(xml,'Position')[0]||'',p=tag(position,'PanTilt');return {pan:finite(attr(p,'x')),tilt:finite(attr(p,'y')),moving:text(blocks(xml,'MoveStatus')[0]||'','PanTilt')||'UNKNOWN'};}
  async move(x,y){await this.ptz('ContinuousMove',`<tptz:Velocity><tt:PanTilt x="${x}" y="${y}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace"/></tptz:Velocity><tptz:Timeout>PT1S</tptz:Timeout>`);}
  async stop(){await this.ptz('Stop','<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom>');}
}

const validHome=position=>position&&typeof position.pan==='number'&&typeof position.tilt==='number'&&Number.isFinite(position.pan)&&Number.isFinite(position.tilt)&&Math.abs(position.pan)<=1&&Math.abs(position.tilt)<=1;

export class PtzController {
  constructor(client,{home,invertPan=false,invertTilt=false,positionPanDirection=1,positionTiltDirection=1,delay=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,homeTimeoutMs=12000,homeMaxPulses=20,homeTolerance=0.02}={}){
    this.client=client;this.home=undefined;if(home!==undefined)this.setHome(home);this.panDirection=invertPan?-1:1;this.tiltDirection=invertTilt?-1:1;this.positionPanDirection=positionPanDirection;this.positionTiltDirection=positionTiltDirection;this.delay=delay;this.now=now;this.homeTimeoutMs=Math.min(12000,Math.max(1,homeTimeoutMs));this.homeMaxPulses=Math.min(20,Math.max(1,homeMaxPulses));this.homeTolerance=Math.min(0.02,Math.max(0.001,homeTolerance));this.busy=false;this.generation=0;this.inflight=null;
  }
  setHome(position){if(!validHome(position))throw fail(400,'Home requires finite pan and tilt coordinates between -1 and 1.');this.home={pan:position.pan,tilt:position.tilt};return {...this.home};}
  async status(){return {available:true,home_configured:!!this.home,pan_direction:this.positionPanDirection,tilt_direction:this.positionTiltDirection,position_pan_direction:this.positionPanDirection,position_tilt_direction:this.positionTiltDirection,motor_pan_direction:this.panDirection,motor_tilt_direction:this.tiltDirection,...await this.client.status()};}
  async waitUntilIdle(timeoutMs=1000){
    if(!this.busy)return;
    let timer;
    try{await Promise.race([this.inflight?.catch(()=>{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(409,'Camera is still moving; Home was not started.')),Math.min(1000,Math.max(1,timeoutMs)));})]);}finally{clearTimeout(timer);}
    if(this.busy)throw fail(409,'Camera is still moving; Home was not started.');
  }
  async whenIdle(timeoutMs=1000){return this.waitUntilIdle(timeoutMs);}
  async returnHome(generation){
    const target={...this.home},deadline=this.now()+this.homeTimeoutMs;
    const guard=()=>{if(generation!==this.generation)throw fail(409,'Camera Home cancelled.');if(this.now()>=deadline)throw fail(504,'Camera Home time budget reached; stopped.');};
    const step=async operation=>{
      guard();let timer;
      try{const value=await Promise.race([Promise.resolve().then(()=>{guard();return operation();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(504,'Camera Home time budget reached; stopped.')),Math.max(1,deadline-this.now()));})]);guard();return value;}finally{clearTimeout(timer);}
    };
    const stopSafely=async()=>{let timer;try{await Promise.race([this.client.stop(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(502,'Camera Stop timed out; Home aborted.')),1000);})]);}finally{clearTimeout(timer);}};
    const position=async()=>{const result=await step(()=>this.client.status());if(!validHome(result))throw fail(502,'Camera returned invalid pan/tilt coordinates; Home stopped.');return result;};
    const distance=p=>({pan:Math.abs(target.pan-p.pan),tilt:Math.abs(target.tilt-p.tilt)});
    let pulses=0,stalled=0;
    try{
      let current=await position();
      while(true){
        guard();const before=distance(current);
        if(before.pan<=this.homeTolerance&&before.tilt<=this.homeTolerance)return {ok:true,home_reached:true,pulses,pan:current.pan,tilt:current.tilt};
        if(pulses>=this.homeMaxPulses)throw fail(504,'Camera Home movement budget reached; stopped.');
        // Calibrated movement at speed .25: about .03 pan/.078 tilt per 350ms.
        const axis=before.pan>this.homeTolerance&&(before.tilt<=this.homeTolerance||before.pan/0.03>=before.tilt/0.078)?'pan':'tilt';
        const delta=target[axis]-current[axis],reportedDirection=axis==='pan'?this.positionPanDirection:this.positionTiltDirection,motorDirection=axis==='pan'?this.panDirection:this.tiltDirection;
        const velocity=Math.sign(delta)*reportedDirection*motorDirection*0.25;
        const pulseMs=Math.min(350,Math.max(80,Math.round((Math.abs(delta)-this.homeTolerance/2)/(axis==='pan'?0.03:0.078)*350)));
        try{
          await step(()=>this.client.move(axis==='pan'?velocity:0,axis==='tilt'?velocity:0));pulses++;
          await step(()=>this.delay(pulseMs));
        }finally{await stopSafely();}
        await step(()=>this.delay(100));
        const updated=await position(),after=distance(updated);
        if(after[axis]>before[axis]+0.01)throw fail(502,'Camera Home moved away from its target; check position calibration.');
        stalled=after[axis]>=before[axis]-0.001?stalled+1:0;
        if(stalled>=2)throw fail(502,'Camera Home made no progress; stopped.');
        current=updated;
      }
    }finally{await stopSafely();}
  }
  async command(action){
    const directions={left:[-0.25,0],right:[0.25,0],up:[0,0.25],down:[0,-0.25]};
    if(action==='stop'){this.generation++;await this.client.stop();return {ok:true};}
    if(action==='home'&&!this.home)throw fail(409,'Home is not configured. Record a safe camera position before enabling Home.');
    if(!Object.hasOwn(directions,action)&&action!=='home')throw fail(400,'Choose left, right, up, down, stop, or home.');
    const requestedGeneration=this.generation;
    if(this.busy){if(action!=='home')throw fail(409,'Camera is moving. Wait or press Stop.');await this.waitUntilIdle();if(requestedGeneration!==this.generation)throw fail(409,'Camera Home cancelled.');}
    const generation=++this.generation;this.busy=true;
    const operation=(async()=>{
      try{
        if(action==='home')return await this.returnHome(generation);
        try{const [x,y]=directions[action];await this.client.move(x*this.panDirection,y*this.tiltDirection);if(generation===this.generation)await this.delay(350);}finally{await this.client.stop();}
        return {ok:true};
      }finally{this.busy=false;}
    })();
    this.inflight=operation;
    try{return await operation;}finally{if(this.inflight===operation)this.inflight=null;}
  }
}
export function createPtz(env,fetchImpl=fetch){
  if(!env.ONVIF_URL||!env.ONVIF_USERNAME||!env.ONVIF_PASSWORD)return null;
  let url;try{url=new URL(env.ONVIF_URL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}catch{throw fail(503,'Set ONVIF_URL to an HTTP camera device service URL without embedded credentials.');}
  const positionDirection=name=>{if(env[name]===undefined||env[name]==='')return 1;const value=Number(env[name]);if(value!==1&&value!==-1)throw fail(503,`${name} must be 1 or -1 after camera calibration.`);return value;};
  const positionPanDirection=positionDirection('PTZ_POSITION_PAN_DIRECTION'),positionTiltDirection=positionDirection('PTZ_POSITION_TILT_DIRECTION');
  const pan=env.PTZ_HOME_PAN===''?null:finite(env.PTZ_HOME_PAN),tilt=env.PTZ_HOME_TILT===''?null:finite(env.PTZ_HOME_TILT);
  let home=pan!==null&&tilt!==null&&Math.abs(pan)<=1&&Math.abs(tilt)<=1?{pan,tilt}:undefined;
  try{const saved=JSON.parse(readFileSync(env.CAMERA_HOME_FILE||'data/camera-home.json','utf8'));if(!validHome(saved))throw Error('Invalid saved home');home={pan:saved.pan,tilt:saved.tilt};}catch(error){if(error.code!=='ENOENT')throw fail(503,'Saved camera Home is invalid or unreadable; automatic return is disabled.');}
  return new PtzController(new OnvifClient({url:url.href,username:env.ONVIF_USERNAME,password:env.ONVIF_PASSWORD,fetchImpl}),{home,invertPan:env.PTZ_INVERT_PAN==='true',invertTilt:env.PTZ_INVERT_TILT==='true',positionPanDirection,positionTiltDirection});
}
