import {orderGraph} from './graph.mjs';
import {prepareInputs,readOutput} from './media-io.mjs';
import {defaultNaming,validateDirectory,validatePattern,outputFor} from './output-config.mjs';
import {inspectOrbit,loginOrbit,logoutOrbit,validateBinding,executeOrbit} from './orbit-client.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const data=process.env.MV_DATA_DIR||path.join(root,'data');
const port=Number(process.env.MV_PORT||7788);
fs.mkdirSync(path.join(data,'media'),{recursive:true});
const dbFile=path.join(data,'project.json');
const tokenFile=path.join(data,'worker-token.txt');
if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('hex'));
const workerToken=fs.readFileSync(tokenFile,'utf8').trim();
const suffix=', clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.';
function initial(){return {name:'Live Concert đầu tiên',revision:1,website:'',audio:null,audioDuration:null,fields:{identity:'Adult singer, dark wavy hair, natural appearance',wardrobe:'Burgundy velvet evening outfit',instrument:'Matte black handheld microphone',stage:'Grand concert theater, polished wooden stage, singer center, guitarist left, piano right',lighting:'Warm amber key light, soft golden rim light, gentle haze',bpm:''},nodes:[{id:'singer',name:'Ca sĩ',prompt:'',image:null,video:null},{id:'stage',name:'Sân khấu',prompt:'',image:null,video:null},{id:'scene',name:'Ghép cảnh',prompt:'',image:null,video:null},...['wide','medium','close'].map((id,i)=>({id,name:['Toàn cảnh','Trung cảnh','Cận cảnh'][i],prompt:'',videoPrompt:'',lyric:'',start:i*8,duration:8,image:null,video:null}))],jobs:[],worker:null};}
let db=fs.existsSync(dbFile)?JSON.parse(fs.readFileSync(dbFile,'utf8')):initial();
db.outputDirectory??=path.join(root,'results');for(const n of db.nodes)n.outputNaming??={...defaultNaming};
db.edges??=[{source:'singer',target:'scene'},{source:'stage',target:'scene'},...['wide','medium','close'].map(target=>({source:'scene',target}))];
if(db.autoRun?.status==='running'){db.autoRun.status='stopped';db.autoRun.message='Đã khởi động lại. Kiểm tra tác vụ cũ trước khi chạy tiếp.';}
function save(){fs.writeFileSync(dbFile+'.tmp',JSON.stringify(db,null,2));fs.renameSync(dbFile+'.tmp',dbFile);}
// Never silently resubmit a possibly successful browser action after a restart.
for(const j of db.jobs)if(j.status==='running'){j.status='needs_review';j.error='Ứng dụng đã khởi động lại. Kiểm tra website trước khi tạo lại.';}
save();
const getNode=id=>db.nodes.find(n=>n.id===id);
const deps=id=>db.edges.filter(e=>e.target===id).map(e=>e.source);
function markChildren(id){for(const n of db.nodes)if(deps(n.id).includes(id)){if(n.image||n.video)n.stale=true;if(n.id!==id)markChildren(n.id);}}
function markAll(){for(const n of db.nodes)if(n.image||n.video)n.stale=true;}
function prompts(n){const f=db.fields, common=`${f.identity}. ${f.wardrobe}. ${f.instrument}.`,stage=`${f.stage}. ${f.lighting}.`;
 const size={wide:'Wide shot, full body and stage environment',medium:'Medium shot, waist-up singer',close:'Close-up three-quarter view, face and microphone'};
 const generated=n.id==='singer'?`${common} Neutral reference portrait and clear face, realistic skin texture, no text.`:n.id==='stage'?`${stage} Wide establishing shot of the empty stage, no singer, no text.`:n.id==='scene'?`Place the referenced singer in the referenced stage, preserve identity, outfit and instrument. ${common} ${stage} Wide shot, physically coherent scale, 16:9, photorealistic.`:`${size[n.id]||'Compose the connected reference images into one coherent photograph'}. Preserve the referenced singer and scene. ${common} ${stage} Photorealistic concert still, 16:9, no text.`;
 const pace=f.bpm?`Steady ${f.bpm} BPM, natural breathing pauses.`:'Natural breathing and restrained motion; align phrasing to the supplied audio.';
 const movement=n.id==='wide'?'Slow dolly-in':n.id==='medium'?'Gentle push-in':'Very slow push-in, stable face';
 let video=`Pace: ${pace} Prompt Video: ${movement}. Preserve the approved keyframe, identity, clothing and lighting. Subtle emotional performance.${n.lyric?' mouth articulates: '+JSON.stringify(n.lyric)+'.':''}${suffix}`;
 return {image:n.prompt||generated,video:n.videoPrompt||video};}
const assetRefs=n=>deps(n.id).map(id=>({role:id,asset:getNode(id).image})).filter(r=>r.asset);
function publicState(){return {...db,worker:db.worker?{...db.worker,online:Date.now()-db.worker.lastSeen<20000}:null,nodes:db.nodes.map(n=>({...n,resolvedPrompts:prompts(n),references:assetRefs(n)}))};}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
async function body(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>150*1024*1024)throw new Error('File quá lớn. Giới hạn 100 MB cho một file.');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
function requireWorker(req){if(req.headers.authorization!=='Bearer '+workerToken)throw Object.assign(new Error('Worker authentication required'),{status:401});}
function storeAsset(b){const types={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/mp4':'m4a','audio/ogg':'ogg'};const ext=types[b.mime];if(!ext)throw new Error('Định dạng chưa hỗ trợ. Dùng PNG/JPG/WebP, MP4/WebM hoặc MP3/WAV/M4A.');const bytes=Buffer.from(b.base64||'','base64');if(!bytes.length||bytes.length>100*1024*1024)throw new Error('File trống hoặc lớn hơn 100 MB.');const id=crypto.randomUUID()+'.'+ext;fs.writeFileSync(path.join(data,'media',id),bytes);return {id,url:'/media/'+id,mime:b.mime,name:String(b.name||id).slice(0,200)};}
function mutate(){db.revision++;save();}
function checkLease(j,b){if(!j||j.status!=='running'||j.lease!==b.lease)throw new Error('Job không còn thuộc phiên worker này.');}
async function createJob(req,b){const n=getNode(b.nodeId);if(!n)throw new Error('Node không tồn tại');const kind=b.kind==='video'?'video':'image';const binding=n.orbit?.[kind];if(!binding)throw new Error('Mở Cài đặt Orbit của node để chọn kịch bản và nick.');const verifiedBinding=await validateBinding(req,binding);if(verifiedBinding.owner!==binding.owner)throw new Error('Cấu hình thuộc tài khoản khác. Chọn và lưu lại nick/kịch bản bằng tài khoản hiện tại.');const prior=db.jobs.find(j=>j.nodeId===n.id&&j.kind===kind&&['queued','running'].includes(j.status));if(prior)return prior;if(kind==='video'&&!n.image)throw new Error('Cần ảnh của shot trước khi tạo video.');if(kind==='image'&&deps(n.id).some(id=>!getNode(id).image||getNode(id).stale))throw new Error('Hãy tạo hoặc tải ảnh các bước phía trước trước.');if(n.stale&&kind==='video')throw new Error('Ảnh cần cập nhật sau thay đổi đầu vào. Hãy tạo lại hoặc tải ảnh đã duyệt.');const references=kind==='video'?[{role:'keyframe',asset:n.image}]:assetRefs(n);const jobId=crypto.randomUUID();const output=outputFor(db.outputDirectory,n.outputNaming,n.id,kind,jobId);const payload={output,orbit:verifiedBinding,kind,prompt:prompts(n)[kind],website:verifiedBinding.scriptName,aspectRatio:'16:9',references,audio:db.audio,timing:{start:n.start||0,duration:n.duration||8},nodeId:n.id,projectRevision:db.revision};const j={id:jobId,nodeId:n.id,kind,status:'queued',createdAt:new Date().toISOString(),payload,error:null};db.jobs.push(j);save();return j;}

async function collectJob(j){const content=await readOutput(j,Number(process.env.MV_OUTPUT_WAIT_MS||60000));const a=storeAsset(content);const n=getNode(j.nodeId);j.result=a;j.status='completed';j.completedAt=new Date().toISOString();j.resultStale=db.revision!==j.payload.projectRevision;n[j.kind]=a;if(j.kind==='image'){n.stale=j.resultStale;markChildren(n.id);}else n.videoStale=j.resultStale;j.progress='Đã nhận file vào node';save();}
function requireIdle(){if(db.autoRun?.status==='running'||db.jobs.some(j=>['queued','running'].includes(j.status)))throw new Error('Đợi tác vụ hoàn tất hoặc dừng chuỗi trước khi sửa workflow.');}
let orbitBusy=false;
async function pumpOrbit(req,owner){
 if(process.env.MV_RUNNER_DISABLED==='1'||orbitBusy||db.jobs.some(j=>j.status==='running'))return;
 orbitBusy=true;
 try{for(;;){let j=db.jobs.find(j=>j.status==='queued'&&j.payload.orbit?.owner===owner);
 if(!j&&db.autoRun?.status==='running'&&db.autoRun.owner===owner){
  const run=db.autoRun;
  while(run.index<run.order.length){const node=getNode(run.order[run.index]);if(node.image&&!node.stale){run.index++;continue;}break;}
  if(run.index===run.order.length){run.status='completed';run.message='Đã nhận đủ ảnh của chuỗi';save();break;}
  try{j=await createJob(req,{nodeId:run.order[run.index],kind:'image'});j.autoRunId=run.id;save();}catch(e){run.status='blocked';run.message=e.message;save();break;}
 }
 if(!j)break;
 j.status='running';j.executor='orbit-direct';j.startedAt=new Date().toISOString();j.heartbeat=Date.now();j.progress='Đang kiểm tra Orbit';save();
 const heartbeat=setInterval(()=>{j.heartbeat=Date.now();save();},10000);
 try{await prepareInputs(j,path.join(data,'media'));save();await executeOrbit(req,j,message=>{j.progress=message;j.heartbeat=Date.now();save();});j.progress='Đang chờ file đầu ra';save();await collectJob(j);if(j.autoRunId&&db.autoRun?.id===j.autoRunId)db.autoRun.index++;}
 catch(e){j.status='needs_review';j.error=e.message;j.progress='Cần kiểm tra Orbit trước khi chạy lại';if(j.autoRunId&&db.autoRun?.id===j.autoRunId){db.autoRun.status='blocked';db.autoRun.message=e.message;}}
 finally{clearInterval(heartbeat);save();}
 }}finally{orbitBusy=false;}
}
const server=http.createServer(async(req,res)=>{try{
 const origin=req.headers.origin;if(origin&&![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(origin))return json(res,403,{error:'Origin not allowed'});
 const u=new URL(req.url,`http://127.0.0.1:${port}`),p=u.pathname;
 if(p==='/api/orbit'&&req.method==='GET'){const info=await inspectOrbit(req);if(info.authenticated)pumpOrbit(req,info.user.email);return json(res,200,info);}
 if(p==='/api/orbit/login'&&req.method==='POST')return json(res,200,await loginOrbit(req,res,await body(req)));
 if(p==='/api/orbit/logout'&&req.method==='POST')return json(res,200,await logoutOrbit(req,res));
 if(p==='/api/state'&&req.method==='GET')return json(res,200,publicState());
 if(p==='/api/project'&&req.method==='PATCH'){requireIdle();const b=await body(req);const outputDirectory='outputDirectory'in b?validateDirectory(b.outputDirectory):db.outputDirectory;if(b.fields){if(b.fields.bpm&&(!Number.isFinite(Number(b.fields.bpm))||Number(b.fields.bpm)<=0))throw new Error('BPM phải là số dương.');for(const key of Object.keys(db.fields))if(key in b.fields)db.fields[key]=String(b.fields[key]).slice(0,5000);if(db.fields.bpm&&(!Number.isFinite(Number(db.fields.bpm))||Number(db.fields.bpm)<=0))throw new Error('BPM phải là số dương.');markAll();}db.outputDirectory=outputDirectory;if('website'in b)db.website=String(b.website).slice(0,500);if('name'in b)db.name=String(b.name).slice(0,100);mutate();return json(res,200,publicState());}
 if(p==='/api/node'&&req.method==='PATCH'){requireIdle();const b=await body(req),n=getNode(b.id);if(!n)throw new Error('Node không tồn tại');const next={...n};if('name'in b){next.name=String(b.name).trim().slice(0,100);if(!next.name)throw new Error('Tên node không được trống.');}if(b.outputNaming){next.outputNaming={...n.outputNaming};for(const kind of ['image','video'])if(kind in b.outputNaming)next.outputNaming[kind]=validatePattern(b.outputNaming[kind],kind);}if('orbit'in b){next.orbit={...n.orbit};for(const kind of ['image','video'])if(kind in b.orbit)next.orbit[kind]=b.orbit[kind]===null?null:await validateBinding(req,b.orbit[kind]);}for(const k of ['prompt','videoPrompt','lyric'])if(k in b)next[k]=String(b[k]).slice(0,20000);for(const k of ['start','duration'])if(k in b){const v=Number(b[k]);if(!Number.isFinite(v)||v<0||(k==='duration'&&v===0))throw new Error('Thời lượng không hợp lệ');next[k]=v;}const imageChanged=next.prompt!==n.prompt;const changed=JSON.stringify(n)!==JSON.stringify(next);Object.assign(n,next);if(changed&&n.video)n.videoStale=true;if(imageChanged){if(n.image)n.stale=true;markChildren(n.id);}if(changed)mutate();return json(res,200,publicState());}
 if(p==='/api/upload'&&req.method==='POST'){requireIdle();const b=await body(req);if(b.nodeId!=='audio'&&!getNode(b.nodeId))throw new Error('Node không tồn tại');const kind=b.nodeId==='audio'?'audio':b.kind==='video'?'video':'image';if(!String(b.mime).startsWith(kind+'/'))throw new Error('Loại file không khớp');const a=storeAsset(b);if(b.nodeId==='audio'){db.audio=a;db.audioDuration=Number.isFinite(b.duration)?b.duration:null;}else{const n=getNode(b.nodeId);n[kind]=a;if(kind==='image'){n.stale=false;if(n.video)n.videoStale=true;markChildren(n.id);}else n.videoStale=false;}mutate();return json(res,200,publicState());}
 if(p==='/api/jobs'&&req.method==='POST'){if(db.autoRun?.status==='running')throw new Error('Đang chạy tự động. Dừng chuỗi trước khi chạy riêng.');const j=await createJob(req,await body(req));pumpOrbit(req,j.payload.orbit.owner);return json(res,201,{job:j});}

 if(p==='/api/nodes'&&req.method==='POST'){requireIdle();const b=await body(req);if(db.nodes.length>=100)throw new Error('Giới hạn 100 node/project.');const node={id:'node-'+crypto.randomUUID(),name:String(b.name||'Ảnh mới').slice(0,100),prompt:'',videoPrompt:'',lyric:'',start:0,duration:8,image:null,video:null,outputNaming:{...defaultNaming}};db.nodes.push(node);mutate();return json(res,201,publicState());}
 if(p==='/api/edges'&&req.method==='PUT'){requireIdle();const b=await body(req);if(!Array.isArray(b.edges))throw new Error('Danh sách nối không hợp lệ');const edges=b.edges.map(e=>({source:String(e.source),target:String(e.target)}));if(new Set(edges.map(e=>e.source+'>'+e.target)).size!==edges.length)throw new Error('Đường nối trùng');orderGraph(db.nodes,edges);const changed=db.nodes.filter(n=>JSON.stringify(deps(n.id))!==JSON.stringify(edges.filter(e=>e.target===n.id).map(e=>e.source)));db.edges=edges;for(const n of changed){if(n.image)n.stale=true;markChildren(n.id);}mutate();return json(res,200,publicState());}
 if(p==='/api/auto/start'&&req.method==='POST'){
  requireIdle();const b=await body(req),order=orderGraph(db.nodes,db.edges,b.target||null),rerun=new Set();
  for(const id of order){const n=getNode(id);if(!n.image||n.stale||deps(id).some(id=>rerun.has(id)))rerun.add(id);}
  const info=await inspectOrbit(req);if(!info.authenticated)throw new Error(info.message);
  for(const id of rerun){const n=getNode(id);const ambiguous=[...db.jobs].reverse().find(j=>j.nodeId===id&&j.kind==='image');if(ambiguous?.status==='needs_review')throw new Error(n.name+': dùng Nhận file hoặc chạy riêng để xử lý tác vụ trước.');const binding=await validateBinding(req,n.orbit?.image);if(binding.owner!==n.orbit.image.owner)throw new Error('Chọn lại tài khoản chạy node '+n.name);}
  fs.mkdirSync(db.outputDirectory,{recursive:true});fs.accessSync(db.outputDirectory,fs.constants.W_OK);
  db.autoRun={id:crypto.randomUUID(),owner:info.user.email,status:'running',order,index:0,message:'Chạy lần lượt; dùng lại ảnh còn hợp lệ'};save();pumpOrbit(req,info.user.email);return json(res,200,publicState());
 }
 if(p==='/api/auto/stop'&&req.method==='POST'){if(db.autoRun?.status==='running'){db.autoRun.status='stopped';db.autoRun.message='Dừng sau node hiện tại; không hủy kịch bản trên Orbit';save();}return json(res,200,publicState());}
 if(p==='/api/jobs/collect'&&req.method==='POST'){const b=await body(req),j=db.jobs.find(j=>j.id===b.id);if(!j||!['needs_review','script_completed'].includes(j.status)||!j.payload.output)throw new Error('Tác vụ chưa thể nhận file');requireIdle();await collectJob(j);return json(res,200,publicState());}
 if(p==='/api/jobs/cancel'&&req.method==='POST'){const b=await body(req),j=db.jobs.find(j=>j.id===b.id);if(!j||j.status!=='queued')throw new Error('Chỉ hủy được job chưa chạy.');j.status='cancelled';save();return json(res,200,{ok:true});}
 if(p==='/api/worker/claim'&&req.method==='POST'){requireWorker(req);const b=await body(req);db.worker={name:String(b.name||'Web worker').slice(0,100),lastSeen:Date.now()};const j=db.jobs.some(j=>j.status==='running')?null:db.jobs.find(j=>j.status==='queued'&&!j.payload.orbit);if(j){j.status='running';j.startedAt=new Date().toISOString();j.heartbeat=Date.now();j.lease=crypto.randomUUID();}save();return json(res,200,{job:j||null});}
 if(p==='/api/worker/heartbeat'&&req.method==='POST'){requireWorker(req);const b=await body(req),j=db.jobs.find(j=>j.id===b.id);checkLease(j,b);j.heartbeat=Date.now();if(db.worker)db.worker.lastSeen=Date.now();save();return json(res,200,{ok:true});}
 if(p==='/api/worker/complete'&&req.method==='POST'){requireWorker(req);const b=await body(req),j=db.jobs.find(j=>j.id===b.id);checkLease(j,b);if(!String(b.mime).startsWith(j.kind+'/'))throw new Error('Worker trả về sai loại file');const a=storeAsset(b);j.status='completed';j.result=a;j.completedAt=new Date().toISOString();const n=getNode(j.nodeId);n[j.kind]=a;n.stale=db.revision!==j.payload.projectRevision;j.resultStale=n.stale;if(j.kind==='image'){if(n.video)n.videoStale=true;markChildren(n.id);}else {n.videoStale=n.stale;n.stale=false;}save();return json(res,200,{ok:true,asset:a});}
 if(p==='/api/worker/fail'&&req.method==='POST'){requireWorker(req);const b=await body(req),j=db.jobs.find(j=>j.id===b.id);checkLease(j,b);j.status=b.needsReview?'needs_review':'failed';j.error=String(b.error||'Worker failed').slice(0,2000);save();return json(res,200,{ok:true});}
 if(p==='/api/export'&&req.method==='GET'){const shots=db.nodes.map(n=>({shotId:n.id,start:n.start,duration:n.duration,lyric:n.lyric,prompts:prompts(n),references:assetRefs(n),image:n.image,video:n.video,stale:!!n.stale}));return json(res,200,{project:db.name,edges:db.edges,version:2,timingStatus:'manual_unverified',audio:db.audio,fields:db.fields,shots});}
 if(p.startsWith('/media/')&&req.method==='GET'){const name=p.slice(7);if(!/^[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|ogg)$/.test(name))return json(res,404,{error:'Not found'});const file=path.join(data,'media',name);if(!fs.existsSync(file))return json(res,404,{error:'Not found'});const ext=path.extname(name),mime={'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg'}[ext];const size=fs.statSync(file).size;const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);res.setHeader('Content-Type',mime);res.setHeader('Accept-Ranges','bytes');if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),size-1):size-1;if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});fs.createReadStream(file,{start,end}).pipe(res);}else{res.writeHead(200,{'Content-Length':size});fs.createReadStream(file).pipe(res);}return;}
 if(req.method==='GET'&&['/','/app.js','/style.css'].includes(p)){const file=p==='/'?'index.html':p.slice(1);res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store'});return fs.createReadStream(path.join(root,'public',file)).pipe(res);}
 return json(res,404,{error:'Not found'});
}catch(e){json(res,e.status||400,{error:e.message});}});
setInterval(()=>{let changed=false;for(const j of db.jobs)if(j.status==='running'&&Date.now()-j.heartbeat>90000){j.status='needs_review';j.error='Worker mất kết nối. Kiểm tra website trước khi tạo lại để tránh chạy trùng.';changed=true;}if(changed)save();},10000).unref();
server.listen(port,'127.0.0.1',()=>console.log(`MV Director ready: http://127.0.0.1:${port}`));
