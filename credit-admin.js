(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const box=$('#adminOrders'),status=$('#adminStatus');
  const state = {pending:'等待审核',approved:'已批准',rejected:'已拒绝'};
  function say(message) { status.textContent=message; }
  async function call(url,method='GET') {
    const response=await fetch('/api/admin/'+url,{method,credentials:'same-origin',cache:'no-store',headers:method==='POST'?{'Content-Type':'application/json'}:undefined,body:method==='POST'?'{}':undefined});
    let payload;try{payload=await response.json();}catch{throw new Error('服务器返回异常');}
    if(!response.ok)throw new Error(payload.error||'请求失败');return payload;
  }
  function element(tag,cls,text) { const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n; }
  async function review(id,decision,btn) {
    if(!confirm(decision==='approve'?'确定批准并向该会员实际发放积分？':'确定拒绝这笔积分申请？'))return;
    btn.disabled=true;
    try{
      await call('credit-orders/'+encodeURIComponent(id)+'/'+decision,'POST');
      say(decision==='approve'?'批准成功，积分已记入会员账户。':'订单已拒绝。');
      await load();
    }catch(e){say(e.message);btn.disabled=false;}
  }
  async function load() {
    try {
      const data=await call('credit-orders');box.replaceChildren();
      if(!data.orders.length){box.append(element('p','credit-empty','暂无积分申请。'));say('已加载订单。');return;}
      for(const order of data.orders){
        const card=element('article','admin-entry');
        card.append(element('strong','',order.email+' · '+order.requested_points+' 点'));
        card.append(element('p','',(state[order.status]||order.status)+' · '+new Date(order.created_at).toLocaleString('zh-CN')));
        card.append(element('p','',order.remark||'无备注'));
        if(order.status==='pending'){
          const actions=element('div','admin-actions');
          for(const d of [{id:'approve',label:'批准发放',cls:'approve'},{id:'reject',label:'拒绝',cls:'reject'}]){
            const btn=element('button',d.cls,d.label);btn.type='button';btn.addEventListener('click',()=>review(order.id,d.id,btn));actions.append(btn);
          }
          card.append(actions);
        }
        box.append(card);
      }
      say('已读取最近 '+data.orders.length+' 笔订单。');
    }catch(e){say(e.message+' 可先返回原翻译工作台，以管理员账户登录。');}
  }
  $('#adminRefresh').addEventListener('click',load);load();
})();
