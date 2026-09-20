// 批条 · 悬浮手机面板 v0.3.1（远程托管 dist/phone_panel.js，卡内运行时加载器 fetch+eval 拉起）
// v0.3.1：修复面板内部点击全灭——拖拽改 document 级手势跟踪（零指针捕获）+面板拖拽限定标题栏（真机真实点击复现根因）
//
// 架构对齐参考卡《Sugar Daddy Simulator》的成熟模式（2026-09-19 拆解学习其线上实现）：
//   悬浮 FAB + 可拖面板（makeDraggable：指针位移阈值合成 tap，不依赖 click 事件——
//   pointerdown 即 setPointerCapture 会把 click 重定向到容器吃掉子元素点击，tap 合成天然免疫）；
//   聊天级变量 pt 命名空间单一真源；事件 pt_updated / pt_floor_log 驱动刷新。
//   代码为本卡原创实现；未搬运参考卡代码文本（其声明「可读可学，禁止直接搬运」）。
// UI 主题：体制灰蓝 + 公章红 + 监控绿（design-brief §9）
// 铁律：不写正文链字段；玩家回复只进 pt 子树；异常 toastr/console 留痕
(function () {
  'use strict';
  var TAG = '[批条·手机]';
  if (window.__PiaotiaoPhonePanel) { console.info(TAG, '已挂载，跳过重复初始化'); return; }

  var DOC = (typeof parent !== 'undefined' && parent.document) ? parent.document : document;
  var VIEW = DOC.defaultView || window;

  var C = {
    bg: '#1b222c', panel: '#242e3a', header: '#2b3a4a', line: '#33414f',
    text: '#cfd8e3', dim: '#8fa1b3', red: '#c0392b', green: '#2ecc71',
    blue: '#4a7ba6', mine: '#33506e', theirs: '#313d4b', gold: '#d9a441',
  };

  // ── 小工具 ──
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(kind, msg) { try { toastr[kind](msg, '批条 · 手机'); } catch (e) { console.info(TAG, msg); } }
  function lsGet(k) { try { return VIEW.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { VIEW.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { VIEW.localStorage.removeItem(k); } catch (e) {} }
  function nowTime() {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function dayKey(ts) { var d = ts ? new Date(ts) : new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

  // ── 数据层：聊天级 pt 命名空间 + 串行写闸（updateVariablesWith 读→改→异步写，贴近必覆盖） ──
  var _updQ = Promise.resolve();
  function ptRead() { try { return getVariables({ type: 'chat' }) || {}; } catch (e) { return {}; } }
  function ptUpdate(fn) {
    _updQ = _updQ.then(function () { return updateVariablesWith(fn, { type: 'chat' }); })
      .catch(function (e) { console.error(TAG, '写变量失败', e); toast('error', '写变量失败: ' + ((e && e.message) || e)); });
    return _updQ;
  }
  function ptSaveChat() { try { VIEW.SillyTavern && VIEW.SillyTavern.saveChat && VIEW.SillyTavern.saveChat(); } catch (e) {} }
  function ptStatData() {
    try {
      var mid = null;
      try { if (typeof getLastMessageId === 'function') mid = getLastMessageId(); } catch (e0) {}
      var v = getVariables({ type: 'message', message_id: (mid != null ? mid : 0) });
      var sd = v && v.stat_data;
      if (!sd && mid !== 0) { try { v = getVariables({ type: 'message', message_id: 0 }); sd = v && v.stat_data; } catch (e2) {} }
      return (sd && typeof sd === 'object') ? sd : null;
    } catch (e) { return null; }
  }
  function ptBare(v) { return (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string') ? v[0] : v; }

  // ── 发件箱（pt._outbox：防重载/切聊天丢失） ──
  function loadOutbox() { var v = ptRead(); return (v && v.pt && v.pt._outbox) ? v.pt._outbox : {}; }
  function saveOutbox(ob) {
    return ptUpdate(function (v) { if (!v.pt) v.pt = { npcs: {} }; v.pt._outbox = ob; return v; }).then(function () { ptSaveChat(); });
  }
  function outboxCount() { var ob = loadOutbox(), n = 0; for (var k in ob) { if (ob.hasOwnProperty(k)) n += (ob[k] || []).length; } return n; }
  function queueOutbox(id, line) {
    var ob = loadOutbox();
    if (!ob[id]) ob[id] = [];
    ob[id].push(String(line));
    return saveOutbox(ob);
  }

  // ── 会话名解析（stat_data 是联系人真源；pt.npcs 兜底；家庭按一家之主名折回） ──
  function convName(sd, id) {
    sd = sd || ptStatData() || {};
    if (sd.contacts && sd.contacts[id]) return String(ptBare(sd.contacts[id].name) || id);
    if (sd.families) {
      if (sd.families[id]) { var h = sd.families[id].head; return String((h && ptBare(h.name)) || (ptBare(sd.families[id].name) || id) + '家'); }
      for (var fid in sd.families) {
        var f = sd.families[fid];
        var hn = f.head && ptBare(f.head.name);
        if (hn && String(hn) === String(id)) return String(hn);
      }
    }
    var v = ptRead();
    var npcs = (v.pt && v.pt.npcs) || {};
    return (npcs[id] && npcs[id].name) || id;
  }

  // ── 未读 / 待发角标 ──
  function totalUnread() {
    var v = ptRead();
    var npcs = (v.pt && v.pt.npcs) || {};
    var n = 0;
    for (var k in npcs) { if (npcs.hasOwnProperty(k)) n += (npcs[k].unread || 0); }
    return n;
  }

  // ── 打字指示（生成期间线程里显示"对方正在输入…"） ──
  var _typing = false;
  function setTyping(on) { _typing = !!on; if (currentConv && panelVisible()) render(); updateBadge(); }

  // ── 拖动系统（参考卡模式：handle 上挂指针事件，位移>6px 判拖、否则合成 tap） ──
  var CAL = { ox: 0, oy: 0, sx: 1, sy: 1 };
  function recalib() {
    try {
      var probe = DOC.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;pointer-events:none;visibility:hidden;';
      DOC.body.appendChild(probe);
      var r = probe.getBoundingClientRect();
      probe.remove();
      CAL = { ox: r.left, oy: r.top, sx: (r.width / 100) || 1, sy: (r.height / 100) || 1 };
    } catch (e) {}
  }
  function vpW() { return (VIEW.visualViewport && VIEW.visualViewport.width) || VIEW.innerWidth; }
  function vpH() { return (VIEW.visualViewport && VIEW.visualViewport.height) || VIEW.innerHeight; }
  function setClientPos(el, cx, cy) { el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.left = ((cx - CAL.ox) / CAL.sx) + 'px'; el.style.top = ((cy - CAL.oy) / CAL.sy) + 'px'; }
  function clampXY(x, y, margin) { return { x: Math.max(8, Math.min(x, vpW() - (margin || 64))), y: Math.max(8, Math.min(y, vpH() - (margin || 64))) }; }
  function loadPos(key) { try { var s = lsGet(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function savePos(key, x, y) { try { lsSet(key, JSON.stringify({ x: x, y: y })); } catch (e) {} }
  function applyPos(el, key, defFn) {
    recalib();
    var pos = loadPos(key);
    if (pos) { var c = clampXY(pos.x, pos.y); setClientPos(el, c.x, c.y); return; }
    defFn();
  }
  // v0.3.1 修复：pointerdown 即 setPointerCapture 会把后续 click 重定向到捕获容器，
  // 面板内部所有子元素的原生 click 监听全部落空（v0.2.5 悬浮窗同坑复发；真机真实点击复现）。
  // 方案：完全不使用指针捕获——手势跟踪挂 document（按 pointerId 过滤，任何元素下都能收到
  // move/up，不依赖指针停留在手柄上）；按下时仅登记待定手势且不 preventDefault，保住子元素
  // click 与输入框 focus；位移越过 6px 才判定为拖拽，未越阈值抬起按 tap 合成（仅 FAB 用）；
  // 拖拽/合成后吞掉跟随 click 防误触。gate：面板只允许从标题栏发起拖拽（保住列表滚动与内部交互）。
  function makeDraggable(el, handle, storeKey, onTap, gate) {
    var g = null; // 待定手势 {pid, sx, sy, ox, oy, moved}
    var suppress = null;
    function armSuppress() {
      if (suppress) return;
      suppress = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
      handle.addEventListener('click', suppress, { capture: true, once: true });
      setTimeout(function () {
        if (suppress) { handle.removeEventListener('click', suppress, { capture: true }); suppress = null; }
      }, 350);
    }
    handle.addEventListener('pointerdown', function (e) {
      if (g) return;
      if (gate && !(e.target && e.target.closest && e.target.closest(gate))) return;
      var r = el.getBoundingClientRect();
      g = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      // 此刻意不捕获、不 preventDefault：保住子元素 click 与输入框 focus
    });
    DOC.addEventListener('pointermove', function (e) {
      if (!g || e.pointerId !== g.pid) return;
      var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      g.moved = true;
      recalib();
      var c = clampXY(g.ox + dx, g.oy + dy);
      setClientPos(el, c.x, c.y);
      e.preventDefault();
    }, true);
    function up(e) {
      if (!g || e.pointerId !== g.pid) return;
      var wasMoved = g.moved, tap = !wasMoved && onTap;
      var t = e.target;
      g = null;
      if (wasMoved) {
        recalib();
        var r = el.getBoundingClientRect();
        savePos(storeKey, r.left, r.top);
        armSuppress();
      } else if (tap && !(t && t.closest && t.closest('button, input, textarea, select, [data-tab], [data-conv], #piaotiao-close, #piaotiao-back, #piaotiao-sendall, #piaotiao-queue'))) {
        armSuppress();
        onTap(e);
      }
    }
    DOC.addEventListener('pointerup', up, true);
    DOC.addEventListener('pointercancel', up, true);
  }

  // ── DOM 宿主 ──
  var root = null, panelHost = null, panelEl = null, _menuEl = null;
  var currentView = 'wechat', currentConv = null;
  var FAB_KEY = 'piaotiao_fab_pos', PANEL_KEY = 'piaotiao_panel_pos';

  function defaultFabPos() { recalib(); setClientPos(root, vpW() * 0.7, vpH() * 0.2); }
  function defaultPanelPos() { recalib(); var pw = Math.min(360, vpW() - 24), ph = Math.min(600, vpH() - 60); setClientPos(panelHost, Math.max(8, (vpW() - pw) / 2), Math.max(8, (vpH() - ph) / 2 - 20)); }

  var CSS = [
    '#piaotiao-phone-panel{--bg:' + C.bg + ';--panel:' + C.panel + ';--header:' + C.header + ';--line:' + C.line + ';--text:' + C.text + ';--dim:' + C.dim + ';--red:' + C.red + ';--green:' + C.green + ';--blue:' + C.blue + ';--mine:' + C.mine + ';--theirs:' + C.theirs + ';--gold:' + C.gold + ';}',
    '#piaotiao-phone-panel *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
    '#piaotiao-phone-panel .pt-row{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;}',
    '#piaotiao-phone-panel .pt-row:active{background:var(--header);}',
    '#piaotiao-phone-panel .pt-ava{flex-shrink:0;width:40px;height:40px;border-radius:6px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;}',
    '#piaotiao-phone-panel .pt-ava.family{background:var(--red);}',
    '#piaotiao-phone-panel .pt-mid{flex:1;min-width:0;}',
    '#piaotiao-phone-panel .pt-name{font-size:14px;color:var(--text);display:flex;justify-content:space-between;align-items:baseline;gap:6px;}',
    '#piaotiao-phone-panel .pt-prev{font-size:12px;color:var(--dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#piaotiao-phone-panel .pt-unread{background:var(--red);color:#fff;border-radius:10px;min-width:18px;text-align:center;font-size:11px;padding:2px 5px;flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-time{font-size:10px;color:var(--dim);flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-meta{font-size:12px;color:var(--dim);margin-top:3px;}',
    '#piaotiao-phone-panel .pt-banner{margin:10px 12px 4px;background:var(--green);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3);}',
    '#piaotiao-phone-panel .pt-banner .n{background:var(--red);color:#fff;border-radius:10px;min-width:20px;text-align:center;font-size:12px;font-weight:bold;padding:2px 6px;}',
    '#piaotiao-phone-panel .pt-banner .t{color:#123;font-weight:bold;font-size:13px;}',
    '#piaotiao-phone-panel .pt-chat{display:flex;flex-direction:column;height:100%;}',
    '#piaotiao-phone-panel .pt-chat-head{background:var(--header);padding:9px 12px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-msgs{flex:1;overflow-y:auto;padding:8px 0;display:flex;flex-direction:column;gap:2px;}',
    '#piaotiao-phone-panel .pt-msg{display:flex;padding:3px 10px;gap:8px;align-items:flex-end;}',
    '#piaotiao-phone-panel .pt-msg.mine{flex-direction:row-reverse;}',
    '#piaotiao-phone-panel .pt-bub{max-width:78%;background:var(--theirs);color:var(--text);border-radius:12px;padding:7px 11px;font-size:13.5px;line-height:1.55;word-break:break-word;white-space:pre-wrap;}',
    '#piaotiao-phone-panel .pt-msg.mine .pt-bub{background:var(--mine);}',
    '#piaotiao-phone-panel .pt-bub.sys{background:transparent;color:var(--dim);font-size:11px;text-align:center;max-width:100%;}',
    '#piaotiao-phone-panel .pt-bub.recall{background:transparent;color:var(--dim);font-size:12px;font-style:italic;}',
    '#piaotiao-phone-panel .pt-bub.transfer{border:1px solid var(--gold);color:var(--gold);background:rgba(217,164,65,.08);}',
    '#piaotiao-phone-panel .pt-bub.voice{border-left:3px solid var(--blue);}',
    '#piaotiao-phone-panel .pt-tail{font-size:9px;color:var(--dim);margin-top:3px;text-align:right;}',
    '#piaotiao-phone-panel .pt-divider{text-align:center;font-size:10px;color:var(--dim);padding:6px 0 2px;}',
    '#piaotiao-phone-panel .pt-inputbar{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line);background:var(--header);flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-inputbar input{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 10px;font-size:12px;outline:none;}',
    '#piaotiao-phone-panel .pt-btn{border:none;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;color:#fff;background:var(--blue);}',
    '#piaotiao-phone-panel .pt-btn.green{background:var(--green);color:#123;font-weight:bold;}',
    '#piaotiao-phone-panel .pt-btn.red{background:var(--red);}',
    '#piaotiao-phone-panel .pt-btn.gray{background:var(--header);border:1px solid var(--line);color:var(--text);}',
    '#piaotiao-phone-panel .pt-chips{display:flex;gap:6px;overflow-x:auto;padding:6px 10px;flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-chip{flex-shrink:0;background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:14px;padding:4px 10px;font-size:11px;cursor:pointer;}',
    '#piaotiao-phone-panel .pt-typing{font-size:11px;color:var(--dim);padding:2px 14px 6px;font-style:italic;}',
    '#piaotiao-phone-panel .pt-cfg label{font-size:12px;color:var(--dim);display:block;margin:10px 14px 4px;}',
    '#piaotiao-phone-panel .pt-cfg input,#piaotiao-phone-panel .pt-cfg textarea,#piaotiao-phone-panel .pt-cfg select{width:calc(100% - 28px);margin:0 14px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 9px;font-size:12px;outline:none;resize:none;}',
    '#piaotiao-phone-panel input.piao-mask{-webkit-text-security:disc;}',
    '#piaotiao-phone-panel .pt-menu{position:fixed;z-index:10001;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden;min-width:120px;}',
    '#piaotiao-phone-panel .pt-menu div{padding:9px 14px;font-size:13px;color:var(--text);cursor:pointer;border-bottom:1px solid var(--line);}',
    '#piaotiao-phone-panel .pt-menu div:last-child{border-bottom:none;}',
    '#piaotiao-phone-panel .pt-menu div:active{background:var(--header);}',
    '#piaotiao-phone-panel svg text{font-family:system-ui,sans-serif;}',
  ].join('\n');

  function ensureCss() {
    if (DOC.getElementById('piaotiao-panel-css')) return;
    var st = DOC.createElement('style');
    st.id = 'piaotiao-panel-css';
    st.textContent = CSS;
    DOC.head.appendChild(st);
  }

  function ensureHost() {
    ensureCss();
    if (!root || !DOC.body.contains(root)) {
      if (root) root.remove();
      root = DOC.createElement('div');
      root.id = 'piaotiao-phone-root';
      root.style.cssText = 'position:fixed;left:70%;top:20%;z-index:9998;font-family:"Microsoft YaHei",system-ui,sans-serif;';
      DOC.body.appendChild(root);
      applyPos(root, FAB_KEY, defaultFabPos);
      makeDraggable(root, root, FAB_KEY, openPanel);
      renderFab();
    }
    if (!panelHost || !DOC.body.contains(panelHost)) {
      if (panelHost) panelHost.remove();
      panelHost = DOC.createElement('div');
      panelHost.id = 'piaotiao-phone-panel-root';
      panelHost.style.cssText = 'position:fixed;left:30%;top:12%;z-index:9999;display:none;font-family:"Microsoft YaHei",system-ui,sans-serif;';
      DOC.body.appendChild(panelHost);
      applyPos(panelHost, PANEL_KEY, defaultPanelPos);
      makeDraggable(panelHost, panelHost, PANEL_KEY, null, '#piaotiao-drag-handle'); // v0.3.1：仅标题栏发起拖拽
      panelEl = DOC.createElement('div');
      panelEl.id = 'piaotiao-phone-panel';
      panelEl.style.cssText = 'width:360px;max-width:94vw;height:600px;max-height:92vh;background:' + C.bg +
        ';border:1px solid ' + C.line + ';border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;color:' + C.text + ';';
      panelHost.appendChild(panelEl);
    }
    renderFab();
  }

  function renderFab() {
    if (!root) return;
    var unread = totalUnread();
    var pending = outboxCount();
    var badge = '';
    if (unread > 0) badge = '<span style="position:absolute;top:-6px;right:-6px;background:' + C.red + ';color:#fff;font-size:11px;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;pointer-events:none;">' + unread + '</span>';
    else if (pending > 0) badge = '<span style="position:absolute;top:-6px;right:-6px;background:' + C.blue + ';color:#fff;font-size:11px;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;pointer-events:none;">' + pending + '</span>';
    root.innerHTML = '<div id="piaotiao-phone-btn" title="批条 · 手机（可拖动）" style="cursor:grab;width:52px;height:52px;border-radius:14px;background:' + C.header + ';border:1px solid ' + C.line + ';box-shadow:0 4px 14px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;position:relative;user-select:none;touch-action:none;">' +
      '<span style="font-size:24px;pointer-events:none;">📱</span>' + badge + '</div>';
  }

  function openPanel() {
    ensureHost();
    panelHost.style.display = 'block';
    if (root) root.style.display = 'none'; // v0.3.4：面板打开时隐藏 FAB（窄屏两者重叠压字）
    render();
  }
  function closePanel() { if (panelHost) panelHost.style.display = 'none'; if (root) root.style.display = ''; }
  function panelVisible() { return panelHost && panelHost.style.display !== 'none'; }

  // ── 渲染 ──
  function render() {
    if (!panelEl) return;
    try {
      var tabs = [['wechat', '微信'], ['contacts', '联系人'], ['network', '关系网'], ['notes', '备忘录'], ['gallery', '图鉴'], ['settings', '设置']];
      var head =
        '<div id="piaotiao-drag-handle" style="background:' + C.header + ';padding:10px 14px;font-size:15px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;touch-action:none;">' +
        '<span>批条 · 这事，能办。</span><span id="piaotiao-close" style="cursor:pointer;color:' + C.dim + ';font-size:13px;">收起</span></div>' +
        '<div style="display:flex;border-bottom:1px solid ' + C.line + ';">' +
        tabs.map(function (t) {
          return '<div data-tab="' + t[0] + '" style="flex:1;text-align:center;padding:8px 0;cursor:pointer;font-size:13px;user-select:none;' +
            (currentView === t[0] ? 'color:' + C.green + ';border-bottom:2px solid ' + C.green + ';' : 'color:' + C.dim + ';') + '">' + t[1] + '</div>';
        }).join('') + '</div>';
      var body = '';
      if (currentView === 'wechat') body = currentConv ? viewThread() : viewWechatList();
      else if (currentView === 'contacts') body = viewContacts();
      else if (currentView === 'network') body = viewNetwork();
      else if (currentView === 'notes') body = viewNotes();
      else if (currentView === 'gallery') body = viewGallery();
      else if (currentView === 'settings') body = viewSettings();
      panelEl.innerHTML = head + '<div id="piaotiao-body" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;">' + body + '</div>';
      bindPanel();
      var sc = panelEl.querySelector('.pt-msgs');
      if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (e) {
      try { console.error(TAG, '渲染失败', e); toastr.error('渲染失败：' + ((e && e.message) || e), '批条 · 手机'); } catch (e2) {}
      if (panelEl) panelEl.innerHTML = '<div style="padding:16px;color:#e74c3c;font-size:13px;">渲染失败：' + esc(String(e && e.message || e)) + '</div>';
    }
  }

  function bindPanel() {
    var close = panelEl.querySelector('#piaotiao-close');
    if (close) close.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    panelEl.querySelectorAll('[data-tab]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); currentView = el.getAttribute('data-tab'); currentConv = null; _netSel = null; render(); });
    });
    if (currentView === 'wechat' && currentConv) bindThread();
    else if (currentView === 'wechat') bindWechatList();
    else if (currentView === 'settings') bindSettings();
    else if (currentView === 'contacts') bindContacts();
    else if (currentView === 'network') bindNetwork();
  }

  // ── 微信列表 ──
  function viewWechatList() {
    var v = ptRead();
    var npcs = (v.pt && v.pt.npcs) || {};
    var sd = ptStatData() || {};
    var ids = Object.keys(npcs).sort(function (a, b) { return (npcs[b].last_ts || 0) - (npcs[a].last_ts || 0); });
    var ob = loadOutbox();
    var obCount = outboxCount();
    var banner = '';
    if (obCount > 0) {
      banner = '<div id="piaotiao-sendall" class="pt-banner"><span class="n">' + obCount + '</span><span class="t">📨 确定发送，等他们回复</span></div>';
    }
    var rows = ids.map(function (id) {
      var npc = npcs[id];
      var name = convName(sd, id);
      var unread = npc.unread || 0;
      var queued = (ob[id] || []).length;
      var isFam = !!(sd.families && sd.families[id]);
      return '<div data-conv="' + esc(id) + '" class="pt-row">' +
        '<span class="pt-ava' + (isFam ? ' family' : '') + '">' + esc(String(name).slice(0, 1)) + '</span>' +
        '<span class="pt-mid"><span class="pt-name"><span>' + esc(name) + (npc.archetype ? ' <span style="font-size:10px;color:var(--dim);">' + esc(npc.archetype) + '</span>' : '') + '</span>' +
        '<span class="pt-time">' + (npc.dm_history && npc.dm_history.length ? esc((npc.dm_history[npc.dm_history.length - 1] || {}).time || '') : '') + '</span></span>' +
        '<span class="pt-prev">' + (queued > 0 ? '<span style="color:var(--blue);">✍️ 待发' + queued + '条 </span>' : '') + esc(npc.last_message || '') + '</span>' +
        (unread > 0 ? '<span class="pt-unread">' + unread + '</span>' : '') +
        '</span></div>';
    }).join('');
    return banner + '<div style="background:' + C.bg + ';">' + (rows || '<div style="padding:24px;color:var(--dim);text-align:center;font-size:13px;">暂无会话<br><span style="font-size:12px;">剧情里的微信往来会出现在这里</span></div>') + '</div>';
  }
  function bindWechatList() {
    var sa = panelEl.querySelector('#piaotiao-sendall');
    if (sa) sa.addEventListener('click', function (e) { e.stopPropagation(); sendAll(); });
    panelEl.querySelectorAll('[data-conv]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openConv(el.getAttribute('data-conv')); });
    });
  }

  // ── 确定发送（合并一次请求；生成器做点名补漏） ──
  function sendAll() {
    var ob = loadOutbox();
    var ids = Object.keys(ob).filter(function (k) { return (ob[k] || []).length; });
    if (!ids.length) { toast('info', '队列为空'); return; }
    var cfg = (function () { try { return JSON.parse(lsGet('piaotiao_dm_api') || 'null'); } catch (e) { return null; } })();
    if (!cfg || !((cfg.url || cfg.apiurl) && cfg.key)) {
      toast('warning', '先到「设置」填好独立 API 地址和 Key 再发送；你的消息还留在待发队列');
      return;
    }
    if (!window.__PiaotiaoDmGenerator) { toast('error', '私信模块还没就绪，消息已留在待发队列，稍后再试'); return; }
    var linesByConv = {}, parts = [], focus = [];
    ids.forEach(function (id) {
      var name = convName(null, id);
      linesByConv[name] = (ob[id] || []).map(String);
      focus.push(name);
      parts.push('对 ' + name + ' 说：' + linesByConv[name].map(function (s) { return '「' + s + '」'; }).join('、'));
    });
    var reason = '玩家在微信里' + parts.join('；') + '。只让这几个人本人回应这些，别的角色不要出现、不要插话。';
    var n = Math.min(6, Math.max(2, ids.length));
    saveOutbox({}).then(function () {
      setTyping(true);
      try { eventEmit('pt_request_dm', { reason: reason, n: String(n) + '-3', focus: focus, linesByConv: linesByConv }); } catch (e) { toast('error', '私信触发失败: ' + e.message); }
      toast('success', '📨 已发送，等他们回复…');
      renderFab();
      render();
    });
  }

  // ── 会话线程 ──
  function openConv(id) {
    currentConv = id;
    currentView = 'wechat';
    ptUpdate(function (v) {
      if (v.pt && v.pt.npcs && v.pt.npcs[id]) v.pt.npcs[id].unread = 0;
      return v;
    }).then(function () { renderFab(); render(); });
  }
  function viewThread() {
    var v = ptRead();
    var sd = ptStatData() || {};
    var npc = (v.pt && v.pt.npcs && v.pt.npcs[currentConv]) || { dm_history: [] };
    var name = convName(sd, currentConv);
    var list = npc.dm_history || [];
    var items = [];
    var lastDay = '';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var day = dayKey(m.ts);
      if (day !== lastDay) { items.push('<div class="pt-divider">' + esc(day) + '</div>'); lastDay = day; }
      items.push(renderOneMsg(m, i));
    }
    var typing = _typing ? '<div class="pt-typing">' + esc(name) + ' 正在输入…</div>' : '';
    var ob = loadOutbox();
    var queued = (ob[currentConv] || []).length;
    var QUICK = ['这事包在我身上。', '今晚见个面，细说。', '我尽量办。', '我会留意。', '老规矩。', '事情有进展，电话里不便说。'];
    return '<div class="pt-chat">' +
      '<div class="pt-chat-head" id="piaotiao-back"><span style="color:var(--dim);font-size:16px;">‹</span>' +
      '<span style="display:inline-block;line-height:1.15;max-width:230px;"><b>' + esc(name) + '</b>' +
      // v0.3.9：姓名下一行身份性格短句（引擎抓档案/账本生成，存 pt.npcs[*].tagline）
      (npc.tagline ? '<span style="display:block;font-size:10px;font-weight:normal;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(npc.tagline) + '</span>' : '') +
      '</span>' +
      (queued > 0 ? '<span style="margin-left:auto;font-size:11px;color:var(--blue);">✍️ 待发' + queued + '条</span>' : '') + '</div>' +
      '<div class="pt-msgs">' + (items.join('') || '<div style="text-align:center;color:var(--dim);padding:20px;font-size:12px;">暂无消息</div>') + '</div>' +
      typing +
      '<div class="pt-chips">' + QUICK.map(function (q) { return '<span class="pt-chip" data-quick="' + esc(q) + '">' + esc(q) + '</span>'; }).join('') + '</div>' +
      '<div class="pt-inputbar"><input id="piaotiao-input" placeholder="发消息…（加入待发，回列表统一发送）" autocomplete="off" />' +
      '<button id="piaotiao-queue" class="pt-btn">加入待发</button></div></div>';
  }
  function renderOneMsg(m, idx) {
    var mine = m.sender === 'ME';
    var type = m.type || 'text';
    var content = String(m.content || '');
    var inner = '';
    if (type === 'recall') inner = '<span class="pt-bub recall">' + (mine ? '你撤回了一条消息' : '对方撤回了一条消息') + '</span>';
    else if (type === 'transfer') {
      var amt = content.replace(/[^0-9.]/g, '') || content;
      inner = '<span class="pt-bub transfer">¥ ' + esc(amt) + '<div style="font-size:10px;color:var(--dim);margin-top:2px;">' + (mine ? '转账' : '收到转账') + '</div></span>';
    } else if (type === 'voice') inner = '<span class="pt-bub voice">▶ 语音 ' + esc(content).replace(/\n/g, ' ').slice(0, 80) + '</span>';
    else if (type === 'image') inner = '<span class="pt-bub">🖼 [图片] ' + esc(content).slice(0, 120) + '</span>';
    else inner = '<span class="pt-bub">' + esc(content) + '</span>';
    var tail = '<span class="pt-tail">' + esc(m.time || '') + '</span>';
    return '<div class="pt-msg ' + (mine ? 'mine' : 'theirs') + '" data-midx="' + idx + '" data-mine="' + (mine ? '1' : '0') + '">' + inner + tail + '</div>';
  }
  function bindThread() {
    var back = panelEl.querySelector('#piaotiao-back');
    if (back) back.addEventListener('click', function (e) { e.stopPropagation(); currentConv = null; render(); });
    var input = panelEl.querySelector('#piaotiao-input');
    var queueBtn = panelEl.querySelector('#piaotiao-queue');
    function doQueue() {
      var text = input && input.value.trim();
      if (!text || !currentConv) { toast('warning', '先输入要说的内容'); return; }
      queueOutbox(currentConv, text).then(function () {
        if (input) input.value = '';
        toast('success', '✍️ 已加入待发队列');
        renderFab();
        render();
      });
    }
    if (queueBtn) queueBtn.addEventListener('click', function (e) { e.stopPropagation(); doQueue(); });
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.stopPropagation(); doQueue(); } });
    panelEl.querySelectorAll('[data-quick]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var inp = panelEl.querySelector('#piaotiao-input');
        if (inp) { inp.value = el.getAttribute('data-quick'); inp.focus(); }
      });
    });
    // 消息长按菜单：撤回（自己的）/重掷（对方最后一条）/删除
    var pressTimer = null;
    panelEl.querySelectorAll('.pt-msg').forEach(function (el) {
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); showMsgMenu(el); });
      el.addEventListener('pointerdown', function () {
        pressTimer = setTimeout(function () { showMsgMenu(el); }, 550);
      });
      ['pointerup', 'pointerleave', 'pointermove'].forEach(function (ev) {
        el.addEventListener(ev, function () { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
      });
    });
    function showMsgMenu(el) {
      closeMsgMenu();
      var idx = parseInt(el.getAttribute('data-midx'), 10);
      var mine = el.getAttribute('data-mine') === '1';
      var v = ptRead();
      var npc = v.pt && v.pt.npcs && v.pt.npcs[currentConv];
      if (!npc) return;
      var m = (npc.dm_history || [])[idx];
      if (!m) return;
      _menuEl = DOC.createElement('div');
      _menuEl.className = 'pt-menu';
      _menuEl.id = 'piaotiao-msg-menu';
      var opts = [];
      if (mine && m.type !== 'recall') opts.push(['撤回', function () {
        ptUpdate(function (v2) { var n2 = v2.pt.npcs[currentConv]; if (n2 && n2.dm_history[idx]) { n2.dm_history[idx].type = 'recall'; n2.dm_history[idx].content = ''; } return v2; }).then(function () { closeMsgMenu(); render(); });
      }]);
      if (!mine && idx === (npc.dm_history.length - 1)) opts.push(['↻ 重掷这条', function () {
        ptUpdate(function (v2) { var n2 = v2.pt.npcs[currentConv]; if (n2 && n2.dm_history) n2.dm_history.splice(idx, 1); return v2; }).then(function () {
          closeMsgMenu(); render();
          setTyping(true);
          try { eventEmit('pt_request_dm', { reason: '重掷：' + npc.name + ' 刚才那条私信不算了，重新发一条新的（情境不变）', n: '1' }); } catch (e) {}
        });
      }]);
      opts.push(['删除', function () {
        ptUpdate(function (v2) { var n2 = v2.pt.npcs[currentConv]; if (n2 && n2.dm_history) n2.dm_history.splice(idx, 1); return v2; }).then(function () { closeMsgMenu(); render(); });
      }]);
      opts.forEach(function (o) {
        var d = DOC.createElement('div');
        d.textContent = o[0];
        d.addEventListener('click', function (e) { e.stopPropagation(); o[1](); });
        _menuEl.appendChild(d);
      });
      panelHost.appendChild(_menuEl);
      var r = el.getBoundingClientRect();
      _menuEl.style.position = 'fixed';
      _menuEl.style.left = Math.min(r.left, vpW() - 140) + 'px';
      _menuEl.style.top = Math.min(r.bottom + 4, vpH() - 120) + 'px';
      setTimeout(function () { DOC.addEventListener('click', closeMsgMenu, { once: true }); }, 0);
    }
  }
  function closeMsgMenu() { if (_menuEl && _menuEl.parentNode) _menuEl.parentNode.removeChild(_menuEl); _menuEl = null; }

  // ── 联系人（stat_data 真源；点行进会话） ──
  function viewContacts() {
    var sd = ptStatData() || {};
    var cs = sd.contacts || {};
    var rows = '';
    var ptv = ptRead();
    var allNpcs = (ptv && ptv.pt && ptv.pt.npcs) || {};
    function taglineOf(npcId, npcName) {
      var n = allNpcs[npcId] || allNpcs[npcName];
      return (n && n.tagline) ? String(n.tagline) : '';
    }
    function taglineHtml(line) {
      return line ? '<span style="display:block;font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(line) + '</span>' : '';
    }
    for (var id in cs) {
      var c = cs[id];
      var status = ptBare(c.status) || '?';
      var color = status === 'hostile' ? 'var(--red)' : (status === 'active' || status === 'available') ? 'var(--green)' : 'var(--dim)';
      rows += '<div class="pt-row" data-contact="' + esc(id) + '"><span class="pt-ava">' + esc(String(ptBare(c.name) || id).slice(0, 1)) + '</span>' +
        '<span class="pt-mid"><span class="pt-name">' + esc(ptBare(c.name) || id) + '<span style="font-size:11px;color:' + color + ';">' + esc(ptBare(c.attitude) || '') + '·' + esc(status) + '</span>' +
        // v0.3.9：姓名下一行身份性格短句（引擎从世界书档案抓取，兜底用账本 group/attitude 拼）
        taglineHtml(taglineOf(id, ptBare(c.name) || id) || ((ptBare(c.group) || '体制内') + '联系人，对你' + (ptBare(c.attitude) || '保持观望'))) + '</span>' +
        '<span class="pt-meta">想要：' + esc(ptBare(c.wants) || '—') + '｜能办：' + esc(ptBare(c.can_provide) || '—') + '｜他欠我' + ((c.favors_owed || []).length) + '·我欠他' + ((c.favors_debt || []).length) + '</span></span></div>';
    }
    var fams = sd.families || {};
    var frows = '';
    for (var fid in fams) {
      var f = fams[fid];
      var head = f.head || {};
      var hid = (head && ptBare(head.name)) || fid;
      // v0.3.5：成员行化——家主/配偶/子女各自成行（正文出场即自动入列的载体）
      function famRow(name, role, rel, extra) {
        var nm = String(name || '').trim();
        if (!nm) return '';
        var roleTag = role === '一家之主' ? '' : '<span style="font-size:10px;color:var(--gold);margin-left:6px;">' + role + '</span>';
        return '<div class="pt-row" data-contact="' + esc(nm) + '"><span class="pt-ava family">' + esc(nm.slice(0, 1)) + '</span>' +
          '<span class="pt-mid"><span class="pt-name">' + esc(nm) + roleTag + '<span style="font-size:11px;color:var(--dim);">' + esc(ptBare(f.name) || '') + '家' + (rel !== null && rel !== undefined ? '·关系' + rel : '') + '</span>' +
          // v0.3.9：家庭成员身份句（账本家庭结构拼接；引擎抓的 tagline 优先）
          taglineHtml(taglineOf(nm, nm) || ((ptBare(f.name) || '') + '家' + (role === '一家之主' ? '家主' : role) + '，家里的事瞒着TA也瞒着外头')) + '</span>' +
          '<span class="pt-meta">' + (extra || '') + '</span></span></div>';
      }
      frows += famRow(hid, '一家之主', ptBare(head.relationship) || 0, '请求：' + esc(f.request ? ptBare(f.request.type) + '/' + ptBare(f.request.status) : '无') + '｜暴露：' + (ptBare(f.exposure_risk) || 0));
      var sp = f.spouse || {};
      if (ptBare(sp.name)) frows += famRow(ptBare(sp.name), '配偶', ptBare(sp.relationship) || 0, '察觉：' + (ptBare(sp.awareness) || 0) + '｜同谋：' + (ptBare(sp.complicity) || 0));
      var ch = f.children || {};
      for (var cid in ch) {
        var c = ch[cid];
        if (!ptBare(c.name)) continue;
        frows += famRow(ptBare(c.name), '子女', ptBare(c.relationship) || 0, '察觉：' + (ptBare(c.awareness) || 0) + '｜立场：' + esc(ptBare(c.stance) || '—'));
      }
    }
    return '<div style="padding:10px 14px;font-size:12px;color:var(--dim);">点联系人可直达会话（档案由账本驱动）</div>' +
      (frows ? '<div style="padding:4px 14px;font-size:11px;color:var(--gold);">在办家庭</div>' + frows : '') +
      (rows ? '<div style="padding:4px 14px;font-size:11px;color:var(--gold);">体制联系人</div>' + rows : '<div style="padding:24px;color:var(--dim);text-align:center;">关系网尚未展开</div>');
  }
  function bindContacts() {
    panelEl.querySelectorAll('[data-contact]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openConv(el.getAttribute('data-contact')); });
    });
  }

  // ── 关系网（v0.3.9：节点提纲 + 点击节点看详情） ──
  var _netSel = null;                                        // 当前选中的节点（null=网络图视图）
  function viewNetwork() {
    var sd = ptStatData() || {};
    var cs = sd.contacts || {};
    var ptv = ptRead();
    var allNpcs = (ptv && ptv.pt && ptv.pt.npcs) || {};
    function outlineOf(id, c) {
      var n = allNpcs[id];
      if (n && n.tagline) return String(n.tagline);
      return String(ptBare(c.group) || '体制内') + '，对你' + String(ptBare(c.attitude) || '观望');
    }
    var ids = Object.keys(cs);
    // 详情视图：点开某个节点
    if (_netSel && cs[_netSel]) {
      var cD = cs[_netSel];
      var nD = allNpcs[_netSel];
      var tagD = (nD && nD.tagline) || outlineOf(_netSel, cD);
      function drow(label, v, color) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 16px;border-bottom:1px solid var(--line);font-size:12px;"><span style="color:var(--dim);white-space:nowrap;">' + label + '</span><span style="color:' + (color || 'var(--text)') + ';text-align:right;">' + esc(String(v)) + '</span></div>';
      }
      var lev = cD.leverage || [];
      var relD = Number(ptBare(cD.relationship)) || 0;
      var owedD = (cD.favors_owed || []).length, debtD = (cD.favors_debt || []).length;
      return '<div style="padding:10px 14px 4px;"><span id="piaotiao-net-back" style="cursor:pointer;color:var(--dim);font-size:13px;">‹ 返回网络</span></div>' +
        '<div style="padding:6px 16px 12px;border-bottom:1px solid var(--line);"><b style="font-size:16px;">' + esc(ptBare(cD.name) || _netSel) + '</b>' +
        '<div style="font-size:11px;color:var(--dim);margin-top:3px;">' + esc(tagD) + '</div></div>' +
        drow('关系', relD + ' / 100', relD >= 60 ? 'var(--green)' : relD < 20 ? 'var(--red)' : 'var(--text)') +
        drow('对你的态度', ptBare(cD.attitude) || '—') +
        drow('TA 想要', ptBare(cD.wants) || '—') +
        drow('TA 能办', ptBare(cD.can_provide) || '—') +
        drow('把柄', lev.length ? esc(lev.map(function (l) { return ptBare(l) || String(l); }).join('、')) : '暂无', lev.length ? 'var(--gold)' : 'var(--dim)') +
        drow('把柄强度', (Number(ptBare(cD.leverage_strength)) || 0) + ' / 5') +
        drow('人情账', '他欠我 ' + owedD + ' · 我欠他 ' + debtD) +
        drow('状态', String(ptBare(cD.status) || '—'), String(ptBare(cD.status)) === 'hostile' ? 'var(--red)' : 'var(--green)');
    }
    if (!ids.length) return '<div style="padding:24px;color:var(--dim);text-align:center;">暂无节点</div>';
    var W = 320, H = 380, cx = W / 2, cy = H / 2, R = 120;
    var nodes = ids.map(function (id, i) {
      var c = cs[id];
      var ang = (Math.PI * 2 * i) / ids.length - Math.PI / 2;
      var rel = Number(ptBare(c.relationship)) || 0;
      return { id: id, name: String(ptBare(c.name) || id), rel: rel, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), outline: outlineOf(id, c) };
    });
    var lines = nodes.map(function (n) {
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + n.x + '" y2="' + n.y + '" stroke="' + (n.rel >= 0 ? C.green : C.red) + '" stroke-width="1.2" opacity="0.55" />';
    }).join('');
    // v0.3.9：节点圈姓名 + 圈下 2-4 字提纲；点击节点看详情
    var dots = nodes.map(function (n) {
      var words = n.outline.replace(/[，,。；].*$/, '').slice(0, 6);
      return '<g data-netnode="' + esc(n.id) + '" style="cursor:pointer;">' +
        '<circle cx="' + n.x + '" cy="' + n.y + '" r="24" fill="' + C.panel + '" stroke="' + C.blue + '" />' +
        '<text x="' + n.x + '" y="' + (n.y + 1) + '" text-anchor="middle" font-size="11" fill="' + C.text + '">' + esc(n.name.slice(0, 4)) + '</text>' +
        '<text x="' + n.x + '" y="' + (n.y + 38) + '" text-anchor="middle" font-size="9" fill="' + C.dim + '">' + esc(words) + '</text></g>';
    }).join('');
    return '<div style="padding:8px 14px 0;font-size:11px;color:var(--dim);">点节点看详情</div>' +
      '<div style="flex:1;display:flex;align-items:center;"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;">' + lines +
      '<circle cx="' + cx + '" cy="' + cy + '" r="30" fill="' + C.mine + '" stroke="' + C.green + '" />' +
      '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="12" fill="#fff">我</text>' + dots + '</svg></div>';
  }
  function bindNetwork() {
    var back = panelEl.querySelector('#piaotiao-net-back');
    if (back) back.addEventListener('click', function (e) { e.stopPropagation(); _netSel = null; render(); });
    panelEl.querySelectorAll('[data-netnode]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        _netSel = el.getAttribute('data-netnode');
        render();
      });
    });
  }

  // ── 备忘录 ──
  function viewNotes() {
    var sd = ptStatData() || {};
    var p = sd.player || {}, d = sd.derived || {};
    function row(label, v, color) {
      return '<div style="display:flex;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--line);"><span style="color:var(--dim);">' + label + '</span><span style="color:' + (color || 'var(--text)') + ';">' + esc(String(v)) + '</span></div>';
    }
    var favors = '';
    for (var id in (sd.contacts || {})) {
      var c = sd.contacts[id];
      var owed = (c.favors_owed || []).length, debt = (c.favors_debt || []).length;
      if (!owed && !debt) continue;
      favors += '<div style="padding:8px 14px;font-size:12px;border-bottom:1px solid var(--line);">' + esc(ptBare(c.name) || id) + '：<span style="color:var(--green)">他欠我 ' + owed + '</span> / <span style="color:var(--red)">我欠他 ' + debt + '</span></div>';
    }
    function num(x) { return ptBare(x) != null ? ptBare(x) : 0; }
    var expo = Number(num(d.exposure_global)) || 0;
    // ── v0.3.9：当前待办（账本 active 事件 + 未读私信 + 待发队列） ──
    var todos = '';
    var evs = sd.events || {};
    for (var eid in evs) {
      var ev = evs[eid];
      if (String(ptBare(ev.status) || '') !== 'active') continue;
      var urg = String(ptBare(ev.urgency) || '');
      var urgColor = urg === '高' ? 'var(--red)' : urg === '中' ? 'var(--gold)' : 'var(--dim)';
      todos += '<div style="padding:8px 14px;font-size:12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;">' +
        '<span>☐ ' + esc(ptBare(ev.type) || '事项') + ' · ' + esc(ptBare(ev.source) || '?') + '</span>' +
        '<span style="color:' + urgColor + ';white-space:nowrap;">' + esc(urg || '—') + '</span></div>';
    }
    var ptNow = ptRead();
    var npcNow = (ptNow && ptNow.pt && ptNow.pt.npcs) || {};
    var unreadSum = 0;
    for (var uk in npcNow) unreadSum += (npcNow[uk].unread || 0);
    var obNow = loadOutbox();
    var queuedSum = 0;
    for (var ok in obNow) queuedSum += (obNow[ok] || []).length;
    if (unreadSum > 0) todos += '<div style="padding:8px 14px;font-size:12px;border-bottom:1px solid var(--line);">💬 未读私信 <b style="color:var(--gold);">' + unreadSum + '</b> 条</div>';
    if (queuedSum > 0) todos += '<div style="padding:8px 14px;font-size:12px;border-bottom:1px solid var(--line);">✍️ 待发消息 <b style="color:var(--blue);">' + queuedSum + '</b> 条</div>';
    var todoBlock = '<div style="padding:10px 14px;color:var(--dim);font-size:12px;">当前待办</div>' +
      (todos || '<div style="padding:10px 14px;color:var(--dim);font-size:12px;">暂无待办——正好歇口气</div>');
    return '<div style="padding-top:4px;">' +
      row('影响力', num(p.influence)) +
      row('资金', '¥ ' + Number(num(p.capital)).toLocaleString('zh-CN')) +
      row('保护伞', num(p.protection) + ' / 5') +
      row('暴露风险', expo + ' / 100', expo > 50 ? 'var(--red)' : 'var(--text)') +
      row('人情余额', (num(d.favors_balance)) + '（我欠 ' + (num(d.favors_debt_total)) + '）') +
      row('关系网等级', num(d.network_level), 'var(--green)') +
      '</div>' + todoBlock + '<div style="padding:10px 14px;color:var(--dim);font-size:12px;">人情账目</div>' + (favors || '<div style="padding:10px 14px;color:var(--dim);font-size:12px;">暂无往来</div>');
  }

  // ── 图鉴（P5：跨聊天结局收藏；解锁记录在脚本级持久存储，MVU 只带本局结果） ──
  // ENDING_META 的 name/gallery 两列与卡内 ending-copy.js 人工保持一致
  var ENDING_META = {
    A: ['教父', '你成了规矩本身'], B: ['牺牲品', '权力只保护自己'], C: ['白手套', '干净是买来的'],
    D: ['被吞噬者', '别人流程里的一个章'], E: ['共生体', '谁也不敢先动'], F: ['末路', 'S市不缺下一个中间人'],
  };
  function galleryRead() {
    // v0.3.3-W5：主存 localStorage（重导卡不清档）；脚本级旧数据自动迁移进主存
    var out = {};
    try { out = JSON.parse(lsGet('piaotiao_gallery_v1') || '{}') || {}; } catch (e0) { out = {}; }
    try {
      var v = getVariables({ type: 'script' }) || {};
      var legacy = v.piaotiao_gallery || {};
      Object.keys(legacy).forEach(function (k) { if (!out[k]) out[k] = legacy[k]; });
    } catch (e1) { /* TH 不可用时只用主存 */ }
    return out;
  }
  function fmtDay(ts) {
    var d = new Date(ts);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate());
  }
  function viewGallery() {
    var g = galleryRead();
    var sd = ptStatData() || {};
    var cur = sd.endings ? ptBare(sd.endings.current_ending) : null;
    var rows = '';
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(function (x) {
      var m = ENDING_META[x] || [x, ''];
      var rec = g[x];
      var isCur = cur === x;
      var right = rec
        ? '<span style="color:var(--green);font-size:11px;flex-shrink:0;">✓ ' + fmtDay(rec.ts) + '</span>'
        : '<span style="color:var(--dim);font-size:11px;flex-shrink:0;">未解锁</span>';
      rows += '<div class="pt-row" style="cursor:default;' + (isCur ? 'border-left:3px solid var(--gold);' : '') + '">' +
        '<span class="pt-ava" style="' + (rec ? 'background:var(--gold);' : 'filter:grayscale(1);opacity:.5;') + '">' + (rec ? x : '?') + '</span>' +
        '<span class="pt-mid"><span class="pt-name"><span>' + (rec ? esc(m[0]) : '<span style="color:var(--dim);">？？？</span>') +
        (isCur ? ' <span style="font-size:10px;color:var(--gold);">本局</span>' : '') + '</span>' + right + '</span>' +
        '<span class="pt-prev">' + (rec ? esc(m[1]) : '这条路线还没有人走到头') + '</span></span></div>';
    });
    return '<div style="padding:10px 14px;font-size:12px;color:var(--dim);">跨聊天图鉴 · 解锁一次永久点亮（存本机，重导卡不清档）</div>' + rows;
  }

  // ── 设置 ──
  var API_KEY_STORAGE = 'piaotiao_dm_api';
  function viewSettings() {
    var cfg = (function () { try { return JSON.parse(lsGet(API_KEY_STORAGE) || 'null') || {}; } catch (e) { return {}; } })();
    var attrs = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"';
    var plotN = parseInt(lsGet('piaotiao_plot_n'), 10) || 6;
    return '<div class="pt-cfg" style="padding-bottom:14px;">' +
      '<div style="background:var(--header);padding:9px 14px;font-size:13px;margin-bottom:4px;"><b>手机设置</b> <span style="color:var(--dim);font-size:11px;">independent API</span></div>' +
      '<label>API 地址（OpenAI 兼容）</label><textarea id="piaotiao-cfg-url" rows="1" ' + attrs + ' placeholder="https://api.xxx.com/v1">' + esc(cfg.url || cfg.apiurl || '') + '</textarea>' +
      '<label>API Key</label><input id="piaotiao-cfg-key" type="text" class="piao-mask" readonly ' + attrs + ' placeholder="sk-..." value="' + esc(cfg.key || '') + '" />' +
      '<label>模型名（🔄 拉取后可选）</label><input id="piaotiao-cfg-model" list="piaotiao-cfg-models" ' + attrs + ' placeholder="deepseek-chat" value="' + esc(cfg.model || '') + '" />' +
      '<datalist id="piaotiao-cfg-models"></datalist>' +
      '<div style="display:flex;gap:8px;margin:12px 14px 0;">' +
      '<button id="piaotiao-cfg-fetch" class="pt-btn gray" style="flex:1;">🔄 拉取模型</button>' +
      '<button id="piaotiao-cfg-save" class="pt-btn green" style="flex:1;">💾 保存</button>' +
      '<button id="piaotiao-cfg-clear" class="pt-btn red" style="flex:1;">🗑️ 清除</button></div>' +
      '<div id="piaotiao-cfg-msg" style="text-align:left;padding:6px 16px;font-size:12px;min-height:18px;color:var(--green);"></div>' +
      '<label>私信读正文层数（默认 6）</label><input id="piaotiao-cfg-plotn" type="number" min="1" max="20" value="' + plotN + '" style="width:80px;" />' +
      '<label>其他</label>' +
      '<div style="margin:0 14px;font-size:12px;color:var(--dim);line-height:1.7;">私信只走这里填的独立 API，不占聊天 API。Key 只存本机浏览器，不进聊天文件。🔄 拉取模型兼连通性测试。<span style="color:var(--red);">公益站谨慎使用，易误封。</span></div>' +
      '</div>';
  }
  function bindSettings() {
    var keyInput = panelEl.querySelector('#piaotiao-cfg-key');
    if (keyInput) {
      keyInput.readOnly = true;
      panelHost.addEventListener('focusin', function (e) { if (e.target && e.target.id === 'piaotiao-cfg-key') e.target.removeAttribute('readonly'); });
    }
    var save = panelEl.querySelector('#piaotiao-cfg-save');
    if (save) save.addEventListener('click', function (e) {
      e.stopPropagation();
      var c = {
        url: panelEl.querySelector('#piaotiao-cfg-url').value.trim(),
        key: panelEl.querySelector('#piaotiao-cfg-key').value.trim(),
        model: panelEl.querySelector('#piaotiao-cfg-model').value.trim(),
      };
      try { lsSet(API_KEY_STORAGE, JSON.stringify(c)); } catch (e2) { toast('error', '保存失败'); }
      var plotN = parseInt(panelEl.querySelector('#piaotiao-cfg-plotn').value, 10);
      if (plotN > 0) lsSet('piaotiao_plot_n', String(plotN));
      var msg = panelEl.querySelector('#piaotiao-cfg-msg');
      if (msg) msg.textContent = '✅ 设置成功，已保存' + ((c.url && c.key) ? '：私信将使用独立 API' : '：私信暂不生成（未填地址/Key）');
      toast('success', '✅ 设置已保存');
    });
    var clear = panelEl.querySelector('#piaotiao-cfg-clear');
    if (clear) clear.addEventListener('click', function (e) {
      e.stopPropagation();
      lsDel(API_KEY_STORAGE);
      var msg = panelEl.querySelector('#piaotiao-cfg-msg');
      if (msg) msg.textContent = '🗑️ 已清除：私信暂不生成';
      toast('info', '已清除独立 API 配置');
    });
    var fetchBtn = panelEl.querySelector('#piaotiao-cfg-fetch');
    if (fetchBtn) fetchBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var u = panelEl.querySelector('#piaotiao-cfg-url').value.trim();
      var k = panelEl.querySelector('#piaotiao-cfg-key').value.trim();
      if (!u || !k) { toast('warning', '先填 API 地址和 Key'); return; }
      fetchBtn.textContent = '⏳ 拉取中…';
      var mu = u.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      mu = /\/v\d+$/.test(mu) ? mu + '/models' : mu + '/v1/models';
      fetch(mu, { headers: { 'Authorization': 'Bearer ' + k } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        var ids = (j.data || j.models || []).map(function (m) { return (m && (m.id || m.name)) || m; }).filter(function (x) { return typeof x === 'string'; });
        if (!ids.length) throw new Error('返回里没有模型列表');
        panelEl.querySelector('#piaotiao-cfg-models').innerHTML = ids.map(function (id) { return '<option value="' + esc(id) + '">'; }).join('');
        toast('success', '📡 拉到 ' + ids.length + ' 个模型——连通性OK');
        fetchBtn.textContent = '🔄 拉取模型(' + ids.length + ')';
      }).catch(function (err) {
        toast('error', '拉取失败: ' + ((err && err.message) || err));
        fetchBtn.textContent = '🔄 拉取模型';
      });
    });
  }

  // ── 自愈：swipe/换聊天导致 body 重建时重挂 ──
  function selfHealLoop() {
    setInterval(function () {
      try {
        if (!DOC.getElementById('piaotiao-phone-root') || !DOC.getElementById('piaotiao-phone-panel-root') || !DOC.getElementById('piaotiao-panel-css')) {
          root = null; panelHost = null; panelEl = null; ensureHost();
        }
      } catch (e) {}
    }, 10000);
  }

  function updateBadge() { try { renderFab(); } catch (e) {} }

  // ── 事件 ──
  function bindEvents() {
    if (typeof eventOn === 'function') {
      eventOn('pt_updated', function () { _typing = false; updateBadge(); if (panelVisible()) render(); });
      eventOn('pt_floor_log', function () { updateBadge(); });
      return true;
    }
    return false;
  }
  function mount() {
    ensureHost();
    if (!bindEvents()) {
      var waited = 0;
      var timer = setInterval(function () {
        waited += 400;
        if (bindEvents() || waited > 30000) clearInterval(timer);
      }, 400);
    }
    console.info(TAG, '已挂载：悬浮手机（微信/联系人/关系网/备忘录/设置），可拖动');
    selfHealLoop();
  }
  mount();
  window.__PiaotiaoPhonePanel = true;
})();
