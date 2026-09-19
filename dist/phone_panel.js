// 批条 · 悬浮手机面板（远程托管 dist/phone_panel.js，由卡内运行时加载器 fetch+eval 拉起）
//
// 职责（design-brief §9）：悬浮入口 + 手机四应用（微信/联系人/关系网/备忘录）+ 设置页
// 机制照抄参考卡《Sugar Daddy Simulator》phone_panel（2026-09-19 拆解其线上脚本）：
//   - 发件箱：玩家回复先攒进待发队列（存聊天变量 phone._outbox，防重载/切聊天丢失），
//     主屏一个「确定发送」横条统一发出——支持同时给多人发消息
//   - 拖动：makeDraggable（pointer capture + 6px 点击阈值 + 视口钳制 + 位置存档 localStorage）
//     悬浮窗与面板都可拖动；默认位不在屏幕边角（军规 1.4：小屏/缩放会切掉贴边元素）
//   - 设置页照参考卡：API 地址/Key/模型名 + 拉取模型兼连通性测试；Key 框防密码管理器处理
// 铁律：本脚本不写正文链字段；玩家回复只写 phone 子树；异常 toastr/console 留痕（军规 2）
(function () {
  'use strict';
  const TAG = '[批条·手机]';
  if (window.__PiaotiaoPhonePanel) { console.info(TAG, '已挂载，跳过重复初始化'); return; }

  const COLORS = {
    bg: '#1f2731', panel: '#26303d', header: '#2b3a4a', line: '#33414f',
    text: '#cfd8e3', dim: '#8fa1b3', red: '#c0392b', green: '#2ecc71', blue: '#4a7ba6',
    mine: '#3a5a7a', theirs: '#33414f',
  };

  // ---------- 拖动系统（照抄参考卡 makeDraggable：pointer capture + 钳制 + 存档） ----------
  const VIEW = window.parent && window.parent.document ? window.parent : window;
  const DOC = VIEW.document;
  let CAL = { ox: 0, oy: 0, sx: 1, sy: 1 };
  function vpW() { return (VIEW.visualViewport && VIEW.visualViewport.width) || VIEW.innerWidth; }
  function vpH() { return (VIEW.visualViewport && VIEW.visualViewport.height) || VIEW.innerHeight; }
  function recalib() {
    try {
      const probe = DOC.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;pointer-events:none;visibility:hidden;';
      DOC.body.appendChild(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      CAL = { ox: r.left, oy: r.top, sx: (r.width / 100) || 1, sy: (r.height / 100) || 1 };
    } catch (e) {}
  }
  function clampXY(x, y, margin) {
    return {
      x: Math.max(8, Math.min(x, vpW() - (margin || 64))),
      y: Math.max(8, Math.min(y, vpH() - (margin || 64))),
    };
  }
  function setClientPos(el, cx, cy) {
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.left = ((cx - CAL.ox) / CAL.sx) + 'px';
    el.style.top = ((cy - CAL.oy) / CAL.sy) + 'px';
  }
  function loadPos(key) {
    try { const s = VIEW.localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function savePos(key, x, y) { try { VIEW.localStorage.setItem(key, JSON.stringify({ x, y })); } catch (e) {} }
  function applyPos(el, key) {
    const pos = loadPos(key);
    recalib();
    if (pos) { const c = clampXY(pos.x, pos.y); setClientPos(el, c.x, c.y); return true; }
    return false;
  }
  function makeDraggable(el, handle, storeKey) {
    handle.style.touchAction = 'none';
    handle.style.cursor = 'grab';
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // 6px 内算点击不算拖
      moved = true;
      recalib();
      const c = clampXY(ox + dx, oy + dy);
      setClientPos(el, c.x, c.y);
      e.preventDefault();
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        recalib();
        const r = el.getBoundingClientRect();
        savePos(storeKey, r.left, r.top);
      }
    });
    handle.addEventListener('pointercancel', () => { dragging = false; });
  }

  // ---------- 数据读取（只读投影） ----------
  async function readStat() {
    const Mvu = window.Mvu;
    if (!Mvu) throw new Error('Mvu 未就绪');
    const data = await Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    return (data && data.stat_data) || null;
  }

  // ---------- 发件箱（照抄参考卡：存聊天变量，防重载/切聊天丢失） ----------
  async function loadOutbox() {
    try {
      const sd = (await window.Mvu.getMvuData({ type: 'message', message_id: 'latest' })).stat_data;
      return (sd && sd.phone && sd.phone._outbox) || {};
    } catch (e) { return {}; }
  }
  async function saveOutbox(ob) {
    const fresh = await window.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    fresh.stat_data.phone = fresh.stat_data.phone || {};
    fresh.stat_data.phone._outbox = ob;
    await window.Mvu.replaceMvuData(fresh, { type: 'message', message_id: 'latest' });
  }
  async function outboxCount() {
    const ob = await loadOutbox();
    let n = 0;
    for (const k of Object.keys(ob)) n += (ob[k] || []).length;
    return n;
  }

  // ---------- DOM ----------
  let root = null;          // 启动器宿主
  let panelHostRoot = null; // 面板宿主
  let panelEl = null;
  let currentView = 'wechat';
  let currentConv = null;
  const FAB_POS_KEY = 'piaotiao_fab_pos';
  const PANEL_POS_KEY = 'piaotiao_panel_pos';

  function defaultFabPos() {
    recalib();
    // 默认位不在屏幕边角：右上偏内（宽 70%、高 20% 处），可拖走
    setClientPos(root, Math.max(8, vpW() * 0.7), Math.max(8, vpH() * 0.2));
  }
  function defaultPanelPos() {
    recalib();
    const pw = Math.min(340, vpW() - 24), ph = Math.min(560, vpH() - 60);
    setClientPos(panelHostRoot, Math.max(8, (vpW() - pw) / 2), Math.max(8, (vpH() - ph) / 2 - 20));
  }

  function ensureHost() {
    const host = DOC;
    if (!root || !host.body || !host.body.contains(root)) {
      host.getElementById('piaotiao-phone-root')?.remove();
      root = host.createElement('div');
      root.id = 'piaotiao-phone-root';
      root.style.cssText = 'position:fixed;left:70%;top:20%;z-index:9998;font-family:"Microsoft YaHei",system-ui,sans-serif;';
      root.addEventListener('click', onRootClick);
      host.body.appendChild(root);
      if (!applyPos(root, FAB_POS_KEY)) defaultFabPos();
    }
    if (!panelHostRoot || !host.body.contains(panelHostRoot)) {
      host.getElementById('piaotiao-phone-panel-root')?.remove();
      panelHostRoot = host.createElement('div');
      panelHostRoot.id = 'piaotiao-phone-panel-root';
      panelHostRoot.style.cssText = 'position:fixed;left:30%;top:12%;z-index:9999;display:none;font-family:"Microsoft YaHei",system-ui,sans-serif;';
      panelHostRoot.addEventListener('click', onRootClick);
      panelHostRoot.addEventListener('keydown', onRootKeydown);
      // Key 框 readonly 到聚焦才解锁：安卓 autofill 只认这招（参考卡实测），focusin 才能冒泡
      panelHostRoot.addEventListener('focusin', (e) => {
        if (e.target && e.target.id === 'piaotiao-cfg-key') e.target.removeAttribute('readonly');
      });
      host.body.appendChild(panelHostRoot);
      if (!applyPos(panelHostRoot, PANEL_POS_KEY)) defaultPanelPos();
    }
    renderLauncher();
    if (panelEl) makeDraggable(panelHostRoot, panelEl.querySelector('#piaotiao-drag-handle'), PANEL_POS_KEY);
    return host;
  }

  function renderLauncher() {
    const unread = window.__piaotiaoUnread || 0;
    const pending = window.__piaotiaoPending || 0;
    root.innerHTML =
      '<div id="piaotiao-phone-btn" title="批条 · 手机（可拖动）" style="cursor:grab;width:52px;height:52px;border-radius:14px;' +
      'background:' + COLORS.header + ';border:1px solid ' + COLORS.line + ';box-shadow:0 4px 14px rgba(0,0,0,.45);' +
      'display:flex;align-items:center;justify-content:center;position:relative;user-select:none;">' +
      '<span style="font-size:24px;pointer-events:none;">📱</span>' +
      (unread > 0 ? '<span style="position:absolute;top:-6px;right:-6px;background:' + COLORS.red + ';color:#fff;font-size:11px;' +
        'min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;pointer-events:none;">' + unread + '</span>' : '') +
      (pending > 0 && unread === 0 ? '<span style="position:absolute;top:-6px;right:-6px;background:' + COLORS.blue + ';color:#fff;font-size:11px;' +
        'min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;pointer-events:none;">' + pending + '</span>' : '') +
      '</div>';
  }

  function openPanel() {
    try {
      ensureHost();
      if (!panelEl) {
        panelEl = DOC.createElement('div');
        panelEl.id = 'piaotiao-phone-panel';
        panelEl.style.cssText = 'width:340px;height:560px;background:' + COLORS.bg +
          ';border:1px solid ' + COLORS.line + ';border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.55);' +
          'display:flex;flex-direction:column;overflow:hidden;color:' + COLORS.text + ';';
        panelHostRoot.appendChild(panelEl);
      }
      panelHostRoot.style.display = 'block';
      render();
    } catch (e) { reportError('面板打开失败', e); }
  }
  function closePanel() { if (panelHostRoot) panelHostRoot.style.display = 'none'; }

  async function render() {
    if (!panelEl) return;
    try {
      const stat = await readStat();
      if (!stat) { panelEl.innerHTML = '<div style="padding:20px;color:' + COLORS.dim + '">账本尚未初始化</div>'; return; }
      const tabs = ['wechat', 'contacts', 'network', 'notes', 'settings'];
      const tabNames = { wechat: '微信', contacts: '联系人', network: '关系网', notes: '备忘录', settings: '设置' };
      let body = '';
      if (currentView === 'wechat') body = await viewWechat(stat);
      else if (currentView === 'contacts') body = viewContacts(stat);
      else if (currentView === 'network') body = viewNetwork(stat);
      else if (currentView === 'notes') body = viewNotes(stat);
      else if (currentView === 'settings') body = viewSettings();
      // 头部即拖动把手（收起按钮 stopPropagation 不抢拖动）
      panelEl.innerHTML =
        '<div id="piaotiao-drag-handle" style="background:' + COLORS.header + ';padding:10px 14px;font-size:15px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;touch-action:none;">' +
        '<span>批条 · 这事，能办。</span><span id="piaotiao-close" style="cursor:pointer;color:' + COLORS.dim + ';font-size:13px;pointer-events:auto;">收起</span></div>' +
        '<div style="display:flex;border-bottom:1px solid ' + COLORS.line + ';">' +
        tabs.map((t) => '<div data-tab="' + t + '" style="flex:1;text-align:center;padding:8px 0;cursor:pointer;font-size:13px;user-select:none;' +
          (currentView === t ? 'color:' + COLORS.green + ';border-bottom:2px solid ' + COLORS.green + ';' : 'color:' + COLORS.dim + ';') + '">' + tabNames[t] + '</div>').join('') +
        '</div>' +
        '<div id="piaotiao-body" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;">' + body + '</div>';
      panelEl.querySelector('#piaotiao-close').addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });
      panelEl.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); currentView = el.getAttribute('data-tab'); currentConv = null; render(); }));
      // 面板 innerHTML 重建后拖动把手要重绑
      makeDraggable(panelHostRoot, panelEl.querySelector('#piaotiao-drag-handle'), PANEL_POS_KEY);
    } catch (e) { reportError('渲染失败', e); }
  }

  // ---------- 设置（UI 照抄参考卡，含防密码管理器处理） ----------
  const DM_API_KEY_STORAGE = 'piaotiao_dm_api';
  function readDmApiConfig() {
    try { return JSON.parse(localStorage.getItem(DM_API_KEY_STORAGE) || '{}'); } catch (e) { return {}; }
  }
  function saveDmApiConfig(cfg) {
    try { localStorage.setItem(DM_API_KEY_STORAGE, JSON.stringify(cfg || {})); } catch (e) { reportError('设置保存失败', e); }
  }
  function ensureMaskCss() {
    if (DOC.getElementById('piaotiao-mask-css')) return;
    const st = DOC.createElement('style');
    st.id = 'piaotiao-mask-css';
    st.textContent = '#piaotiao-phone-panel input.piao-mask{-webkit-text-security:disc;}';
    DOC.head.appendChild(st);
  }

  function viewSettings() {
    ensureMaskCss();
    const cfg = readDmApiConfig();
    const attrs = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"';
    return '<div style="background:' + COLORS.header + ';padding:9px 14px;font-size:13px;"><b>手机设置</b> <span style="color:' + COLORS.dim + ';font-size:11px;">independent API</span></div>' +
      '<div style="padding-top:16px;">' +
      '<div style="padding:0 14px 10px;"><label style="font-size:12px;color:' + COLORS.dim + ';display:block;margin-bottom:4px;">API 地址（OpenAI 兼容）</label>' +
      '<textarea id="piaotiao-cfg-url" rows="1" ' + attrs + ' data-lpignore="true" data-1p-ignore placeholder="https://api.xxx.com/v1" style="width:100%;box-sizing:border-box;background:' + COLORS.panel + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:8px;padding:7px 9px;font-size:12px;outline:none;resize:none;">' + esc(cfg.url || '') + '</textarea></div>' +
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
      '<div id="piaotiao-cfg-msg" style="text-align:left;padding:0 16px 6px;font-size:12px;min-height:18px;color:' + COLORS.green + ';"></div>' +
      '<div style="text-align:left;padding:4px 16px;font-size:12px;color:' + COLORS.red + ';">此处谨慎使用公益站 api，容易被误封。</div>' +
      '<div style="text-align:left;padding:4px 16px;font-size:12px;color:' + COLORS.dim + ';">填了独立 API 后，私信生成不占聊天 API。Key 只存这台浏览器本地，不进聊天文件。🔄 拉取模型兼做连通性测试：拉得到 = 地址/Key/CORS 都通。</div>' +
      '</div>';
  }

  async function onCfgFetch() {
    const p2 = document.getElementById('piaotiao-phone-panel');
    const u = p2.querySelector('#piaotiao-cfg-url').value.trim();
    const k = p2.querySelector('#piaotiao-cfg-key').value.trim();
    if (!u || !k) { toast('warning', '先填 API 地址和 Key'); return; }
    const fbtn = p2.querySelector('#piaotiao-cfg-fetch');
    fbtn.textContent = '⏳ 拉取中…';
    try {
      let mu = u.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      mu = /\/v\d+$/.test(mu) ? mu + '/models' : mu + '/v1/models';
      const resp = await fetch(mu, { headers: { 'Authorization': 'Bearer ' + k } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      const ids = (j.data || j.models || []).map((m) => (m && (m.id || m.name)) || m).filter((x) => typeof x === 'string');
      if (!ids.length) throw new Error('返回里没有模型列表');
      p2.querySelector('#piaotiao-cfg-models').innerHTML = ids.map((id) => '<option value="' + esc(id) + '">').join('');
      const sel = p2.querySelector('#piaotiao-cfg-modelsel'); // 安卓不支持 datalist → 真 <select> 兜底
      sel.innerHTML = '<option value="">— 从 ' + ids.length + ' 个模型里选 —</option>' + ids.map((id) => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('');
      sel.style.display = 'block';
      sel.onchange = function () { if (sel.value) p2.querySelector('#piaotiao-cfg-model').value = sel.value; };
      const mi = p2.querySelector('#piaotiao-cfg-model');
      if (!mi.value.trim()) mi.value = ids[0];
      toast('success', '📡 拉到 ' + ids.length + ' 个模型——连通性OK，选一个再保存');
      fbtn.textContent = '🔄 拉取模型 (' + ids.length + ')';
    } catch (e) {
      toast('error', '拉取失败: ' + ((e && e.message) || e) + '。多半是地址不对 / Key 无效 / 该服务不允许浏览器直连(CORS)');
      fbtn.textContent = '🔄 拉取模型';
    }
  }
  function onCfgSave() {
    const p2 = document.getElementById('piaotiao-phone-panel');
    const c = {
      url: p2.querySelector('#piaotiao-cfg-url').value.trim(),
      key: p2.querySelector('#piaotiao-cfg-key').value.trim(),
      model: p2.querySelector('#piaotiao-cfg-model').value.trim(),
    };
    saveDmApiConfig(c);
    const msg = p2.querySelector('#piaotiao-cfg-msg'); // 页面内常驻成功提示（用户要求）
    if (msg) msg.textContent = '✅ 设置成功，已保存' + (c.url && c.key ? '：私信将使用你填写的独立 API' : '：私信暂不生成（未填地址/Key）');
    toast('success', '✅ 设置已保存');
  }
  function onCfgClear() {
    try { localStorage.removeItem(DM_API_KEY_STORAGE); } catch (e) {}
    const msg = document.getElementById('piaotiao-cfg-msg');
    if (msg) msg.textContent = '🗑️ 已清除：私信暂不生成';
    toast('info', '已清除独立 API 配置');
  }

  // ---------- 微信（仿微信风格 + 发件箱） ----------
  function avatarDot(name) {
    return '<span style="flex-shrink:0;width:38px;height:38px;border-radius:6px;background:' + COLORS.mine +
      ';color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;">' + esc(String(name || '?').slice(0, 1)) + '</span>';
  }
  function convName(sd, id) {
    const c = (sd.contacts || {})[id];
    if (c) return val(c.name) || id;
    if (id === 'chen_guobang') return '陈国邦';
    const fam = (sd.families || {})[id];
    if (fam) return val(fam.name) + '家';
    return id;
  }
  async function viewWechat(stat) {
    if (currentConv) return wechatThread(stat, currentConv);
    const convs = stat.phone?.wechat_conversations || {};
    const ob = await loadOutbox();
    const ids = Object.keys(convs);
    const obCount = await outboxCount();
    let banner = '';
    if (obCount > 0) {
      banner = '<div id="piaotiao-sendall" style="margin:10px 12px 4px;background:' + COLORS.green + ';border-radius:10px;padding:10px 12px;' +
        'display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3);">' +
        '<span style="background:' + COLORS.red + ';color:#fff;border-radius:10px;min-width:20px;text-align:center;font-size:12px;font-weight:bold;padding:2px 6px;">' + obCount + '</span>' +
        '<span style="color:#123;font-weight:bold;font-size:13px;">📨 确定发送，等他们回复</span></div>';
    }
    const rows = ids.map((id) => {
      const c = convs[id];
      const name = convName(stat, id);
      const unread = Number(val(c.unread)) || 0;
      const queued = (ob[id] || []).length;
      return '<div data-conv="' + esc(id) + '" style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid ' + COLORS.line + ';cursor:pointer;">' +
        avatarDot(name) +
        '<div style="flex:1;min-width:0;"><div style="display:flex;justify-content:space-between;align-items:baseline;">' +
        '<span style="font-size:14px;color:' + COLORS.text + ';">' + esc(name) + '</span>' +
        (queued > 0 ? '<span style="font-size:11px;color:' + COLORS.blue + ';">✍️ 待发 ' + queued + ' 条</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:' + COLORS.dim + ';margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(val(c.last_summary) || '') + '</div></div>' +
        (unread > 0 ? '<span style="background:' + COLORS.red + ';color:#fff;border-radius:10px;min-width:18px;text-align:center;font-size:11px;padding:2px 5px;flex-shrink:0;">' + unread + '</span>' : '') +
        '</div>';
    }).join('');
    return banner + '<div style="background:' + COLORS.bg + ';">' +
      (rows || '<div style="padding:24px;color:' + COLORS.dim + ';text-align:center;font-size:13px;">暂无会话<br><span style="font-size:12px;">剧情里的微信往来会出现在这里</span></div>') + '</div>';
  }

  function wechatThread(stat, convId) {
    const box = (stat.phone?.wechat_messages || {})[convId];
    const list = (box && Array.isArray(val(box.messages))) ? val(box.messages) : [];
    const name = convName(stat, convId);
    const ob = stat.phone?._outbox || {};
    const queued = (ob[convId] || []).length;
    const items = list.map((m) => {
      const mine = val(m.from) === 'player';
      return '<div style="display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') + ';padding:4px 12px;gap:8px;">' +
        (mine ? '' : avatarDot(name)) +
        '<div style="max-width:75%;background:' + (mine ? COLORS.mine : COLORS.theirs) + ';color:' + COLORS.text +
        ';border-radius:12px;border-' + (mine ? 'bottom-right' : 'bottom-left') + '-radius:3px;padding:8px 12px;font-size:13.5px;line-height:1.55;word-break:break-word;">' +
        esc(val(m.text)) + '</div></div>';
    }).join('');
    return '<div style="display:flex;flex-direction:column;height:100%;">' +
      '<div style="background:' + COLORS.header + ';padding:9px 14px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;flex-shrink:0;" id="piaotiao-back">' +
      '<span style="color:' + COLORS.dim + ';font-size:16px;">‹</span>' + esc(name) +
      (queued > 0 ? '<span style="margin-left:auto;font-size:11px;color:' + COLORS.blue + ';">✍️ 待发 ' + queued + ' 条</span>' : '') + '</div>' +
      '<div style="flex:1;overflow-y:auto;padding:10px 0;display:flex;flex-direction:column;gap:4px;">' +
      (items || '<div style="text-align:center;color:' + COLORS.dim + ';padding:20px;font-size:12px;">暂无消息</div>') + '</div>' +
      '<div style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid ' + COLORS.line + ';background:' + COLORS.header + ';flex-shrink:0;">' +
      '<input id="piaotiao-input" placeholder="发消息…（加入待发后回列表统一发送）" autocomplete="off" style="flex:1;background:' + COLORS.bg + ';border:1px solid ' + COLORS.line + ';color:' + COLORS.text + ';border-radius:8px;padding:7px 10px;font-size:12px;outline:none;" />' +
      '<button id="piaotiao-queue" style="background:' + COLORS.blue + ';border:none;color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;">加入待发</button></div></div>';
  }

  // 发件箱操作（写 phone._outbox；玩家内容只进队列，由列表页「确定发送」统一发出）
  async function queueReply(convId, text) {
    try {
      const ob = await loadOutbox();
      ob[convId] = ob[convId] || [];
      ob[convId].push(String(text));
      await saveOutbox(ob);
      toast('success', '✍️ 已加入待发队列');
      window.__piaotiaoPending = await outboxCount();
      renderLauncher();
      render();
    } catch (e) { reportError('加入队列失败', e); }
  }
  // 确定发送：把发件箱里所有人的消息逐个发事件（生成器串行处理）
  async function sendAll() {
    try {
      const stat = await readStat();
      const ob = await loadOutbox();
      const ids = Object.keys(ob).filter((k) => (ob[k] || []).length);
      if (!ids.length) { toast('info', '队列为空'); return; }
      for (const convId of ids) {
        const lines = ob[convId] || [];
        if (!lines.length) continue;
        const name = convName(stat, convId);
        const reason = '玩家在私信里对 ' + name + ' 说了：' + lines.map((s) => '「' + s + '」').join('、') +
          '。只让 ' + name + ' 本人回应这些，别的角色不要出现、不要插话。';
        try { window.dispatchEvent(new CustomEvent('piaotiao_request_dm', { detail: { convId, reason, lines } })); } catch (e) { reportError('私信触发失败', e); }
      }
      await saveOutbox({}); // 清空发件箱
      window.__piaotiaoPending = 0;
      toast('success', '📨 已发送，等他们回复…');
      renderLauncher();
      render();
    } catch (e) { reportError('发送失败', e); }
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

  // ---------- 事件与自愈 ----------
  async function onVariableUpdateEnded() {
    try {
      const stat = await readStat();
      let unread = 0;
      Object.values((stat && stat.phone && stat.phone.wechat_conversations) || {}).forEach((c) => { unread += Number(val(c.unread)) || 0; });
      window.__piaotiaoUnread = unread;
      window.__piaotiaoPending = await outboxCount();
      if (root) renderLauncher();
      if (panelEl && panelHostRoot && panelHostRoot.style.display !== 'none') await render();
    } catch (e) { /* 初始化前静默，下次事件再刷 */ }
  }

  function bindEvents() {
    if (window.Mvu && window.Mvu.events && typeof eventOn === 'function') {
      eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED, onVariableUpdateEnded);
      window.addEventListener('piaotiao_phone_refresh', () => { onVariableUpdateEnded(); });
      return true;
    }
    return false;
  }
  function mount() {
    ensureHost();
    if (!bindEvents()) {
      let waited = 0;
      const timer = setInterval(() => {
        waited += 400;
        if (bindEvents() || waited > 30000) {
          clearInterval(timer);
          if (waited > 30000) reportError('Mvu 长时间未就绪，手机面板暂不可用（正文不受影响）');
        }
      }, 400);
    }
    reportInfo('已挂载：悬浮手机（微信/联系人/关系网/备忘录/设置），可拖动');
    onVariableUpdateEnded();
    // swipe/换聊天导致 body 重建时自愈
    setInterval(() => {
      try {
        if (!DOC.getElementById('piaotiao-phone-root') || !DOC.getElementById('piaotiao-phone-panel-root')) {
          root = null; panelHostRoot = null; panelEl = null; ensureHost();
        }
      } catch (e) { /* 下次轮询再试 */ }
    }, 10000);
  }

  // ---------- 交互委托（root 与 panelHost 各绑一次） ----------
  function onRootClick(e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('#piaotiao-phone-btn')) { openPanel(); return; }
    if (!panelEl) return;
    if (t.closest('#piaotiao-close')) { closePanel(); return; }
    const tab = t.closest('[data-tab]');
    if (tab) { currentView = tab.getAttribute('data-tab'); currentConv = null; render(); return; }
    const conv = t.closest('[data-conv]');
    if (conv) { currentConv = conv.getAttribute('data-conv'); render(); return; }
    if (t.closest('#piaotiao-back')) { currentConv = null; render(); return; }
    if (t.closest('#piaotiao-sendall')) { sendAll(); return; }
    if (t.closest('#piaotiao-queue')) {
      const input = panelEl.querySelector('#piaotiao-input');
      const text = input ? input.value.trim() : '';
      if (text && currentConv) queueReply(currentConv, text);
      else toast('warning', '先输入要说的内容');
      return;
    }
    if (t.closest('#piaotiao-cfg-fetch')) { onCfgFetch(); return; }
    if (t.closest('#piaotiao-cfg-save')) { onCfgSave(); return; }
    if (t.closest('#piaotiao-cfg-clear')) { onCfgClear(); return; }
  }
  function onRootKeydown(e) {
    if (e.key !== 'Enter') return;
    const input = e.target && e.target.id === 'piaotiao-input' ? e.target : null;
    if (input && currentConv) {
      const text = input.value.trim();
      if (text) { input.value = ''; queueReply(currentConv, text); }
    }
  }

  mount();
  window.__PiaotiaoPhonePanel = true;
})();
