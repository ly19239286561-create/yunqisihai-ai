(()=>{'use strict';
const $=s=>document.querySelector(s);
const statusNode=$('#notice');
let config=null, tab='file', activeFile=null, requestId=null, busy=false, refreshTimer=null, localDuration=null;
const zh={'English':'英语','Korean':'韩语','Japanese':'日语','French':'法语','German':'德语','Spanish':'西班牙语','Thai':'泰语','Vietnamese':'越南语','Arabic':'阿拉伯语','Portuguese':'葡萄牙语','Russian':'俄语','Mandarin':'中文（普通话）','Chinese':'中文','Hindi':'印地语','Italian':'意大利语','Dutch':'荷兰语','Indonesian':'印度尼西亚语','Malay':'马来语','Turkish':'土耳其语','Swedish':'瑞典语','Vietnamese':'越南语'};
function say(message,error=false){statusNode.textContent=message;statusNode.classList.toggle('error',error);}
async function api(path, options={}){
 const headers={...(options.body && typeof options.body==='string'?{'Content-Type':'application/json'}:{}),...(options.headers||{})};
 const res=await fetch('/api/members'+path,{credentials:'same-origin',cache:'no-store',...options,headers});
 let data;try{data=await res.json();}catch{throw new Error('服务器暂时无法返回数据，请稍后再试。');}
 if(!res.ok)throw new Error(data.error||`请求失败 ${res.status}`);
 return data;
}
function readableLanguage(text){const m=/^([^()]+?)(?: \((.+)\))?$/.exec(text);if(!m)return text;const base=m[1].trim();return (zh[base]||base)+(m[2]?' · '+m[2]:'')+'（'+text+'）';}
function setBalance(value){const number=Number(value);const txt=Number.isFinite(number)?number.toFixed(2):'—';$('#memberBalance').textContent=txt;$('#asideBalance').textContent=txt;}
function previewCost(){if(!config||!Number.isFinite(localDuration)||localDuration<=0||localDuration>1800)return null;return (Math.ceil(localDuration)*Number(config.pointsPerSecond)).toFixed(2);}
function setModePrice(){const price=previewCost();$('#price').textContent=price===null?'待检测时长':price;$('#durationInfo').textContent=price===null?'上传视频后自动估算；最终费用以服务器检测为准':`原片 ${localDuration.toFixed(2)} 秒，计费 ${Math.ceil(localDuration)} 秒 × 0.65 积分`;}

function newId(){if(globalThis.crypto?.randomUUID)return crypto.randomUUID();const a=new Uint8Array(16);crypto.getRandomValues(a);a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;return Array.from(a,(v,i)=>([4,6,8,10].includes(i)?'-':'')+v.toString(16).padStart(2,'0')).join('');}
function renderLanguageOptions(data){
 const select=$('#language');select.replaceChildren();
 const priority=['English','Korean','Japanese','Spanish','French','German','Thai','Vietnamese','Arabic','Chinese (Mandarin, Simplified)'];
 const langs=data.languages.slice().sort((a,b)=>{const x=priority.indexOf(a),y=priority.indexOf(b);return (x<0?999:x)-(y<0?999:y)||a.localeCompare(b,'en');});
 const available=Array.isArray(data.availableOnPlan)?new Set(data.availableOnPlan):null;
 for(const label of langs){const o=document.createElement('option');o.value=label;o.disabled=!!(available&&!available.has(label));o.textContent=readableLanguage(label)+(o.disabled?' · 当前不可用':'');select.append(o);}
 select.value=available&&available.has('English')?'English':langs.find(l=>!available||available.has(l))||'';
 $('#languageHint').textContent=`共 ${langs.length} 个语种及地区口音选项`+(available?`，当前套餐可使用 ${langs.filter(l=>available.has(l)).length} 个`:'');
}
async function loadConfig(){
 const member=await api('/me');if(!member.loggedIn){location.replace('/members.html?next=%2Fmember-studio.html');return;}
 config=await api('/video-config');renderLanguageOptions(config);setBalance(config.balance);setModePrice();$('#submitBtn').disabled=false;
}
function addText(parent,tag,text,className){const n=document.createElement(tag);n.textContent=String(text??'');if(className)n.className=className;parent.append(n);return n;}
const jobState={submitting:'正在提交',submitted:'已提交',processing:'正在翻译',completed:'已完成',refunded:'失败 · 已退还积分',failed:'失败'};
function renderJobs(jobs){
 const root=$('#worksList');root.replaceChildren();
 if(!jobs.length){addText(root,'p','还没有作品，上传一个旅游视频开始吧！','explain');return;}
 for(const j of jobs){
  const card=document.createElement('article');card.className='work';const detail=addText(card,'div','','work-details');
  addText(detail,'strong',j.name||'旅游视频');
  addText(detail,'small',`${readableLanguage(j.language)} · ${new Date(j.created_at).toLocaleString('zh-CN')} · ${j.cost_points}积分`);
  addText(detail,'span',jobState[j.status]||j.status,'work-status');
  if(j.failure_message)addText(detail,'small',j.failure_message);
  const links=addText(card,'div','','work-links');
  if(j.status==='completed'){
   for(const [url,title] of [[j.video_url,'下载成片'],[j.caption_url,'下载字幕']]){
    if(typeof url==='string'&&url.startsWith('https://')){const a=document.createElement('a');a.href=url;a.textContent=title;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}
   }
  }
  root.append(card);
 }
}
async function updateJobs({poll=true}={}){
 const data=await api('/video-jobs');renderJobs(data.jobs||[]);
 const waiting=(data.jobs||[]).filter(j=>['submitting','submitted','processing'].includes(j.status)).slice(0,5);
 if(poll&&waiting.length){for(const j of waiting){try{await api('/video-jobs/'+encodeURIComponent(j.id));}catch(e){/* keep current progress without exposing provider errors */}}
 const next=await api('/video-jobs');renderJobs(next.jobs||[]);}
}
function resetRequest(){requestId=null;}
async function submit(){
 if(busy)return;
 if(!config){say('语言与会员数据尚未加载完成。',true);return;}
 if(!$('#consent').checked){say('请确认拥有视频、出镜者肖像及声音的授权。',true);return;}
 const language=$('#language').value,mode=$('#mode').value;
 if(!language){say('请选择可用目标语种。',true);return;}
 const price=previewCost();if(price===null){say('请先上传能够检测时长的视频（不超过30分钟）。',true);return;}
 if(Number(config.balance)<Number(price)){say(`积分不足，本次预计需要 ${price} 积分。请先到积分中心申请。`,true);return;}
 busy=true;$('#submitBtn').disabled=true;
 let fields={clientRequestId:requestId||newId(),language,mode,enableCaption:$('#captions').checked};
 requestId=fields.clientRequestId;
 try{
  if(tab==='file'){
   if(!activeFile)throw new Error('请先选择一个视频文件。');
   if(activeFile.size>32*1024*1024)throw new Error('文件超过32MB，请先压缩后再上传。');
   if(!['video/mp4','video/webm'].includes(activeFile.type))throw new Error('请上传MP4或WEBM格式视频。');
   say('正在上传视频，请保持页面打开…');
   const result=await api('/video-assets',{method:'POST',headers:{'Content-Type':activeFile.type},body:activeFile});
   fields.assetId=result.assetId;fields.name=activeFile.name.slice(0,120);
   if(result.costPoints)$('#price').textContent=Number(result.costPoints).toFixed(2);
  }else{
   const link=$('#videoUrl').value.trim();if(!link.startsWith('https://'))throw new Error('请输入HTTPS视频直链。');
   fields.videoUrl=link;fields.name='在线视频';
  }
  say('服务器已核实视频时长，正在按0.65积分/秒计费并提交任务…');
  const result=await api('/video-jobs',{method:'POST',body:JSON.stringify(fields)});
  say(result.duplicate?'任务已提交，请勿重复点击。':'提交成功！系统正在处理，你可以稍后在“我的作品”查看结果。');
  requestId=null;
  config.balance=Number(config.balance)-(result.duplicate?0:Number(result.costPoints||price));setBalance(config.balance);
  await updateJobs({poll:false});
  $('#myWorks').scrollIntoView({behavior:'smooth'});
 }catch(e){say(e.message||'提交失败，请重试。',true);try{await loadConfig();}catch{}}
 finally{busy=false;$('#submitBtn').disabled=false;}
}
for(const btn of document.querySelectorAll('.tabs button'))btn.addEventListener('click',()=>{
 if(btn.disabled)return;tab=btn.dataset.tab;document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b===btn));
 $('#fileArea').classList.toggle('hidden',tab!=='file');$('#urlArea').classList.toggle('hidden',tab!=='url');resetRequest();
});
$('#videoFile').addEventListener('change',e=>{
 const file=e.target.files?.[0];if(!file)return;activeFile=file;localDuration=null;resetRequest();setModePrice();
 $('#fileTitle').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(1)}MB`;
 const player=$('#preview');if(player.dataset.blob)URL.revokeObjectURL(player.dataset.blob);
 player.dataset.blob=URL.createObjectURL(file);player.src=player.dataset.blob;player.classList.remove('hidden');
 player.onloadedmetadata=()=>{localDuration=Number.isFinite(player.duration)?player.duration:null;setModePrice();};
 player.onerror=()=>{localDuration=null;setModePrice();say('视频无法读取，请转成标准MP4或WEBM格式。',true);};
});
$('#videoUrl').addEventListener('input',resetRequest);$('#mode').addEventListener('change',()=>{setModePrice();resetRequest();});
$('#language').addEventListener('change',resetRequest);$('#captions').addEventListener('change',resetRequest);
$('#submitBtn').addEventListener('click',submit);
$('#refreshJobs').addEventListener('click',async()=>{try{say('刷新作品进度中…');await updateJobs();const latest=await api('/video-config');config=latest;setBalance(latest.balance);say('作品与积分已刷新。');}catch(e){say(e.message,true);}});
(async()=>{try{await loadConfig();await updateJobs();refreshTimer=setInterval(async()=>{try{if(document.visibilityState==='visible')await updateJobs();}catch{}},30000);}catch(e){say(e.message,true);}})();
})();
