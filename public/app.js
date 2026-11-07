const $ = s=>document.querySelector(s);
let selectedTab='file';
let currentFile=null;
let signedStorage=false;
let pollTimer=null;
const STORAGE='yunqisihai-translation-jobs-v1';
const langNames={'English (United States)':'英语','Korean':'韩语','Japanese':'日语','French (France)':'法语','German (Germany)':'德语','Spanish (Spain)':'西班牙语','Thai':'泰语','Vietnamese':'越南语','Chinese (Mandarin, Simplified)':'中文'};
function setMessage(message,err=false){const node=$('#notice');node.className=err?'error':'';node.textContent=message;}
async function api(path,options={}){
  const response=await fetch('/api'+path,{credentials:'same-origin',...options,
    headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  let payload;try{payload=await response.json();}catch{payload={error:'服务器返回异常，请查看部署日志'};}
  if(!response.ok)throw new Error(payload.error||`请求失败 ${response.status}`);
  return payload;
}
function readJobs(){try{const data=JSON.parse(localStorage.getItem(STORAGE)||'[]');return Array.isArray(data)?data.slice(0,50):[];}catch{return [];}}
function saveJobs(jobs){localStorage.setItem(STORAGE,JSON.stringify(jobs.slice(0,50)));}
function htmlEscape(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderJobs(){
  const jobs=readJobs(),root=$('#jobsList');
  if(!jobs.length){root.innerHTML='<div class="empty">还没有提交过翻译任务。</div>';return;}
  root.innerHTML=jobs.map(j=>{
    const url=typeof j.videoUrl==='string' && j.videoUrl.startsWith('https://') ?j.videoUrl:null;
    const captions=typeof j.captionUrl==='string'&&j.captionUrl.startsWith('https://')?j.captionUrl:null;
    const state=({submitted:'已提交',pending:'等待处理',processing:'处理中',running:'翻译中',completed:'已完成',success:'已完成',failed:'失败'})[j.status]||j.status;
    return `<div class="job"><div><strong>${htmlEscape(j.name)} · ${htmlEscape(langNames[j.language]||j.language)}</strong><small>${htmlEscape(new Date(j.date).toLocaleString('zh-CN'))} · 任务 ${htmlEscape(j.id.slice(0,15))}</small><div class="state">${htmlEscape(state)}${j.failureMessage?' · '+htmlEscape(j.failureMessage):''}</div></div><div>${url?`<a href="${htmlEscape(url)}" target="_blank" rel="noreferrer">下载成片</a>`:''}${captions?` <a href="${htmlEscape(captions)}" target="_blank" rel="noreferrer">字幕文件</a>`:''}</div></div>`;
  }).join('');
}
async function refreshJobs(){
  const jobs=readJobs();let changed=false;
  for(const job of jobs.slice(0,12)){
    if(['completed','success','failed'].includes(job.status))continue;
    try{
      const result=await api('/translate/'+encodeURIComponent(job.id));
      Object.assign(job,{status:result.status,videoUrl:result.videoUrl,captionUrl:result.captionUrl,failureMessage:result.failureMessage});changed=true;
    }catch(err){if(err.message==='请先登录工作台')return;}
  }
  if(changed)saveJobs(jobs);renderJobs();
}
async function restoreSession(){
  try{
    const data=await api('/session');signedStorage=!!data.uploadsEnabled;
    $('#authPanel').classList.toggle('hidden',data.loggedIn);
    $('#toolPanel').classList.toggle('hidden',!data.loggedIn);
    $('#logoutBtn').classList.toggle('hidden',!data.loggedIn);
    $('#storageHint').classList.toggle('hidden',signedStorage);
    if(!signedStorage)$('#storageHint').textContent='当前服务器未配置上传存储，请切换“视频链接”提交真实任务。';
    if(data.loggedIn){renderJobs();await refreshJobs();if(!pollTimer)pollTimer=setInterval(refreshJobs,18000);}
    else{if(pollTimer)clearInterval(pollTimer);pollTimer=null;}
  }catch(e){setMessage(e.message,true);}
}
$('#loginForm').addEventListener('submit',async event=>{
  event.preventDefault();setMessage('正在验证登录…');
  try{await api('/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});$('#password').value='';setMessage('登录成功，开始使用翻译工作台。');await restoreSession();}catch(e){setMessage(e.message,true);}
});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/logout',{method:'POST'});setMessage('已退出。');await restoreSession();}catch(e){setMessage(e.message,true);}});
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  selectedTab=btn.dataset.tab;
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b===btn));
  $('#fileTab').classList.toggle('hidden',selectedTab!=='file');$('#urlTab').classList.toggle('hidden',selectedTab!=='url');
}));
$('#file').addEventListener('change',event=>{
  const file=event.target.files?.[0];if(!file)return;
  currentFile=file;$('#fileName').textContent=`${file.name}（${(file.size/1024/1024).toFixed(1)} MB）`;
  const preview=$('#preview');if(preview.dataset.objectUrl)URL.revokeObjectURL(preview.dataset.objectUrl);
  preview.dataset.objectUrl=URL.createObjectURL(file);preview.src=preview.dataset.objectUrl;preview.classList.remove('hidden');
});
$('#submitBtn').addEventListener('click',async()=>{
  if(!$('#consent').checked){setMessage('请先确认拥有视频和出镜者声音的使用授权。',true);return;}
  const btn=$('#submitBtn');btn.disabled=true;
  try{
    let input={language:$('#language').value,mode:$('#mode').value,enableCaption:$('#captions').checked};
    let name='在线视频';
    if(selectedTab==='file'){
      if(!currentFile)throw new Error('请先选择视频文件。');
      if(!signedStorage)throw new Error('尚未配置 R2 存储。请切换“视频链接”，或先完成 R2 配置。');
      if(currentFile.size>1024*1024*1024)throw new Error('文件不能超过 1GB。');
      if(!['video/mp4','video/quicktime','video/webm'].includes(currentFile.type))throw new Error('请上传 MP4 / MOV / WEBM 文件。');
      setMessage('正在申请安全上传地址…');
      const signed=await api('/uploads/sign',{method:'POST',body:JSON.stringify({type:currentFile.type,size:currentFile.size})});
      setMessage('正在上传视频文件，请保持页面打开…');
      const uploaded=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':currentFile.type},body:currentFile});
      if(!uploaded.ok)throw new Error('上传失败。请检查 R2 存储 CORS 规则、容量及网络状态。');
      input.fileKey=signed.key;name=currentFile.name;
    }else{
      const url=$('#videoUrl').value.trim();if(!url.startsWith('https://'))throw new Error('请填写 HTTPS 视频文件链接。');
      input.videoUrl=url;name=url.split('/').pop().split('?')[0].slice(0,60)||'在线视频';
    }
    setMessage('正在向 HeyGen 提交视频翻译任务…');
    const job=await api('/translate',{method:'POST',body:JSON.stringify(input)});
    const jobs=readJobs();jobs.unshift({id:job.id,status:'submitted',name,language:input.language,date:new Date().toISOString()});saveJobs(jobs);renderJobs();
    setMessage(`任务已真实提交：${job.id}。系统将自动检查状态，完成后显示下载链接。`);
    await refreshJobs();
    document.querySelector('#jobs').scrollIntoView({behavior:'smooth'});
  }catch(e){setMessage(e.message,true);}finally{btn.disabled=false;}
});
$('#refreshBtn').addEventListener('click',async()=>{setMessage('查询中…');await refreshJobs();setMessage('查询完成。');});
renderJobs();restoreSession();
