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

  // v0.3.21（用户拍板：微信白天模式）——白底灰卡、微信绿 #07c160 唯一强调、
  // 我方气泡 #95ec69 / 对方纯白、文字 #191919，次级信息 #9c9c9c
  var C = {
    bg: '#ededed', panel: '#ffffff', header: '#ededed', line: '#e0e0e0',
    text: '#191919', dim: '#9c9c9c', red: '#fa5151', green: '#07c160',
    blue: '#10aeff', mine: '#95ec69', theirs: '#ffffff', gold: '#bd8b23',
    // v0.3.25（三席联审 J16）：警告语义色收进 token 表——原来三处散落字面量改主题必漏
    warn: '#b3541e', err: '#e74c3c',
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
  // v0.3.23（三席联审 M7）：面板与私信引擎原本各持一把锁、都写同一棵 pt 子树，军规 14 的
  // 「共用一把锁」跨模块不成立。两个模块由 phone-loader 在同一 iframe 里 eval，故锁挂共享宿主
  // window：先加载者建，后加载者接同一根链条。每次取锁都读宿主当前尾巴，不缓存本地变量。
  function ptWriteHost() {
    try {
      var w = (typeof window !== 'undefined') ? window : null;
      if (!w) return null;
      if (!w.__PiaotiaoWriteQ || typeof w.__PiaotiaoWriteQ.q === 'undefined') w.__PiaotiaoWriteQ = { q: Promise.resolve() };
      return w.__PiaotiaoWriteQ;
    } catch (e) { return null; }
  }
  function ptRead() { try { return getVariables({ type: 'chat' }) || {}; } catch (e) { return {}; } }
  function ptUpdate(fn) {
    var host = ptWriteHost();
    var tail = host ? host.q : Promise.resolve();
    var next = tail.then(function () { return updateVariablesWith(fn, { type: 'chat' }); })
      .catch(function (e) { console.error(TAG, '写变量失败', e); toast('error', '写变量失败: ' + ((e && e.message) || e)); });
    if (host) host.q = next;
    return next;
  }
  // v0.3.23（三席联审 M10）：旧写法只探 VIEW.SillyTavern.saveChat——不在本体上就是静默 no-op、
  // 外层 catch 空吞（疑似死代码）。聊天级变量本身由 TH 的 updateVariablesWith 落盘，这里只是
  // 保险：逐级找可用的保存入口，全找不到时留一条 console 证据（不再静默）。
  var _saveChatWarned = false;
  function ptSaveChat() {
    try {
      if (VIEW.SillyTavern && typeof VIEW.SillyTavern.saveChat === 'function') { VIEW.SillyTavern.saveChat(); return; }
    } catch (e0) { /* 继续找下一级 */ }
    try {
      var ctx = VIEW.SillyTavern && VIEW.SillyTavern.getContext ? VIEW.SillyTavern.getContext() : null;
      if (ctx && typeof ctx.saveChat === 'function') { ctx.saveChat(); return; }
    } catch (e1) { /* 继续 */ }
    if (!_saveChatWarned) {
      _saveChatWarned = true;
      console.info(TAG, '未找到 saveChat 入口：聊天级变量由酒馆助手自行落盘，跳过显式保存');
    }
  }
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
  // v0.3.18（三席联审 A6 轻方案）：独立 API 配置与否三处共用——sendAll 闸、微信列表/会话页
  // 常驻提示条。没配 API 时消息永远停在待发箱（开局页还引导玩家去回话），必须常驻出声，
  // 不能只靠 sendAll 那一次性 toast。
  function ptApiReady() {
    try {
      var c = JSON.parse(lsGet('piaotiao_dm_api') || 'null');
      return !!(c && ((c.url || c.apiurl) && c.key));
    } catch (e) { return false; }
  }
  function queueOutbox(id, line) {
    // v0.3.17（三席联审 J2）：入队键规范为人名——与微信会话键/发送 linesByConv 同键。
    // 旧行为联系人页入队写拼音 id，微信列表与线程只按人名读 → 待发消息隐身。
    try { var nm = convName(null, id); if (nm) id = nm; } catch (e) {}
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
  // v0.3.25（三席联审 J13）：校准从「每个 pointermove 一次」改为「拖拽起点一次＋视口 resize 补校准」——
  // 旧版 move 事件里建删 DOM 探针＝每次移动强制回流，高轮询鼠标一秒上千次，拖拽发涩
  if (VIEW.visualViewport) VIEW.visualViewport.addEventListener('resize', function () { recalib(); });
  function vpW() { return (VIEW.visualViewport && VIEW.visualViewport.width) || VIEW.innerWidth; }
  function vpH() { return (VIEW.visualViewport && VIEW.visualViewport.height) || VIEW.innerHeight; }
  function setClientPos(el, cx, cy) { el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.left = ((cx - CAL.ox) / CAL.sx) + 'px'; el.style.top = ((cy - CAL.oy) / CAL.sy) + 'px'; }
  // v0.3.22（真机 390px 窄屏实测翻车）：旧夹持按固定 64px 余量算右/下边界——那是按 52px 悬浮球
  // 调的；面板 367px 宽时左上角最多只能夹到 vpW−64，右半截 303px 全挂在屏外（同浏览器从宽窗口
  // 缩窄必踩）。改为按元素自身宽高夹持：任何元素都以「整体留在屏内（留 8px 边距）」为界，
  // 悬浮球行为不变（52px 与旧 64px 余量几乎重合）。
  function clampXY(x, y, el, margin) {
    var w = (el && el.offsetWidth) || (margin || 64);
    var h = (el && el.offsetHeight) || (margin || 64);
    return { x: Math.max(8, Math.min(x, vpW() - w - 8)), y: Math.max(8, Math.min(y, vpH() - h - 8)) };
  }
  function loadPos(key) { try { var s = lsGet(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function savePos(key, x, y) { try { lsSet(key, JSON.stringify({ x: x, y: y })); } catch (e) {} }
  function applyPos(el, key, defFn) {
    recalib();
    var pos = loadPos(key);
    if (pos) { var c = clampXY(pos.x, pos.y, el); setClientPos(el, c.x, c.y); return; }
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
      // v0.3.25（三席联审 J17）：零捕获＋document 级跟踪的代价——指针在窗口外松手时 pointerup
      // 不入 DOC，旧手势卡死会拒绝一切新拖拽。新指针按下且 pid 不同＝旧手势已死，接管。
      if (g) { if (g.pid === e.pointerId) return; g = null; }
      if (gate && !(e.target && e.target.closest && e.target.closest(gate))) return;
      var r = el.getBoundingClientRect();
      g = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      // 此刻意不捕获、不 preventDefault：保住子元素 click 与输入框 focus
    });
    DOC.addEventListener('pointermove', function (e) {
      if (!g || e.pointerId !== g.pid) return;
      var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (!g.moved) recalib(); // v0.3.25（J13）：校准只在拖拽起点做一次，move 循环用缓存
      g.moved = true;
      var c = clampXY(g.ox + dx, g.oy + dy, el);
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
    // v0.3.24（三席联审 J11）：变量同时挂 panel-root——长按菜单是 panelHost 的子节点（panelEl 的兄弟），
    // 只挂 panelEl 时菜单的 var(--panel)/var(--line)/var(--text) 全解析无效＝透明底无边框，暗色主题不可读
    '#piaotiao-phone-panel-root,#piaotiao-phone-panel{--bg:' + C.bg + ';--panel:' + C.panel + ';--header:' + C.header + ';--line:' + C.line + ';--text:' + C.text + ';--dim:' + C.dim + ';--red:' + C.red + ';--green:' + C.green + ';--blue:' + C.blue + ';--mine:' + C.mine + ';--theirs:' + C.theirs + ';--gold:' + C.gold + ';}',
    '#piaotiao-phone-panel *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
    '#piaotiao-phone-panel .pt-row{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel);cursor:pointer;}',
    '#piaotiao-phone-panel .pt-row:active{background:#e5e5e5;}',
    '#piaotiao-phone-panel .pt-ava{flex-shrink:0;width:40px;height:40px;border-radius:9px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;text-shadow:0 1px 2px rgba(0,0,0,.15);}',
    '#piaotiao-phone-panel .pt-ava.family{background:var(--red);}',
    '#piaotiao-phone-panel .pt-mid{flex:1;min-width:0;}',
    '#piaotiao-phone-panel .pt-name{font-size:14px;color:var(--text);display:flex;justify-content:space-between;align-items:baseline;gap:6px;min-width:0;}',
    // v0.3.20（用户真机反馈）：三字名被状态标签挤得从中间断行（白景/舟）——
    // 名字永不压缩不换行，标签与长句各自走省略号
    '#piaotiao-phone-panel .pt-nm{flex-shrink:0;white-space:nowrap;}',
    '#piaotiao-phone-panel .pt-tag{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
    '#piaotiao-phone-panel .pt-prev{font-size:12px;color:var(--dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#piaotiao-phone-panel .pt-unread{background:var(--red);color:#fff;border-radius:10px;min-width:18px;text-align:center;font-size:11px;padding:2px 5px;flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-time{font-size:10px;color:var(--dim);flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-meta{font-size:12px;color:var(--dim);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#piaotiao-phone-panel .pt-banner{margin:10px 12px 4px;background:var(--green);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);}',
    '#piaotiao-phone-panel .pt-banner .n{background:var(--red);color:#fff;border-radius:10px;min-width:20px;text-align:center;font-size:12px;font-weight:bold;padding:2px 6px;}',
    '#piaotiao-phone-panel .pt-banner .t{color:#fff;font-weight:bold;font-size:13px;}',
    '#piaotiao-phone-panel .pt-chat{display:flex;flex-direction:column;height:100%;}',
    '#piaotiao-phone-panel .pt-chat-head{background:var(--panel);padding:9px 12px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;flex-shrink:0;border-bottom:1px solid var(--line);}',
    '#piaotiao-phone-panel .pt-msgs{flex:1;overflow-y:auto;padding:8px 0;display:flex;flex-direction:column;gap:2px;}',
    '#piaotiao-phone-panel .pt-msg{display:flex;padding:3px 12px;gap:8px;align-items:flex-end;}',
    '#piaotiao-phone-panel .pt-msg.mine{flex-direction:row-reverse;}',
    // v0.3.21 微信白天模式：对方白泡左尖角、我方浅绿泡右尖角
    '#piaotiao-phone-panel .pt-bub{max-width:78%;background:var(--theirs);color:var(--text);border-radius:4px 12px 12px 12px;padding:7px 11px;font-size:13.5px;line-height:1.55;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '#piaotiao-phone-panel .pt-msg.mine .pt-bub{background:var(--mine);border-radius:12px 4px 12px 12px;}',
    '#piaotiao-phone-panel .pt-bub.sys{background:transparent;color:var(--dim);font-size:11px;text-align:center;max-width:100%;box-shadow:none;}',
    '#piaotiao-phone-panel .pt-bub.recall{background:transparent;color:var(--dim);font-size:12px;font-style:italic;box-shadow:none;}',
    '#piaotiao-phone-panel .pt-bub.transfer{border:1px solid var(--gold);color:var(--gold);background:#fdf6e9;}',
    '#piaotiao-phone-panel .pt-bub.voice{border-left:3px solid var(--blue);}',
    '#piaotiao-phone-panel .pt-tail{font-size:9px;color:var(--dim);margin-top:3px;text-align:right;}',
    '#piaotiao-phone-panel .pt-divider{text-align:center;font-size:10px;color:var(--dim);padding:6px 0 2px;}',
    '#piaotiao-phone-panel .pt-inputbar{display:flex;gap:8px;padding:8px 10px;border-top:1px solid var(--line);background:var(--panel);flex-shrink:0;align-items:center;}',
    '#piaotiao-phone-panel .pt-inputbar input{flex:1;background:#f5f5f5;border:1px solid var(--line);color:var(--text);border-radius:17px;padding:8px 13px;font-size:13px;outline:none;}',
    '#piaotiao-phone-panel .pt-btn{border:none;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;color:#fff;background:var(--blue);}',
    '#piaotiao-phone-panel .pt-btn.send{border-radius:17px;background:var(--green);color:#fff;font-weight:bold;padding:8px 15px;font-size:13px;}',
    '#piaotiao-phone-panel .pt-btn.green{background:var(--green);color:#fff;font-weight:bold;}',
    '#piaotiao-phone-panel .pt-btn.red{background:var(--red);}',
    '#piaotiao-phone-panel .pt-btn.gray{background:var(--panel);border:1px solid var(--line);color:var(--text);}',
    '#piaotiao-phone-panel .pt-chips{display:flex;gap:6px;overflow-x:auto;padding:6px 10px;flex-shrink:0;}',
    '#piaotiao-phone-panel .pt-chip{flex-shrink:0;background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:14px;padding:4px 10px;font-size:11px;cursor:pointer;}',
    '#piaotiao-phone-panel .pt-typing{font-size:11px;color:var(--dim);padding:2px 14px 6px;font-style:italic;}',
    '#piaotiao-phone-panel .pt-cfg label{font-size:12px;color:var(--dim);display:block;margin:10px 14px 4px;}',
    '#piaotiao-phone-panel .pt-cfg input,#piaotiao-phone-panel .pt-cfg textarea,#piaotiao-phone-panel .pt-cfg select{width:calc(100% - 28px);margin:0 14px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 9px;font-size:12px;outline:none;resize:none;}',
    '#piaotiao-phone-panel input.piao-mask{-webkit-text-security:disc;}',
    '#piaotiao-phone-panel .pt-menu{position:fixed;z-index:10001;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);overflow:hidden;min-width:120px;}',
    '#piaotiao-phone-panel .pt-menu div{padding:9px 14px;font-size:13px;color:var(--text);cursor:pointer;border-bottom:1px solid var(--line);}',
    '#piaotiao-phone-panel .pt-menu div:last-child{border-bottom:none;}',
    '#piaotiao-phone-panel .pt-menu div:active{background:#e5e5e5;}',
    '#piaotiao-phone-panel svg text{font-family:system-ui,sans-serif;}',
    // v0.3.21：窄屏适配（联审 J3 上轮欠账）——≤420px 时手机铺满可用宽高，页签字号已小无需再缩
    '@media (max-width:420px){#piaotiao-phone-panel{width:calc(100vw - 12px) !important;height:calc(100vh - 80px) !important;}}',
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
        ';border:1px solid ' + C.line + ';border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;color:' + C.text + ';';
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
    root.innerHTML = '<div id="piaotiao-phone-btn" title="批条 · 手机（可拖动）" style="cursor:grab;width:52px;height:52px;border-radius:26px;background:' + C.green + ';box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;position:relative;user-select:none;touch-action:none;">' +
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
  // v0.3.3-W25 修复（J5）：全量 innerHTML 重建会把打字中的输入框连焦点带文字一起抹掉——
  // 回信生成期（setTyping）与任意变量写完成（pt_updated）都会触发 render，恰是打字高峰。
  // 面板内文本输入框持有焦点且非空时跳过本次全刷；发送/失焦后自然恢复刷新（数据仍在变量层）。
  function typingGuardActive() {
    try {
      var act = DOC.activeElement; // v0.3.24（三席联审 M13）：面板挂在父文档（DOC=L16），裸 document 是 srcdoc iframe 自身——守卫恒 false，J5 修复从未生效
      if (!act || !panelEl || !panelEl.contains(act)) return false;
      if (act.tagName === 'TEXTAREA') return !!act.value;
      if (act.tagName !== 'INPUT') return false;
      var t = (act.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit') return false;
      return !!act.value;
    } catch (eG) { return false; }
  }
  function render() {
    if (!panelEl) return;
    if (typingGuardActive()) return;
    try {
      var tabs = [['wechat', '微信'], ['contacts', '联系人'], ['notes', '备忘录'], ['gallery', '图鉴'], ['settings', '设置']];
      // v0.3.21 微信白天模式：顶部双行页签收成窄标题栏（居中标题，拖拽手柄仍只认这一条），
      // 五页签挪到底部导航（emoji 图标 + 未在页灰字/在页绿字）
      var TAB_ICONS = { wechat: '💬', contacts: '👥', notes: '📖', gallery: '🏆', settings: '⚙️' };
      var head =
        '<div id="piaotiao-drag-handle" style="background:' + C.bg + ';padding:11px 14px;font-size:15px;font-weight:bold;display:flex;justify-content:center;align-items:center;cursor:grab;user-select:none;touch-action:none;position:relative;border-bottom:1px solid ' + C.line + ';">' +
        '<span>批条 · 这事，能办。</span><span id="piaotiao-close" style="position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;color:' + C.dim + ';font-size:13px;font-weight:normal;">收起</span></div>';
      var tabbar =
        '<div style="display:flex;border-top:1px solid ' + C.line + ';background:' + C.panel + ';flex-shrink:0;padding:4px 0 3px;">' +
        tabs.map(function (t) {
          return '<div data-tab="' + t[0] + '" style="flex:1;text-align:center;padding:2px 0;cursor:pointer;user-select:none;">' +
            '<div style="font-size:17px;line-height:1.15;filter:' + (currentView === t[0] ? 'none' : 'grayscale(1)') + ';opacity:' + (currentView === t[0] ? '1' : '.55') + ';">' + TAB_ICONS[t[0]] + '</div>' +
            '<div style="font-size:10.5px;margin-top:1px;color:' + (currentView === t[0] ? C.green : C.dim) + ';">' + t[1] + '</div></div>';
        }).join('') + '</div>';
      var body = '';
      if (currentView === 'wechat') body = currentConv ? viewThread() : viewWechatList();
      else if (currentView === 'contacts') body = viewContacts();
      else if (currentView === 'notes') body = viewNotes();
      else if (currentView === 'gallery') body = viewGallery();
      else if (currentView === 'settings') body = viewSettings();
      panelEl.innerHTML = head + '<div id="piaotiao-body" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;background:' + C.bg + ';">' + body + '</div>' + tabbar;
      bindPanel();
      var sc = panelEl.querySelector('.pt-msgs');
      if (sc) sc.scrollTop = sc.scrollHeight;
    } catch (e) {
      try { console.error(TAG, '渲染失败', e); toastr.error('渲染失败：' + ((e && e.message) || e), '批条 · 手机'); } catch (e2) {}
      if (panelEl) panelEl.innerHTML = '<div style="padding:16px;color:' + C.err + ';font-size:13px;">渲染失败：' + esc(String(e && e.message || e)) + '</div>';
    }
  }

  function bindPanel() {
    var close = panelEl.querySelector('#piaotiao-close');
    if (close) close.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    panelEl.querySelectorAll('[data-tab]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); currentView = el.getAttribute('data-tab'); currentConv = null; render(); });
    });
    if (currentView === 'wechat' && currentConv) bindThread();
    else if (currentView === 'wechat') bindWechatList();
    else if (currentView === 'settings') bindSettings();
    else if (currentView === 'contacts') bindContacts();
  }

  // ── 微信列表 ──
  function viewWechatList() {
    var v = ptRead();
    var npcs = (v.pt && v.pt.npcs) || {};
    var sd = ptStatData() || {};
    var ob = loadOutbox();
    var obCount = outboxCount();
    var banner = '';
    if (obCount > 0 && !ptApiReady()) {
      // A6：没配 API 时点「确定发送」也发不出去（消息全留在待发箱）——先提示补配置
      banner = '<div id="piaotiao-noapi" class="pt-banner" style="background:' + C.warn + ';cursor:default;"><span class="t" style="color:#fff;">⚠️ 还没填私信 API：消息发不出去，会一直留在待发箱——去「设置」补好地址和 Key</span></div>';
    } else if (obCount > 0) {
      banner = '<div id="piaotiao-sendall" class="pt-banner"><span class="n">' + obCount + '</span><span class="t">📨 确定发送，等他们回复</span></div>';
    }
    // v0.3.13：①从无往来的空会话不进微信列表（人脉留在「联系人」页，谁真来过消息谁才出现）；
    // ②认识与否按人名对账本判定——微信会话 id 是人名、账本键是拼音 id，旧逻辑 sd.contacts[id]
    //   永远查不中，导致雷万钧/陈国邦等账本联系人全掉进陌生人组、只剩 story 源的家人占上组。
    var contactNames = {}, famNames = {};
    for (var ck in (sd.contacts || {})) {
      var cn = String(ptBare((sd.contacts[ck] || {}).name) || '').trim();
      if (cn) contactNames[cn] = true;
    }
    for (var fk in (sd.families || {})) {
      var f = sd.families[fk];
      var members = [f.head, f.spouse];
      for (var mi = 0; mi < members.length; mi++) { var mn = members[mi] && ptBare(members[mi].name); if (mn) famNames[String(mn).trim()] = true; }
      var chd = f.children || {};
      for (var ckk in chd) { var n3 = ptBare(chd[ckk].name); if (n3) famNames[String(n3).trim()] = true; }
    }
    var knownIds = [], strangerIds = [], seenIds = {};
    Object.keys(npcs).forEach(function (id) {
      seenIds[id] = true;
      var npc = npcs[id];
      var hasMsg = (npc.dm_history && npc.dm_history.length > 0) || ((ob[id] || []).length > 0);
      if (!hasMsg) return;
      var nm = String(npc.name || id).trim();
      (contactNames[nm] || famNames[nm] || npc.source === 'story' ? knownIds : strangerIds).push(id);
    });
    // v0.3.24（三席联审 J12）：待发箱键并入列表——中局新认识的联系人还没有 npcs 条目，
    // 只遍历 npcs 会把「已入队待发」的会话整条隐身（toast 说发了、列表看不到行）。
    // 行数据由 rowHtml 的空 npc 兜底；归属按账本联系人/家属判入 knownIds。
    Object.keys(ob).forEach(function (id) {
      if (seenIds[id] || !(ob[id] || []).length) return;
      seenIds[id] = true;
      var nm = String(convName(null, id) || id).trim();
      (contactNames[nm] || famNames[nm] ? knownIds : strangerIds).push(id);
    });
    var sortTs = function (a, b) { return ((npcs[b] || {}).last_ts || 0) - ((npcs[a] || {}).last_ts || 0); };
    knownIds.sort(sortTs);
    strangerIds.sort(sortTs);
    function rowHtml(id) {
      // v0.3.24（J12）：待发箱键可能还没有 npcs 条目（中局新认识的联系人）——空 npc 兜底出行
      var npc = npcs[id] || { name: id, dm_history: [], last_message: '', unread: 0 };
      var name = convName(sd, id);
      var unread = npc.unread || 0;
      var queued = (ob[id] || []).length;
      var isFam = famNames[String(npc.name || id).trim()];
      // v0.3.14：身份短句取 archetype 优先、退回 tagline——账本建档渠道的联系人（如陈国邦）
      // 没有 seedArchetypes 给的 archetype，但引擎的 ptEnsureTaglines 有 tagline，旧写法会空着
      var rowTag = npc.archetype || npc.tagline || '';
      // v0.3.25（三席联审 J18）：可点行补 role/tabindex（键盘可达的第一步；Enter/Space 激活与焦点样式后续批）
      return '<div class="pt-row" role="button" tabindex="0" data-conv="' + esc(id) + '">' +
        '<span class="pt-ava' + (isFam ? ' family' : '') + '">' + esc(String(name).slice(0, 1)) + '</span>' +
        '<span class="pt-mid"><span class="pt-name"><span>' + esc(name) + (rowTag ? ' <span style="font-size:10px;color:var(--dim);">' + esc(rowTag) + '</span>' : '') + '</span>' +
        '<span class="pt-time">' + (npc.dm_history && npc.dm_history.length ? esc((npc.dm_history[npc.dm_history.length - 1] || {}).time || '') : '') + '</span></span>' +
        '<span class="pt-prev">' + (queued > 0 ? '<span style="color:var(--blue);">✍️ 待发' + queued + '条 </span>' : '') + esc(npc.last_message || '') + '</span>' +
        (unread > 0 ? '<span class="pt-unread">' + unread + '</span>' : '') +
        '</span></div>';
    }
    var rows = knownIds.map(rowHtml).join('');
    if (strangerIds.length) {
      rows += '<div style="padding:6px 14px 4px;font-size:11px;color:var(--dim);background:' + C.bg + ';">—— 陌生人（不在联系人里） ——</div>' +
        strangerIds.map(rowHtml).join('');
    }
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
    if (!ptApiReady()) {
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
      try { eventEmit('pt_request_dm', { reason: reason, n: String(n) + '-3', focus: focus, linesByConv: linesByConv }); } catch (e) {
        // v0.3.25（三席联审 M18）：清箱成功但触发抛错＝消息已在箱外——原样写回待发箱，不静默吞
        try { Object.keys(linesByConv).forEach(function (nm) { (linesByConv[nm] || []).forEach(function (ln) { queueOutbox(nm, String(ln)); }); }); } catch (e2) {}
        toast('error', '私信触发失败，消息已放回待发箱：' + e.message);
      }
      toast('success', '📨 已发送，等他们回复…');
      renderFab();
      render();
    });
  }

  // ── 会话线程 ──
  function openConv(id) {
    // v0.3.13：联系人页传的是账本键（拼音 id），微信会话键是人名——折回一致，否则线程恒空
    // v0.3.24（三席联审 J12）：去掉「npcs 已有该人名」的门槛——中局新认识的联系人还没有
    // npcs 条目，带门槛折不回去，线程/待发全按拼音读＝双隐身。convName 解析不到时原样返回，安全。
    try { id = convName(null, id) || id; } catch (e0) {}
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
    // v0.3.11：待发消息（发件箱）即时显示在消息流尾部——入队即可见，不等批量发送成功
    var obMsgs = ob[currentConv] || [];
    if (obMsgs.length) {
      var obDay = dayKey();
      if (obDay !== lastDay) items.push('<div class="pt-divider">' + esc(obDay) + '</div>');
      for (var oi = 0; oi < obMsgs.length; oi++) {
        items.push('<div class="pt-msg mine"><span class="pt-bub" style="opacity:.72;">' + esc(String(obMsgs[oi])) + '</span><span class="pt-tail">✍️ 待发</span></div>');
      }
    }
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
      (!ptApiReady() && obMsgs.length ? '<div class="pt-banner" style="background:' + C.warn + ';cursor:default;"><span class="t" style="color:#fff;">⚠️ 未填私信 API：待发消息发不出去——去「设置」补好地址和 Key</span></div>' : '') +
      '<div class="pt-chips">' + QUICK.map(function (q) { return '<span class="pt-chip" data-quick="' + esc(q) + '">' + esc(q) + '</span>'; }).join('') + '</div>' +
      '<div class="pt-inputbar"><input id="piaotiao-input" placeholder="发消息…（加入待发，回列表统一发送）" autocomplete="off" />' +
      '<button id="piaotiao-queue" class="pt-btn send" title="加入待发，回列表统一发送">发送</button></div></div>';
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
    // v0.3.24（三席联审 J14）：IME 组合期（拼音候选未上屏）的 Enter 是上屏动作，不是发送
    if (input) input.addEventListener('keydown', function (e) { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.stopPropagation(); doQueue(); } });
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
      var px = 0, py = 0;
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); showMsgMenu(el); });
      el.addEventListener('pointerdown', function (e) {
        px = e.clientX || 0; py = e.clientY || 0;
        pressTimer = setTimeout(function () { showMsgMenu(el); }, 550);
      });
      ['pointerup', 'pointerleave'].forEach(function (ev) {
        el.addEventListener(ev, function () { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
      });
      // v0.3.23（三席联审 J9）：旧版把 pointermove 也挂进「一有动作就取消」——手指微颤 1px
      // 菜单就没了，撤回/重掷在触屏上近乎不可用。改为累计位移 >6px 才算「移动了」
      //（与拖拽同款阈值），位移小于阈值时按住不动仍会正常弹出。
      el.addEventListener('pointermove', function (e) {
        if (!pressTimer) return;
        if (Math.abs((e.clientX || 0) - px) + Math.abs((e.clientY || 0) - py) > 6) { clearTimeout(pressTimer); pressTimer = null; }
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
  // v0.3.15：客户/关系人分类系统——家庭按「家姓+家」自动归类（家姓缺省时取户主姓氏首字），
  // 其余联系人按 group 值分栏；已归入家庭块的人不再在分栏里重复出现
  var CONTACT_GROUP_ORDER = ['官员', '管理者', '中间人', '亲属', '其他'];
  // v0.3.23（三席联审 J7）：面板侧补上账房侧已做的家姓边界判断（同一函数两侧，M9 只修了账房）。
  // 旧实现两个显示边界：① f.name 写了全名（陈国邦）→ 渲染「陈国邦家」；② f.name 与 head.name
  // 双缺（老档 fid 就是 chen/ruan 拼音）→ 渲染「chen家」拼音直出。现：合法家姓（1~2 汉字、
  // 不带「家」字）直接用；否则依次取 f.name 里的汉字、户主姓名里的汉字；仍取不到就不出标题
  // （宁可少一行标题，也不给玩家看拼音），并留一条 console 证据。
  function famLabelOf(fid, f) {
    var raw = String(ptBare(f && f.name) || '').trim();
    if (raw.length > 1 && raw.slice(-1) === '家') raw = raw.slice(0, -1);   // 写成「阮家」也认
    var legal = !!raw && raw.length <= 2 && !/[A-Za-z0-9]/.test(raw);
    if (!legal) {
      var hn = String(ptBare(f && f.head && f.head.name) || '').trim();
      var fromName = (raw.match(/[\u4e00-\u9fa5]/) || [])[0] || '';
      var fromHead = (hn.match(/[\u4e00-\u9fa5]/) || [])[0] || '';
      raw = fromName || fromHead || '';
    }
    if (!raw) {
      var fidTxt = String(fid || '').trim();
      if (/^[\u4e00-\u9fa5]{1,2}$/.test(fidTxt)) raw = fidTxt;              // fid 本身是汉字才算数
      else console.info(TAG, '家姓缺失且无从推断，家庭块不出标题：fid=' + fidTxt);
    }
    if (!raw) return '';
    return /家$/.test(raw) ? raw : raw + '家';
  }
  function viewContacts() {
    var sd = ptStatData() || {};
    var cs = sd.contacts || {};
    var fams = sd.families || {};
    var ptv = ptRead();
    var allNpcs = (ptv && ptv.pt && ptv.pt.npcs) || {};
    function taglineOf(npcId, npcName) {
      var n = allNpcs[npcId] || allNpcs[npcName];
      return (n && n.tagline) ? String(n.tagline) : '';
    }
    function contactPreview(c, npcId, npcName) {
      // 优先显示能解决什么问题（can_provide），回退到身份短句（tagline），最后兜底 group+attitude
      var cp = ptBare(c && c.can_provide);
      if (cp && cp !== '—') return '能办：' + String(cp);
      return taglineOf(npcId, npcName) || ((ptBare(c && c.group) || '其他') + '，对你' + (ptBare(c && c.attitude) || '保持观望'));
    }
    function taglineHtml(line) {
      return line ? '<span style="display:block;font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(line) + '</span>' : '';
    }
    function groupHeader(label) {
      return '<div style="padding:6px 14px 2px;font-size:11px;color:var(--gold);">' + esc(label) + '</div>';
    }
    function contactRow(id, c) {
      var nm = String(ptBare(c.name) || id);
      // v0.3.20（用户真机反馈）：status 是内部字段（available/active/hostile/offline），
      // 旧版把英文枚举直接糊进 UI（「利用available」）。现只翻译对玩家有意义的状态：
      // 离场/敌对；正常在册（available/active）不显示任何状态字。
      var stMap = { offline: '已离场', hostile: '敌对' };
      var st = stMap[ptBare(c.status)];
      // v0.3.25（三席联审 J15）：attitude 为空时不再拼出前导「·」（空态度+离场 → 「·已离场」悬挂）
      var att = ptBare(c.attitude) || '';
      var tag = att && st ? att + '·' + st : (att || st || '');
      return '<div class="pt-row" role="button" tabindex="0" data-contact="' + esc(id) + '"><span class="pt-ava" style="background:' + groupAvaColor(c) + ';">' + esc(nm.slice(0, 1)) + '</span>' +
        '<span class="pt-mid"><span class="pt-name"><span class="pt-nm">' + esc(nm) + '</span>' + (tag ? '<span class="pt-tag" style="color:' + (st === '敌对' ? 'var(--red)' : 'var(--dim)') + ';">' + esc(tag) + '</span>' : '') +
        taglineHtml(contactPreview(c, id, nm)) + '</span>' +
        '<span class="pt-meta">想要：' + esc(ptBare(c.wants) || '—') + '｜他欠我' + ((c.favors_owed || []).length) + '·我欠他' + ((c.favors_debt || []).length) + '</span></span></div>';
    }
    // 账本联系人按人名建索引：家庭成员若同时有联系人文录，行内补出其「能办」与人情账（不丢信息）
    var contactByName = {};
    for (var cid0 in cs) {
      var c0 = cs[cid0];
      var nm0 = String(ptBare(c0.name) || cid0).trim();
      if (nm0 && !contactByName[nm0]) contactByName[nm0] = { id: cid0, c: c0 };
    }
    function contactMetaSuffix(nm) {
      var hit = contactByName[nm];
      if (!hit) return '';
      return '｜他欠我' + ((hit.c.favors_owed || []).length) + '·我欠他' + ((hit.c.favors_debt || []).length);
    }
    var claimed = {};                       // 已归入家庭块的人名，下方分栏不再重复
    var REQ_ST = { active: '进行中', completed: '已办结', failed: '已失败' };   // v0.3.20：事件/请求状态枚举不裸露英文
    // v0.3.21：头像按分组着色（微信通讯录同款思路，一眼分清谁是谁家的人）
    var GROUP_COLOR = { '官员': '#10aeff', '管理者': '#576b95', '中间人': '#bd8b23', '亲属': '#fa5151', '其他': '#8a8a8a' };
    function groupAvaColor(c) { return GROUP_COLOR[String(ptBare(c && c.group) || '').trim()] || 'var(--blue)'; }
    function famRow(famLabel, name, role, rel, extra) {
      var nm = String(name || '').trim();
      if (!nm) return '';
      claimed[nm] = true;
      var roleTag = role === '一家之主' ? '' : '<span style="font-size:10px;color:var(--gold);margin-left:6px;white-space:nowrap;">' + role + '</span>';
      var sub = taglineOf(nm, nm) ||
        (contactByName[nm] ? contactPreview(contactByName[nm].c, contactByName[nm].id, nm) : '') ||
        (famLabel + (role === '一家之主' ? '家主' : role) + '，家里的事瞒着TA也瞒着外头');
      return '<div class="pt-row" role="button" tabindex="0" data-contact="' + esc(nm) + '"><span class="pt-ava family">' + esc(nm.slice(0, 1)) + '</span>' +
        '<span class="pt-mid"><span class="pt-name"><span class="pt-nm">' + esc(nm) + '</span>' + roleTag + '<span class="pt-tag" style="color:var(--dim);">' + esc(famLabel) + (rel !== null && rel !== undefined && rel !== '' ? '·关系' + esc(String(ptBare(rel))) : '') + '</span>' +
        taglineHtml(sub) + '</span>' +
        '<span class="pt-meta">' + (extra || '') + contactMetaSuffix(nm) + '</span></span></div>';
    }
    var famBlocks = '';
    for (var fid in fams) {
      var f = fams[fid];
      var famLabel = famLabelOf(fid, f);
      var head = f.head || {};
      var hid = String(ptBare(head.name) || '').trim();
      var frows = '';
      if (hid) frows += famRow(famLabel, hid, '一家之主', ptBare(head.relationship), '请求：' + esc(f.request ? ptBare(f.request.type) + '/' + (REQ_ST[ptBare(f.request.status)] || ptBare(f.request.status) || '无') : '无') + '｜暴露：' + (ptBare(f.exposure_risk) || 0));
      var sp = f.spouse || {};
      if (String(ptBare(sp.name) || '').trim()) frows += famRow(famLabel, ptBare(sp.name), '配偶', ptBare(sp.relationship), '察觉：' + (ptBare(sp.awareness) || 0) + '｜同谋：' + (ptBare(sp.complicity) || 0));
      var ch = f.children || {};
      for (var cid in ch) {
        var kid = ch[cid];
        if (!String(ptBare(kid.name) || '').trim()) continue;
        frows += famRow(famLabel, ptBare(kid.name), '子女', ptBare(kid.relationship), '察觉：' + (ptBare(kid.awareness) || 0) + '｜立场：' + esc(ptBare(kid.stance) || '—'));
      }
      var oth = (f.others && f.others.length) ? f.others : [];
      for (var oi = 0; oi < oth.length; oi++) {
        var oe = oth[oi];
        var onm = String(typeof oe === 'string' ? oe : (ptBare(oe && oe.name) || '')).trim();
        if (!onm) continue;
        frows += famRow(famLabel, onm, '同住亲属', (oe && typeof oe === 'object') ? ptBare(oe.relationship) : null, '');
      }
      if (frows) famBlocks += groupHeader(famLabel) + frows;
    }
    var buckets = {}, tailOrder = [];
    var famGroupDup = 0;                    // v0.3.23（J10）：家庭成员同时带官员/管理者等身份的人数
    for (var id in cs) {
      var c = cs[id];
      var nm = String(ptBare(c.name) || id).trim();
      var g = String(ptBare(c.group) || '其他').trim() || '其他';
      if (claimed[nm]) {
        // 家庭块优先、分栏跳过是确定行为（家庭块赢），但玩家会疑惑「官员栏怎么少了人」——
        // 数一下，末尾给一行灰字说明（不是 bug，是设计取向）。
        if (g && g !== '亲属') famGroupDup++;
        continue;
      }
      if (!buckets[g]) { buckets[g] = []; if (CONTACT_GROUP_ORDER.indexOf(g) < 0) tailOrder.push(g); }
      buckets[g].push(contactRow(id, c));
    }
    var groupBlocks = '';
    var order = CONTACT_GROUP_ORDER.concat(tailOrder);
    for (var gi = 0; gi < order.length; gi++) {
      var gk = order[gi];
      if (!buckets[gk] || !buckets[gk].length) continue;
      groupBlocks += groupHeader(gk) + buckets[gk].join('');
    }
    var dupNote = famGroupDup
      ? '<div style="padding:6px 14px 14px;font-size:11px;color:var(--dim);line-height:1.7;">（有 ' + famGroupDup + ' 位同时身兼官方身份，已归在自家块里，不再在下栏重复列出。）</div>'
      : '';
    return '<div style="padding:10px 14px;font-size:12px;color:var(--dim);">点联系人可直达会话（档案由账本驱动）</div>' +
      famBlocks + groupBlocks + dupNote +
      ((famBlocks || groupBlocks) ? '' : '<div style="padding:24px;color:var(--dim);text-align:center;">联系人尚未入账</div>');
  }
  function bindContacts() {
    panelEl.querySelectorAll('[data-contact]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openConv(el.getAttribute('data-contact')); });
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
      // v0.3.23（三席联审 J6）：解锁态与未解锁原来只差一行小字，图鉴这个「晒卡传播页」零记忆点。
      // 解锁行加金边 + 浅金底 + 头像角的「办」字印章（纯内联样式，零 CDN、零新依赖）。
      var seal = rec
        ? '<span style="position:absolute;right:-3px;bottom:-3px;width:15px;height:15px;border-radius:3px;background:var(--gold);color:#fff;font-size:10px;line-height:15px;text-align:center;font-weight:bold;">办</span>'
        : '';
      rows += '<div class="pt-row" style="cursor:default;' +
        (rec ? 'border:1px solid var(--gold);background:rgba(189,139,35,.07);' : '') +
        (isCur ? 'border-left:3px solid var(--gold);' : '') + '">' +
        '<span class="pt-ava" style="position:relative;' + (rec ? 'background:var(--gold);' : 'filter:grayscale(1);opacity:.5;') + '">' + (rec ? x : '?') + seal + '</span>' +
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
      '<div style="background:var(--header);padding:9px 14px;font-size:13px;margin-bottom:4px;"><b>手机设置</b> <span style="color:var(--dim);font-size:11px;">私信专线（与正文 API 相互独立）</span></div>' +
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
      // v0.3.23（三席联审 J10）：bindSettings 每次 render 都跑，而监听挂在长期存在的 panelHost 上
      // → 每渲染一次设置页就叠一层同名监听（进设置页几十次就是几十个回调）。改一次性绑定。
      if (!panelHost.__PiaotiaoCfgFocusBound) {
        panelHost.__PiaotiaoCfgFocusBound = true;
        panelHost.addEventListener('focusin', function (e) { if (e.target && e.target.id === 'piaotiao-cfg-key') e.target.removeAttribute('readonly'); });
      }
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
    console.info(TAG, '已挂载：悬浮手机（微信/联系人/备忘录/图鉴/设置），可拖动');
    selfHealLoop();
  }
  mount();
  window.__PiaotiaoPhonePanel = true;
})();
