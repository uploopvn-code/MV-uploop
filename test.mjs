import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mv-director-test-'));
const mock=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;res.setHeader('Content-Type','application/json');if(req.url==='/api/login'){const b=JSON.parse(raw);if(b.password!=='test-password'){res.writeHead(401);return res.end(JSON.stringify({detail:'Sai email hoặc mật khẩu'}));}res.setHeader('Set-Cookie','orbit_session=test-session; HttpOnly');return res.end('{}');}if(req.url==='/api/auth-status')return res.end(JSON.stringify({user:req.headers.cookie==='orbit_session=test-session'?{email:'test@example.com',role:'user'}:null}));if(req.headers.cookie!=='orbit_session=test-session'){res.writeHead(401);return res.end('{}');}res.end(JSON.stringify(req.url==='/api/apps'?[]:req.url==='/api/profiles'?[{id:'p1',name:'Test nick'}]:req.url==='/api/flows'?[{id:'f1',name:'Test flow'}]:req.url.startsWith('/api/workflows')?[{id:'w1',name:'Test workflow'}]:{}));});
await new Promise(r=>mock.listen(17789,'127.0.0.1',r));
let cookie='';
const proc=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,MV_RUNNER_DISABLED:'1',MV_ORBIT_URL:'http://127.0.0.1:17789',MV_PORT:'17788',MV_DATA_DIR:dir},stdio:'pipe'});
const base='http://127.0.0.1:17788';
async function call(url,method='GET',body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
try{
 await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',code=>reject(new Error('Server exit '+code)));});
 const token=fs.readFileSync(path.join(dir,'worker-token.txt'),'utf8').trim();
 assert.equal((await call('/api/worker/claim','POST',{})).status,401);
 assert.equal((await call('/api/project','PATCH',{fields:{bpm:'oops'}})).status,400);
 assert.equal((await call('/api/state')).data.fields.bpm,'');
 assert.equal((await call('/api/orbit')).data.authenticated,false);
 assert.equal((await call('/api/orbit/login','POST',{email:'test@example.com',password:'wrong'})).status,401);
 assert.equal((await call('/api/orbit/login','POST',{email:'test@example.com',password:'test-password'})).status,200);
 const inventory=(await call('/api/orbit')).data;assert.equal(inventory.profiles.length,1);assert.equal(inventory.workflows.length,1);
 const binding={type:'workflow',scriptId:'w1',profileId:'p1'};
 assert.equal((await call('/api/node','PATCH',{id:'singer',orbit:{image:{...binding,profileId:'other'}}})).status,400);
 for(const id of ['singer','stage','scene','wide'])assert.equal((await call('/api/node','PATCH',{id,orbit:{image:binding,video:binding}})).status,200);
 assert.equal((await call('/api/jobs','POST',{nodeId:'scene'})).status,400);
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
 for(const id of ['singer','stage','scene','wide'])assert.equal((await call('/api/upload','POST',{nodeId:id,mime:'image/png',base64:png})).status,200);
 await call('/api/node','PATCH',{id:'wide',lyric:'Hello',duration:9});
 const state=(await call('/api/state')).data;
 assert.ok(!state.nodes.find(n=>n.id==='wide').stale,'Lyrics must not invalidate image');
 const a=await call('/api/jobs','POST',{nodeId:'wide',kind:'video'});
 assert.equal(a.status,201);assert.match(a.data.job.payload.prompt,/mouth articulates: "Hello"/);
 assert.equal((await call('/api/jobs','POST',{nodeId:'wide',kind:'video'})).data.job.id,a.data.job.id);
 const job=(await call('/api/worker/claim','POST',{},token)).data.job;
 // Direct Orbit jobs are not claimable by the generic bridge.
 assert.equal(job,null);
 console.log('PASS: user login, binding, prompt snapshot, generic-worker isolation');
 process.exitCode=0;

 }finally{proc.kill();mock.close();}
