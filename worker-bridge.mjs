// The handler module implements the user's documented Orbit/web automation.
// No vendor URLs, profile-opening endpoints or page selectors are guessed here.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const handlerPath=process.argv[2];
if(!handlerPath){console.error('Usage: node worker-bridge.mjs <orbit-handler.mjs>');process.exit(1);}
const {runJob}=await import(pathToFileURL(path.resolve(handlerPath)).href);
if(typeof runJob!=='function')throw new Error('Handler must export async function runJob(payload, context)');
const base=process.env.MV_BASE_URL||'http://127.0.0.1:7788';
const token=process.env.MV_WORKER_TOKEN||(await fs.readFile(path.join(root,'data/worker-token.txt'),'utf8')).trim();
const send=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});const b=await r.json();if(!r.ok)throw new Error(b.error);return b;};
let stopping=false;process.on('SIGINT',()=>stopping=true);process.on('SIGTERM',()=>stopping=true);
console.log('Orbit bridge started. One job at a time.');
while(!stopping){let job;try{({job}=await send('/api/worker/claim',{name:'Orbit web worker'}));if(!job){await new Promise(r=>setTimeout(r,2500));continue;}
 const context={jobId:job.id,baseUrl:base,downloadReference:async(asset)=>{if(!asset?.url?.startsWith('/media/'))throw new Error('Invalid local reference');const r=await fetch(base+asset.url);if(!r.ok)throw new Error('Reference download failed');return Buffer.from(await r.arrayBuffer());}};
 const timer=setInterval(()=>send('/api/worker/heartbeat',{id:job.id,lease:job.lease}).catch(()=>{}),10000);
 let result;
 try{result=await runJob(job.payload,context);}catch(e){await send('/api/worker/fail',{id:job.id,lease:job.lease,error:e.message,needsReview:true});continue;}finally{clearInterval(timer);}
 // Once the site has generated output, report failures without creating again.
 try{if(!result?.filePath||!result?.mime)throw new Error('Handler must return filePath and mime');const bytes=await fs.readFile(result.filePath);await send('/api/worker/complete',{id:job.id,lease:job.lease,name:path.basename(result.filePath),mime:result.mime,base64:bytes.toString('base64')});console.log('Completed',job.id);}catch(e){await send('/api/worker/fail',{id:job.id,lease:job.lease,error:'Output may already exist on website: '+e.message,needsReview:true});}
}catch(e){console.error('Bridge:',e.message);await new Promise(r=>setTimeout(r,3000));}}
