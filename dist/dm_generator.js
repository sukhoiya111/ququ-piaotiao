// 批条 · 私信生成器（远程托管 dist/dm_generator.js，由卡内运行时加载器 fetch+eval 拉起）
//
// 职责（design-brief §9.3）：微信私信的唯一写入者
//   1. 触发：VARIABLE_UPDATE_ENDED（注册晚于账房与手机面板）+ 玩家回复标记（dm_pending）
//   2. 生成：TavernHelper.generateRaw（自带 ordered_prompts，不落聊天楼层，should_silence 隐藏）
//      输入 = 私信风格铁律 + 信息差矩阵 + 事件摘要 + NPC A 层字段 + 最近消息
//      输出 = json_schema 强约束 {message, replies[1-3]}
//   3. 写回：仅对 phone 子树读-改-写（重读最新 stat_data，防与正文链竞态；禁全量替换旧快照）
//   4. 失败安全：静默跳过本楼（不留占位垃圾），console.warn 留证
// 签名依据：本机酒馆助手源码 src/function/generate/{index,types}.ts（2026-09-19 核对）
(function () {
  'use strict';
  const TAG = '[批条·私信]';
  if (window.__PiaotiaoDmGenerator) { console.info(TAG, '已挂载，跳过重复初始化'); return; }

  const val = (v) => (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v);
  const isPair = (v) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'string';
  const wrapLike = (old, v) => (isPair(old) ? [v, old[1]] : v);
  const MAX_MSGS = 30;

  let busy = false; // 串行化：一次只跑一条隐藏生成

  function convName(sd, id) {
    const c = (sd.contacts || {})[id];
    if (c) return val(c.name) || id;
    if (id === 'chen_guobang') return '陈国邦';
    const fam = (sd.families || {})[id];
    if (fam) return val(fam.name) + '家';
    return id;
  }

  function contactBrief(sd, id) {
    const c = (sd.contacts || {})[id];
    if (c) {
      return '姓名：' + val(c.name) + '\n对我的态度：' + val(c.attitude) + '\n当前想要：' + val(c.wants) +
        '\n能提供：' + val(c.can_provide) + '\n他欠我的：' + JSON.stringify((c.favors_owed || []).map(val)) +
        '\n我欠他的：' + JSON.stringify((c.favors_debt || []).map(val)) + '\n状态：' + val(c.status);
    }
    const fam = (sd.families || {})[id];
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
    const fams = sd.families || {};
    for (const [fid, fam] of Object.entries(fams)) {
      const asym = fam.info_asymmetry || {};
      const members = [fam.head && val(fam.head.name), fam.spouse && val(fam.spouse.name)].filter(Boolean);
      const kids = Object.values(fam.children || {}).map((k) => val(k.name));
      if (members.concat(kids).some((n) => n && convName(sd, convId).includes(n)) || convId === fid) {
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

  async function generateDm(convId) {
    const Mvu = window.Mvu;
    const fresh = await Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    const sd = fresh.stat_data;
    const name = convName(sd, convId);

    const system =
      '/no_think 你是微信私信生成器，为角色「' + name + '」写一条发给「我」（S 市掮客）的微信消息。\n' +
      '铁律：\n' +
      '1. 冷冰冰的礼貌：客气但暗藏内容，不露骨，威胁用请托句式；陈述句，不用感叹号\n' +
      '2. 1-3 句话，像真的微信消息；不复述正文剧情，只顺着最近往来推进自己的诉求\n' +
      '3. 严格遵守信息差：只引用该角色知道的信息；「你知道但他们不知道的」绝不出现在消息里\n' +
      '4. replies 给 3 个玩家可能的选择回复（一句一条，口吻克制）\n' +
      '5. 直接输出最终 JSON，不要思考过程、不要解释、不要 markdown 代码块';

    const user =
      '【联系人档案】\n' + contactBrief(sd, convId) +
      '\n【当前事件】\n' + eventSummary(sd) +
      '\n【信息差】\n' + asymSummary(sd, convId) +
      '\n【最近消息】\n' + (recentMessages(sd, convId, 6).join('\n') || '（无）') +
      '\n\n请生成 ' + name + ' 的下一条微信消息与 3 个快捷回复。只输出 JSON。';

    // 【硬性边界 2026-09-19 用户明令】聊天 API 仅供酒馆正文 RP，脚本调用一律禁止
    //（曾因脚本调用导致用户账号被封、余额透支）。私信生成只走玩家在面板-设置里
    // 自填的额外 API（存本机 localStorage）；未配置则不生成，绝无默认回退。
    let dmApi = null;
    try { dmApi = JSON.parse(localStorage.getItem('piaotiao_dm_api') || 'null'); } catch (e) { dmApi = null; }
    if (!dmApi || !dmApi.url || !dmApi.key) {
      console.info(TAG, '未配置独立 API，跳过私信生成（手机面板-设置里填写后生效）');
      return;
    }
    const customApi = { apiurl: dmApi.url, key: dmApi.key, ...(dmApi.model ? { model: dmApi.model } : {}) };

    const call = async (extra) => {
      const prompts = [
        { role: 'system', content: system },
        { role: 'user', content: '{{user}}：' },
      ];
      if (extra) prompts.push({ role: 'user', content: extra });
      return window.generateRaw({
        user_input: user,
        use_preset: false,
        should_silence: true,
        ordered_prompts: prompts,
        custom_api: customApi,
      });
    };

    let raw = await call();
    if (!String(raw).trim()) raw = await call('（再次提醒：跳过一切分析，直接输出最终 JSON。）');

    let parsed = null;
    for (const candidate of [String(raw), (String(raw).match(/\{[\s\S]*\}/) || [])[0]]) {
      if (!candidate) continue;
      try { parsed = JSON.parse(candidate); break; } catch (e) { /* 下一个候选 */ }
    }
    if (!parsed || typeof parsed.message !== 'string' || !parsed.message.trim()) {
      console.warn(TAG, '生成结果无法解析，保持 dm_pending 待下楼重试：', String(raw).slice(0, 120));
      return;
    }
    const message = parsed.message.trim();
    const replies = Array.isArray(parsed.replies) ? parsed.replies.map((r) => String(r)).filter(Boolean).slice(0, 3) : [];

    // 写回：重读最新，仅改 phone 子树（竞态保护 v1.3）
    const latest = await Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    const lsd = latest.stat_data;
    lsd.phone = lsd.phone || { wechat_conversations: {}, wechat_messages: {} };
    const box = (lsd.phone.wechat_messages = lsd.phone.wechat_messages || {});
    const entry = box[convId] = box[convId] || { messages: [] };
    const list = Array.isArray(val(entry.messages)) ? val(entry.messages) : (entry.messages = []);
    list.push({ from: 'npc', text: message, floor: currentFloorSafe() });
    while (list.length > MAX_MSGS) list.shift();
    const convs = (lsd.phone.wechat_conversations = lsd.phone.wechat_conversations || {});
    const conv = convs[convId] = convs[convId] || { unread: 0, last_summary: '', suggested_replies: [] };
    conv.last_summary = name + '：' + message.slice(0, 40);
    conv.suggested_replies = replies;
    conv.unread = wrapLike(conv.unread, (Number(val(conv.unread)) || 0) + 1);
    conv.dm_pending = false;
    await Mvu.replaceMvuData(latest, { type: 'message', message_id: 'latest' });
    // 通知手机面板重渲染（replaceMvuData 不产生 VUE）
    try { window.dispatchEvent(new Event('piaotiao_phone_refresh')); } catch (e) { /* 面板未挂载时忽略 */ }
    console.info(TAG, '私信已产出：', convId, '「' + message.slice(0, 24) + '…」');
  }

  function currentFloorSafe() {
    try { const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext(); return ctx ? ctx.chat.length : 0; } catch (e) { return 0; }
  }

  async function onVariableUpdateEnded() {
    if (busy) return;
    try {
      const sd = (await window.Mvu.getMvuData({ type: 'message', message_id: 'latest' })).stat_data;
      if (!sd || !sd.phone) return;
      const convs = sd.phone.wechat_conversations || {};
      // 触发条件：玩家回复待答（dm_pending）优先；否则各会话有未读时随机由一个 NPC 主动开口（开局/新动态）
      const pendingId = Object.keys(convs).find((id) => convs[id] && val(convs[id].dm_pending) === true);
      const unreadId = Object.keys(convs).find((id) => (Number(val(convs[id].unread)) || 0) > 0);
      const target = pendingId || unreadId;
      if (!target) return;
      busy = true;
      try { await generateDm(target); } finally { busy = false; }
    } catch (e) {
      busy = false;
      console.warn(TAG, '本楼私信生成静默跳过：', e && (e.message || e));
    }
  }

  function mount() {
    if (window.Mvu && window.Mvu.events && typeof eventOn === 'function') {
      eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED, onVariableUpdateEnded);
      // 玩家面板回复走 replaceMvuData，不产生 VUE 事件 → 面板发信后用 kick 事件直呼生成器
      window.addEventListener('piaotiao_dm_kick', () => { onVariableUpdateEnded(); });
      window.__piaotiaoDmKick = () => onVariableUpdateEnded();
      console.info(TAG, '已挂载：私信生成通道（generateRaw + json_schema，phone 子树单写者）');
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
