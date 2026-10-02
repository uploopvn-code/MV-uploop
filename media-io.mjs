import fs from 'node:fs/promises';
import path from 'node:path';
export async function prepareInputs(job,mediaDir){
 const dir=job.payload.output.directory;await fs.mkdir(dir,{recursive:true});
 const inputDir=path.join(dir,'inputs');const references=[];
 for(const ref of job.payload.references){
  if(!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(ref.asset.id))throw new Error('Ảnh tham chiếu không hợp lệ.');
  await fs.mkdir(inputDir,{recursive:true});const dest=path.join(inputDir,ref.asset.id);
  await fs.copyFile(path.join(mediaDir,ref.asset.id),dest);
  references.push({node_id:ref.role,path:dest,mime:ref.asset.mime});
 }
 job.payload.inputFiles=references;
 // Unique job paths must never overwrite a previous output.
 try{await fs.access(job.payload.output.path);throw new Error('File đích đã tồn tại. Nhận file hoặc kiểm tra trước khi chạy.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
export async function readOutput(job,timeout=60000){
 const file=job.payload.output.path,until=Date.now()+timeout;let previous='';
 do{
  try{const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>100*1024*1024)throw new Error('File đầu ra không hợp lệ hoặc lớn hơn 100 MB.');
   const stamp=st.size+':'+st.mtimeMs;
   if(st.size&&stamp===previous){const b=await fs.readFile(file);let mime='';if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';else if(b[0]===255&&b[1]===216&&b[2]===255)mime='image/jpeg';else if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')mime='image/webp';else if(b.toString('ascii',4,8)==='ftyp')mime='video/mp4';else if(b.subarray(0,4).equals(Buffer.from([26,69,223,163])))mime='video/webm';if(!mime.startsWith(job.kind+'/'))throw new Error('Nội dung file không đúng loại ảnh/video yêu cầu.');return {mime,base64:b.toString('base64'),name:path.basename(file)};}
   previous=stamp;
  }catch(e){if(e.code!=='ENOENT')throw e;}
  await new Promise(r=>setTimeout(r,1000));
 }while(Date.now()<until);
 throw new Error('Chưa nhận được file tại '+file+'. Kiểm tra bước lưu file của Orbit rồi dùng Nhận file; không cần chạy lại kịch bản.');
}
