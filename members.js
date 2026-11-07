(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let mode = 'login';
  const status = (message, type = '') => {
    const el = $('#status');
    el.textContent = message;
    el.className = 'status ' + type;
  };
  async function request(path, options = {}) {
    const response = await fetch('/api/members' + path, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('服务响应异常，请稍后刷新页面。'); }
    if (!response.ok) throw new Error(data.error || '操作失败：' + response.status);
    return data;
  }
  function setMode(value) {
    mode = value;
    $('#tabLogin').classList.toggle('active', value === 'login');
    $('#tabSignup').classList.toggle('active', value === 'signup');
    $('#nameField').classList.toggle('hidden', value !== 'signup');
    $('#name').required = value === 'signup';
    $('#password').autocomplete = value === 'signup' ? 'new-password' : 'current-password';
    $('#submit').textContent = value === 'signup' ? '创建会员账号' : '会员登录';
    status('');
  }
  function showUser(user) {
    const signedIn = !!user;
    $('#signedInArea').classList.toggle('hidden', !signedIn);
    $('#signedOutArea').classList.toggle('hidden', signedIn);
    if (user) {
      $('#profileEmail').textContent = user.email || '';
      $('#profileName').textContent = user.name || '';
      $('#profileId').textContent = user.id || '';
    }
  }
  const orderState = {pending:'等待审核',approved:'已通过（积分到账）',rejected:'未通过'};
  const formatDate = value => value ? new Date(value).toLocaleString('zh-CN') : '';
  function appendLine(container, title, subtext, details) {
    const line = document.createElement('div');
    line.className = 'credit-record';
    const head = document.createElement('strong');head.textContent = title;
    const sub = document.createElement('small');sub.textContent = subtext;
    const desc = document.createElement('span');desc.textContent = details;
    line.append(head,sub,desc);container.append(line);
  }
  async function refreshCredits() {
    const data = await request('/credits');
    $('#creditBalance').textContent = data.balance + ' 点';
    const orders = $('#creditOrders'),ledger = $('#creditLedger');
    orders.replaceChildren();ledger.replaceChildren();
    if (!data.orders.length) {
      const p=document.createElement('p');p.className='credit-empty';p.textContent='还没有积分申请。';orders.append(p);
    } else {
      for(const order of data.orders){
        appendLine(orders, order.requested_points + ' 点 · ' + (orderState[order.status]||'未知状态'), formatDate(order.created_at), order.remark || '无备注');
      }
    }
    if (!data.ledger.length) {
      const p=document.createElement('p');p.className='credit-empty';p.textContent='还没有积分变动。';ledger.append(p);
    } else {
      for(const event of data.ledger){
        appendLine(ledger, (event.delta>0?'+':'') + event.delta + ' 点 · 余额 ' + event.balance_after, formatDate(event.created_at), event.note || '积分调整');
      }
    }
    return data;
  }
  async function refresh() {
    const res = await request('/me');
    showUser(res.user);
    if (res.user) {
      try { await refreshCredits(); } catch(e) { $('#creditStatus').textContent = e.message; }
    }
    return res.user;
  }
  $('#creditForm').addEventListener('submit',async event => {
    event.preventDefault();
    const btn=$('#creditSubmit');btn.disabled=true;
    try {
      const points=Number($('#creditPoints').value);
      if(!Number.isInteger(points)||points<1||points>100000)throw new Error('请输入1至100000的整数积分。');
      await request('/credit-orders',{
        method:'POST',body:JSON.stringify({points,remark:$('#creditRemark').value.trim()})
      });
      $('#creditStatus').textContent='申请成功，待管理员审核；没有产生付款。';
      $('#creditRemark').value='';
      await refreshCredits();
    } catch(e){$('#creditStatus').textContent=e.message || '提交失败。';}
    finally{btn.disabled=false;}
  });
  $('#creditRefresh').addEventListener('click',async () => {
    try{await refreshCredits();$('#creditStatus').textContent='已刷新余额与订单。';}
    catch(e){$('#creditStatus').textContent=e.message;}
  });
  $('#togglePassword').addEventListener('click',()=>{
    const input=$('#password'), visible=input.type==='password';
    input.type=visible?'text':'password';
    $('#togglePassword').setAttribute('aria-label',visible?'隐藏密码':'显示密码');
    $('#togglePassword').setAttribute('aria-pressed',String(visible));
    $('#togglePassword').classList.toggle('visible',visible);
  });
  $('#tabLogin').addEventListener('click', () => setMode('login'));
  $('#tabSignup').addEventListener('click', () => setMode('signup'));
  $('#authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const btn = $('#submit');
    btn.disabled = true;
    try {
      const details = { email: $('#email').value.trim(), password: $('#password').value };
      if (mode === 'signup') details.name = $('#name').value.trim();
      const response = await request(mode === 'signup' ? '/signup' : '/login', { method: 'POST', body: JSON.stringify(details) });
      $('#password').value = '';
      const current = await refresh();
      if (!current || current.id !== response.user?.id) throw new Error('登录后未读取到同一用户，请检查会话设置。');
      status(mode === 'signup' ? '注册成功，欢迎开始创作。' : '登录成功，欢迎回来。', 'success');
      const next = new URLSearchParams(location.search).get('next');
      if(next === '/member-studio.html') location.assign(next);
    } catch (error) {
      status(error.message || '操作失败，请重试。', 'error');
    } finally { btn.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => {
    try { await request('/logout', { method: 'POST', body: JSON.stringify({}) }); await refresh(); status('已安全退出会员账户。', 'success'); }
    catch (error) { status(error.message, 'error'); }
  });
  (async () => {
    try {
      const state = await request('/status');
      if (!state.configured) {
        status('网站还没连接 Neon 数据库。请先在 Render 配置 DATABASE_URL。', 'error');
        $('#submit').disabled = true;
        return;
      }
      const current = await refresh();
      if (!current) status('请输入会员邮箱和密码登录。');
      else if(new URLSearchParams(location.search).get('next')==='/member-studio.html') location.replace('/member-studio.html');
    } catch (error) { status(error.message, 'error'); }
  })();
})();
