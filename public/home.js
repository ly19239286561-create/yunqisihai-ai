(()=>{'use strict';
const $=x=>document.querySelector(x);
const jobText={submitting:'正在提交',submitted:'已提交',processing:'翻译中',completed:'已完成',refunded:'已退还积分',failed:'失败'};
async function get(path){const r=await fetch(path,{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('暂不可用');return r.json();}
async function load(){
 try{
  const account=await get('/api/members/me');if(!account.loggedIn)return;
  $('#memberName').textContent=account.user.name||'我的会员账号';
  $('#memberHint').textContent='会员中心 · 点击查看账户';
  $('#balanceAction').textContent='积分中心';
  $('#balanceAction').href='/members.html#creditArea';
  $('#loginHeader').textContent='会员中心';
  try{const wallet=await get('/api/members/credits');$('#homeBalance').textContent=Number(wallet.balance||0).toFixed(2);}catch{}
  try{
   const results=await get('/api/members/video-jobs');const recent=(results.jobs||[]).slice(0,3);const container=$('#homeWorks');container.replaceChildren();
   if(!recent.length){const p=document.createElement('div');p.className='empty-works';p.textContent='还没有作品，点击“开始制作视频”创作第一条。';container.append(p);return;}
   for(const j of recent){
    const card=document.createElement('div');card.className='work-tile';
    const details=document.createElement('div'),name=document.createElement('strong'),desc=document.createElement('small');
    name.textContent=j.name||'视频翻译';desc.textContent=`${j.language} · ${jobText[j.status]||j.status} · ${j.cost_points}积分`;details.append(name,desc);
    const action=document.createElement('a');action.href='/member-studio.html#myWorks';action.textContent='查看 ›';card.append(details,action);container.append(card);
   }
  }catch{}
 }catch{}
}
load();
})();
