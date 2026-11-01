import {statSync,createReadStream} from 'node:fs';
// Range-capable static file send (video, wav).
export function sendFileRange(req,res,p,type){
  {
    const size=statSync(p).size,range=req.headers.range,head={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    let start=0,end=size-1,status=200;
    if(range){
      const r=range.match(/^bytes=(\d*)-(\d*)$/);
      if(!r||(r[1]===''&&r[2]==='')){res.writeHead(416,{...head,'Content-Range':`bytes */${size}`});res.end();return true;}
      if(r[1]===''){start=Math.max(0,size-Number(r[2]));}else{start=Number(r[1]);if(r[2]!=='')end=Math.min(size-1,Number(r[2]));}
      if(start>end||start>=size){res.writeHead(416,{...head,'Content-Range':`bytes */${size}`});res.end();return true;}
      status=206;head['Content-Range']=`bytes ${start}-${end}/${size}`;
    }
    res.writeHead(status,{...head,'Content-Length':end-start+1});
    const stream=createReadStream(p,{start,end});stream.on('error',()=>res.destroy());req.once('close',()=>stream.destroy());stream.pipe(res);return true;
  }
}

