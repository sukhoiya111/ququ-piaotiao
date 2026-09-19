// 批条 · 悬浮手机面板（远程托管 dist/phone_panel.js，由卡内运行时加载器 fetch+eval 拉起）
//
// 职责（design-brief §9）：悬浮入口 + 手机桌面四应用（微信/联系人/关系网/备忘录）
// 架构铁律：
//   - 只读渲染：所有数据来自 MVU stat_data 投影，本脚本不写正文链字段
//   - 玩家微信回复：以「回复<名字>：<内容>」写入 phone 子树并打 dm_pending 标记，
//     NPC 回信由 dm_generator.js 产出（本脚本不直接生成）
//   - 监听 VARIABLE_UPDATE_ENDED（注册晚于账房 → 每次结算后重渲染）
//   - 军规 2：任何异常 toastr/console 留痕，不静默吞错
//   - 军规 6：零 CDN、无 ES Module、自托管浮动 DOM（body 直挂，swipe 不丢）+ 内联轮询自愈
// 主题：体制灰蓝 + 公章红 + 监控绿
(function () {
  'use strict';
  const TAG = '[批条·手机]';
  if (window.__PiaotiaoPhonePanel) { console.info(TAG, '已挂载，跳过重复初始化'); return; }

  const COLORS = {
    bg: '#1f2731', panel: '#26303d', header: '#2b3a4a', line: '#33414f',
    text: '#cfd8e3', dim: '#8fa1b3', red: '#c0392b', green: '#2ecc71', blue: '#4a7ba6',
    mine: '#3a5a7a', theirs: '#33414f',
  };

  // ---------- 工具 ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = (v) => (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v);
  function reportError(msg, err) {
    console.error(TAG, msg, err);
    try { toastr.error(String(msg) + (err ? '：' + (err.message || err) : ''), '批条 · 手机'); } catch (e) { /* console 已留证 */ }
  }
  function reportInfo(msg) { console.info(TAG, msg); }

  // ---------- 数据读取（只读投影） ----------
  async function readStat() {
    const Mvu = window.Mvu;
    if (!Mvu) throw new Error('Mvu 未就绪');
    const data = await Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    return (data && data.stat_data) || null;
  }

  // ---------- DOM ----------
  // 2026-09-19 真机教训：面板与启动器不能同容器——renderLauncher 的 innerHTML 重写会
  // 把面板连根拔掉。拆成两个宿主：launcherRoot（启动器）与 panelHostRoot（面板）。
  let root = null;        // 启动器宿主
  let panelHostRoot = null; // 面板宿主
  let panelEl = null;
  let currentView = 'wechat';       // wechat | contacts | network | notes
  let currentConv = null;           // 打开的会话 id
  let pendingReplies = [];          // 当前会话的快捷回复

  function ensureHost() {
    const host = window.parent && window.parent.document ? window.parent.document : document;
    if (!root || !host.body || !host.body.contains(root)) {
      host.getElementById('piaotiao-phone-root')?.remove();
      root = host.createElement('div');
      root.id = 'piaotiao-phone-root';
      root.style.cssText = 'position:fixed;right:16px;bottom:90px;z-index:9998;font-family:"Microsoft YaHei",system-ui,sans-serif;';
      root.addEventListener('click', onRootClick);
      (host.body || document.body).appendChild(root);
    }
    if (!panelHostRoot || !host.body.contains(panelHostRoot)) {
      host.getElementById('piaotiao-phone-panel-root')?.remove();
      panelHostRoot = host.createElement('div');
      panelHostRoot.id = 'piaotiao-phone-panel-root';
      panelHostRoot.style.cssText = 'position:fixed;right:80px;bottom:90px;z-index:9999;font-family:"Microsoft YaHei",system-ui,sans-serif;';
      panelHostRoot.addEventListener('click', onRootClick);
      panelHostRoot.addEventListener('keydown', onRootKeydown);
      // Key 框 readonly 到聚焦才解锁：安卓 autofill 只认这招（参考卡实测），focusin 才能冒泡
      panelHostRoot.addEventListener('focusin', (e) => {
        if (e.target && e.target.id === 'piaotiao-cfg-key') e.target.removeAttribute('readonly');
      });
      (host.body || document.body).appendChild(panelHostRoot);
    }
    renderLauncher();
    return host;
  }

  let lastStat = null; // 委托处理器用的最近一次账本快照

  function onRootClick(e) {
    const t = e.target.closest ? e.target : e.target.parentElement;
    if (!t) return;
    if (t.closest('#piaotiao-phone-btn')) { panelEl && panelEl.style.display !== 'none' ? closePanel() : openPanel(); return; }
    if (!panelEl) return;
    if (t.closest('#piaotiao-close')) { closePanel(); return; }
    const tab = t.closest('[data-tab]');
    if (tab) { currentView = tab.getAttribute('data-tab'); currentConv = null; render(); return; }
    const conv = t.closest('[data-conv]');
    if (conv) { currentConv = conv.getAttribute('data-conv'); render(); return; }
    if (t.closest('#piaotiao-back')) { currentConv = null; render(); return; }
    const quick = t.closest('[data-quick]');
    if (quick && lastStat) { const i = Number(quick.getAttribute('data-quick')); if (pendingReplies[i]) sendReply(lastStat, pendingReplies[i]); return; }
    if (t.closest('#piaotiao-send') && lastStat) {
      const input = panelEl.querySelector('#piaotiao-input');
      const text = input ? input.value.trim() : '';
      if (text) { if (input) input.value = ''; sendReply(lastStat, text); }
      return;
    }
    if (t.closest('#piaotiao-cfg-fetch')) { onCfgFetch(); return; }
    if (t.closest('#piaotiao-cfg-save')) { onCfgSave(); return; }
    if (t.closest('#piaotiao-cfg-clear')) { onCfgClear(); return; }
  }
  function onRootKeydown(e) {
    if (e.key !== 'Enter') return;
    const input = e.target && e.target.id === 'piaotiao-input' ? e.target : null;
    if (input && lastStat) {
      const text = input.value.trim();
      if (text) { input.value = ''; sendReply(lastStat, text); }
    }
  }

  function renderLauncher() {
    const unread = window.__piaotiaoUnread || 0;
    root.innerHTML =
      '<div id="piaotiao-phone-btn" title="批条 · 手机" style="cursor:pointer;width:52px;height:52px;border-radius:14px;' +
      'background:' + COLORS.header + ';border:1px solid ' + COLORS.line + ';box-shadow:0 4px 14px rgba(0,0,0,.45);' +
      'display:flex;align-items:center;justify-content:center;position:relative;">' +
      '<span style="font-size:24px;">📱</span>' +
      (unread > 0 ? '<span style="position:absolute;top:-6px;right:-6px;background:' + COLORS.red + ';color:#fff;font-size:11px;' +
        'min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;">' + unread + '</span>' : '') +
      '</div>';
  }

  function openPanel() {
    try {
      const host = ensureHost();
      if (!panelEl) {
        panelEl = host.createElement('div');
        panelEl.id = 'piaotiao-phone-panel';
        panelEl.style.cssText = 'width:340px;height:560px;background:' + COLORS.bg +
          ';border:1px solid ' + COLORS.line + ';border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.55);' +
          'display:flex;flex-direction:column;overflow:hidden;color:' + COLORS.text + ';';
        panelHostRoot.appendChild(panelEl);
      }
      panelEl.style.display = 'flex';
      render();
    } catch (e) { reportError('面板打开失败', e); }
  }
  function closePanel() { if (panelEl) panelEl.style.display = 'none'; }

  // ---------- 渲染 ----------
  async function render() {
    if (!panelEl || panelEl.style.display === 'none') return;
    try {
      const stat = await readStat();
      if (!stat) { panelEl.innerHTML = '<div style="padding:20px;color:' + COLORS.dim + '">账本尚未初始化</div>'; return; }
      lastStat = stat;
      const tabs = ['wechat', 'contacts', 'network', 'notes', 'settings'];
      const tabNames = { wechat: '微信', contacts: '联系人', network: '关系网', notes: '备忘录', settings: '设置' };
      let body = '';
      if (currentView === 'wechat') body = await viewWechat(stat);
      else if (currentView === 'contacts') body = viewContacts(stat);
      else if (currentView === 'network') body = viewNetwork(stat);
      else if (currentView === 'notes') body = viewNotes(stat);
      else if (currentView === 'settings') body = viewSettings(stat);
      panelEl.innerHTML =
        '<div style="background:' + COLORS.header + ';padding:10px 14px;font-size:15px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>批条 · 这事，能办。</span><span id="piaotiao-close" style="cursor:pointer;color:' + COLORS.dim + ';font-size:13px;">收起</span></div>' +
        '<div style="display:flex;border-bottom:1px solid ' + COLORS.line + ';">' +
        tabs.map((t) => '<div data-tab="' + t + '" style="flex:1;text-align:center;padding:8px 0;cursor:pointer;font-size:13px;' +
          (currentView === t ? 'color:' + COLORS.green + ';border-bottom:2px solid ' + COLORS.green + ';' : 'color:' + COLORS.dim + ';') + '">' + tabNames[t] + '</div>').join('') +
        '</div>' +
        '<div id="piaotiao-body" style="flex:1;overflow-y:auto;">' + body + '</div>';
    } catch (e) { reportError('渲染失败', e); }
  }

  // ---------- 设置（私信 API；UI 照抄参考卡《Sugar Daddy Simulator》设置页，含其防密码管理器处理） ----------
  const DM_API_KEY_STORAGE = 'piaotiao_dm_api';
  function readDmApiConfig() {
    try { return JSON.parse(localStorage.getItem(DM_API_KEY_STORAGE) || '{}'); } catch (e) { return {}; }
  }
  function saveDmApiConfig(cfg) {
    try { localStorage.setItem(DM_API_KEY_STORAGE, JSON.stringify(cfg || {})); } catch (e) { reportError('设置保存失败', e); }
  }
  function ensureMaskCss() {
    // Key 遮罩：不用 type=password（会勾出安卓密码管理器，参考卡实测玩家投诉），用 CSS 圆点（Firefox 不支持就明文，自己的 key 无妨）
    const host = window.parent && window.parent.document ? window.parent.document : document;
    if (host.getElementById('piaotiao-mask-css')) return;
    const st = host.createElement('style');
    st.id = 'piaotiao-mask-css';
    st.textContent = '#piaotiao-phone-panel input.piao-mask{-webkit-text-security:disc;}';
    host.head.appendChild(st);
  }

  function viewSettings(stat) {
    ensureMaskCss();
    const cfg = readDmApiConfig();
    const attrs = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"';
    return '<div style="background:' + COLORS.header + ';padding:9px 14px;font-size:13px;"><b>手机设置</b> <span style="color:' + COLORS.dim + ';font-size:11px;">independent API</span></div>' +
      '<div style="padding-top:16px;">' +
      '<div style="padding:0 14px 10px;"><label style="font-size:12px;color:' + COLORS.dim + ';display:block;margin-bottom:4px;">API 地址（OpenAI 兼容）</label>' +
      '<textarea id="piaotiao-cfg-url" rows="1" ' + attrs + ' data-lpignore="true" data-1p-ignore placeholder="https://api.xxx.com/v1" style="width:100%;box-sizing:border-box;background:' + COLORS.panel + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:8px;padding:7px 9px;font-size:12px;outline:none;resize:none;">' + esc(cfg.url || '') + '</textarea></div>' +
      // type=password 会勾出安卓输入法的密码管理器（参考卡实测玩家投诉）——text + CSS 圆点遮罩 + 密码管理器忽略标记 + readonly 到聚焦
      '<div style="padding:0 14px 10px;"><label style="font-size:12px;color:' + COLORS.dim + ';display:block;margin-bottom:4px;">API Key</label>' +
      '<input id="piaotiao-cfg-key" type="text" class="piao-mask" ' + attrs + ' readonly data-lpignore="true" data-1p-ignore data-form-type="other" placeholder="sk-..." value="' + esc(cfg.key || '') + '" style="width:100%;box-sizing:border-box;background:' + COLORS.panel + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:8px;padding:7px 9px;font-size:12px;outline:none;" /></div>' +
      '<div style="padding:0 14px 10px;"><label style="font-size:12px;color:' + COLORS.dim + ';display:block;margin-bottom:4px;">模型名（🔄 拉取后下面出下拉可选）</label>' +
      '<input id="piaotiao-cfg-model" list="piaotiao-cfg-models" ' + attrs + ' placeholder="deepseek-chat" value="' + esc(cfg.model || '') + '" style="width:100%;box-sizing:border-box;background:' + COLORS.panel + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:8px;padding:7px 9px;font-size:12px;outline:none;" />' +
      '<datalist id="piaotiao-cfg-models"></datalist>' +
      '<select id="piaotiao-cfg-modelsel" style="display:none;margin-top:6px;border:1px solid ' + COLORS.line + ';border-radius:8px;padding:7px 10px;font-size:12px;background:' + COLORS.panel + ';color:' + COLORS.text + ';width:100%;"></select></div>' +
      '<div style="display:flex;gap:8px;margin:4px 14px 10px;">' +
      '<button id="piaotiao-cfg-fetch" style="flex:1;background:' + COLORS.header + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:8px;padding:8px;cursor:pointer;font-size:12px;">🔄 拉取模型</button>' +
      '<button id="piaotiao-cfg-save" style="flex:1;background:' + COLORS.green + ';border:none;color:#123;border-radius:8px;padding:8px;cursor:pointer;font-size:12px;font-weight:bold;">💾 保存</button>' +
      '<button id="piaotiao-cfg-clear" style="flex:1;background:' + COLORS.red + ';border:none;color:#fff;border-radius:8px;padding:8px;cursor:pointer;font-size:12px;">🗑️ 清除</button></div>' +
      '<div style="font-style:normal;text-align:left;padding:4px 16px;font-size:12px;color:' + COLORS.red + ';">此处谨慎使用公益站 api，容易被误封。</div>' +
      '<div style="font-style:normal;text-align:left;padding:4px 16px;font-size:12px;color:' + COLORS.dim + ';">填了独立 API 后，私信生成不占聊天 API。Key 只存这台浏览器本地，不进聊天文件。🔄 拉取模型兼做连通性测试：拉得到 = 地址/Key/CORS 都通。</div>' +
      '</div>';
  }

  // 设置页三个按钮 + 模型下拉（逻辑照抄参考卡）
  async function onCfgFetch() {
    const panelEl = document.getElementById('piaotiao-phone-panel');
    if (!panelEl) return;
    const u = panelEl.querySelector('#piaotiao-cfg-url').value.trim();
    const k = panelEl.querySelector('#piaotiao-cfg-key').value.trim();
    if (!u || !k) { try { toastr.warning('先填 API 地址和 Key'); } catch (e) {} return; }
    const fbtn = panelEl.querySelector('#piaotiao-cfg-fetch');
    fbtn.textContent = '⏳ 拉取中…';
    try {
      let mu = u.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      mu = /\/v\d+$/.test(mu) ? mu + '/models' : mu + '/v1/models';
      const resp = await fetch(mu, { headers: { 'Authorization': 'Bearer ' + k } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      const ids = (j.data || j.models || []).map((m) => (m && (m.id || m.name)) || m).filter((x) => typeof x === 'string');
      if (!ids.length) throw new Error('返回里没有模型列表');
      panelEl.querySelector('#piaotiao-cfg-models').innerHTML = ids.map((id) => '<option value="' + esc(id) + '">').join('');
      // 安卓不支持 datalist → 同时给一个真 <select>（选中自动填进输入框）
      const sel = panelEl.querySelector('#piaotiao-cfg-modelsel');
      sel.innerHTML = '<option value="">— 从 ' + ids.length + ' 个模型里选 —</option>' + ids.map((id) => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('');
      sel.style.display = 'block';
      sel.onchange = function () { if (sel.value) panelEl.querySelector('#piaotiao-cfg-model').value = sel.value; };
      const mi = panelEl.querySelector('#piaotiao-cfg-model');
      if (!mi.value.trim()) mi.value = ids[0];
      try { toastr.success('📡 拉到 ' + ids.length + ' 个模型——连通性OK，选一个再保存'); } catch (e) {}
      fbtn.textContent = '🔄 拉取模型 (' + ids.length + ')';
    } catch (e) {
      try { toastr.error('拉取失败: ' + ((e && e.message) || e) + '。多半是地址不对 / Key 无效 / 该服务不允许浏览器直连(CORS)'); } catch (e2) {}
      fbtn.textContent = '🔄 拉取模型';
    }
  }
  function onCfgSave() {
    const panelEl = document.getElementById('piaotiao-phone-panel');
    if (!panelEl) return;
    const c = {
      url: panelEl.querySelector('#piaotiao-cfg-url').value.trim(),
      key: panelEl.querySelector('#piaotiao-cfg-key').value.trim(),
      model: panelEl.querySelector('#piaotiao-cfg-model').value.trim(),
    };
    saveDmApiConfig(c);
    try { toastr.success(c.url && c.key ? '🔌 独立API已启用' : '已保存'); } catch (e) {}
    render();
  }
  function onCfgClear() {
    try { localStorage.removeItem(DM_API_KEY_STORAGE); } catch (e) {}
    try { toastr.info('已清除，私信不生成（需重新配置独立API）'); } catch (e) {}
    render();
  }

  // ---------- 微信 ----------
  async function viewWechat(stat) {
    const convs = stat.phone?.wechat_conversations || {};
    const msgs = stat.phone?.wechat_messages || {};
    if (currentConv) return wechatThread(stat, currentConv, msgs[currentConv]);
    const ids = Object.keys(convs);
    if (!ids.length) return '<div style="padding:24px;color:' + COLORS.dim + ';text-align:center;">暂无会话<br><span style="font-size:12px;">剧情里的微信往来会出现在这里</span></div>';
    return ids.map((id) => {
      const c = convs[id];
      const name = convName(stat, id);
      const unread = val(c.unread) || 0;
      return '<div data-conv="' + esc(id) + '" style="padding:12px 14px;border-bottom:1px solid ' + COLORS.line + ';cursor:pointer;display:flex;justify-content:space-between;align-items:center;">' +
        '<div><div style="font-size:14px;">' + esc(name) + '</div>' +
        '<div style="font-size:12px;color:' + COLORS.dim + ';margin-top:3px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(val(c.last_summary) || '') + '</div></div>' +
        (unread > 0 ? '<span style="background:' + COLORS.red + ';color:#fff;border-radius:10px;min-width:18px;text-align:center;font-size:11px;padding:2px 5px;">' + unread + '</span>' : '') +
        '</div>';
    }).join('');
  }

  function convName(stat, id) {
    const convs = stat.phone?.wechat_conversations || {};
    const c = convs[id] || {};
    if (c.name) return val(c.name);
    if (id === 'chen_guobang') return '陈国邦';
    const contact = (stat.contacts || {})[id];
    if (contact) return val(contact.name) || id;
    const fam = (stat.families || {})[id];
    if (fam) return val(fam.name) + '家';
    return id;
  }

  function wechatThread(stat, convId, box) {
    const list = (box && Array.isArray(val(box.messages))) ? val(box.messages) : [];
    const conv = (stat.phone?.wechat_conversations || {})[convId] || {};
    pendingReplies = Array.isArray(val(conv.suggested_replies)) ? val(conv.suggested_replies) : [];
    const name = convName(stat, convId);
    const items = list.map((m) => {
      const mine = val(m.from) === 'player';
      return '<div style="display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') + ';padding:5px 12px;">' +
        '<div style="max-width:75%;background:' + (mine ? COLORS.mine : COLORS.theirs) + ';border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.5;">' +
        esc(val(m.text)) + '</div></div>';
    }).join('');
    const quick = pendingReplies.length
      ? '<div style="padding:6px 10px;display:flex;flex-wrap:wrap;gap:6px;">' + pendingReplies.map((r, i) =>
        '<span data-quick="' + i + '" style="cursor:pointer;border:1px solid ' + COLORS.blue + ';color:' + COLORS.text + ';border-radius:12px;padding:4px 10px;font-size:12px;">' + esc(r) + '</span>').join('') + '</div>'
      : '';
    return '<div style="background:' + COLORS.header + ';padding:9px 14px;font-size:13px;cursor:pointer;" id="piaotiao-back">← ' + esc(name) + '</div>' +
      '<div style="padding:8px 0;">' + (items || '<div style="text-align:center;color:' + COLORS.dim + ';padding:20px;font-size:12px;">暂无消息</div>') + '</div>' +
      quick +
      '<div style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid ' + COLORS.line + ';">' +
      '<input id="piaotiao-input" placeholder="回复' + esc(name) + '…" style="flex:1;background:' + COLORS.panel + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:10px;padding:7px 10px;font-size:13px;outline:none;" />' +
      '<button id="piaotiao-send" style="background:' + COLORS.blue + ';border:none;color:#fff;border-radius:10px;padding:7px 14px;cursor:pointer;font-size:13px;">发送</button></div>';
  }

  // 玩家回复：只写 phone 子树（读-改-写最新 stat_data，防竞态），打 pending 标记给私信生成器
  async function sendReply(stat, text) {
    try {
      const Mvu = window.Mvu;
      const convId = currentConv;
      if (!convId || !text) return;
      const fresh = await Mvu.getMvuData({ type: 'message', message_id: 'latest' });
      const sd = fresh.stat_data;
      const box = (sd.phone.wechat_messages = sd.phone.wechat_messages || {});
      const entry = box[convId] = box[convId] || { messages: [] };
      const list = Array.isArray(val(entry.messages)) ? val(entry.messages) : (entry.messages = []);
      list.push({ from: 'player', text: String(text), floor: Number(getSafelyFloor()) || 0 });
      const convs = (sd.phone.wechat_conversations = sd.phone.wechat_conversations || {});
      const conv = convs[convId] = convs[convId] || { unread: 0, last_summary: '', suggested_replies: [] };
      conv.last_summary = '我：' + String(text).slice(0, 40);
      conv.suggested_replies = [];
      conv.dm_pending = true; // 私信生成器：玩家已回复，待产出 NPC 回信
      await Mvu.replaceMvuData(fresh, { type: 'message', message_id: 'latest' });
      // replaceMvuData 不触发 VUE → 踢一下私信生成器（同 iframe，kick 事件）
      try { (window.__piaotiaoDmKick || (() => window.dispatchEvent(new Event('piaotiao_dm_kick'))))(); } catch (e) { console.warn(TAG, '私信生成器踢取失败', e); }
      reportInfo('回复已入账：' + convId);
      render();
    } catch (e) { reportError('回复写入失败', e); }
  }
  function getSafelyFloor() {
    try { const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext(); return ctx ? ctx.chat.length : 0; } catch (e) { return 0; }
  }

  // ---------- 联系人 ----------
  function viewContacts(stat) {
    const contacts = stat.contacts || {};
    const ids = Object.keys(contacts);
    if (!ids.length) return '<div style="padding:24px;color:' + COLORS.dim + ';text-align:center;">关系网尚未展开</div>';
    return ids.map((id) => {
      const c = contacts[id];
      const status = val(c.status);
      const color = status === 'hostile' ? COLORS.red : status === 'active' ? COLORS.green : COLORS.dim;
      return '<div style="padding:12px 14px;border-bottom:1px solid ' + COLORS.line + ';">' +
        '<div style="display:flex;justify-content:space-between;"><span style="font-size:14px;">' + esc(val(c.name) || id) + '</span>' +
        '<span style="font-size:11px;color:' + color + ';">' + esc(val(c.attitude) || '') + '·' + esc(status) + '</span></div>' +
        '<div style="font-size:12px;color:' + COLORS.dim + ';margin-top:4px;">想要：' + esc(val(c.wants) || '—') + '</div>' +
        '<div style="font-size:12px;color:' + COLORS.dim + ';margin-top:2px;">能办：' + esc(val(c.can_provide) || '—') + '</div>' +
        '<div style="font-size:12px;margin-top:2px;">人情：<span style="color:' + COLORS.green + '">他欠我 ' + ((c.favors_owed || []).length) + '</span>' +
        ' / <span style="color:' + COLORS.red + '">我欠他 ' + ((c.favors_debt || []).length) + '</span>' +
        ' / 把柄 ' + ((c.leverage || []).length) + '（强度 ' + (val(c.leverage_strength) || 1) + '）</div>' +
        '</div>';
    }).join('');
  }

  // ---------- 关系网 ----------
  function viewNetwork(stat) {
    const contacts = stat.contacts || {};
    const ids = Object.keys(contacts);
    if (!ids.length) return '<div style="padding:24px;color:' + COLORS.dim + ';text-align:center;">暂无节点</div>';
    // 轻量布局：中心=我，节点按扇形排布（脚本布局，模型不参与）
    const W = 320, H = 380, cx = W / 2, cy = H / 2, R = 120;
    const nodes = ids.map((id, i) => {
      const c = contacts[id];
      const ang = (Math.PI * 2 * i) / ids.length - Math.PI / 2;
      return { id, name: val(c.name) || id, rel: Number(val(c.relationship)) || 0, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    });
    const lines = nodes.map((n) => {
      const color = n.rel >= 0 ? COLORS.green : COLORS.red;
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + n.x + '" y2="' + n.y + '" stroke="' + color + '" stroke-width="1.2" opacity="0.55" />';
    }).join('');
    const dots = nodes.map((n) =>
      '<circle cx="' + n.x + '" cy="' + n.y + '" r="22" fill="' + COLORS.panel + '" stroke="' + COLORS.blue + '" />' +
      '<text x="' + n.x + '" y="' + (n.y + 4) + '" text-anchor="middle" font-size="11" fill="' + COLORS.text + '">' + esc(n.name.slice(0, 4)) + '</text>').join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;">' + lines +
      '<circle cx="' + cx + '" cy="' + cy + '" r="30" fill="' + COLORS.mine + '" stroke="' + COLORS.green + '" />' +
      '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="12" fill="#fff">我</text>' + dots + '</svg>';
  }

  // ---------- 备忘录 ----------
  function viewNotes(stat) {
    const p = stat.player || {};
    const d = stat.derived || {};
    const row = (label, v, color) => '<div style="display:flex;justify-content:space-between;padding:9px 14px;border-bottom:1px solid ' + COLORS.line + ';">' +
      '<span style="color:' + COLORS.dim + ';">' + label + '</span><span style="color:' + (color || COLORS.text) + ';">' + esc(String(v)) + '</span></div>';
    const favors = Object.entries(stat.contacts || {}).map(([id, c]) => {
      const owed = (c.favors_owed || []).length, debt = (c.favors_debt || []).length;
      if (!owed && !debt) return '';
      return '<div style="padding:8px 14px;font-size:12px;border-bottom:1px solid ' + COLORS.line + ';">' + esc(val(c.name) || id) +
        '：<span style="color:' + COLORS.green + '">他欠我 ' + owed + '</span> / <span style="color:' + COLORS.red + '">我欠他 ' + debt + '</span></div>';
    }).join('');
    return '<div style="padding-top:4px;">' +
      row('影响力', val(p.influence) ?? 0) +
      row('资金', '¥ ' + Number(val(p.capital) ?? 0).toLocaleString('zh-CN')) +
      row('保护伞', val(p.protection) ?? 0) +
      row('暴露风险', (val(d.exposure_global) ?? 0) + ' / 100', (val(d.exposure_global) ?? 0) > 50 ? COLORS.red : COLORS.text) +
      row('人情余额', (val(d.favors_balance) ?? 0) + '（我欠 ' + (val(d.favors_debt_total) ?? 0) + '）') +
      row('关系网等级', val(d.network_level) ?? 0, COLORS.green) +
      '</div><div style="padding:10px 14px;color:' + COLORS.dim + ';font-size:12px;">人情账目</div>' + (favors || '<div style="padding:10px 14px;color:' + COLORS.dim + ';font-size:12px;">暂无往来</div>');
  }

  // ---------- 事件挂载与自愈 ----------
  async function onVariableUpdateEnded() {
    try {
      const stat = await readStat();
      let unread = 0;
      Object.values((stat && stat.phone && stat.phone.wechat_conversations) || {}).forEach((c) => { unread += Number(val(c.unread)) || 0; });
      window.__piaotiaoUnread = unread;
      if (root) renderLauncher();
      if (panelEl && panelEl.style.display !== 'none') await render();
    } catch (e) { reportError('刷新失败', e); }
  }

  function mount() {
    ensureHost();
    window.addEventListener('piaotiao_phone_refresh', () => { onVariableUpdateEnded(); });
    if (window.Mvu && window.Mvu.events && typeof eventOn === 'function') {
      eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED, onVariableUpdateEnded);
      reportInfo('已挂载：悬浮手机（微信/联系人/关系网/备忘录）');
      onVariableUpdateEnded();
    } else {
      // 内联轮询等待 Mvu（军规 6 范式），30s 上限
      let waited = 0;
      const timer = setInterval(() => {
        waited += 400;
        if ((window.Mvu && window.Mvu.events && typeof eventOn === 'function') || waited > 30000) {
          clearInterval(timer);
          if (waited <= 30000) mount();
          else reportError('Mvu 长时间未就绪，手机面板暂不可用（正文不受影响）');
        }
      }, 400);
    }
  }
  // swipe/换聊天等导致 body 重建时自愈（内联轮询，10s 一次）
  setInterval(() => {
    try {
      const host = window.parent && window.parent.document ? window.parent.document : document;
      if (!host.getElementById('piaotiao-phone-root') || !host.getElementById('piaotiao-phone-panel-root')) {
        root = null; panelHostRoot = null; ensureHost();
      }
    } catch (e) { /* 主文档未就绪时静默，下次轮询再试 */ }
  }, 10000);

  mount();
  window.__PiaotiaoPhonePanel = true;
})();
