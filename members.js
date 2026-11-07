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
  async function refresh() {
    const res = await request('/me');
    showUser(res.user);
    return res.user;
  }
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
      status(mode === 'signup' ? '注册成功，并已读取当前用户。邮箱验证尚未启用。' : '登录成功，并已读取当前用户。', 'success');
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
      if (!current) status('会员服务已连接，可以测试注册和登录。');
    } catch (error) { status(error.message, 'error'); }
  })();
})();
