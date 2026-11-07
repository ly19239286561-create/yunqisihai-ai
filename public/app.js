const $ = s=>document.querySelector(s);
let selectedTab='file';
let currentFile=null;
let signedStorage=false;
let uploadMode='none';
let pollTimer=null;
const STORAGE='yunqisihai-translation-jobs-v1';
const langNames={'English':'英语','English (United States)':'英语（美国）','English (UK)':'英语（英国）','Korean':'韩语','Japanese':'日语','French':'法语','German':'德语','Spanish':'西班牙语','Thai':'泰语','Vietnamese':'越南语','Chinese (Mandarin, Simplified)':'中文（普通话）'};
const chineseNames={'Afrikaans':'南非荷兰语','Albanian':'阿尔巴尼亚语','Amharic':'阿姆哈拉语','Arabic':'阿拉伯语','Armenian':'亚美尼亚语','Azerbaijani':'阿塞拜疆语','Bangla':'孟加拉语','Basque':'巴斯克语','Belarusian':'白俄罗斯语','Bengali':'孟加拉语','Bosnian':'波斯尼亚语','Bulgarian':'保加利亚语','Burmese':'缅甸语','Catalan':'加泰罗尼亚语','Chinese':'中文','Croatian':'克罗地亚语','Czech':'捷克语','Danish':'丹麦语','Dutch':'荷兰语','English':'英语','Estonian':'爱沙尼亚语','Filipino':'菲律宾语','Finnish':'芬兰语','French':'法语','Galician':'加利西亚语','Georgian':'格鲁吉亚语','German':'德语','Greek':'希腊语','Gujarati':'古吉拉特语','Haitian Creole':'海地克里奥尔语','Hebrew':'希伯来语','Hindi':'印地语','Hungarian':'匈牙利语','Icelandic':'冰岛语','Indonesian':'印尼语','Irish':'爱尔兰语','Italian':'意大利语','Japanese':'日语','Javanese':'爪哇语','Kannada':'卡纳达语','Kazakh':'哈萨克语','Khmer':'高棉语','Konkani':'孔卡尼语','Korean':'韩语','Lao':'老挝语','Latin':'拉丁语','Latvian':'拉脱维亚语','Lithuanian':'立陶宛语','Luxembourgish':'卢森堡语','Macedonian':'马其顿语','Maithili':'迈蒂利语','Malagasy':'马达加斯加语','Malay':'马来语','Malayalam':'马拉雅拉姆语','Maltese':'马耳他语','Mandarin':'中文（普通话）','Marathi':'马拉地语','Mongolian':'蒙古语','Nepali':'尼泊尔语','Norwegian Bokmål':'挪威语（博克马尔）','Norwegian Nynorsk':'挪威语（尼诺斯克）','Odia':'奥里亚语','Pashto':'普什图语','Persian':'波斯语','Polish':'波兰语','Portuguese':'葡萄牙语','Punjabi':'旁遮普语','Romanian':'罗马尼亚语','Russian':'俄语','Serbian':'塞尔维亚语','Sindhi':'信德语','Sinhala':'僧伽罗语','Slovak':'斯洛伐克语','Slovenian':'斯洛文尼亚语','Somali':'索马里语','Spanish':'西班牙语','Sundanese':'巽他语','Swahili':'斯瓦希里语','Swedish':'瑞典语','Tamil':'泰米尔语','Telugu':'泰卢固语','Thai':'泰语','Turkish':'土耳其语','Ukrainian':'乌克兰语','Urdu':'乌尔都语','Uzbek':'乌兹别克语','Vietnamese':'越南语','Welsh':'威尔士语','Zulu':'祖鲁语'};
function displayLanguage(name){if(langNames[name])return `${langNames[name]} · ${name}`;const match=/^([^()]+?)(?: \((.+)\))?$/.exec(name);if(!match)return name;const base=match[1].trim();return `${chineseNames[base]||base}${match[2]?'（'+match[2]+'）':''} · ${name}`;}
async function loadLanguages(){
 const select=$('#language'),status=$('#languageStatus');
 try{
  const data=await api('/languages');
  if(!Array.isArray(data.languages)||!data.languages.length)throw new Error('语言列表为空');
  const previous=select.value;
  select.replaceChildren();
  const langs=data.languages.slice().sort((a,b)=>a.localeCompare(b,'en'));
  const preferred=['English','English (United States)','Korean','Japanese','Spanish','French','German','Thai','Vietnamese','Chinese (Mandarin, Simplified)'];
  const rank=x=>{const i=preferred.indexOf(x);return i<0?999:i;};
  langs.sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b,'en'));
  const available=Array.isArray(data.availableOnPlan)?new Set(data.availableOnPlan):null;
  for(const name of langs){
   const opt=document.createElement('option');opt.value=name;
   const blocked=available&&!available.has(name);
   opt.textContent=displayLanguage(name)+(blocked?' · 需升级套餐':'');
   if(blocked)opt.disabled=true;
   select.append(opt);
  }
  const chosen=previous&&langs.includes(previous)?previous:(langs.includes('English')?'English':langs[0]);
  if(available&&!available.has(chosen))select.value=langs.find(x=>available.has(x))||'';
  else select.value=chosen;
  status.textContent=`已加载 ${langs.length} 个语言及地区选项`+(available?`，当前套餐可用 ${langs.filter(x=>available.has(x)).length} 项`:'')+(data.fromLiveApi?'':'（使用备用列表，提交时可能受限制）');
 }catch(error){
  status.textContent='加载语言失败：'+error.message;
  select.replaceChildren();const opt=document.createElement('option');opt.value='';opt.textContent='语言暂不可用，请刷新页面';select.append(opt);
 }
}

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
    const data=await api('/session');uploadMode=data.uploadMode||(data.uploadsEnabled?'r2':'none');signedStorage=uploadMode!=='none';
    $('#authPanel').classList.toggle('hidden',data.loggedIn);
    $('#toolPanel').classList.toggle('hidden',!data.loggedIn);
    $('#logoutBtn').classList.toggle('hidden',!data.loggedIn);
    $('#storageHint').classList.toggle('hidden',signedStorage);
    if(!signedStorage)$('#storageHint').textContent='当前不支持本地上传，请切换视频链接。';
    if(data.loggedIn){await loadLanguages();renderJobs();await refreshJobs();if(!pollTimer)pollTimer=setInterval(refreshJobs,18000);}
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
    if(!$('#language').value)throw new Error('请选择可用翻译语言。');
    let input={language:$('#language').value,mode:$('#mode').value,enableCaption:$('#captions').checked};
    let name='在线视频';
    if(selectedTab==='file'){
      if(!currentFile)throw new Error('请先选择视频文件。');
      if(!signedStorage)throw new Error('服务器尚未启用本地视频上传。');
      name=currentFile.name;
      if(uploadMode==='direct'){
        if(currentFile.size>32*1024*1024)throw new Error('免费直传限32MB，建议先用剪映压缩视频。');
        if(!['video/mp4','video/webm'].includes(currentFile.type))throw new Error('请将视频转为 MP4 或 WEBM 再上传。');
        setMessage('正在安全上传视频，请保持页面打开…');
        const response=await fetch('/api/uploads/video',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':currentFile.type},body:currentFile
        });
        let payload;try{payload=await response.json();}catch{payload={error:'上传服务器响应异常'};}
        if(!response.ok)throw new Error(payload.error||('上传失败：'+response.status));
        if(!payload.assetId)throw new Error('上传成功，但没有获取到视频编号');
        input.assetId=payload.assetId;
      }else if(uploadMode==='r2'){
        if(currentFile.size>1024*1024*1024)throw new Error('文件不能超过1GB。');
        if(!['video/mp4','video/quicktime','video/webm'].includes(currentFile.type))throw new Error('请上传 MP4/MOV/WEBM 视频');
        setMessage('正在申请安全上传地址…');
        const signed=await api('/uploads/sign',{method:'POST',body:JSON.stringify({type:currentFile.type,size:currentFile.size})});
        setMessage('正在上传视频文件，请保持页面打开…');
        const uploaded=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':currentFile.type},body:currentFile});
        if(!uploaded.ok)throw new Error('上传失败。请检查 R2 存储配置。');
        input.fileKey=signed.key;
      }else throw new Error('暂无可用上传通道');
    }else{
      const url=$('#videoUrl').value.trim();if(!url.startsWith('https://'))throw new Error('请填写 HTTPS 视频文件链接。');
      input.videoUrl=url;name=url.split('/').pop().split('?')[0].slice(0,60)||'在线视频';
    }
    setMessage('正在提交视频翻译任务…');
    const job=await api('/translate',{method:'POST',body:JSON.stringify(input)});
    const jobs=readJobs();jobs.unshift({id:job.id,status:'submitted',name,language:input.language,date:new Date().toISOString()});saveJobs(jobs);renderJobs();
    setMessage(`任务已真实提交：${job.id}。系统将自动检查状态，完成后显示下载链接。`);
    await refreshJobs();
    document.querySelector('#jobs').scrollIntoView({behavior:'smooth'});
  }catch(e){setMessage(e.message,true);}finally{btn.disabled=false;}
});
$('#refreshBtn').addEventListener('click',async()=>{setMessage('查询中…');await refreshJobs();setMessage('查询完成。');});
renderJobs();restoreSession();
