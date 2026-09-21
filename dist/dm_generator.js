(function () {
'use strict';
// 批条 · 私信生成器 v0.3.0（远程托管 dist/dm_generator.js，卡内运行时加载器 fetch+eval 拉起）
//
// 架构对齐参考卡《Sugar Daddy Simulator》的成熟模式（2026-09-19 拆解学习其线上实现）：
//   聊天级变量单一真源 + 串行写队列 + 事件驱动 + injectPrompts 主线感知 + 队列合并/补漏/strict 重试。
//   代码为本卡原创实现；未搬运参考卡代码文本（其声明「可读可学，禁止直接搬运」）。
//
// 【硬性边界】聊天 API 仅供酒馆正文 RP——参考卡用 generateRaw 走主 API 的路线与本卡绝不相容
// （2026-09-19 实证：脚本调用主 API 曾致封号、余额透支）。本引擎只用玩家自填的独立 API；
// 未配置则完全不生成，无任何主 API 回退路径。
//
// 自包含：无 import、无 CDN、无 MVU 依赖。只用酒馆助手全局：
//   getVariables / updateVariablesWith / getChatMessages / getCharWorldbookNames / getWorldbook /
//   injectPrompts / uninjectPrompts / eventOn / eventEmit / getPersona / substitudeMacros
'use strict';

var PT_TAG = '[批条·私信]';
if (window.__PiaotiaoDmGenerator) { console.info(PT_TAG, '已挂载，跳过重复初始化'); return; }

// ── 小工具 ──
function ptEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ptNow() {
  var d = new Date();
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function ptLsGet(k) { try { var st = (typeof parent !== 'undefined' && parent.localStorage) ? parent.localStorage : localStorage; return st.getItem(k); } catch (e) { return null; } }
function ptLsSet(k, v) { try { var st = (typeof parent !== 'undefined' && parent.localStorage) ? parent.localStorage : localStorage; st.setItem(k, v); } catch (e) {} }
function ptNotify(kind, msg) { try { toastr[kind](msg, '批条 · 手机'); } catch (e) { console.info(PT_TAG, msg); } }

// ── 聊天级变量：读 + 串行写闸（参考卡同款结论：updateVariablesWith 是读→改→异步写，
//    两次贴太近第二次会读到旧状态把人家的写覆盖掉——所有写排队过闸） ──
var _updQ = Promise.resolve();
function ptUpdate(fn) {
  _updQ = _updQ.then(function () { return updateVariablesWith(fn, { type: 'chat' }); })
    .catch(function (e) { console.error(PT_TAG, '写变量失败', e); ptNotify('error', '写变量失败: ' + ((e && e.message) || e)); });
  return _updQ;
}
function ptRead() { try { return getVariables({ type: 'chat' }) || {}; } catch (e) { return {}; } }

// ── MVU 账本只读（contacts/families/player 的唯一真源在 stat_data，这里只读不写） ──
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

// ── 固定联系人的"声音卡"（私信精简版；完整档案在世界书，按点名上车） ──
var PT_VOICES = {
  '陈国邦': '陈国邦，52岁，建材起家的民营老板，陈家一家之主。开局求办儿子名校名额。迷信关系不信合同，口头禅"您看这事，多少是个意思"。私信里客气但不遮遮掩掩，急事直说，爱用"您"，从不催命只说"劳您费心"。嫌烦也端着： Line短，一条一个事。',
  '王敬明': '王敬明，54岁，省教育厅基教处副处长，人称王处。圆滑×谨慎，笑起来像弥勒佛。从不报价，报价的是你的悟性；私信里客客气气打太极，从不落把柄，从不写数字，事情全在"回头吃饭细说"。怕老婆是真的怕。',
  '周之桐': '周之桐，45岁，留学机构「枫桥路」实际控制人，人称周律。精确×清高，无框眼镜。谈生意像问诊：先问三个问题再谈钱。小额收钱，大额换信息；最想要对等的秘密。私信简短、句句在点上，偶尔冷不丁透露一点别人的事当见面礼。',
  '白景舟': '白景舟，49岁，某文化艺术基金会秘书长，人称白秘书长。恋权×好色（全留在水面下）。不谈帮忙，谈缘分。私信文雅周到，爱用书面语和省略号，从不明说，一切安排都"顺其自然"——时间地点都他定，深夜发出。',
  '蔡满仓': '蔡满仓，58岁，「金满堂」商K老板，信息贩子，人称老蔡。贫豪×重情（危险），手腕上佛珠金表各一。什么都用酒局谈，口头禅"小事小事"。私信热络得像老友，爱发语音，三句不离"有个好玩的事"，情报真假九真一假。',
  '方岚': '方岚，41岁，市审计系统专项处副处长，人称方检。精确×谨慎，短发，全身上下没有一件衣服在讲故事。不收礼、不吃饭、不给面子任何进度条，但讲规则：规则内可以慢，可以"再核一遍"。私信极简，一句是一句，从不寒暄，回复慢但准。',
  '雷万钧': '雷万钧，46岁，城投片区开发公司副总经理，人称雷哥。{{user}} 圈里的狐朋狗友、带局人——不求助不结仇不图什么，纯为「玩」而来。说话短、糙、直接，带钩子："周五云顶，给你留了个人""这局你不去亏大了"。私信从不谈业务，业务在酒桌上谈；约局从不解释理由，只给时间地点。',
};

// ── 世界书素材直读（单一真源：改条目=私信同步生效） ──
var _wbCache = null, _wbAt = 0;
async function ptWbEntries() {
  if (_wbCache && Date.now() - _wbAt < 5 * 60 * 1000) return _wbCache;
  try {
    var names = await getCharWorldbookNames('current');
    if (names && names.primary) {
      var entries = await getWorldbook(names.primary);
      if (entries && entries.length) { _wbCache = entries; _wbAt = Date.now(); }
    }
  } catch (e) { console.warn(PT_TAG, '世界书读取失败', e); }
  return _wbCache || [];
}
async function ptWbContent(nameSub, fallback) {
  var es = await ptWbEntries();
  for (var i = 0; i < es.length; i++) {
    if (es[i].enabled === false) continue;
    var nm = String(es[i].comment || es[i].name || '');
    if (nm.indexOf(nameSub) !== -1) return es[i].content || fallback;
  }
  return fallback;
}
// 点名联系人 → 完整档案条目名（worldbook comment 精确匹配）
var PT_WB_KEY = {
  '王敬明': '联系人档案·王敬明', '周之桐': '联系人档案·周之桐', '白景舟': '联系人档案·白景舟',
  '蔡满仓': '联系人档案·蔡满仓', '方岚': '联系人档案·方岚', '陈国邦': '家庭档案',
};

// ── 玩家身份（酒馆人设为唯一可信来源，没填就留白） ──
function ptIdentity() {
  var name = '', persona = '';
  try { if (typeof getPersona === 'function') { var pp = getPersona('current'); if (pp) { name = String(pp.name || '').trim(); persona = String(pp.description || '').trim(); } } } catch (e) {}
  try { if (!name && typeof substitudeMacros === 'function') name = String(substitudeMacros('{{user}}') || '').trim(); } catch (e) {}
  try { if (!persona && typeof substitudeMacros === 'function') persona = String(substitudeMacros('{{persona}}') || '').trim(); } catch (e) {}
  if (/^\{\{[^}]*\}\}$/.test(name)) name = '';
  if (/^\{\{[^}]*\}\}$/.test(persona)) persona = '';
  return { name: name, persona: persona };
}

// ── 主线最近散文（私信的眼睛；层数×字数预算，砍太狠=手机不读正文） ──
function ptCleanProse(t) {
  return String(t || '')
    .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
    .replace(/<Analysis>[\s\S]*?<\/Analysis>/gi, '')
    .replace(/<initvar>[\s\S]*?<\/initvar>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]{1,80}>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
async function ptRecentPlot() {
  try {
    var arr = await getChatMessages('0-{{lastMessageId}}');
    if (!arr || !arr.length) return '';
    var nFloors = parseInt(ptLsGet('piaotiao_plot_n'), 10); if (!(nFloors > 0)) nFloors = 6;
    var lines = arr.slice(-nFloors).map(function (m) {
      var t = ptCleanProse(m.message);
      if (!t) return '';
      return (m.is_user || m.role === 'user' ? '我' : '正文') + '：' + t;
    }).filter(Boolean).join('\n');
    var cap = nFloors * 900;
    return lines.length > cap ? lines.slice(-cap) : lines;
  } catch (e) { return ''; }
}
// 谁在剧情里被提到（纯文本扫描，零额外调用）
function ptInScene(plot) {
  if (!plot) return [];
  var hay = plot.toLowerCase();
  var hits = [];
  var names = [];
  var sd = ptStatData();
  if (sd) {
    for (var cid in (sd.contacts || {})) { var c = sd.contacts[cid]; var n = ptBare(c && c.name); if (n && names.indexOf(n) === -1) names.push(n); }
    for (var fid in (sd.families || {})) {
      var f = sd.families[fid];
      ['head', 'spouse'].forEach(function (role) { var n2 = f[role] && ptBare(f[role].name); if (n2 && names.indexOf(n2) === -1) names.push(n2); });
      for (var kid in (f.children || {})) { var n3 = ptBare(f.children[kid] && f.children[kid].name); if (n3 && names.indexOf(n3) === -1) names.push(n3); }
    }
  }
  for (var key in PT_VOICES) { if (names.indexOf(key) === -1) names.push(key); }
  var npcs = (ptRead().pt && ptRead().pt.npcs) || {};
  for (var k in npcs) { var nm = String(npcs[k] && npcs[k].name || k); if (names.indexOf(nm) === -1) names.push(nm); }
  for (var i = 0; i < names.length; i++) {
    var tok = String(names[i]).toLowerCase();
    if (tok.length >= 2 && hay.indexOf(tok) !== -1 && hits.indexOf(names[i]) === -1) hits.push(names[i]);
  }
  return hits;
}

// ── 独立 API（唯一生成通道；配置存 parent localStorage，不进聊天文件） ──
function ptApiCfg() {
  try {
    var store = (typeof parent !== 'undefined' && parent.localStorage) ? parent.localStorage : localStorage;
    var raw = store.getItem('piaotiao_dm_api');
    var cfg = raw ? JSON.parse(raw) : null;
    var url = cfg && (cfg.url || cfg.apiurl);
    if (cfg && url && cfg.key) return { url: url, key: cfg.key, model: cfg.model || '' };
  } catch (e) {}
  return null;
}
function ptChatUrlOf(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}
async function ptCallApi(cfg, ordered, instr) {
  var messages = [];
  for (var i = 0; i < ordered.length; i++) messages.push({ role: ordered[i].role, content: ordered[i].content });
  messages.push({ role: 'user', content: instr });
  var body = { model: cfg.model || 'gpt-4o-mini', messages: messages, temperature: 1.0 };
  var resp = await fetch(ptChatUrlOf(cfg.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    var errText = ''; try { errText = (await resp.text()).slice(0, 120); } catch (e) {}
    throw new Error('HTTP ' + resp.status + ' ' + errText);
  }
  var json = await resp.json();
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
}

// ── 限速闸（保护独立 API 端点；被限就等，不丢请求） ──
var _callTimes = [];
var RATE_WINDOW = 60 * 1000, RATE_MAX = 8;
async function ptWaitSlot() {
  for (;;) {
    var now = Date.now();
    _callTimes = _callTimes.filter(function (t) { return now - t < RATE_WINDOW; });
    if (_callTimes.length < RATE_MAX) { _callTimes.push(now); return; }
    var waitMs = RATE_WINDOW - (now - _callTimes[0]) + 300;
    await new Promise(function (r) { setTimeout(r, waitMs); });
  }
}

// ── 会话 id 规范 = 人名（固定联系人/家庭成员/陌生人统一；避免 id 歧义劈开会话） ──
var PT_ALIAS = { 'chen_guobang': '陈国邦' };   // v0.3.0 初版种子曾用的楼层 id → 正名
function ptCanon(name) {
  name = String(name || '').trim();
  var sd = ptStatData() || {};
  for (var id in (sd.contacts || {})) { var n = String(ptBare((sd.contacts[id] || {}).name) || '').trim(); if (n && n === name) return n; }
  for (var fid in (sd.families || {})) { var f = sd.families[fid]; var hn = f.head && ptBare(f.head.name); if (hn && String(hn) === name) return String(hn); }
  for (var vk in PT_VOICES) { if (vk === name) return vk; }
  if (PT_ALIAS[name]) return PT_ALIAS[name];
  return name;
}
function ptMergeFrags(v) { // 合并同名碎片（历史键混用过 family id/名字）；返回重命名清单
  var renamedAll = [];
  var npcs = v.pt && v.pt.npcs; if (!npcs) return renamedAll;
  var groups = {};
  for (var id in npcs) {
    if (!npcs.hasOwnProperty(id)) continue;
    var nm = String((npcs[id] && npcs[id].name) || id).trim();
    var key = ptCanon(nm);
    if (key === nm && id !== nm) { var k2 = ptCanon(id); if (k2 !== id) key = k2; }
    if (!groups[key]) groups[key] = [];
    groups[key].push(id);
  }
  var renamed = [];
  for (var key2 in groups) {
    var ids = groups[key2];
    if (ids.length < 2 && ids[0] === key2) continue;
    ids.sort(function (a, b) { return (npcs[a].last_ts || 0) - (npcs[b].last_ts || 0); });
    var merged = { name: key2, unread: 0, dm_history: [], last_ts: 0, last_message: '', muted: false, archetype: '' };
    for (var i2 = 0; i2 < ids.length; i2++) {
      var n2 = npcs[ids[i2]];
      merged.dm_history = merged.dm_history.concat(n2.dm_history || []);
      merged.unread += (n2.unread || 0);
      if ((n2.last_ts || 0) > merged.last_ts) { merged.last_ts = n2.last_ts; merged.last_message = n2.last_message; }
      merged.muted = merged.muted || !!n2.muted;
      merged.archetype = merged.archetype || n2.archetype || '';
    }
    merged.dm_history.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    if (merged.dm_history.length > 400) merged.dm_history = merged.dm_history.slice(-400);
    for (var i3 = 0; i3 < ids.length; i3++) delete npcs[ids[i3]];
    npcs[key2] = merged;
    renamed.push(ids.join('+') + '→' + key2);
  }
  if (renamed.length) console.info(PT_TAG, '合并同名会话:', renamed.join(', '));
  return renamed.concat(renamedAll);
}
// ── 会话记录（pt.npcs[id]，id=人名） ──
function ptEnsureNpc(v, id, name) {
  if (!v.pt) v.pt = {};
  if (!v.pt.npcs) v.pt.npcs = {};
  if (!v.pt.npcs[id]) {
    v.pt.npcs[id] = { id: id, name: name || id, unread: 0, dm_history: [], last_ts: 0, last_message: '', muted: false, persistent: false };
  }
  if (name && v.pt.npcs[id].name !== name) v.pt.npcs[id].name = name;
  return v.pt.npcs[id];
}
function ptPushThem(sb, id, name, type, content) {
  var npc = ptEnsureNpc(sb, id, name);
  npc.dm_history.push({ sender: 'THEM', time: ptNow(), ts: Date.now(), type: type || 'text', content: String(content || '') });
  if (npc.dm_history.length > 400) npc.dm_history = npc.dm_history.slice(-400);
  npc.last_ts = Date.now();
  npc.last_message = type === 'recall' ? '撤回了一条消息' : ((type && type !== 'text' ? '[' + type + '] ' : '') + String(content || '').substring(0, 50));
  npc.unread = (npc.unread || 0) + 1;
}
function ptPushMe(sb, id, name, text) {
  var npc = ptEnsureNpc(sb, id, name);
  npc.dm_history.push({ sender: 'ME', time: ptNow(), ts: Date.now(), type: 'text', content: String(text || '') });
  if (npc.dm_history.length > 400) npc.dm_history = npc.dm_history.slice(-400);
  npc.last_ts = Date.now();
  npc.last_message = String(text || '').substring(0, 50);
}
function ptRecentMessages(v, id, n) {
  var npcs = (v.pt && v.pt.npcs) || {};
  var rec = npcs[id] && npcs[id].dm_history || [];
  return rec.slice(-n).map(function (m) { return (m.sender === 'ME' ? '我' : (npcs[id] ? npcs[id].name : id)) + '：' + (m.type === 'recall' ? '（撤回了一条消息）' : String(m.content || '')); });
}

// ── 账本概况 → 文本（describeState 批条版：影响力/资金/保护伞/暴露/人情） ──
function ptDescribeState() {
  var sd = ptStatData() || {};
  var lines = [];
  lines.push('【手机时钟】现在是 ' + ptNow() + '（深夜像深夜，清晨像清晨）');
  var uid = ptIdentity();
  lines.push('【玩家档案】');
  if (uid.name) lines.push('名字: ' + uid.name);
  if (uid.persona) lines.push('玩家写的人设（关于他的唯一可信设定，别另编）:\n' + uid.persona.slice(0, 1000));
  var player = sd.player || {};
  function num(x) { var n = ptBare(x); return (n == null || n === '') ? null : n; }
  if (num(player.influence) != null) lines.push('影响力: ' + num(player.influence) + '/100');
  if (num(player.capital) != null) lines.push('可动用资金: ¥' + Number(num(player.capital) || 0).toLocaleString('zh-CN'));
  if (num(player.protection) != null) lines.push('保护伞: ' + num(player.protection) + '/5');
  var d = sd.derived || {};
  if (num(d.exposure_global) != null) lines.push('暴露风险: ' + num(d.exposure_global) + '/100（越高越接近败露）');
  if (num(d.favors_balance) != null) lines.push('人情余额: ' + num(d.favors_balance) + '（正=别人欠我）');
  // 联系人名录（身份+态度，供"谁该来信"判断；档案细节按点名上车）
  var cs = sd.contacts || {};
  var cl = [];
  for (var id in cs) {
    var c = cs[id];
    cl.push('· ' + (ptBare(c.name) || id) + '（' + (ptBare(c.status) || '?') + '，态度' + (ptBare(c.attitude) || '?') + '）：想要' + (ptBare(c.wants) || '—') + '，能办' + (ptBare(c.can_provide) || '—'));
  }
  if (cl.length) lines.push('【通讯录·体制联系人】\n' + cl.join('\n'));
  var fams = sd.families || {};
  var fl = [];
  for (var fid in fams) {
    var f = fams[fid];
    var head = f.head || {};
    var req = f.request ? (ptBare(f.request.type) + '/' + ptBare(f.request.status)) : '无';
    fl.push('· ' + (ptBare(f.name) || fid) + '家：一家之主' + (ptBare(head.name) || '?') + '（关系' + (ptBare(head.relationship) || 0) + '），进行中请求=' + req + '，家庭暴露=' + (ptBare(f.exposure_risk) || 0));
  }
  if (fl.length) lines.push('【在办家庭】\n' + fl.join('\n'));
  return lines.join('\n');
}

// ── 提示词组装 ──
var PT_FORMAT_RULES =
  '【输出格式·铁律】只输出私信，每条占一行，格式严格为：\n' +
  '名字|类型|内容\n' +
  '- 类型只能是 text / voice / image / transfer / recall 之一\n' +
  '- 语音 image 不存在实体文件：voice 的内容写这段语音的质感（语气/说了什么/背景音，如 名字|voice|背景音是工地打桩，声音压得很低，说…）；image 的内容写一张照片的画面描述\n' +
  '- transfer 的内容只填金额数字（打点/送礼/预付，数字不带单位）\n' +
  '- recall（稀用，一个月两三次）：名字|recall|他没说出口的那句话——手机上只显示"撤回了一条消息"，User 看不到内容\n' +
  '- 一条私信永远只占一行——再长也绝不换行，用句号和空格连着写\n' +
  '- 严禁输出任何叙事、旁白、环境描写、心理描写、解释、标题；严禁代替 User 说话或回复\n' +
  '- 严禁复读：这个人自己说过的话、发过的邀约，绝不换个说法再发一遍；没有新话可说的人这一轮就沉默';

async function ptBuildPrompt(sb, plot, n, reason, strict) {
  var sd = ptStatData() || {};
  // 声音卡：固定联系人全员上车
  var voiceCard = Object.keys(PT_VOICES).map(function (k) { return '· ' + PT_VOICES[k]; }).join('\n');
  // 随机素材：直读世界书「群像库·体制众生」
  var randomGuide = await ptWbContent('群像库', '（群像库条目未读到：按 S 市各职能口现编——处/科/局/委办/国企/学校医院，配【性格两词】×【软肋】×【把柄方向】，姓氏+职务做称呼，绝不重名）');
  var sys1 =
    '你是「批条」模拟器里"手机私信"的生成器。背景：User 是 S 市的地下掮客，专为有权有钱的家庭解决「棘手问题」（名校名额/艺术留学/签证移民）。任务：生成几条 NPC 发给 User 的微信私信。\n\n' +
    '【文风铁律】冷冰冰的礼貌，客气但暗藏内容；威胁用请托句式；陈述句，不用感叹号；1-3 句一条，像真的体制内微信。所有人都在体制内外边缘行走：话不说满、事不落纸、钱不过账面。\n\n' +
    '【固定联系人的声音】每个人必须用自己的语气，不要混：\n' + voiceCard + '\n\n' +
    '【随机NPC素材库】体制众生按 职能口×性格×软肋×把柄方向 自由组合现抽，称呼用「姓+职务」：\n' + String(randomGuide).slice(0, 2500) + '\n\n' +
    '【开口要五花八门】不只"在吗"——有的直接递话（「有个事，电话里说不方便」）、有的试探口风（「最近上面查得严啊」）、有的求办事、有的送消息当投名状、有的来还人情。开口方式本身就是这个人的名片。\n\n' +
    '【人设边界·铁律】每个 NPC 只知道自己那条线；「你知道但他们不知道的」绝不出现在私信里。\n' +
    '【在场铁律】别的角色在剧情里做了什么——只有正文里出现TA名字或 User 告诉过TA，TA才知道；否则只能像局外人那样问「最近怎么样」。\n' +
    '【信息隔离·铁律】谁都看不到 User 的手机和账本——不知道他的余额、他还在跟谁聊、别人的把柄强度。⛔ 不许说"听说你还有别的客户""你上周替谁办的"。各自只知道：自己和他说过的话、他当面做的事、自己亲眼看见的。\n\n' +
    '【User侧动作】他可能：发语音[voice]（对方听到的是内容和语气）；发图片[image]（材料照片/收据截图，按画面理解）；转账[transfer]（打点/预付——体制内的人对钱都敏感，收得矜持或干脆不接，绝不当场道谢收到甜甜）；撤回[recall]（TA只知道他撤回了，永远看不到内容——追问还是装大度，按人设）。每一样都要有反应，别当没发生。\n' +
    '【平台设定·铁律】这是私人工作微信：敢谈事、敢谈价、敢谈人，但绝不留下字据——能当面说的绝不打字，打了字的也是暗语（「那个东西」「上次的数」「老地方」）。体制内的人句句设防是本能：不写全名、不写学校、不写金额精确数。\n' + PT_FORMAT_RULES + '\n';
  var ordered = [
    { role: 'system', content: sys1 },
    { role: 'system', content: ptDescribeState() },
  ];
  if (plot) ordered.push({ role: 'system', content: '【主线最近剧情，私信可呼应但不要复述】\n' + plot });
  // 点名联系人 → 完整档案上车（回信人设密度=主线同级）
  if (reason) {
    for (var fk in PT_WB_KEY) {
      if (PT_WB_KEY.hasOwnProperty(fk) && reason.indexOf(fk) !== -1) {
        var dossier = await ptWbContent(PT_WB_KEY[fk], '');
        if (dossier) ordered.push({ role: 'system', content: '【' + fk + ' 的完整档案（回信必须贴合这份人设）】\n' + String(dossier).slice(0, 4000) });
        break;
      }
    }
  }
  // 闭集锁：点名回信时关掉陌生人通道（防串号乱回）
  var soloLock = !!reason && /别人不要出现|别的角色不要出现|只让 .+ 本人回应|没被点名的人这一轮不出现|绝不替别人回/.test(reason);
  // 刷新守则：下拉刷新≠让所有人表演
  var isRefresh = !!reason && reason.indexOf('玩家刷新手机') !== -1;
  var refreshHint = isRefresh
    ? '【刷新守则】这只是玩家下拉刷新，不是让所有人表演：已认识的人只有剧情有新进展、或TA真有新鲜事时才发消息，没有就一个字不发。本轮可以只有 0-2 条。'
    : '';
  // 等待回复名单：上一条是 NPC 发的还没得到 User 回复 → 不许追发（真人会干等）
  var waiting = [];
  var npcsW = (sb && sb.npcs) || {};
  for (var wk in npcsW) {
    if (!npcsW.hasOwnProperty(wk)) continue;
    var wh = npcsW[wk].dm_history || [];
    if (wh.length && wh[wh.length - 1].sender === 'THEM') waiting.push(npcsW[wk].name);
  }
  var waitHint = waiting.length ? '【等待回复中，本轮禁止再发：' + waiting.join('、') + '】他们上一条还没得到回复，正常人会干等。例外：手头有事相求的人可以厚脸皮追一条。' : '';
  // 冷处理名单
  var mutedList = [];
  for (var mk in npcsW) { if (npcsW.hasOwnProperty(mk) && npcsW[mk].muted) mutedList.push(npcsW[mk].name); }
  var mutedHint = mutedList.length ? '【被User冷处理，绝对禁止发消息：' + mutedList.join('、') + '】' : '';
  var onstage = soloLock ? [] : ptInScene(plot);
  var stageHint = onstage.length ? '【此刻剧情里出现/被提到的人：' + onstage.join('、') + '】这几条里最好有人呼应刚才正文发生的事。' : '';
  var tail = soloLock
    ? '严格只输出被点名的人的回复，绝不出现其他角色。每条一行 名字|类型|内容，不要写别的。'
    : '最好有 0-1 条来自全新的体制陌生人（按素材库现抽，换着花样来），其余可以是已认识且不在等待名单里的人。每条一行 名字|类型|内容，不要写别的。';
  var instr = '现在生成 ' + (n || '1-3') + ' 条新私信' + (reason ? '（情境：' + reason + '）' : '') + '。' + stageHint + waitHint + mutedHint + refreshHint + tail;
  if (strict) instr = '【再次强调：只能输出 名字|类型|内容 的行，每条一行，不许有任何其他文字】\n' + instr;
  return { ordered: ordered, instr: instr, soloLock: soloLock };
}

// ── 解析：每行 名字|类型|内容 ──
var PT_VALID_TYPES = ['text', 'voice', 'image', 'transfer', 'recall', 'tag'];
function ptParseDMs(raw) {
  var rows = [];
  var text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```[a-z]*\s*$/gim, '');
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t) continue;
    if (t.charAt(0) === '<') break;                       // 噪声标签行 → 停止
    var parts = t.split('|');
    var name = (parts[0] || '').trim().replace(/^[-*•\d.\s]+/, '');
    var type = parts.length >= 3 ? parts[1].trim().toLowerCase() : '';
    var isRow = !!name && parts.length >= 3 && PT_VALID_TYPES.indexOf(type) !== -1;
    if (isRow) {
      rows.push({ name: name, type: type, content: parts.slice(2).join('|').trim() });
    } else if (rows.length && (rows[rows.length - 1].type === 'text' || rows[rows.length - 1].type === 'voice')) {
      var last = rows[rows.length - 1];
      if ((last.content.length + t.length) < 3000) last.content += '\n' + t;   // 长消息被换行拆开 → 拼回
    }
  }
  return rows;
}

// ── 名字 → 会话 id（固定联系人/账本联系人按名折回；陌生人名即 id） ──
function ptNameToId(sb, name) {
  var sd = ptStatData() || {};
  var lower = String(name || '').trim().toLowerCase();
  for (var id in (sd.contacts || {})) {
    var n = String(ptBare((sd.contacts[id] || {}).name) || '').trim().toLowerCase();
    if (n && (n === lower || n.indexOf(lower) !== -1 || lower.indexOf(n) !== -1)) return id;
  }
  for (var fid in (sd.families || {})) {
    var f = sd.families[fid];
    var hn = String((f.head && ptBare(f.head.name)) || '').trim().toLowerCase();
    if (hn && hn === lower) return fid;
  }
  // pt 里已有的按名折回
  var npcs = (sb && sb.npcs) || {};
  for (var k in npcs) { if (String(npcs[k].name || '').toLowerCase() === lower) return k; }
  // 固定声音卡里的名字
  for (var vk in PT_VOICES) { if (vk === name) return vk; }
  return String(name || '').trim();
}
function ptIdToName(sb, id, sd) {
  sd = sd || ptStatData() || {};
  if (sd.contacts && sd.contacts[id]) return String(ptBare(sd.contacts[id].name) || id);
  if (sd.families && sd.families[id]) { var h = sd.families[id].head; return String((h && ptBare(h.name)) || id); }
  if (PT_VOICES[id]) return id;
  var npcs = (sb && sb.npcs) || {};
  return (npcs[id] && npcs[id].name) || id;
}

// ── 生成一轮 ──
var _lastRaw = '';
async function ptGenerateOnce(sb, plot, n, reason, strict) {
  var built = await ptBuildPrompt(sb, plot, n, reason, strict);
  var cfg = ptApiCfg();
  if (!cfg) { throw new Error('NO_API'); }
  await ptWaitSlot();
  var raw = await ptCallApi(cfg, built.ordered, built.instr);
  _lastRaw = typeof raw === 'string' ? raw : (raw && raw.content) || '';
  var parsed = ptParseDMs(_lastRaw);
  // soloLock 下滤掉被点名者之外的人
  if (built.soloLock && reason) {
    parsed = parsed.filter(function (r) { return reason.indexOf(r.name) !== -1; });
  }
  return parsed;
}

// ── 主流程（请求排队 + 合并，绝不丢单） ──
var _busy = false, _pending = [];
function ptMergeRequests(batch) {
  var reasons = [], focus = [];
  for (var i = 0; i < batch.length; i++) {
    var p = batch[i] || {};
    if (p.reason) reasons.push(p.reason);
    if (Array.isArray(p.focus)) for (var f = 0; f < p.focus.length; f++) if (focus.indexOf(p.focus[f]) === -1) focus.push(p.focus[f]);
  }
  var n = (batch.length === 1 && batch[0] && batch[0].n) ? batch[0].n : (batch.length > 1 ? String(batch.length) + '-3' : '1-3');
  return { reason: reasons.join('；同时：'), n: n, focus: focus };
}

async function ptRunOnce(req) {
  var vars = ptRead();
  var sb = (vars && vars.pt) ? vars.pt : null;
  if (!sb) { ptNotify('warning', '手机还没初始化，稍后再试'); return; }
  var plot = await ptRecentPlot();
  var all = [];
  try { all = await ptGenerateOnce(sb, plot, req.n, req.reason, false); }
  catch (e) {
    if (String(e && e.message) === 'NO_API') { ptNotify('warning', '未配置独立 API，跳过私信生成'); return; }
    throw e;
  }
  var dms = [], tags = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].type === 'tag') tags.push({ name: all[i].name, label: String(all[i].content).slice(0, 12) });
    else dms.push(all[i]);
  }
  if (!dms.length) {
    try { all = await ptGenerateOnce(sb, plot, req.n, req.reason, true); } catch (e2) { all = []; }
    dms = []; tags = [];
    for (var j = 0; j < all.length; j++) {
      if (all[j].type === 'tag') tags.push({ name: all[j].name, label: String(all[j].content).slice(0, 12) });
      else dms.push(all[j]);
    }
  }
  // 批量发补漏：点名的人里有没回的 → 再补一轮（防一次生成只回前两个）
  if (Array.isArray(req.focus) && req.focus.length) {
    var replied = {};
    for (var ri = 0; ri < dms.length; ri++) replied[ptCanon(dms[ri].name)] = true;
    var missing = req.focus.filter(function (id) { return !replied[id]; });
    if (missing.length && missing.length < req.focus.length) {
      var names = missing.map(function (id) { return ptIdToName(sb, id); });
      var mReason = '补漏：' + names.join('、') + ' 刚才漏了回复，现在必须每人各回 1-2 条，一个不能少。只让这几个人回应，别人不要出现、不要引入陌生人。';
      var more = [];
      try { more = await ptGenerateOnce(sb, plot, String(missing.length) + '-2', mReason, false); } catch (e3) { more = []; }
      for (var mi = 0; mi < more.length; mi++) {
        var mid = ptCanon(more[mi].name);
        if (missing.indexOf(mid) !== -1 && more[mi].type !== 'tag') dms.push(more[mi]);
      }
    }
  }
  if (!dms.length) {
    ptNotify('error', '私信生成失败：两次输出都解析不出格式（原始输出在控制台F12）');
    console.warn(PT_TAG, '解析失败原始输出（后600字）:', _lastRaw ? _lastRaw.slice(-600) : '(空)');
    return;
  }
  // 写回（串行闸内整树改）
  await ptUpdate(function (v) {
    if (!v.pt) v.pt = { npcs: {}, _outbox: {} };
    for (var di = 0; di < dms.length; di++) {
      var row = dms[di];
      var id = ptCanon(row.name);
      var nm = id;
      if (row.type === 'tag') continue;
      var exN = v.pt.npcs && v.pt.npcs[id];
      if (exN && exN.muted) continue;                      // 冷处理硬闸
      // v0.3.9：单人未读上限——未读已 ≥3 的不再收主动消息，防单人轰炸；
      // 玩家本轮点名要回的人（focus）豁免：回信必须到
      if (exN && (exN.unread || 0) >= 3 && !(req.focus && req.focus.indexOf(id) !== -1)) continue;
      ptPushThem(v, id, nm, row.type, row.content);
    }
    for (var ti = 0; ti < tags.length; ti++) {
      var tid = ptCanon(tags[ti].name);
      var tn = v.pt.npcs && v.pt.npcs[tid];
      if (tn && !tn.archetype) tn.archetype = tags[ti].label;
    }
    return v;
  });
  try { eventEmit('pt_updated'); } catch (e) {}
  try { ptNotify('success', '📱 新私信 +' + dms.length); } catch (e) {}
  ptSyncInject();
}

// ── 主线感知：把手机私信摘要隐形注入主线 LLM 上下文（injectPrompts） ──
// 参考卡同款机制：私信不进 stat_data、不进正文，主线靠这份摘要"知道"手机上发生过什么。
function ptBuildDigest(v) {
  var npcs = (v.pt && v.pt.npcs) || {};
  var budget = parseInt(ptLsGet('piaotiao_dm_mem'), 10); if (!(budget > 0)) budget = 120;
  var keys = Object.keys(npcs)
    .filter(function (k) { return (npcs[k].dm_history || []).length > 0; })
    .sort(function (a, b) { return (npcs[b].last_ts || 0) - (npcs[a].last_ts || 0); });
  var blocks = [], used = 0;
  for (var ki = 0; ki < keys.length && used < budget; ki++) {
    var npc = npcs[keys[ki]];
    var h = npc.dm_history || [];
    var take = Math.min(ki < 3 ? Math.max(12, Math.ceil(budget / 3)) : 6, budget - used, h.length);
    if (take <= 0) break;
    var recent = h.slice(-take);
    used += recent.length;
    var lines = ['· 与 ' + npc.name + ' 的微信往来（最近' + recent.length + '条）— 仅 ' + npc.name + ' 与 User 知晓，其他角色不知情：'];
    for (var i = 0; i < recent.length; i++) {
      var m = recent[i];
      var who = m.sender === 'ME' ? 'User' : npc.name;
      if (m.type === 'recall' && m.sender === 'ME') { lines.push('   User: （发了一条消息又撤回了——' + npc.name + ' 看不到内容）'); continue; }
      var tag = (m.type && m.type !== 'text') ? '[' + m.type + ']' : '';
      lines.push('   ' + who + tag + ': ' + String(m.content || '').substring(0, 300));
    }
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return '';
  return '【User 手机微信摘要（带入正文人物的记忆；每个角色只记得自己参与的那段，别人的私聊内容TA不知道）】\n' + blocks.join('\n');
}
function ptSyncInject() {
  try {
    var v = ptRead();
    var digest = ptBuildDigest(v);
    try { uninjectPrompts(['piaotiao-dm-digest']); } catch (e) {}
    if (!digest) return;
    injectPrompts([{
      id: 'piaotiao-dm-digest', position: 'in_chat', depth: 1,
      role: 'system', content: digest, should_scan: true,
    }]);
  } catch (e) { console.warn(PT_TAG, '注入摘要失败', e); }
}

// ── 触发 ──
// 玩家发送（面板「确定发送」）→ { focus: [ids], linesByConv, reason }
// 正文楼结算 → pt_floor_log（账房 VUE 末尾发）→ 有待复信先补、再按概率推进/陌生人
function ptOnPlayerReply(payload) {
  enqueueRequest({
    reason: payload && payload.reason ? payload.reason : '玩家刚在微信里回复了你',
    n: (payload && payload.n) || '1-2',
    focus: payload && payload.focus,
    linesByConv: payload && payload.linesByConv,
  }, true);
}
var AUTO_STRANGER_CHANCE = 0.25, AUTO_STRANGER_MINGAP = 3, AUTO_STRANGER_MAXPENDING = 4;
// ── v0.3.9：节奏控制（不让玩家"回不完消息"） ──
// BACKLOG_MAX：全账号未读总数上限——超过后所有"主动私信"（剧情/事件/陌生人/保底）暂停入队，
// 玩家自己发的回信请求（urgent）不受限；读完/回掉几条后自动恢复。
// QUIET_TRIGGER：连续 N 次楼层调度完全没有产生任何事件（私信/登门/偶遇都没有）→ 保底轮
// 随机抽一个"可能有需求"的 NPC 主动发 1 条。≈两个玩家回合（玩家楼+AI楼各计一次）。
var BACKLOG_MAX = 5, QUIET_TRIGGER = 4, _quietStreak = 0;
// ── v0.3.5：剧情成员同步（正文出场人物自动入列 + 察觉变化触发剧情私信） ──
var STORY_DM_CHANCE = 0.35, STORY_DM_COOLDOWN = 8;
function ptFloorNo() { try { return (parent.SillyTavern && parent.SillyTavern.getContext().chat.length) || 0; } catch (e) { return 0; } }
function ptStoryCast(sd) {
  var cast = {};
  function put(name, info) {
    var n = String(name || '').trim();
    if (!n || n === '无' || n.length > 12) return;
    var key = ptCanon(n);
    if (!cast[key]) { info.name = n; cast[key] = info; }
  }
  for (var fid in (sd.families || {})) {
    var f = sd.families[fid];
    if (f.head && ptBare(f.head.name)) put(ptBare(f.head.name), { family: fid, role: '一家之主', aware: Number(ptBare(f.head.awareness)) || 0 });
    if (f.spouse && ptBare(f.spouse.name)) put(ptBare(f.spouse.name), { family: fid, role: '配偶', aware: Number(ptBare(f.spouse.awareness)) || 0 });
    var ch = f.children || {};
    for (var cid in ch) { var c = ch[cid]; if (ptBare(c.name)) put(ptBare(c.name), { family: fid, role: '子女', aware: Number(ptBare(c.awareness)) || 0, stance: ptBare(c.stance) || '疏离' }); }
  }
  for (var cid2 in (sd.contacts || {})) {
    var c2 = sd.contacts[cid2];
    if (ptBare(c2.name)) put(ptBare(c2.name), { contact: cid2, role: ptBare(c2.group) || '联系人', aware: -1 });
  }
  return cast;
}
function ptStoryScan(allowDm) {
  try {
    var sd = ptStatData() || {};
    var cast = ptStoryCast(sd);
    var toAsk = [];
    ptUpdate(function (v) {
      if (!v.pt || !v.pt.npcs) return v;
      for (var key in cast) {
        var info = cast[key];
        if (!v.pt.npcs[key]) {
          var npc = ptEnsureNpc(v, key, info.name);
          npc.source = 'story';
          npc.story_role = info.role;
          if (info.family) npc.story_family = info.family;
          // 世界书档案映射动态注册（人物档案·人名 / 联系人档案·人名；查不到则 dossier 为空，无害）
          if (!PT_WB_KEY[info.name]) PT_WB_KEY[info.name] = (info.contact ? '联系人档案·' + info.name : '人物档案·' + info.name);
        }
      }
      if (!allowDm) return v;
      var floorNow = ptFloorNo();
      for (var key2 in cast) {
        var info2 = cast[key2];
        if (!info2.family || info2.role === '一家之主') continue; // 一家之主走正门对话；配偶/子女才是背线核心（设计 §3.2）
        var npc2 = v.pt.npcs[key2];
        if (!npc2 || npc2.muted) continue;
        var aw = Number(info2.aware) || 0;
        if (aw <= 0) continue;
        var st = npc2._story || { floor: -99, aware: 0 };
        var isNew = !npc2._story;
        var risen = aw > (st.aware || 0) && (floorNow - (st.floor || -99)) >= STORY_DM_COOLDOWN;
        if (isNew || risen) {
          npc2._story = { floor: floorNow, aware: aw };
          if (Math.random() < STORY_DM_CHANCE) toAsk.push(info2);
        }
      }
      return v;
    }).then(function () {
      for (var i = 0; i < toAsk.length; i++) {
        var a = toAsk[i];
        var stanceHint = a.stance === '反抗' ? '质问、警告或冷处理' : a.stance === '共谋' ? '试探合作、递话' : a.stance === '被利用' ? '隐晦地求助' : '小心翼翼地试探';
        // v0.3.9：剧情私信豁免积压节流——触发本身稀疏（35%+冷却8楼），且被节流会因 _story 已记楼而永久丢失
        enqueueRequest({ reason: a.name + '（' + (a.family || '') + '家的' + a.role + '，察觉度 ' + a.aw + '）在剧情里察觉到了家里的异常。以 TA 的立场主动给玩家发私信：' + stanceHint + '。符合 TA 的身份与性格，冷冰冰的礼貌，不要写成求救信，不要提系统或数值。没被点名的人这一轮不出现', n: '1-2', focus: [ptCanon(a.name)] });
      }
    });
  } catch (eS) { console.warn(PT_TAG, '剧情成员扫描失败（不影响其他私信）', eS); }
}

// ── v0.3.6：NPC 主动事件调度（每个世界书 NPC 都可能主动开启事件：私信/登门/偶遇） ──
var EVT_CHANCE = 0.4, EVT_MINGAP = 3, EVT_NPC_COOLDOWN = 20;
function ptEventTick() {
  try {
    var evtMeta = (ptRead().pt && ptRead().pt._evt) || { turns: 0, last: -99, lastNpc: '', cd: {} };
    var turns = (evtMeta.turns || 0) + 1;
    var passGate = (turns - (evtMeta.last != null ? evtMeta.last : -99)) >= EVT_MINGAP;
    ptUpdate(function (v) {
      if (!v.pt) return v;
      v.pt._evt = v.pt._evt || { turns: 0, last: -99, lastNpc: '', cd: {} };
      v.pt._evt.turns = turns;
      return v;
    });
    if (!passGate) return;
    (async function () {
      try {
        var es = await ptWbEntries();
        var candidates = [];
        var seen = {};
        for (var i = 0; i < es.length; i++) {
          var nm = String(es[i].comment || es[i].name || '');
          var m = nm.match(/^(?:人物档案|联系人档案)·(.+)$/);
          if (m && es[i].enabled !== false && !seen[m[1]]) { seen[m[1]] = true; candidates.push(m[1]); }
        }
        var npcs = (ptRead().pt && ptRead().pt.npcs) || {};
        for (var k in npcs) { var nn = String(npcs[k] && npcs[k].name || k); if (!seen[nn]) { seen[nn] = true; candidates.push(nn); } }
        // 排除：当前在场的（已在剧情里，不需要登场事件）、上一事件同一人、冷却中的
        var plot = await ptRecentPlot();
        var inScene = ptInScene(plot);
        candidates = candidates.filter(function (n) {
          if (inScene.indexOf(n) !== -1) return false;
          if (n === evtMeta.lastNpc) return false;
          var cd = evtMeta.cd || {};
          if (cd[n] != null && turns - cd[n] < EVT_NPC_COOLDOWN) return false;
          return true;
        });
        if (!candidates.length) return;
        if (Math.random() >= EVT_CHANCE) return;
        var who = candidates[Math.floor(Math.random() * candidates.length)];
        var forms = ['dm', 'visit', 'encounter'];
        var form = forms[Math.floor(Math.random() * forms.length)];
        var cdNow = (ptRead().pt && ptRead().pt._evt && ptRead().pt._evt.cd) || {};
        cdNow[who] = turns;
        await ptUpdate(function (v) {
          if (!v.pt) return v;
          v.pt._evt = v.pt._evt || { turns: turns, last: -99, lastNpc: '', cd: {} };
          v.pt._evt.last = turns;
          v.pt._evt.lastNpc = who;
          v.pt._evt.cd = cdNow;
          return v;
        });
        if (form === 'dm') {
          if (ptUnreadTotal((ptRead().pt) || {}) >= BACKLOG_MAX) return;   // v0.3.9：积压超限，事件私信这轮不发
        enqueueRequest({ reason: who + ' 主动给玩家发来消息——动机按 TA 的档案来（TA 想要什么/能提供什么/性格），也许是试探、也许是求办事、也许是送一个只有 TA 才知道的消息。没被点名的人这一轮不出现', n: '1-2', focus: [ptCanon(who)] });
        } else {
          var where = form === 'visit'
            ? '没有预约，直接出现在了玩家办公室的门口（楼下老魏没有提前打招呼——这次是 TA 自己要来）'
            : '在玩家即将前往或正在停留的场所里出现（场所由你按剧情与 TA 的场所习惯安排）';
          var instr = '【事件引导 · 主动登场】' + who + ' ' + where + '。请按 TA 的世界书档案（性格/行为模式/交易偏好/弱点/场所习惯）设计这次登场：TA 为什么来、想要什么、以什么姿态开口。冷冰冰的礼貌；信息隔离照常生效（TA 只知道 TA 该知道的）；本事件只在接下来的一次叙事中发生一次，之后按剧情自然延续；除剧情需要外不要输出 <UpdateVariable> 之外的结构化内容。';
          try { uninjectPrompts(['piaotiao-event-note']); } catch (e0) {}
          injectPrompts([{ id: 'piaotiao-event-note', position: 'in_chat', depth: 1, role: 'system', content: instr, should_scan: true }]);
          ptNotify('info', '📱 有事要发生……');
        }
      } catch (eE) { console.warn(PT_TAG, '事件调度失败（不影响私信）', eE); }
    })();
  } catch (eT) { console.warn(PT_TAG, '事件调度异常', eT); }
}

// ── v0.3.9：节奏工具（未读总量 / 身份短句 / 保底轮） ──
function ptUnreadTotal(sb) {
  var n = 0;
  for (var k in (sb && sb.npcs)) { if (Object.prototype.hasOwnProperty.call(sb.npcs, k)) n += (sb.npcs[k].unread || 0); }
  return n;
}
// 等待回复名单（last=THEM 的人）：保底轮不再追发（真人会干等）
function ptWaitingMap(sb) {
  var w = {};
  for (var k in (sb && sb.npcs)) {
    if (!Object.prototype.hasOwnProperty.call(sb.npcs, k)) continue;
    var h = sb.npcs[k].dm_history || [];
    if (h.length && h[h.length - 1].sender === 'THEM') w[k] = true;
  }
  return w;
}
// 世界书档案 → 身份短句：标题「## 名 · 职务」的职务 + 「现状:」前 22 字做性格/处境钩子
function ptTaglineFromDossier(dossier) {
  var s = String(dossier || '');
  var t = s.match(/^##\s*(.+)$/m);
  var head = t ? t[1].trim() : '';
  var pos = head.indexOf('·');
  var role = pos !== -1 ? head.slice(pos + 1).trim() : head;
  var now = s.match(/现状[:：]\s*(.+)/);
  var hook = now ? String(now[1]).trim() : '';
  if (hook.length > 22) hook = hook.slice(0, 22);
  var out = role + (hook ? '，' + hook : '');
  return out.slice(0, 42);
}
// 家庭成员身份句（家庭薄条目没有个人档案，从账本拼）
function ptFamilyTagline(sd, name) {
  var fm = (sd && sd.families) || {};
  for (var fid in fm) {
    var f = fm[fid];
    var fname = String(ptBare(f.name) || fid);
    var head = f.head || {};
    if (String(ptBare(head.name) || '') === name) return fname + '一家之主，话里带钩';
    var sp = f.spouse || {};
    if (String(ptBare(sp.name) || '') === name) return fname + '家主配偶，同谋度' + (ptBare(sp.complicity) || 0);
    var ch = f.children || {};
    for (var cid in ch) {
      if (String(ptBare(ch[cid].name) || '') === name) return fname + '子女，立场' + String(ptBare(ch[cid].stance) || '未知');
    }
  }
  return '';
}
// 每楼补抓：给缺 tagline 的 NPC 填身份短句（读本地世界书/账本，不调 API）
var _taglineBusy = false;
function ptEnsureTaglines() {
  if (_taglineBusy) return;
  _taglineBusy = true;
  (async function () {
    try {
      var v = ptRead();
      var sb = v && v.pt;
      if (!sb || !sb.npcs) return;
      var sd = ptStatData() || {};
      var jobs = [];
      for (var k in sb.npcs) {
        if (sb.npcs[k].tagline) continue;
        var nm = String(sb.npcs[k].name || k);
        var famLine = ptFamilyTagline(sd, nm);
        if (famLine) { jobs.push({ id: k, line: famLine }); continue; }
        if (sd.contacts && sd.contacts[k]) {
          var c = sd.contacts[k];
          jobs.push({ id: k, line: String(ptBare(c.group) || '体制内') + '联系人，对你' + String(ptBare(c.attitude) || '保持观望') });
          continue;
        }
        if (sb.npcs[k].archetype) { jobs.push({ id: k, line: String(sb.npcs[k].archetype) + '，主动寻上门' }); continue; }
        if (PT_WB_KEY[nm]) jobs.push({ id: k, wb: PT_WB_KEY[nm] });
      }
      if (!jobs.length) return;
      for (var i = 0; i < jobs.length; i++) {
        var it = jobs[i];
        if (it.wb) {
          var dossier = await ptWbContent(it.wb, '');
          if (!dossier) continue;
          it.line = ptTaglineFromDossier(dossier);
        }
        if (!it.line) continue;
        (function (id2, line2) {
          ptUpdate(function (v2) {
            if (v2.pt && v2.pt.npcs[id2] && !v2.pt.npcs[id2].tagline) v2.pt.npcs[id2].tagline = line2;
            return v2;
          }).catch(function () {});
        })(it.id, it.line);
      }
    } catch (e) { console.warn(PT_TAG, '身份短句抓取失败（不影响私信）', e); }
    finally { _taglineBusy = false; }
  })();
}
// 保底轮：连续 QUIET_TRIGGER 次楼层调度毫无动静 → 随机抽一个"可能有需求"的人主动开口
function ptQuietPing() {
  var v = ptRead();
  var sb = v && v.pt;
  if (!sb) return;
  if (ptUnreadTotal(sb) >= BACKLOG_MAX) return;      // 积压上限内才保底
  var waiting = ptWaitingMap(sb);
  var sd = ptStatData() || {};
  var contacts = sd.contacts || {};
  var withWant = [], others = [];
  // 账本联系人：有 wants 的优先（TA 最可能主动来找）
  for (var cid in contacts) {
    var c = contacts[cid];
    var nm = String(ptBare(c.name) || cid);
    var id = ptCanon(nm);
    var npc = sb.npcs[id];
    if (npc && npc.muted) continue;
    if (waiting[id]) continue;
    if (npc && (npc.unread || 0) >= 2) continue;
    withWant.push(id);
  }
  // 已有会话的人（有来往，TA 也可能惦记着事）
  for (var k in sb.npcs) {
    var n = sb.npcs[k];
    if (n.muted || waiting[k] || (n.unread || 0) >= 2) continue;
    if (withWant.indexOf(k) !== -1) continue;
    if (!(n.dm_history || []).length) continue;      // 从没说过话的空会话不保底
    others.push(k);
  }
  var pool = (withWant.length && Math.random() < 0.7) ? withWant : (others.length ? others : withWant);
  if (!pool.length) return;
  var pick = pool[Math.floor(Math.random() * pool.length)];
  var pname = ptIdToName(sb, pick);
  enqueueRequest({ reason: pname + ' 好像有事找你——按 TA 的档案（性格/想要什么/能提供什么），顺着最近剧情发来私信：也许是催问、试探、递话或求办事。冷冰冰的礼貌，不要提系统或数值。只让 ' + pname + ' 本人回应，别人不要出现', n: '1-2', focus: [pick] });
  console.info(PT_TAG, '保底轮：', pname, '（连续', _quietStreak, '次调度无事件）');
}

var _lastFloorSeen = -1;                                   // v0.3.8：楼层去重闸（message_received 一楼会多次触发）
async function ptOnFloorLog() {
  if (_busy || _pending.length) return;
  var vars = ptRead();
  var sb = (vars && vars.pt) ? vars.pt : null;
  if (!sb || !sb.npcs) return;
  var curFloor = -1;
  try { if (typeof getLastMessageId === 'function') curFloor = getLastMessageId(); } catch (e0) {}
  if (curFloor >= 0) {
    if (_lastFloorSeen < 0 && sb._lastLogFloor != null) _lastFloorSeen = sb._lastLogFloor;  // 刷新后从聊天级恢复
    if (curFloor === _lastFloorSeen) return;               // 同楼重放（生成结束/全局脚本/编辑都会再触发）→ 跳过
    _lastFloorSeen = curFloor;
    // v0.3.11：写点前移（fire-and-forget 过串行闸）——下方待复信/积压超限/未配API几条提前return
    // 也要记楼，否则刷新后恢复不到楼号，同楼重放多跑一遍（Bug H 遗留项）
    ptUpdate(function (v) { if (v.pt) v.pt._lastLogFloor = curFloor; return v; });
  }
  ptStoryScan(false);                                      // v0.3.5：正文出场人物自动入列（建会话不需要 API）
  var cfg = ptApiCfg();
  if (!cfg) return;                                        // 未配置独立 API：正文楼什么都不做
  ptStoryScan(true);                                       // v0.3.5：察觉变化 → 剧情私信候选
  ptEventTick();                                           // v0.3.6：NPC 主动事件调度（私信/登门/偶遇）
  // v0.3.9：节奏观测——1.6s 后看这波调度有没有产生任何动静（请求入队/事件命中）；
  // 连续 QUIET_TRIGGER 次毫无动静 → 保底轮随机抽一个有需求的人开口（回信请求不算事件）
  var qBefore = _reqQueue.length + (_busy ? 1 : 0);
  var evtLastBefore = (sb._evt && sb._evt.last != null) ? sb._evt.last : -99;
  setTimeout(function () {
    try {
      var nowV = ptRead();
      var ptNow = nowV && nowV.pt;
      if (!ptNow) return;
      var qAfter = _reqQueue.length + (_busy ? 1 : 0);
      var evtNow = (ptNow._evt && ptNow._evt.last != null) ? ptNow._evt.last : -99;
      if (qAfter > qBefore || evtNow !== evtLastBefore) { _quietStreak = 0; return; }
      _quietStreak++;
      if (_quietStreak >= QUIET_TRIGGER) ptQuietPing();
    } catch (eQ) { console.warn(PT_TAG, '节奏观测失败', eQ); }
  }, 1600);
  ptEnsureTaglines();                                      // v0.3.9：身份短句补抓（读本地档案，不调 API）
  var npcs = sb.npcs || {};
  // 1) 有待复信（NPC 上一条还没被回）→ 让剧情推着有人说话
  var pendingIds = [];
  for (var k in npcs) {
    if (!npcs.hasOwnProperty(k)) continue;
    var h = npcs[k].dm_history || [];
    if (h.length && h[h.length - 1].sender === 'THEM') pendingIds.push(k);
  }
  if (pendingIds.length && pendingIds.length <= 3) {
    if (ptUnreadTotal(sb) >= BACKLOG_MAX) return;          // v0.3.9：积压超限，主动私信全线暂停
    var names = pendingIds.map(function (id) { return (sb.npcs[id] && sb.npcs[id].name) || id; });
    enqueueRequest({ reason: '剧情推进后，这几个人里该有人顺着正文的事发来新消息：' + names.join('、') + '。没有新鲜事的人保持沉默', n: '0-2', focus: [] });
    return;
  }
  // 2) 偶尔一个体制陌生人主动来探路
  if (ptUnreadTotal(sb) >= BACKLOG_MAX) return;            // v0.3.9：积压超限，不再加新噪声
  var auto = sb._auto || { turns: 0, last: -99 };
  var turns = (auto.turns || 0) + 1;
  var unreadTotal = 0;
  for (var k2 in npcs) { if (npcs.hasOwnProperty(k2)) unreadTotal += (npcs[k2].unread || 0); }
  var hit = (turns - (auto.last != null ? auto.last : -99)) >= AUTO_STRANGER_MINGAP
    && unreadTotal < AUTO_STRANGER_MAXPENDING
    && Math.random() < AUTO_STRANGER_CHANCE;
  await ptUpdate(function (v) {
    if (!v.pt) return v;
    if (!v.pt._auto) v.pt._auto = { turns: 0, last: -99 };
    v.pt._auto.turns = turns;
    if (hit) v.pt._auto.last = turns;
    if (curFloor >= 0) v.pt._lastLogFloor = curFloor;      // v0.3.8：持久化已处理楼号（刷新后兜底）
    return v;
  });
  if (hit && ptUnreadTotal(sb) < BACKLOG_MAX) enqueueRequest({ reason: '全新的体制内陌生人主动来探路（按素材库现抽）：也许是打探，也许是求办事，也许是送消息投诚', n: '1' });
}

// 请求队列（批量合并）
var _reqQueue = [];
function enqueueRequest(req, urgent) {
  // v0.3.7：玩家回信插队（urgent）——回信排在剧情私信/事件请求前面，体验即时
  if (urgent && _reqQueue.length) { _reqQueue.unshift(req); } else { _reqQueue.push(req); }
  pumpRequests();
}
var _pumping = false;
async function pumpRequests() {
  if (_pumping) return;
  _pumping = true;
  try {
    while (_reqQueue.length) {
      var batch = _reqQueue.splice(0, _reqQueue.length);
      var merged = ptMergeRequests(batch);
      // 玩家先发的消息先入账（发件箱的 lines）
      if (batch.length === 1 && batch[0].linesByConv) {
        var lb = batch[0].linesByConv;
        await ptUpdate(function (v) {
          if (!v.pt) v.pt = { npcs: {}, _outbox: {} };
          for (var id in lb) {
            if (!lb.hasOwnProperty(id)) continue;
            var nm = ptIdToName(v, id);
            for (var li = 0; li < lb[id].length; li++) ptPushMe(v, id, nm, lb[id][li]);
          }
          return v;
        });
      }
      try { await ptRunOnce(merged); } catch (e) {
        console.warn(PT_TAG, '本轮私信生成失败：', e && (e.message || e));
        // v0.3.11：失败必须出声（军规2）——玩家消息此时已入账，报错要说清"消息没丢、是回复没生成"
        ptNotify('error', '私信发送失败：' + ((e && (e.message || e)) || '未知错误') + '。你的消息已入账，但对方这次没能回复——检查设置里的 API，或稍后再发一条。');
      }
      try { eventEmit('pt_updated'); } catch (e) {}
    }
  } finally { _pumping = false; }
}

// ── 启动种子 + 旧数据迁移（幂等；每个聊天都要跑到——种子跟着聊天级变量走，换聊天/新聊天都要补） ──
var _seeding = false;
async function ensureSeed() {
  if (_seeding) return;
  _seeding = true;
  try {
    var cur = ptRead();
    if (cur.pt && cur.pt._seeded) {
      _seeding = false;
      var before = Object.keys((cur.pt && cur.pt.npcs) || {}).sort().join('|');
      var probe = JSON.parse(JSON.stringify(cur));
      ptMergeFrags(probe);
      var after = Object.keys(probe.pt.npcs).sort().join('|');
      if (before !== after) await ptUpdate(function (v) { ptMergeFrags(v); return v; });
      return;
    }   // 本聊天已种过（碎片有变化才写回）
    await ptUpdate(function (v) {
      if (!v.pt) v.pt = { npcs: {}, _outbox: {} };
      if (v.pt._seeded) return v;
      // 旧版迁移：v0.2.6 的 piaotiao_phone（messages 数组）→ pt.npcs
      if (v.piaotiao_phone && !v.pt._migrated) {
        var old = v.piaotiao_phone;
        for (var id in (old.wechat_messages || {})) {
          var list = old.wechat_messages[id] && old.wechat_messages[id].messages;
          if (!Array.isArray(list) || !list.length) continue;
          var npc = ptEnsureNpc(v, ptCanon(String(id)), ptCanon(String(id)));
          for (var i = 0; i < list.length; i++) {
            var m = list[i];
            npc.dm_history.push({ sender: ptBare(m.from) === 'player' ? 'ME' : 'THEM', time: '', ts: 0, type: 'text', content: String(ptBare(m.text) || '') });
          }
          if (npc.dm_history.length > 400) npc.dm_history = npc.dm_history.slice(-400);
        }
        v.pt._migrated = true;
        console.info(PT_TAG, '旧版私信数据已迁移');
      }
      // 合并历史碎片后，开局种子：陈国邦的第一条私信
      ptMergeFrags(v);
      v.pt._seeded = true;
      var npc0 = ptEnsureNpc(v, '陈国邦', '陈国邦');
      if (!npc0.dm_history.length) {
        // v0.3.11：文案对齐 first_mes——开局正文里陈国邦已登门交割材料，私信必须是他"走后补发"的口吻（不能再是事前约时间）
        npc0.dm_history.push({ sender: 'THEM', time: ptNow(), ts: Date.now(), type: 'text', content: '刚到楼下，不多坐了。材料您先过目，小陈那边还压着份更全的，随后补上。孩子的事，全凭您安排。王厅长那头一有动静，我第一时间报您。' });
        npc0.unread = 1;
        npc0.last_ts = Date.now();
        npc0.last_message = '刚到楼下，不多坐了。材料您先过目…';
      }
      // 预建固定联系人的空会话（让玩家开局就能在微信列表和联系人页看到人脉）
      var seedArchetypes = {
        '王敬明': '教育厅副处长·管名额',
        '周之桐': '留学机构·管签证',
        '白景舟': '基金会·艺术圈',
        '蔡满仓': '商K·信息贩子',
        '方岚': '审计·讲规则',
        '雷万钧': '城投副总·带局玩伴',
      };
      for (var sk in seedArchetypes) {
        var sn = ptEnsureNpc(v, sk, sk);
        if (!sn.archetype) sn.archetype = seedArchetypes[sk];
        if (!sn.tagline) sn.tagline = seedArchetypes[sk];
      }
      // 开局种子第二条：雷万钧的组局邀约（带局人开局钩子，幂等）
      var npcLei = ptEnsureNpc(v, '雷万钧', '雷万钧');
      if (!npcLei.dm_history.length) {
        npcLei.dm_history.push({ sender: 'THEM', time: ptNow(), ts: Date.now(), type: 'text', content: '周五晚云顶会，我存酒的舱。给你留了个想让你见的人——不来别后悔，这姑娘可不是光会陪唱的。' });
        npcLei.unread = 1;
        npcLei.last_ts = Date.now();
        npcLei.last_message = '周五晚云顶会，我存酒的舱。给你留了个…';
      }
      return v;
    });
    ptSyncInject();
  } catch (e) { console.warn(PT_TAG, '种子失败', e); }
  _seeding = false;
}

// ── 挂载 ──
function ptMount() {
  if (typeof eventOn !== 'function') {
    var waited = 0;
    var timer = setInterval(function () {
      waited += 400;
      if (typeof eventOn === 'function' || waited > 30000) { clearInterval(timer); if (waited <= 30000) ptMount(); else console.warn(PT_TAG, '事件系统长时间未就绪，私信通道未启动'); }
    }, 400);
    return;
  }
  eventOn('pt_request_dm', function (payload) { ptOnPlayerReply(payload || {}); }); // TH 事件监听器直接收 payload 本体（非 e.detail）
  eventOn('pt_floor_log', function () { ensureSeed(); ptOnFloorLog(); });
  ensureSeed();
  ptEnsureTaglines();                                      // v0.3.9：挂载即补一次身份短句
  setInterval(function () { try { ensureSeed(); ptEnsureTaglines(); } catch (e) {} }, 10000);   // 换聊天/新聊天后补种（幂等，聊天级 _seeded 挡重复）
  console.info(PT_TAG, '已挂载：私信生成通道（独立API直连 + 行格式解析 + 队列合并/补漏 + injectPrompts 主线感知）');
}
ptMount();
window.__PiaotiaoDmGenerator = true;

})();
