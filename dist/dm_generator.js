// 批条 · 私信生成器（远程托管 dist/dm_generator.js，由卡内运行时加载器 fetch+eval 拉起）
//
// 机制照抄参考卡《Sugar Daddy Simulator》dm_generator（2026-09-19 拆解其线上脚本）：
//   - 触发：面板玩家回复 → 自定义事件 piaotiao_request_dm；正文楼结算（VUE）→ 事件相关联系人主动来信
//   - 生成：独立 API 直连 fetch（callIndependent，chatUrlOf 规范化，temperature 1.0，不带 max_tokens）
//   - 输出：`名字|text|内容` 行格式（对思考模型/噪声远比 JSON 健壮），<think> 与 ``` 围栏预清洗
//   - 写回：重读最新 stat_data，只写 phone 子树（竞态保护）；失败静默跳过，保持待答标记
// 【硬性边界】聊天 API 仅供酒馆正文 RP——本脚本没有也不允许有主 API 回退路径（用户明令 2026-09-19）：
//   未配置独立 API（面板-设置）则完全不生成。
(function () {
  'use strict';
  const TAG = '[批条·私信]';
  if (window.__PiaotiaoDmGenerator) { console.info(TAG, '已挂载，跳过重复初始化'); return; }

  const val = (v) => (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v);
  const isPair = (v) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'string';
  const wrapLike = (old, v) => (isPair(old) ? [v, old[1]] : v);
  const MAX_MSGS = 30;
  const VALID_TYPES = ['text', 'voice', 'transfer', 'sticker', 'image'];

  let busy = false;

  // ---------- 独立 API（照抄参考卡 callIndependent / chatUrlOf） ----------
  function chatUrlOf(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';
    return u + '/v1/chat/completions';
  }
  function getApiCfg() {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('piaotiao_dm_api') || 'null'); } catch (e) { cfg = null; }
    const url = cfg && (cfg.url || cfg.apiurl); // 兼容旧字段名
    if (!url || !cfg.key) return null;
    return { url, key: cfg.key, model: cfg.model || '' };
  }
  async function callIndependent(cfg, messages) {
    const body = { model: cfg.model || 'gpt-4o-mini', messages, temperature: 1.0 };
    const resp = await fetch(chatUrlOf(cfg.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      let errText = '';
      try { errText = (await resp.text()).slice(0, 100); } catch (e) {}
      throw new Error('HTTP ' + resp.status + ' ' + errText);
    }
    const json = await resp.json();
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  }

  // ---------- 行格式解析（照抄参考卡 parseDMs 的健壮性处理） ----------
  function parseDMs(raw) {
    const rows = [];
    const text = String(raw || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```[a-z]*\s*$/gim, '');
    const lines = text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.charAt(0) === '<') break; // 生成器输出的噪声标签行 → 停止
      const parts = t.split('|');
      const name = (parts[0] || '').trim().replace(/^[-*•\d.\s]+/, '');
      const type = parts.length >= 3 ? parts[1].trim().toLowerCase() : '';
      const isRow = !!name && parts.length >= 3 && VALID_TYPES.indexOf(type) !== -1;
      if (isRow) {
        rows.push({ name, type, raw: parts.slice(2).join('|').trim() });
      } else if (rows.length && (rows[rows.length - 1].type === 'text' || rows[rows.length - 1].type === 'voice')) {
        // 长私信被换行拆开的续段 → 拼回上一条
        const last = rows[rows.length - 1];
        if ((last.raw.length + t.length) < 3000) last.raw += '\n' + t;
      }
    }
    return rows;
  }

  // ---------- 数据 ----------
  function convName(sd, id) {
    const c = (sd.contacts || {})[id];
    if (c) return val(c.name) || id;
    if (id === 'chen_guobang') return '陈国邦';
    const fam = (sd.families || {})[id];
    if (fam) return val(fam.name) + '家';
    return id;
  }
  function findConvIdByName(sd, name) {
    const convs = sd.phone?.wechat_conversations || {};
    for (const id of Object.keys(convs)) {
      if (convName(sd, id) === name || id === name) return id;
    }
    // 联系人档案里有但还没有会话 → 新建会话（信来先于往来是常态）
    for (const [cid, c] of Object.entries(sd.contacts || {})) {
      if (val(c.name) === name) return cid;
    }
    return null;
  }
  function contactBrief(sd, convId) {
    const c = (sd.contacts || {})[convId];
    if (c) {
      return '姓名：' + val(c.name) + '\n对我的态度：' + val(c.attitude) + '\n当前想要：' + val(c.wants) +
        '\n能提供：' + val(c.can_provide) + '\n他欠我的：' + JSON.stringify((c.favors_owed || []).map(val)) +
        '\n我欠他的：' + JSON.stringify((c.favors_debt || []).map(val)) + '\n状态：' + val(c.status);
    }
    const fam = (sd.families || {})[convId];
    if (fam) {
      const head = fam.head || {};
      const asym = fam.info_asymmetry || {};
      return '家庭：' + val(fam.name) + '家\n一家之主：' + val(head.name) + '（关系 ' + val(head.relationship) + '）' +
        '\n进行中请求：' + JSON.stringify(fam.request ? { type: val(fam.request.type), status: val(fam.request.status) } : null) +
        '\n信息差（他们不知道你知道的）：' + JSON.stringify((asym.player_knows || []).map(val));
    }
    return '（无档案）';
  }
  function eventSummary(sd) {
    const evs = Object.entries(sd.events || {}).map(([id, e]) => ({
      id, type: val(e.type), source: val(e.source), status: val(e.status), family_ref: val(e.family_ref),
    }));
    return evs.length ? JSON.stringify(evs) : '（无进行中事件）';
  }
  function asymSummary(sd, convId) {
    for (const [fid, fam] of Object.entries(sd.families || {})) {
      const asym = fam.info_asymmetry || {};
      const members = [fam.head && val(fam.head.name), fam.spouse && val(fam.spouse.name)]
        .concat(Object.values(fam.children || {}).map((k) => val(k.name)))
        .filter(Boolean);
      if (convId === fid || members.some((n) => n && convName(sd, convId).includes(n))) {
        return '家庭 ' + val(fam.name) + ' 的信息差格子：\n' +
          '父亲知道：' + JSON.stringify((asym.head_knows || []).map(val)) + '\n' +
          '母亲知道：' + JSON.stringify((asym.spouse_knows || []).map(val)) + '\n' +
          '子女知道：' + JSON.stringify((asym.child_knows || []).map(val)) + '\n' +
          '你（掮客）知道但他们不知道的：' + JSON.stringify((asym.player_knows || []).map(val));
      }
    }
    return '（该联系人无家庭信息差格子，只按自身档案与公开剧情行事）';
  }
  function recentMessages(sd, convId, n) {
    const box = (sd.phone?.wechat_messages || {})[convId];
    const list = box && Array.isArray(val(box.messages)) ? val(box.messages) : [];
    return list.slice(-n).map((m) => (val(m.from) === 'player' ? '我：' : val(convName(sd, convId)) + '：') + val(m.text));
  }
  function currentFloorSafe() {
    try { const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext(); return ctx ? ctx.chat.length : 0; } catch (e) { return 0; }
  }

  // ---------- 生成 ----------
  const SYSTEM_HEAD =
    '你是「批条」模拟器里手机私信的生成器。任务：生成 NPC 发给「我」（S 市掮客，玩家）的微信私信。\n' +
    '文风铁律：冷冰冰的礼貌，客气但暗藏内容；威胁用请托句式；陈述句，不用感叹号；1-3 句，像真的微信消息。\n' +
    '信息差铁律：每个 NPC 只知道自己的感知；「你知道但他们不知道的」绝不出现在私信里。\n' +
    '输出格式（必须严格遵守）：每条私信一行，格式为 名字|类型|内容。类型只用 text。不输出任何其他文字、解释或 markdown。\n';

  async function generateDMs(convId, n, reason) {
    const cfg = getApiCfg();
    if (!cfg) { console.info(TAG, '未配置独立 API，跳过私信生成（手机面板-设置里填写后生效）'); return; }
    const fresh = await window.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    const sd = fresh.stat_data;
    if (!sd || !sd.phone) return;
    const name = convName(sd, convId);

    const messages = [
      { role: 'system', content: SYSTEM_HEAD + '\n【联系人档案】\n' + contactBrief(sd, convId) + '\n【信息差】\n' + asymSummary(sd, convId) },
      { role: 'user', content: '【当前事件】\n' + eventSummary(sd) +
        '\n【最近消息】\n' + (recentMessages(sd, convId, 6).join('\n') || '（无）') +
        '\n\n请生成 ' + n + ' 条 ' + name + ' 发来的新私信' + (reason ? '（情境：' + reason + '）' : '') + '。每条一行：名字|text|内容' },
    ];

    let raw = await callIndependent(cfg, messages);
    const rows = parseDMs(raw).filter((r) => r.name === name || name.includes(r.name) || r.name.includes(name));

    // 写回：重读最新，仅写 phone 子树（竞态保护）
    const latest = await window.Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    const lsd = latest.stat_data;
    lsd.phone = lsd.phone || { wechat_conversations: {}, wechat_messages: {} };
    const box = (lsd.phone.wechat_messages = lsd.phone.wechat_messages || {});
    const entry = box[convId] = box[convId] || { messages: [] };
    const list = Array.isArray(val(entry.messages)) ? val(entry.messages) : (entry.messages = []);
    const floor = currentFloorSafe();
    for (const r of rows) {
      list.push({ from: 'npc', text: r.raw, type: r.type, floor });
    }
    while (list.length > MAX_MSGS) list.shift();
    const convs = (lsd.phone.wechat_conversations = lsd.phone.wechat_conversations || {});
    const conv = convs[convId] = convs[convId] || { unread: 0, last_summary: '', suggested_replies: [] };
    const lastRow = rows[rows.length - 1];
    conv.last_summary = name + '：' + (lastRow ? lastRow.raw.slice(0, 40) : '');
    conv.unread = wrapLike(conv.unread, (Number(val(conv.unread)) || 0) + rows.length);
    conv.dm_pending = false;
    await window.Mvu.replaceMvuData(latest, { type: 'message', message_id: 'latest' });
    try { window.dispatchEvent(new Event('piaotiao_phone_refresh')); } catch (e) { /* 面板未挂载时忽略 */ }
    console.info(TAG, '私信已产出 ×' + rows.length + '：', convId);
  }

  // ---------- 触发（机制照参考卡：玩家回复事件 + 每楼事件驱动） ----------
  async function onPlayerReply(payload) {
    if (busy) return;
    const convId = payload && payload.convId;
    if (!convId) return;
    busy = true;
    try { await generateDMs(convId, 1, '玩家刚在微信里回复了你'); } catch (e) {
      console.warn(TAG, '本楼私信生成静默跳过：', e && (e.message || e));
    } finally { busy = false; }
  }

  async function onFloorEnded() {
    if (busy) return;
    try {
      const cfg = getApiCfg();
      if (!cfg) return; // 未配置独立 API：什么都不做
      const sd = (await window.Mvu.getMvuData({ type: 'message', message_id: 'latest' })).stat_data;
      if (!sd || !sd.phone) return;
      // 新事件消息：有进行中事件时，从事件相关或可用联系人里挑一个主动来信
      const evs = Object.values(sd.events || {});
      const convs = sd.phone.wechat_conversations || {};
      const pending = Object.keys(convs).find((id) => val(convs[id].dm_pending) === true);
      let target = pending;
      let reason = '玩家有待回复的私信';
      if (!target) {
        const cand = new Set();
        for (const ev of evs) {
          if (val(ev.family_ref) && sd.families?.[val(ev.family_ref)]) cand.add(val(ev.family_ref));
          if (val(ev.contact_ref)) cand.add(val(ev.contact_ref));
        }
        for (const [cid, c] of Object.entries(sd.contacts || {})) {
          if (val(c.status) === 'available' || val(c.status) === 'active') cand.add(cid);
        }
        const pool = [...cand].filter((id) => convs[id]);
        if (!pool.length) return;
        target = pool[Math.floor(Math.random() * pool.length)];
        reason = evs.length ? '当前事件推进带来的新动向' : '日常往来问候';
      }
      busy = true;
      try { await generateDMs(target, 1, reason); } finally { busy = false; }
    } catch (e) {
      busy = false;
      console.warn(TAG, '本楼私信生成静默跳过：', e && (e.message || e));
    }
  }

  function mount() {
    if (window.Mvu && window.Mvu.events && typeof eventOn === 'function') {
      eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED, onFloorEnded);
      window.addEventListener('piaotiao_request_dm', (e) => { onPlayerReply(e.detail || {}); });
      console.info(TAG, '已挂载：私信生成通道（独立API直连 + 行格式解析，phone 子树单写者）');
    } else {
      let waited = 0;
      const timer = setInterval(() => {
        waited += 400;
        if ((window.Mvu && window.Mvu.events && typeof eventOn === 'function') || waited > 30000) {
          clearInterval(timer);
          if (waited <= 30000) mount();
          else console.warn(TAG, 'Mvu 长时间未就绪，私信通道未启动');
        }
      }, 400);
    }
  }
  mount();
  window.__PiaotiaoDmGenerator = true;
})();
