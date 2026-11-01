// One server-owned loop. Stop invalidates pending vision before it can issue motion.
export class AutoFramer {
  constructor({control,observe,now=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms))}){this.control=control;this.observe=observe;this.now=now;this.delay=delay;this.generation=0;this.state={active:false,action:'Stopped',target:null};}
  status(){return {...this.state};}
  async stop(reason='Stopped'){this.generation++;this.state={...this.state,active:false,action:reason};await this.control.command('stop');return this.status();}
  async start(){
    if(this.state.active)return this.status();
    const id=++this.generation;this.state={active:true,action:'Reading camera position…',target:null};
    try{const origin=await this.control.status();if(id!==this.generation)return this.status();if(origin.pan===null||origin.tilt===null)throw Error('Camera position unavailable; auto framing requires position limits.');this.run(id,origin).catch(()=>{});}catch(error){if(id===this.generation)await this.stop(error.message);}
    return this.status();
  }
  async run(id,origin){
    const started=this.now();let moves=0;
    try{
      while(id===this.generation&&this.now()-started<30000&&moves<12){
        const tick=this.now();this.state.action='Looking for a visible person…';
        const result=await this.observe();if(id!==this.generation)return;
        const target=result.target;this.state.target=target;this.state.inference_ms=result.inference_ms;this.state.observed_at=result.captured_at;
        if(this.now()-result.captured_at>10000)throw Error('Camera observation is stale; stopped.');
        if(!target||target.visible!==true||!Number.isFinite(target.confidence)||target.confidence<0.75||target.confidence>1){await this.stop('No confident person in view; stopped.');return;}
        let {x,y}=target;
        let action;
        if(target.head_clipped===true){
          action={top:'up',bottom:'down',left:'left',right:'right'}[target.clipped_edge];
          if(!action)throw Error('Head clipped but direction uncertain; stopped.');
        }else{
          if(target.head_visible!==true||!target.head_bbox)throw Error('Full head not visible; stopped for manual framing.');
          const box=target.head_bbox;
          if(!['x1','y1','x2','y2'].every(k=>Number.isFinite(box[k])&&box[k]>=0&&box[k]<=1)||box.x1>=box.x2||box.y1>=box.y2)throw Error('Invalid head box; stopped.');
          x=(box.x1+box.x2)/2;y=(box.y1+box.y2)/2;
          if(box.y1<0.08)action='up';else if(box.y2>0.9)action='down';else if(box.x1<0.06)action='left';else if(box.x2>0.94)action='right';
          else{
            const dx=x-0.5,dy=y-0.38;
            if(Math.abs(dx)<=0.13&&Math.abs(dy)<=0.14){await this.stop('Person centered with full head in view');return;}
            action=Math.abs(dx)>Math.abs(dy)?(dx<0?'left':'right'):(dy<0?'up':'down');
          }
        }
        const position=await this.control.status();if(id!==this.generation)return;
        if(position.pan===null||position.tilt===null||Math.abs(position.pan-origin.pan)>=0.2||Math.abs(position.tilt-origin.tilt)>=0.2)throw Error('Safe movement range reached; stopped.');
        const panSign=(action==='left'?-1:action==='right'?1:0)*(position.position_pan_direction||position.pan_direction||1),tiltSign=(action==='down'?-1:action==='up'?1:0)*(position.position_tilt_direction||position.tilt_direction||1);
        if((panSign<0&&position.pan<=-0.99)||(panSign>0&&position.pan>=0.99)||(tiltSign<0&&position.tilt<=-0.99)||(tiltSign>0&&position.tilt>=0.99))throw Error('Camera mechanical limit reached; adjust placement or orientation.');
        this.state.action=`Centering person: ${action}`;
        await this.control.command(action);moves++;
        if(id!==this.generation)return;
        await this.delay(Math.max(0,1000-(this.now()-tick)));
      }
      if(id===this.generation)await this.stop('Movement budget reached; stopped.');
    }catch(error){if(id===this.generation){try{await this.stop(error.status?'Camera or vision request failed; stopped.':error.message);}catch{this.state.action='Stop request failed; camera pulse timeout applies.';}}}
  }
}
