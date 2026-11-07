(()=>{'use strict';
const screen=document.body.dataset.screen;
const $=s=>document.querySelector(s);
async function request(url,options={}){
 const response=await fetch('/api/'+url,{credentials:'same-origin',cache:'no-store',...options});
 let data;try{data=await response.json();}catch{throw new Error('服务器响应异常');}
 if(!response.ok)throw new Error(data.error||`操作失败（${response.status}）`);
 return data;
}
function el(tag,className,content){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=String(content);return node;}
async function initLogin(){
 try{const session=await request('session');if(session.loggedIn){location.replace('/admin-dashboard.html');return;}}catch{}
 $('#adminLoginForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('#loginButton');button.disabled=true;
  $('#loginStatus').textContent='正在登录…';
  try{await request('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#adminEmail').value,password:$('#adminPassword').value})});location.replace('/admin-dashboard.html');}
  catch(error){$('#loginStatus').textContent=error.message;button.disabled=false;}
 });
}
async function review(id,kind,button){
 if(!confirm(kind==='approve'?'确定批准此申请并发放积分？':'确定拒绝此积分申请？'))return;
 button.disabled=true;
 try{
  await request('admin/credit-orders/'+encodeURIComponent(id)+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  $('#adminStatus').textContent=kind==='approve'?'已批准并入账。':'已拒绝申请。';
  await loadOrders();
 }catch(e){$('#adminStatus').textContent=e.message;button.disabled=false;}
}
async function loadOrders(){
 const root=$('#pendingOrders');root.replaceChildren();
 try{
  const data=await request('admin/credit-orders');
  const all=Array.isArray(data.orders)?data.orders:[];
  const pending=all.filter(x=>x.status==='pending');
  $('#pendingCount').textContent=pending.length;$('#allCount').textContent=all.length;
  if(!pending.length){root.append(el('p','muted','目前没有待审核积分申请。'));return;}
  for(const order of pending){
   const card=el('article','order-card');card.append(el('div','order-main',`${order.display_name||order.email} · ${order.requested_points}积分`));
   card.append(el('p','order-meta',`${order.email} · ${new Date(order.created_at).toLocaleString('zh-CN')} · ${order.remark||'无备注'}`));
   const actions=el('div','actions');
   for(const o of [{kind:'approve',label:'批准发放',className:'approve'},{kind:'reject',label:'拒绝',className:'reject'}]){
    const btn=el('button',o.className,o.label);btn.type='button';btn.addEventListener('click',()=>review(order.id,o.kind,btn));actions.append(btn);
   }
   card.append(actions);root.append(card);
  }
 }catch(error){
  if(/请先.*登录|401/.test(error.message)){location.replace('/admin.html');return;}
  $('#adminStatus').textContent=error.message;
 }
}
async function initDashboard(){
 try{const s=await request('session');if(!s.loggedIn){location.replace('/admin.html');return;}}
 catch{location.replace('/admin.html');return;}
 $('#refreshPending').addEventListener('click',()=>{ $('#adminStatus').textContent='';loadOrders();});
 $('#adminLogout').addEventListener('click',async()=>{try{await request('logout',{method:'POST'});location.replace('/');}catch(e){$('#adminStatus').textContent=e.message;}});
 await loadOrders();
}
if(screen==='login')initLogin();else if(screen==='dashboard')initDashboard();
})();
