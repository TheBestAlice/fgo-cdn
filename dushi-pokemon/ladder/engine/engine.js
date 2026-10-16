/* =============================================================================
 * 宝可梦对战引擎 · 天梯补丁版（由 天梯引擎/build.js 生成，请勿手改）
 * 来源：玩家脚本「宝可梦本地对战引擎 v1.24.0」content 第 118-7963 行
 *       脚本 id ac50dde1-554c-4b9d-99ad-56d33b70d122；引擎归原脚本作者所有，以下只是补丁。
 * 原文 sha256/16：111e5b5decf130b6
 * 已应用补丁：
 *   01 正电/负电 findAllyWithAbility 未定义（2 处）
 *   02 PP 耗尽自动使用挣扎（4 处）
 *   03 生命宝珠、达人带、属性强化道具加伤害（4 处）
 *   04 反射壁、光墙、极光幕减伤（3 处）
 *   05 暴击无视攻方负面阶级（2 处）
 *   06 讲究系道具锁招（4 处）
 * 补丁标记：源码中搜索「[天梯补丁 NN]」
 * ========================================================================== */
/* =============================================================================
 * 宝可梦对战 · 纯逻辑本地引擎（engine.js）
 * -----------------------------------------------------------------------------
 * 设计约束（见《宝可梦对战-架构与接口.md》第 1、4、5 节）：
 *   - 单文件 UMD：Node 里 require()，浏览器里挂 window.__PKMN_ENGINE__。
 *   - 数据表全部由参数注入（createEngine(DATA)），引擎不 require 任何文件。
 *   - 纯函数式：不访问 window / document / Mvu / 网络；除 Date.now() 外不碰宿主状态。
 *     时间戳只通过 opts.now 注入（默认 Date.now），随机数只通过 rng 注入（默认 Math.random）。
 *   - 无 eval、无动态拼函数名。
 *
 * 代码分节：
 *   §0 通用工具
 *   §1 数据访问      （typechart / pokedex / moves / names）
 *   §2 能力值        （buildUnit / startFromStat / 能力阶级 / 速度线）
 *   §3 伤害与判定    （命中 / 暴击 / 属性相性 / 伤害 / 异常状态 / 追加效果）
 *   §4 回合结算      （resolveTurn / 换人 / 濒死 / 胜负 / 经验升级）
 *   §5 AI 决策       （decideFoe，可替换策略）
 *   §6 patch 输出    （toPatches，字段名严格对齐 stat_data）
 *   §7 战报          （buildReport）
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  /* 宿主桥接：把 Node 的 module 与浏览器的 window 作为参数注入工厂，这样文件最后两行
     “UMD 约定” 里的 createEngine 天然处于作用域内，且那两行可以逐字保留。 */
  var nodeModule = (typeof module !== 'undefined' && module.exports) ? module : null;
  var browserWindow = (typeof window !== 'undefined') ? window : null;
  factory(nodeModule, browserWindow, root);
})(typeof globalThis !== 'undefined' ? globalThis : null, function (module, window, root) {
  'use strict';

  /* ===========================================================================
   * §0 通用工具
   * ======================================================================== */

  /**
   * 深拷贝（只处理 JSON 可表达的结构 + undefined 保留）
   * 契约 10.26：必须容忍对象图里的环（引擎为了给特性钩子传场地/状态，会在单位上挂
   * `__ctxState` 反向引用；unit → state → unit 就是一条环）。这里用「已访问对象对照表」
   * 保护，正常数据（无环）走的是同一条快路径，只在出现重复引用时多一次线性查找。
   */
  function deepClone(v) {
    if (v === null || typeof v !== 'object') return v;
    var seen = [];
    function walk(x) {
      if (x === null || typeof x !== 'object') return x;
      for (var s = 0; s < seen.length; s++) if (seen[s][0] === x) return seen[s][1];
      if (Array.isArray(x)) {
        var arr = new Array(x.length);
        seen.push([x, arr]);
        for (var i = 0; i < x.length; i++) arr[i] = walk(x[i]);
        return arr;
      }
      var out = {};
      seen.push([x, out]);
      var keys = Object.keys(x);
      for (var j = 0; j < keys.length; j++) out[keys[j]] = walk(x[keys[j]]);
      return out;
    }
    return walk(v);
  }

  /**
   * 给单位挂「当前场地状态」的反向引用（特性钩子里找同伴/对手用）。
   * **必须不可枚举**：否则 deepClone(单位) 会把整个 state 拖进来，形成环（契约 10.26）。
   */
  function bindState(unit, st) {
    if (!unit || typeof unit !== 'object' || !st) return unit;
    try {
      Object.defineProperty(unit, '__ctxState', { value: st, writable: true, configurable: true, enumerable: false });
    } catch (e) { /* 冻结对象等极端情况：退化为普通赋值（deepClone 已有环保护） */
      unit.__ctxState = st;
    }
    return unit;
  }

  /**
   * 记下 stat_data 里对手槽位的**原值**（写回保护用，契约 10.28）。
   * 同样必须不可枚举，避免被 deepClone / toPatches 当成业务字段带出去。
   */
  function setOrig(unit, values) {
    if (!unit || typeof unit !== 'object') return unit;
    try {
      Object.defineProperty(unit, '__orig', { value: values || {}, writable: true, configurable: true, enumerable: false });
    } catch (e) { unit.__orig = values || {}; }
    return unit;
  }
  function origOf(unit, key) {
    if (!unit || !unit.__orig) return undefined;
    return unit.__orig[key];
  }
  /**
   * 重新给对手单位挂上「槽位原值」（契约 10.28）。
   * deepClone 会丢掉不可枚举属性，所以每回合结算前按战位号从 state.__stat 恢复一次。
   */
  function restoreFoeOrig(st) {
    if (!st || !st.battle) return st;
    var baseSlots = obj(obj(st.__stat).对方战位);
    var list = [];
    if (Array.isArray(st.battle.foes) && st.battle.foes.length) list = st.battle.foes.slice();
    else if (st.battle.foe) list = [st.battle.foe];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u) continue;
      if (u.__orig) continue;
      /* 契约（对手变量保真）：优先用单位记下的**变量原键名**（AI 的语义键，例如 敌方首领1）；
       * pos 会被补位/压紧改写成槽位号，用它查原值会在那些情况下退化。 */
      var pos = varKeyOf(u, String(u.pos || (i + 1)));
      var slot = obj(baseSlots[pos]);
      setOrig(u, {
        已知特性: (slot.已知特性 !== undefined && slot.已知特性 !== null && String(slot.已知特性).trim())
          ? String(slot.已知特性).trim() : '',
        已知携带: (slot.已知携带 !== undefined && slot.已知携带 !== null && String(slot.已知携带).trim())
          ? String(slot.已知携带).trim() : ''
      });
    }
    /* 对方待命同理（按名字挂） */
    var bench = Array.isArray(st.battle.foeBench) ? st.battle.foeBench : [];
    var baseBench = obj(obj(st.__stat).对方待命);
    for (var b = 0; b < bench.length; b++) {
      var bu = bench[b];
      if (!bu || bu.__orig) continue;
      var bslot = obj(baseBench[bu.nickname]) || {};
      setOrig(bu, {
        已知特性: (bslot.已知特性 !== undefined && bslot.已知特性 !== null) ? String(bslot.已知特性).trim() : '',
        已知携带: (bslot.已知携带 !== undefined && bslot.已知携带 !== null) ? String(bslot.已知携带).trim() : ''
      });
    }
    return st;
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function obj(v) { return isPlainObject(v) ? v : {}; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function toInt(v, d) { return Math.floor(num(v, d)); }

  /**
   * 是不是「startFromStat 的产物」（契约 10.29）。
   *
   * resolveTurn / toPatches / buildReport / statusSnapshot / buildHandoff / applyImprov
   * 的前置校验统一走这里，避免"一边产出一边拒收"：
   *   - battle 必须是对象；
   *   - battle.allies 若存在必须是**数组**（集成层的兜底战斗态给不出它）；
   *   - meta 若存在必须是对象（兜底态也没有它）。
   * 这样「集成层把兜底态当引擎态」在引擎侧一进门就被挡住，报错也指向真正的形状问题。
   */
  function isEngineState(state) {
    if (!isPlainObject(state) || !isPlainObject(state.battle)) return false;
    if (state.battle.allies !== undefined && !Array.isArray(state.battle.allies)) return false;
    if (state.meta !== undefined && !isPlainObject(state.meta)) return false;
    return true;
  }

  /** JSON Pointer 转义（RFC6901），patch 路径用 */
  function esc(p) { return String(p).replace(/~/g, '~0').replace(/\//g, '~1'); }

  /**
   * 造一个可复现的随机源。
   *   mkRng()               → Math.random
   *   mkRng(0.85)           → 恒返回 0.85（固定序列单值）
   *   mkRng([0.1, 0.9])     → 顺序循环取值
   *   mkRng(function(){})   → 直接用
   * 注意：每次调用都会推进随机流，因此固定序列的用例要与调用顺序对应。
   */
  function mkRng(spec) {
    if (typeof spec === 'function') return spec;
    if (Array.isArray(spec)) {
      if (!spec.length) return function () { return 0; };
      var i = 0;
      return function () { var v = spec[i % spec.length]; i++; return typeof v === 'function' ? v() : num(v, 0); };
    }
    if (typeof spec === 'number' && isFinite(spec)) return function () { return spec; };
    return function () { return Math.random(); };
  }

  /** 线性同余伪随机（测试用可复现序列）：lcg(seed) */
  function lcg(seed) {
    var s = (num(seed, 1) >>> 0) || 1;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* 错误类型：数据表缺失 / 非法输入，便于集成层区分 */
  function EngineError(msg) { this.name = 'PkmnEngineError'; this.message = msg; }
  EngineError.prototype = Object.create(Error.prototype);
  function fail(msg) { throw new EngineError(msg); }

  /* 属性与状态的中文常量 */
  var STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  var STATUS_ZH = { ok: '正常', brn: '灼伤', par: '麻痹', psn: '中毒', tox: '剧毒', slp: '睡眠', frz: '冰冻', fnt: '濒死' };
  var STATUS_CODE = { '健康': 'ok', '正常': 'ok', '灼伤': 'brn', '麻痹': 'par', '中毒': 'psn', '剧毒': 'tox', '睡眠': 'slp', '冰冻': 'frz', '濒死': 'fnt' };
  var CATEGORY_ZH = { physical: '物理', special: '特殊', status: '变化' };
  var STAGE_MUL = [2 / 8, 2 / 7, 2 / 6, 2 / 5, 2 / 4, 2 / 3, 1, 3 / 2, 4 / 2, 5 / 2, 6 / 2, 7 / 2, 8 / 2];
  var DASH = '—';               /* 面板用全角破折号表示“无” */
  var BASIC = ['撞击'];          /* 招式兜底 */
  var DEFAULT_IV = 31;           /* EV 一律按 0（卡里没有努力值字段） */

  /* ---- 契约 10.4 节的 kinds 白名单：引擎只会解释这些 ---- */
  var DEFAULT_ABILITY_KINDS = [
    'switchInBoost', 'switchInWeather', 'switchInStatus', 'typeImmunity', 'typeChange',
    'damageMult', 'damageTakenMult', 'contactStatus', 'contactDamage', 'endTurnHeal',
    'endTurnDamage', 'weatherSpeed', 'statusImmunity', 'critBoost', 'priorityBoost',
    'statDropImmune', 'surviveKo', 'accuracyMult', 'stabMult', 'ignoreRedirection',
    'fieldEffect', 'formChangeOnKo',
    /* ---- 契约 10.4 扩展（特性规则表 §2.7）：下列 kinds 都有真实结算路径 ---- */
    'modify_power', 'modify_damage', 'modify_taken', 'modify_def', 'modify_speed', 'modify_stab',
    'modify_accuracy', 'modify_priority', 'calc_crit', 'crit_immune', 'immune', 'noMiss',
    'status_immune', 'volatile_immune', 'stat_drop_immune', 'endTurnCure', 'endTurnBoost',
    'endTurnHealAlly', 'endTurnDamage', 'endTurnHeal', 'switch_in', 'switchInBoost', 'switchInWeather',
    'switchInBoostChoice', 'switchInWarn', 'switchInRevealItem', 'switchInCopyAllyStages',
    'switchInResetAllyStages', 'switchInClearScreens', 'switchInHealAlly', 'switchInStatus',
    'afterDamagingHit', 'contactStatLower', 'contactStatLowerAll', 'contactStatusRandom', 'contactVolatile',
    'contactAbilitySwap', 'contactPerish', 'onFlinch', 'on_crit', 'on_ko', 'onAnyFaint', 'on_faint',
    'onHpThreshold', 'onStatLowered', 'doubleStages', 'invertStages', 'reflectStatDrop', 'unaware',
    'boostBestStat', 'moody', 'copyFoeBoosts', 'healOnSwitchOut', 'emergencyExit', 'goesLast',
    'truant', 'doublePPCost', 'noRecoil', 'noIndirectDamage', 'noContact', 'blockSecondary',
    'doubleSecondaryChance', 'addFlinchSecondary', 'sheerForce', 'bypassStatusImmunity', 'fixMultiHit',
    'typeChangeMove', 'typeChangeSelf', 'ignoreTypeImmunity', 'ignoreAbility', 'ignoreProtect',
    'denyPriorityFoe', 'trapFoe', 'noForceSwitch', 'stickyItem', 'alwaysFlee', 'wonderGuard',
    'allyBasePower', 'allyDamageTaken', 'allyModifyAccuracy', 'allyStatusImmune', 'allyStatDropImmune',
    'allyVolatileImmune', 'allyStatBoost', 'auraDamage', 'auraBreak', 'ruinOnField', 'fieldEffect',
    'liquidOoze', 'syncStatus', 'disableMove', 'earlyBird', 'noop'
  ];
  var DEFAULT_ITEM_KINDS = [
    'damageMult', 'damageTakenMult', 'typeBoost', 'endTurnHeal', 'choiceLock', 'speedMult',
    'accuracyMult', 'surviveKo', 'berryHeal', 'statMult', 'lifeOrb', 'contactDamage',
    'critBoost', 'statusCure'
  ];
  /* 本版本真正参与结算的 kinds（其余 mapped:true 的条目也按“未实现”提示，不静默忽略）。
     现在特性规则表（ABILITY_RULES）里的 kinds 全部有结算路径，因此这里直接取白名单全集；
     真正的「未参与结算」只由规则表里 residual / noop 两种标记决定（见 abilityRule()）。 */
  var IMPLEMENTED_ABILITY_KINDS = DEFAULT_ABILITY_KINDS.slice();
  var IMPLEMENTED_ITEM_KINDS = ['endTurnHeal', 'berryHeal', 'surviveKo', 'critBoost', 'speedMult', 'damageMult', 'typeBoost', 'statusCure', 'lifeOrb'];
  /* ===========================================================================
   * 特性结构化效果表（ABILITY_RULES）
   * ---------------------------------------------------------------------------
   * 每条形如 {zh, en, kinds:[触发器], params:{条件+效果}}；residual/noop 两类标记
   * 表示「确实无法离线结算」与「本身没有战斗结算」，它们不会输出「未参与结算」提示，
   * 但会在 state.meta.unmapped 里留一条可读说明（见 abilityRule / lookupAbility）。
   * 本表与 宝可梦对战-数据/ability-effects.json 同源（321 条，覆盖 abilities.json 全量）。
   * ======================================================================== */
  var ABILITY_RULES = [
  {zh:"适应力", en:"Adaptability", kinds:["modify_stab"], params:{"mult":2}},
  {zh:"飞行皮肤", en:"Aerilate", kinds:["typeChangeMove"], params:{"to":"飞行","from":"一般","mult":1.2}},
  {zh:"引爆", en:"Aftermath", kinds:["contactDamage"], params:{"contactFraction":0.25,"onlyOnFaint":true}},
  {zh:"气闸", en:"Air Lock", residual:true, reason:"需要「全天气无效」的全局天气层（引擎的天气只做招式倍率，天气本身由卡里给出）"},
  {zh:"分析", en:"Analytic", kinds:["modify_power"], params:{"mult":1.3,"when":{"movesLast":true}}},
  {zh:"愤怒穴位", en:"Anger Point", kinds:["on_crit"], params:{"set":{"atk":6}}},
  {zh:"愤怒甲壳", en:"Anger Shell", kinds:["onHpThreshold"], params:{"hpAtMost":2,"boost":{"atk":1,"spa":1,"spe":1,"def":-1,"spd":-1},"text":"愤怒甲壳发动了"}},
  {zh:"危险预知", en:"Anticipation", kinds:["switchInWarn"]},
  {zh:"沙穴", en:"Arena Trap", kinds:["trapFoe"], params:{"onlyGrounded":true,"exceptTypes":["幽灵"]}},
  {zh:"尾甲", en:"Armor Tail", kinds:["denyPriorityFoe"]},
  {zh:"芳香幕", en:"Aroma Veil", kinds:["allyVolatileImmune"], params:{"volatiles":["着迷","混乱"]}},
  {zh:"人马一体", en:"As One (Glastrier)", residual:true, reason:"需要蕾冠王+坐骑的形态数据（同时具有紧张感与漆黑嘶鸣/苍白嘶鸣两个特性）"},
  {zh:"人马一体", en:"As One (Spectrier)", residual:true, reason:"需要蕾冠王+坐骑的形态数据（同时具有紧张感与漆黑嘶鸣/苍白嘶鸣两个特性）"},
  {zh:"气场破坏", en:"Aura Break", kinds:["auraBreak"], params:{"mult":0.75}},
  {zh:"波导防护", en:"Aura Guard", kinds:["modify_taken"], params:{"mult":0.5,"when":{"contact":true}}},
  {zh:"梦魇", en:"Bad Dreams", kinds:["endTurnDamage"], params:{"damageFraction":0.125}},
  {zh:"捡球", en:"Ball Fetch", kinds:["noop"], params:{"note":"战斗外效果"}},
  {zh:"蓄电池", en:"Battery", kinds:["allyBasePower"], params:{"mult":1.3,"when":{"moveCategory":"special"}}},
  {zh:"战斗盔甲", en:"Battle Armor", kinds:["crit_immune"]},
  {zh:"牵绊变身", en:"Battle Bond", residual:true, reason:"需要甲贺忍蛙「小智版」形态数据"},
  {zh:"灾祸之玉", en:"Beads of Ruin", kinds:["ruinOnField"], params:{"stat":"spd","mult":0.75}},
  {zh:"异兽提升", en:"Beast Boost", kinds:["on_ko"], params:{"bestStat":true,"stages":1}},
  {zh:"怒火冲天", en:"Berserk", kinds:["onHpThreshold"], params:{"hpAtMost":2,"boost":{"spa":1},"text":"怒火冲天发动了"}},
  {zh:"健壮胸肌", en:"Big Pecks", kinds:["stat_drop_immune"], params:{"immuneStats":["def"]}},
  {zh:"猛火", en:"Blaze", kinds:["damageBound"], params:{"multTypes":["火"],"mult":1.5,"when":{"hpAtMost":3}}},
  {zh:"防弹", en:"Bulletproof", kinds:["immune"], params:{"immuneFlags":["bullet"]}},
  {zh:"颊囊", en:"Cheek Pouch", kinds:["noop"], params:{"note":"需要「吃树果」事件"}},
  {zh:"苍白嘶鸣", en:"Chilling Neigh", kinds:["on_ko"], params:{"boost":{"atk":1}}},
  {zh:"叶绿素", en:"Chlorophyll", kinds:["modify_speed"], params:{"mult":2,"when":{"weather":["晴","大晴天","大日照","日照强烈"]}}},
  {zh:"恒净之躯", en:"Clear Body", kinds:["stat_drop_immune"], params:{"immuneStats":"all"}},
  {zh:"无关天气", en:"Cloud Nine", residual:true, reason:"同上：需要全局压制天气效果的场地层"},
  {zh:"变色", en:"Color Change", residual:true, reason:"正作以「形态」承载受击改属性，缺形态/属性改写数据"},
  {zh:"绝对睡眠", en:"Comatose", residual:true, reason:"正作里是「永久睡眠但可行动」的特殊状态，引擎异常状态只有六种，无法忠实表达"},
  {zh:"发号施令", en:"Commander", kinds:["noop"], params:{"note":"需要米立龙钻进吃吼霸的双打联动数据"}},
  {zh:"好胜", en:"Competitive", kinds:["onStatLowered"], params:{"boost":{"spa":2}}},
  {zh:"复眼", en:"Compound Eyes", kinds:["modify_accuracy"], params:{"accuracyMult":1.3}},
  {zh:"唱反调", en:"Contrary", kinds:["invertStages"]},
  {zh:"腐蚀", en:"Corrosion", kinds:["bypassStatusImmunity"], params:{"statuses":["psn","tox"]}},
  {zh:"同台共演", en:"Costar", kinds:["switchInCopyAllyStages"]},
  {zh:"棉絮", en:"Cotton Down", kinds:["contactStatLowerAll"], params:{"boost":{"spe":-1}}},
  {zh:"反刍", en:"Cud Chew", kinds:["noop"], params:{"note":"需要树果重复发动"}},
  {zh:"怪药", en:"Curious Medicine", kinds:["switchInResetAllyStages"]},
  {zh:"诅咒之躯", en:"Cursed Body", kinds:["disableMove"], params:{"chance":30}},
  {zh:"迷人之躯", en:"Cute Charm", kinds:["contactVolatile"], params:{"volatile":"着迷","chance":30}},
  {zh:"湿气", en:"Damp", kinds:["noop"], params:{"note":"禁止自爆类招式（本数据表的中文招式名里没有「大爆炸/自爆」条目，待表补齐后再接）"}},
  {zh:"舞者", en:"Dancer", kinds:["noop"], params:{"note":"需要收集本回合所有跳舞招式（引擎逐条结算，无招式收集层）"}},
  {zh:"暗黑气场", en:"Dark Aura", kinds:["auraDamage"], params:{"types":["恶"],"mult":1.33}},
  {zh:"不屈之盾", en:"Dauntless Shield", kinds:["switchInBoost"], params:{"boosts":{"def":1}}},
  {zh:"鲜艳之躯", en:"Dazzling", kinds:["noop"], params:{"note":"双打里禁止对手先制招式（引擎只做单打对位）"}},
  {zh:"软弱", en:"Defeatist", kinds:["damageBound"], params:{"multStats":["atk","spa"],"mult":0.5,"when":{"hpAtMost":2}}},
  {zh:"不服输", en:"Defiant", kinds:["onStatLowered"], params:{"boost":{"atk":2}}},
  {zh:"德尔塔气流", en:"Delta Stream", kinds:["noop"], params:{"note":"需要「全天气无效」的全局天气层"}},
  {zh:"终结之地", en:"Desolate Land", kinds:["switchInWeather"], params:{"weather":"大日照"}},
  {zh:"画皮", en:"Disguise", kinds:["surviveKo"], params:{"surviveHp":1,"ohkoImmune":true,"once":true,"text":"画皮挡下了这一击"}},
  {zh:"下载", en:"Download", kinds:["switchInBoostChoice"]},
  {zh:"龙颚", en:"Dragon's Maw", kinds:["damageBound"], params:{"multTypes":["龙"],"mult":1.5}},
  {zh:"龙皮肤", en:"Dragonize", kinds:["typeChangeMove"], params:{"to":"龙","from":"一般","mult":1.2}},
  {zh:"降雨", en:"Drizzle", kinds:["switchInWeather"], params:{"weather":"雨"}},
  {zh:"日照", en:"Drought", kinds:["switchInWeather"], params:{"weather":"大晴天"}},
  {zh:"干燥皮肤", en:"Dry Skin", kinds:["immune","endTurnHeal","endTurnDamage"], params:{"immuneTypes":["水"],"onImmune":{"healFraction":0.25},"healFraction":0.125,"healWhen":{"weather":["下雨","大雨","雨"]},"damageFraction":0.125,"damageWhen":{"weather":["晴","大晴天","大日照","日照强烈"]}}},
  {zh:"早起", en:"Early Bird", kinds:["earlyBird"]},
  {zh:"食土", en:"Earth Eater", kinds:["immune"], params:{"immuneTypes":["地面"],"onImmune":{"healFraction":0.25}}},
  {zh:"鳗鳗高升", en:"Eelevate", kinds:["immune"], params:{"immuneTypes":["地面"]}},
  {zh:"孢子", en:"Effect Spore", kinds:["contactStatusRandom"], params:{"statuses":["slp","par","psn"],"chance":30}},
  {zh:"电气制造者", en:"Electric Surge", kinds:["fieldEffect"], params:{"terrain":"电气场地"}},
  {zh:"电力转换", en:"Electromorphosis", kinds:["afterDamagingHit"], params:{"charge":true}},
  {zh:"Embody Aspect (Cornerstone)", kinds:["switchInBoost"], params:{"boosts":{"def":1}}},
  {zh:"Embody Aspect (Hearthflame)", kinds:["switchInBoost"], params:{"boosts":{"atk":1}}},
  {zh:"Embody Aspect (Teal)", kinds:["switchInBoost"], params:{"boosts":{"spe":1}}},
  {zh:"Embody Aspect (Wellspring)", kinds:["switchInBoost"], params:{"boosts":{"spd":1}}},
  {zh:"危险回避", en:"Emergency Exit", kinds:["emergencyExit"], params:{"hpAtMost":2}},
  {zh:"妖精气场", en:"Fairy Aura", kinds:["auraDamage"], params:{"types":["妖精"],"mult":1.33}},
  {zh:"过滤", en:"Filter", kinds:["modify_taken"], params:{"mult":0.75,"when":{"superEffective":true}}},
  {zh:"火焰鬃毛", en:"Fire Mane", kinds:["damageBound"], params:{"multTypes":["火"],"mult":1.5}},
  {zh:"火焰之躯", en:"Flame Body", kinds:["contactStatus"], params:{"contactStatus":"brn","contactChance":30}},
  {zh:"受热激升", en:"Flare Boost", kinds:["modify_power"], params:{"mult":1.5,"when":{"moveCategory":"special","hasStatus":true}}},
  {zh:"引火", en:"Flash Fire", kinds:["immune"], params:{"immuneTypes":["火"],"onImmune":{"boost":{"spa":1}}}},
  {zh:"花之礼", en:"Flower Gift", residual:true, reason:"需要樱花儿「花之礼形态」数据（晴天才有的攻/特防加成）"},
  {zh:"花幕", en:"Flower Veil", kinds:["allyStatDropImmune"], params:{"onlyTypes":["草"]}},
  {zh:"毛茸茸", en:"Fluffy", kinds:["modify_taken"], params:{"mult":0.5,"when":{"contact":true},"extraMult":2,"extraWhen":{"moveTypes":["火"]}}},
  {zh:"阴晴不定", en:"Forecast", residual:true, reason:"需要飘浮泡泡 4 种形态数据（天气决定属性）"},
  {zh:"预知梦", en:"Forewarn", kinds:["switchInWarn"]},
  {zh:"友情防守", en:"Friend Guard", kinds:["allyDamageTaken"], params:{"mult":0.75}},
  {zh:"察觉", en:"Frisk", kinds:["switchInRevealItem"]},
  {zh:"金属防护", en:"Full Metal Body", kinds:["stat_drop_immune"], params:{"immuneStats":"all"}},
  {zh:"毛皮大衣", en:"Fur Coat", kinds:["modify_def"], params:{"mult":2}},
  {zh:"疾风之翼", en:"Gale Wings", kinds:["modify_priority"], params:{"plus":1,"when":{"moveTypes":["飞行"],"fullHP":true}}},
  {zh:"电气皮肤", en:"Galvanize", kinds:["typeChangeMove"], params:{"to":"电","from":"一般","mult":1.2}},
  {zh:"贪吃鬼", en:"Gluttony", kinds:["noop"], params:{"note":"树果发动时机提前（引擎的树果回复无阈值判定）"}},
  {zh:"黄金之躯", en:"Good as Gold", kinds:["immune"], params:{"immuneCategory":"status"}},
  {zh:"黏滑", en:"Gooey", kinds:["contactStatLower"], params:{"boost":{"spe":-1}}},
  {zh:"一猩一意", en:"Gorilla Tactics", noop:true, note:"战斗外/信息类特性，无战斗结算"},
  {zh:"草之毛皮", en:"Grass Pelt", kinds:["modify_def"], params:{"mult":1.5,"when":{"terrain":"青草场地"}}},
  {zh:"青草制造者", en:"Grassy Surge", kinds:["fieldEffect"], params:{"terrain":"青草场地"}},
  {zh:"漆黑嘶鸣", en:"Grim Neigh", kinds:["on_ko"], params:{"boost":{"spa":1}}},
  {zh:"看门犬", en:"Guard Dog", kinds:["stat_drop_immune"], params:{"immuneStats":["atk"]}},
  {zh:"一口导弹", en:"Gulp Missile", residual:true, reason:"需要古月鸟「一口导弹」形态数据（形态切换承载反伤/异常）"},
  {zh:"毅力", en:"Guts", kinds:["damageBound"], params:{"multStats":["atk"],"mult":1.5,"when":{"hasStatus":true}}},
  {zh:"强子引擎", en:"Hadron Engine", kinds:["fieldEffect","damageBound"], params:{"terrain":"电气场地","multStats":["spa"],"mult":1.333,"when":{"terrain":"电气场地"}}},
  {zh:"收获", en:"Harvest", kinds:["noop"], params:{"note":"需要树果耗尽记录"}},
  {zh:"治愈之心", en:"Healer", kinds:["endTurnHealAlly"], params:{"chance":30,"cureStatus":true}},
  {zh:"耐热", en:"Heatproof", kinds:["modify_taken"], params:{"mult":0.5,"when":{"moveTypes":["火"]}}},
  {zh:"重金属", en:"Heavy Metal", kinds:["noop"], params:{"note":"体重翻倍（引擎不结算体重）"}},
  {zh:"采蜜", en:"Honey Gather", kinds:["noop"], params:{"note":"战斗外效果"}},
  {zh:"款待", en:"Hospitality", kinds:["switchInHealAlly"], params:{"healFraction":0.25}},
  {zh:"大力士", en:"Huge Power", kinds:["damageBound"], params:{"multStats":["atk"],"mult":2}},
  {zh:"饱了又饿", en:"Hunger Switch", kinds:["noop"], params:{"note":"需要莫鲁贝可形态数据"}},
  {zh:"活力", en:"Hustle", kinds:["damageBound","modify_accuracy"], params:{"multStats":["atk"],"mult":1.5,"accuracyMult":0.8,"when":{"moveCategory":"physical"}}},
  {zh:"湿润之躯", en:"Hydration", kinds:["endTurnCure"], params:{"when":{"weather":["下雨","大雨","雨"]},"text":"湿润之躯治愈了异常状态"}},
  {zh:"怪力钳", en:"Hyper Cutter", kinds:["stat_drop_immune"], params:{"immuneStats":["atk"]}},
  {zh:"冰冻之躯", en:"Ice Body", kinds:["endTurnHeal"], params:{"healFraction":0.063,"healWhen":{"weather":["冰雹","下雪","雪"]}}},
  {zh:"结冻头", en:"Ice Face", kinds:["noop"], params:{"note":"见「冰冻头」（该条为数据表里的重复条目）"}},
  {zh:"冰鳞粉", en:"Ice Scales", kinds:["modify_taken"], params:{"mult":0.5,"when":{"moveCategory":"special"}}},
  {zh:"发光", en:"Illuminate", kinds:["stat_drop_immune"], params:{"immuneStats":["acc"]}},
  {zh:"幻觉", en:"Illusion", residual:true, reason:"需要「伪装成队伍末位宝可梦的外观」的展示层数据"},
  {zh:"免疫", en:"Immunity", kinds:["status_immune","endTurnCure"], params:{"immuneStatuses":["psn","tox"]}},
  {zh:"变身者", en:"Imposter", residual:true, reason:"需要完整复制对手种族值/技能/能力阶级，缺对手数据结构"},
  {zh:"穿透", en:"Infiltrator", kinds:["ignoreRedirection"]},
  {zh:"飞出的内在物", en:"Innards Out", kinds:["on_faint"], params:{"reflectDamage":true}},
  {zh:"精神力", en:"Inner Focus", kinds:["volatile_immune"], params:{"immuneVolatiles":["畏缩"]}},
  {zh:"不眠", en:"Insomnia", kinds:["status_immune","endTurnCure"], params:{"immuneStatuses":["slp"]}},
  {zh:"威吓", en:"Intimidate", kinds:["switchInBoost"], params:{"boosts":{"atk":-1},"boostTarget":"foe"}},
  {zh:"不挠之剑", en:"Intrepid Sword", kinds:["switchInBoost"], params:{"boosts":{"atk":1}}},
  {zh:"铁刺", en:"Iron Barbs", kinds:["contactDamage"], params:{"contactFraction":0.125}},
  {zh:"铁拳", en:"Iron Fist", kinds:["modify_power"], params:{"mult":1.2,"when":{"moveFlags":["punch"]}}},
  {zh:"正义之心", en:"Justified", kinds:["afterDamagingHit"], params:{"when":{"moveTypes":["恶"]},"boost":{"atk":1}}},
  {zh:"锐利目光", en:"Keen Eye", kinds:["stat_drop_immune"], params:{"immuneStats":["acc"]}},
  {zh:"笨拙", en:"Klutz", kinds:["noop"], params:{"note":"无视自身携带物（引擎未实现道具被动）"}},
  {zh:"叶子防守", en:"Leaf Guard", kinds:["status_immune"], params:{"immuneStatuses":["all"],"when":{"weather":["晴","大晴天","大日照","日照强烈"]}}},
  {zh:"飘浮", en:"Levitate", kinds:["immune"], params:{"immuneTypes":["地面"]}},
  {zh:"自由者", en:"Libero", kinds:["typeChangeSelf"]},
  {zh:"轻金属", en:"Light Metal", kinds:["noop"], params:{"note":"体重减半（引擎不结算体重）"}},
  {zh:"避雷针", en:"Lightning Rod", kinds:["immune"], params:{"immuneTypes":["电"],"onImmune":{"boost":{"spa":1}}}},
  {zh:"柔软", en:"Limber", kinds:["status_immune","endTurnCure"], params:{"immuneStatuses":["par"]}},
  {zh:"甩不掉的气味", en:"Lingering Aroma", kinds:["contactAbilitySwap"], params:{"to":"甩不掉的气味"}},
  {zh:"污泥浆", en:"Liquid Ooze", kinds:["liquidOoze"]},
  {zh:"湿润之声", en:"Liquid Voice", kinds:["typeChangeMove"], params:{"to":"水","fromFlags":["sound"],"mult":1.2}},
  {zh:"远隔", en:"Long Reach", kinds:["noContact"]},
  {zh:"魔法镜", en:"Magic Bounce", kinds:["noop"], params:{"note":"需要把变化招式弹回攻击方（引擎无招式反弹层）"}},
  {zh:"魔法防守", en:"Magic Guard", kinds:["noIndirectDamage"]},
  {zh:"魔术师", en:"Magician", kinds:["noop"], params:{"note":"需要道具夺取"}},
  {zh:"熔岩铠甲", en:"Magma Armor", kinds:["status_immune","endTurnCure"], params:{"immuneStatuses":["frz"]}},
  {zh:"磁力", en:"Magnet Pull", kinds:["trapFoe"], params:{"onlyTypes":["钢"]}},
  {zh:"神奇鳞片", en:"Marvel Scale", kinds:["modify_def"], params:{"mult":1.5,"when":{"hasStatus":true}}},
  {zh:"超级发射器", en:"Mega Launcher", kinds:["modify_power"], params:{"mult":1.5,"when":{"moveFlags":["pulse"]}}},
  {zh:"超级日光", en:"Mega Sol", kinds:["noop"], params:{"note":"无天气也能吃到晴天加成（引擎的天气来自卡内变量，不做特性改写）"}},
  {zh:"不仁不义", en:"Merciless", kinds:["calc_crit"], params:{"plus":5,"when":{"targetStatus":["psn","tox"]}}},
  {zh:"拟态", en:"Mimicry", residual:true, reason:"正作以「形态」承载场地改属性，需要对应形态数据"},
  {zh:"心眼", en:"Mind's Eye", kinds:["stat_drop_immune"], params:{"immuneStats":["acc"]}},
  {zh:"负电", en:"Minus", kinds:["allyStatBoost"], params:{"stat":"spa","mult":1.5,"requiresAllyAbility":["正电","负电"]}},
  {zh:"镜甲", en:"Mirror Armor", kinds:["reflectStatDrop"]},
  {zh:"薄雾制造者", en:"Misty Surge", kinds:["fieldEffect"], params:{"terrain":"薄雾场地"}},
  {zh:"破格", en:"Mold Breaker", kinds:["ignoreAbility"]},
  {zh:"心情不定", en:"Moody", kinds:["moody"]},
  {zh:"电气引擎", en:"Motor Drive", noop:true, note:"战斗外/信息类特性，无战斗结算"},
  {zh:"Mountaineer", kinds:["immune"], params:{"immuneTypes":["岩石"],"when":{"justSwitchedIn":true}}},
  {zh:"自信过度", en:"Moxie", kinds:["on_ko"], params:{"boost":{"atk":1}}},
  {zh:"多重鳞片", en:"Multiscale", kinds:["modify_taken"], params:{"mult":0.5,"when":{"fullHP":true}}},
  {zh:"多属性", en:"Multitype", residual:true, reason:"需要石板/纯晶道具与阿尔宙斯形态数据"},
  {zh:"木乃伊", en:"Mummy", kinds:["contactAbilitySwap"], params:{"to":"木乃伊"}},
  {zh:"菌丝之力", en:"Mycelium Might", kinds:["goesLast"], params:{"when":{"moveCategory":"status"}}},
  {zh:"自然回复", en:"Natural Cure", kinds:["healOnSwitchOut"], params:{"cureStatus":true}},
  {zh:"脑核之力", en:"Neuroforce", kinds:["modify_damage"], params:{"mult":1.25,"when":{"superEffective":true}}},
  {zh:"化学变化气体", en:"Neutralizing Gas", kinds:["noop"], params:{"note":"需要全局特性压制层"}},
  {zh:"No Ability", kinds:["noop"], params:{"note":"无特性，无需结算"}},
  {zh:"无防守", en:"No Guard", kinds:["noMiss"]},
  {zh:"一般皮肤", en:"Normalize", kinds:["typeChangeMove"], params:{"to":"一般","mult":1.2}},
  {zh:"迟钝", en:"Oblivious", kinds:["volatile_immune"], params:{"immuneVolatiles":["着迷"]}},
  {zh:"跟风", en:"Opportunist", kinds:["copyFoeBoosts"]},
  {zh:"绯红脉动", en:"Orichalcum Pulse", kinds:["switchInWeather","damageBound"], params:{"weather":"大晴天","multStats":["atk"],"mult":1.333,"when":{"weather":["晴","大晴天","大日照","日照强烈"]}}},
  {zh:"防尘", en:"Overcoat", kinds:["immune"], params:{"immuneFlags":["powder"]}},
  {zh:"茂盛", en:"Overgrow", kinds:["damageBound"], params:{"multTypes":["草"],"mult":1.5,"when":{"hpAtMost":3}}},
  {zh:"我行我素", en:"Own Tempo", kinds:["volatile_immune"], params:{"immuneVolatiles":["混乱"]}},
  {zh:"亲子爱", en:"Parental Bond", kinds:["parentalBond"], params:{"mult":0.25}},
  {zh:"粉彩护幕", en:"Pastel Veil", kinds:["allyStatusImmune"], params:{"statuses":["psn","tox"],"self":true}},
  {zh:"灭亡之躯", en:"Perish Body", kinds:["contactPerish"]},
  {zh:"Persistent", kinds:["noop"], params:{"note":"CAP 特性：需要场地/状态持续回合改写层"}},
  {zh:"顺手牵羊", en:"Pickpocket", kinds:["noop"], params:{"note":"需要道具夺取"}},
  {zh:"捡拾", en:"Pickup", kinds:["noop"], params:{"note":"需要在场道具记录"}},
  {zh:"贯穿钻", en:"Piercing Drill", kinds:["ignoreProtect"]},
  {zh:"妖精皮肤", en:"Pixilate", kinds:["typeChangeMove"], params:{"to":"妖精","from":"一般","mult":1.2}},
  {zh:"正电", en:"Plus", kinds:["allyStatBoost"], params:{"stat":"spa","mult":1.5,"requiresAllyAbility":["正电","负电"]}},
  {zh:"毒疗", en:"Poison Heal", kinds:["endTurnHeal"], params:{"healFraction":0.125,"healWhen":{"statuses":["psn","tox"]},"text":"毒疗回复了体力"}},
  {zh:"毒刺", en:"Poison Point", kinds:["contactStatus"], params:{"contactStatus":"psn","contactChance":30}},
  {zh:"毒傀儡", en:"Poison Puppeteer", residual:true, reason:"需要桃歹郎专属联动（中毒→混乱）与对手特性数据"},
  {zh:"毒手", en:"Poison Touch", kinds:["afterDamagingHit"], params:{"contact":true,"status":"psn","chance":30}},
  {zh:"群聚变形", en:"Power Construct", residual:true, reason:"需要基格尔德「完全体形态」数据"},
  {zh:"化学之力", en:"Power of Alchemy", residual:true, reason:"同「接球手」：需要同队友方特性的运行时继承"},
  {zh:"能量点", en:"Power Spot", kinds:["allyBasePower"], params:{"mult":1.3}},
  {zh:"恶作剧之心", en:"Prankster", kinds:["modify_priority"], params:{"plus":1,"when":{"moveCategory":"status"}}},
  {zh:"压迫感", en:"Pressure", kinds:["doublePPCost"]},
  {zh:"始源之海", en:"Primordial Sea", kinds:["switchInWeather"], params:{"weather":"大雨"}},
  {zh:"棱镜装甲", en:"Prism Armor", kinds:["modify_taken"], params:{"mult":0.75,"when":{"superEffective":true}}},
  {zh:"螺旋尾鳍", en:"Propeller Tail", kinds:["ignoreRedirection"]},
  {zh:"变幻自如", en:"Protean", kinds:["typeChangeSelf"]},
  {zh:"古代活性", en:"Protosynthesis", kinds:["boostBestStat"], params:{"when":{"weather":["晴","大晴天","大日照","日照强烈"]},"mult":1.3,"priorityStat":"spe","priorityMult":1.5,"text":"古代活性提升了最高的能力"}},
  {zh:"精神制造者", en:"Psychic Surge", kinds:["fieldEffect"], params:{"terrain":"精神场地"}},
  {zh:"庞克摇滚", en:"Punk Rock", noop:true, note:"战斗外/信息类特性，无战斗结算"},
  {zh:"瑜伽之力", en:"Pure Power", kinds:["damageBound"], params:{"multStats":["atk"],"mult":2}},
  {zh:"洁净之盐", en:"Purifying Salt", kinds:["modify_taken","status_immune"], params:{"mult":0.5,"when":{"moveTypes":["幽灵"]},"immuneStatuses":["all"]}},
  {zh:"夸克充能", en:"Quark Drive", kinds:["boostBestStat"], params:{"when":{"terrain":"电气场地"},"mult":1.3,"priorityStat":"spe","priorityMult":1.5,"text":"夸克充能提升了最高的能力"}},
  {zh:"女王的威严", en:"Queenly Majesty", kinds:["denyPriorityFoe"]},
  {zh:"速击", en:"Quick Draw", kinds:["modify_priority"], params:{"chance":30,"plus":0.1,"when":{"notCategory":"status"},"text":"速击抢得先手"}},
  {zh:"飞毛腿", en:"Quick Feet", kinds:["modify_speed"], params:{"mult":1.5,"when":{"hasStatus":true}}},
  {zh:"雨盘", en:"Rain Dish", kinds:["endTurnHeal"], params:{"healFraction":0.063,"healWhen":{"weather":["下雨","大雨","雨"]},"text":"雨盘回复了体力"}},
  {zh:"胆怯", en:"Rattled", kinds:["afterDamagingHit"], params:{"when":{"moveTypes":["恶","虫","幽灵"]},"boost":{"spe":1}}},
  {zh:"Rebound", kinds:["noop"], params:{"note":"CAP 特性：需要招式反弹层"}},
  {zh:"接球手", en:"Receiver", residual:true, reason:"需要同队友方特性的运行时继承（双打数据不足）"},
  {zh:"舍身", en:"Reckless", kinds:["modify_power"], params:{"mult":1.2,"when":{"recoilMove":true}}},
  {zh:"冰冻皮肤", en:"Refrigerate", kinds:["typeChangeMove"], params:{"to":"冰","from":"一般","mult":1.2}},
  {zh:"再生力", en:"Regenerator", kinds:["healOnSwitchOut"], params:{"healFraction":0.333}},
  {zh:"熟成", en:"Ripen", kinds:["noop"], params:{"note":"需要树果效果翻倍"}},
  {zh:"斗争心", en:"Rivalry", kinds:["modify_power"], params:{"genderMult":true}},
  {zh:"ＡＲ系统", en:"RKS System", residual:true, reason:"需要存储碟道具与银伴战兽形态数据"},
  {zh:"坚硬脑袋", en:"Rock Head", kinds:["noRecoil"]},
  {zh:"搬岩", en:"Rocky Payload", kinds:["damageBound"], params:{"multTypes":["岩石"],"mult":1.5}},
  {zh:"粗糙皮肤", en:"Rough Skin", kinds:["contactDamage"], params:{"contactFraction":0.125}},
  {zh:"逃跑", en:"Run Away", kinds:["noop"], params:{"note":"野生战必定逃走成功（引擎已允许野生战逃跑）"}},
  {zh:"沙之力", en:"Sand Force", kinds:["damageBound"], params:{"multTypes":["岩石","地面","钢"],"mult":1.3,"when":{"weather":["沙暴"]}}},
  {zh:"拨沙", en:"Sand Rush", kinds:["modify_speed"], params:{"mult":2,"when":{"weather":["沙暴"]}}},
  {zh:"吐沙", en:"Sand Spit", kinds:["afterDamagingHit"], params:{"setWeather":"沙暴"}},
  {zh:"扬沙", en:"Sand Stream", kinds:["switchInWeather"], params:{"weather":"沙暴"}},
  {zh:"沙隐", en:"Sand Veil", kinds:["modify_accuracy"], params:{"accuracyMult":0.8,"when":{"weather":["沙暴"]}}},
  {zh:"食草", en:"Sap Sipper", kinds:["immune"], params:{"immuneTypes":["草"],"onImmune":{"boost":{"atk":1}}}},
  {zh:"鱼群", en:"Schooling", residual:true, reason:"需要弱丁鱼「鱼群形态」数据"},
  {zh:"胆量", en:"Scrappy", kinds:["ignoreTypeImmunity"], params:{"types":["一般","格斗"]}},
  {zh:"除障", en:"Screen Cleaner", kinds:["switchInClearScreens"]},
  {zh:"掉出种子", en:"Seed Sower", kinds:["afterDamagingHit"], params:{"setTerrain":"青草场地"}},
  {zh:"天恩", en:"Serene Grace", kinds:["doubleSecondaryChance"]},
  {zh:"幻影防守", en:"Shadow Shield", kinds:["modify_taken"], params:{"mult":0.5,"when":{"fullHP":true}}},
  {zh:"踩影", en:"Shadow Tag", kinds:["trapFoe"], params:{"exceptTypes":["幽灵"]}},
  {zh:"锋锐", en:"Sharpness", kinds:["modify_power"], params:{"mult":1.5,"when":{"moveFlags":["slicing"]}}},
  {zh:"蜕皮", en:"Shed Skin", kinds:["endTurnCure"], params:{"chance":30,"text":"蜕皮治愈了异常状态"}},
  {zh:"强行", en:"Sheer Force", kinds:["sheerForce"], params:{"mult":1.3}},
  {zh:"硬壳盔甲", en:"Shell Armor", kinds:["crit_immune"]},
  {zh:"鳞粉", en:"Shield Dust", kinds:["blockSecondary"]},
  {zh:"界限盾壳", en:"Shields Down", residual:true, reason:"需要小陨星「流星/核心形态」数据"},
  {zh:"单纯", en:"Simple", kinds:["doubleStages"]},
  {zh:"连续攻击", en:"Skill Link", kinds:["fixMultiHit"]},
  {zh:"慢启动", en:"Slow Start", kinds:["damageBound","modify_speed"], params:{"multStats":["atk"],"mult":0.5,"when":{"activeTurnsAtMost":5},"speedMult":0.5,"speedWhen":{"activeTurnsAtMost":5}}},
  {zh:"拨雪", en:"Slush Rush", kinds:["modify_speed"], params:{"mult":2,"when":{"weather":["冰雹","下雪","雪"]}}},
  {zh:"狙击手", en:"Sniper", kinds:["modify_damage"], params:{"mult":1.5,"when":{"crit":true}}},
  {zh:"雪隐", en:"Snow Cloak", kinds:["modify_accuracy"], params:{"accuracyMult":0.8,"when":{"weather":["冰雹","下雪","雪"]}}},
  {zh:"降雪", en:"Snow Warning", kinds:["switchInWeather"], params:{"weather":"冰雹"}},
  {zh:"太阳之力", en:"Solar Power", kinds:["damageBound","endTurnDamage"], params:{"multStats":["spa"],"mult":1.5,"when":{"weather":["晴","大晴天","大日照","日照强烈"]},"damageFraction":0.125,"damageWhen":{"weather":["晴","大晴天","大日照","日照强烈"]}}},
  {zh:"坚硬岩石", en:"Solid Rock", kinds:["modify_taken"], params:{"mult":0.75,"when":{"superEffective":true}}},
  {zh:"魂心", en:"Soul-Heart", kinds:["onAnyFaint"], params:{"boost":{"spa":1}}},
  {zh:"隔音", en:"Soundproof", kinds:["immune"], params:{"immuneFlags":["sound"]}},
  {zh:"加速", en:"Speed Boost", kinds:["endTurnBoost"], params:{"boost":{"spe":1},"text":"加速提升了速度"}},
  /* 辣椒喷发：官方文案是「受到招式伤害时，会使对手陷入灼伤状态」= **必定**（无概率），
   * 必须**显式**写 chance:100 —— 不然「缺概率参数」会被当成 100% 静默执行（本次审计的反面教材）。 */
  {zh:"辣椒喷发", en:"Spicy Spray", kinds:["afterDamagingHit"], params:{"status":"brn","chance":100}},
  {zh:"蹲守", en:"Stakeout", kinds:["modify_power"], params:{"mult":2,"when":{"targetJustSwitchedIn":true}}},
  {zh:"慢出", en:"Stall", kinds:["goesLast"]},
  {zh:"坚毅", en:"Stalwart", kinds:["ignoreRedirection"]},
  {zh:"持久力", en:"Stamina", kinds:["afterDamagingHit"], params:{"boost":{"def":1}}},
  {zh:"战斗切换", en:"Stance Change", residual:true, reason:"需要坚盾剑怪「刀剑/盾牌形态」数据（种族值随招式切换）"},
  {zh:"静电", en:"Static", kinds:["contactStatus"], params:{"contactStatus":"par","contactChance":30}},
  {zh:"不屈之心", en:"Steadfast", kinds:["onFlinch"], params:{"boost":{"spe":1}}},
  {zh:"蒸汽机", en:"Steam Engine", kinds:["afterDamagingHit"], params:{"when":{"moveTypes":["水","火"]},"boost":{"spe":6}}},
  {zh:"钢能力者", en:"Steelworker", kinds:["damageBound"], params:{"multTypes":["钢"],"mult":1.5}},
  {zh:"钢之意志", en:"Steely Spirit", kinds:["allyBasePower"], params:{"mult":1.5,"when":{"moveTypes":["钢"]}}},
  {zh:"恶臭", en:"Stench", kinds:["addFlinchSecondary"], params:{"chance":10}},
  {zh:"黏着", en:"Sticky Hold", kinds:["stickyItem"]},
  {zh:"引水", en:"Storm Drain", kinds:["immune"], params:{"immuneTypes":["水"],"onImmune":{"boost":{"spa":1}}}},
  {zh:"强壮之颚", en:"Strong Jaw", kinds:["modify_power"], params:{"mult":1.5,"when":{"moveFlags":["bite"]}}},
  {zh:"结实", en:"Sturdy", kinds:["surviveKo"], params:{"surviveHp":1,"ohkoImmune":true,"when":{"fullHP":true}}},
  {zh:"吸盘", en:"Suction Cups", kinds:["noForceSwitch"]},
  {zh:"超幸运", en:"Super Luck", kinds:["calc_crit"], params:{"plus":1}},
  {zh:"甘露之蜜", en:"Supersweet Syrup", kinds:["switchInBoost"], params:{"boosts":{"eva":-1},"boostTarget":"foe","once":true}},
  {zh:"大将", en:"Supreme Overlord", kinds:["damageBound"], params:{"mult":1.1,"fallenScale":true,"fallbackMult":1}},
  {zh:"冲浪之尾", en:"Surge Surfer", kinds:["modify_speed"], params:{"mult":2,"when":{"terrain":"电气场地"}}},
  {zh:"虫之预感", en:"Swarm", kinds:["damageBound"], params:{"multTypes":["虫"],"mult":1.5,"when":{"hpAtMost":3}}},
  {zh:"甜幕", en:"Sweet Veil", kinds:["allyStatusImmune"], params:{"statuses":["slp"]}},
  {zh:"悠游自如", en:"Swift Swim", kinds:["modify_speed"], params:{"mult":2,"when":{"weather":["下雨","大雨","雨"]}}},
  {zh:"灾祸之剑", en:"Sword of Ruin", kinds:["ruinOnField"], params:{"stat":"def","mult":0.75}},
  {zh:"共生", en:"Symbiosis", kinds:["noop"], params:{"note":"道具转移（引擎未实现道具被动）"}},
  {zh:"同步", en:"Synchronize", kinds:["syncStatus"]},
  {zh:"灾祸之简", en:"Tablets of Ruin", kinds:["ruinOnField"], params:{"stat":"atk","mult":0.75}},
  {zh:"蹒跚", en:"Tangled Feet", kinds:["modify_accuracy"], params:{"accuracyMult":0.5,"when":{"hasVolatile":"混乱"}}},
  {zh:"卷发", en:"Tangling Hair", kinds:["contactStatLower"], params:{"boost":{"spe":-1}}},
  {zh:"技术高手", en:"Technician", kinds:["modify_power"], params:{"mult":1.5,"when":{"basePowerAtMost":60}}},
  {zh:"心灵感应", en:"Telepathy", kinds:["immune"], params:{"immuneFromAlly":true}},
  {zh:"太晶甲壳", en:"Tera Shell", residual:true, reason:"需要太晶形态数据（正作以形态承载全属性半减）"},
  {zh:"太晶变形", en:"Tera Shift", residual:true, reason:"需要太晶形态数据（属性/种族值变化）"},
  {zh:"归零化境", en:"Teraform Zero", residual:true, reason:"需要太晶形态 + 场地清除的形态绑定数据"},
  {zh:"兆级电压", en:"Teravolt", kinds:["ignoreAbility"]},
  {zh:"热交换", en:"Thermal Exchange", kinds:["status_immune","afterDamagingHit"], params:{"immuneStatuses":["brn"],"when":{"moveTypes":["火"]},"boost":{"atk":1}}},
  {zh:"厚脂肪", en:"Thick Fat", kinds:["modify_taken"], params:{"mult":0.5,"when":{"moveTypes":["火","冰"]}}},
  {zh:"有色眼镜", en:"Tinted Lens", kinds:["modify_damage"], params:{"mult":2,"when":{"resisted":true}}},
  {zh:"激流", en:"Torrent", kinds:["damageBound"], params:{"multTypes":["水"],"mult":1.5,"when":{"hpAtMost":3}}},
  {zh:"硬爪", en:"Tough Claws", kinds:["modify_power"], params:{"mult":1.3,"when":{"contact":true}}},
  {zh:"中毒激升", en:"Toxic Boost", kinds:["modify_power"], params:{"mult":1.5,"when":{"moveCategory":"physical","hasStatus":true}}},
  {zh:"毒锁链", en:"Toxic Chain", kinds:["afterDamagingHit"], params:{"status":"tox","chance":30}},
  {zh:"毒满地", en:"Toxic Debris", kinds:["afterDamagingHit"], params:{"when":{"moveCategory":"physical"},"setToxicSpikes":true}},
  {zh:"复制", en:"Trace", residual:true, reason:"需要读取对手特性并运行时改写自身特性（对手特性在卡里通常未知，结果不可验证）"},
  {zh:"电晶体", en:"Transistor", kinds:["damageBound"], params:{"multTypes":["电"],"mult":1.3}},
  {zh:"先行治疗", en:"Triage", kinds:["modify_priority"], params:{"plus":3,"when":{"moveFlags":["heal"]}}},
  {zh:"懒惰", en:"Truant", kinds:["truant"]},
  {zh:"涡轮火焰", en:"Turboblaze", kinds:["ignoreAbility"]},
  {zh:"纯朴", en:"Unaware", kinds:["unaware"]},
  {zh:"轻装", en:"Unburden", kinds:["modify_speed"], params:{"mult":2,"when":{"noItem":true}}},
  {zh:"紧张感", en:"Unnerve", kinds:["noop"], params:{"note":"禁止对手吃树果（引擎未实现道具被动）"}},
  {zh:"无形拳", en:"Unseen Fist", kinds:["ignoreProtect"]},
  {zh:"灾祸之鼎", en:"Vessel of Ruin", kinds:["ruinOnField"], params:{"stat":"spa","mult":0.75}},
  {zh:"胜利之星", en:"Victory Star", kinds:["allyModifyAccuracy"], params:{"mult":1.1}},
  {zh:"干劲", en:"Vital Spirit", kinds:["status_immune","endTurnCure"], params:{"immuneStatuses":["slp"]}},
  {zh:"蓄电", en:"Volt Absorb", kinds:["immune"], params:{"immuneTypes":["电"],"onImmune":{"healFraction":0.25}}},
  {zh:"游魂", en:"Wandering Spirit", kinds:["contactAbilitySwap"], params:{"swap":true}},
  {zh:"储水", en:"Water Absorb", kinds:["immune"], params:{"immuneTypes":["水"],"onImmune":{"healFraction":0.25}}},
  {zh:"水泡", en:"Water Bubble", kinds:["damageBound","modify_taken","status_immune","endTurnCure"], params:{"multTypes":["水"],"mult":2,"takenMult":0.5,"takenWhen":{"moveTypes":["火"]},"immuneStatuses":["brn"]}},
  {zh:"遇水凝固", en:"Water Compaction", kinds:["afterDamagingHit"], params:{"when":{"moveTypes":["水"]},"boost":{"def":2}}},
  {zh:"水幕", en:"Water Veil", kinds:["status_immune","endTurnCure"], params:{"immuneStatuses":["brn"]}},
  {zh:"碎裂铠甲", en:"Weak Armor", kinds:["afterDamagingHit"], params:{"when":{"moveCategory":"physical"},"boost":{"def":-1,"spe":2}}},
  {zh:"焦香之躯", en:"Well-Baked Body", kinds:["immune"], params:{"immuneTypes":["火"],"onImmune":{"boost":{"def":2}}}},
  {zh:"白色烟雾", en:"White Smoke", kinds:["stat_drop_immune"], params:{"immuneStats":"all"}},
  {zh:"跃跃欲逃", en:"Wimp Out", kinds:["emergencyExit"], params:{"hpAtMost":2}},
  {zh:"风力发电", en:"Wind Power", kinds:["afterDamagingHit"], params:{"when":{"moveFlags":["wind"]},"charge":true}},
  {zh:"乘风", en:"Wind Rider", kinds:["immune"], params:{"immuneFlags":["wind"],"onImmune":{"boost":{"atk":1}}}},
  {zh:"神奇守护", en:"Wonder Guard", kinds:["wonderGuard"]},
  {zh:"奇迹皮肤", en:"Wonder Skin", kinds:["modify_accuracy"], params:{"setAccuracy":50,"when":{"moveCategory":"status"}}},
  {zh:"达摩模式", en:"Zen Mode", residual:true, reason:"需要达摩狒狒的形态数据（种族值/属性随体力切换）"},
  {zh:"全能变身", en:"Zero to Hero", residual:true, reason:"需要海豚侠「全能形态」数据（离场后变形）"}

  ];;;;;;


  /* 天气 / 场地的有限白名单（口胡通道只接受这些） */
  var DEFAULT_WEATHERS = ['晴', '大晴天', '雨', '下雨', '沙暴', '冰雹', '雪', '雾'];
  var DEFAULT_TERRAINS = ['电气场地', '精神场地', '薄雾场地', '青草场地'];
  var IMPROV_STATUS = ['灼伤', '麻痹', '中毒', '剧毒', '睡眠', '冰冻'];

  /* 口胡通道的上下限（契约 10.2 节） */
  var IMPROV_LIMITS = {
    威力倍率: [0.1, 3.0], 伤害倍率: [0.1, 3.0], 伤害减免: [0.1, 1.0],
    命中修正: [-50, 50], 暴击等级: [0, 3], 回复: [0, 0.5],
    能力阶级: [-2, 2], 持续回合: [1, 20]
  };
  /* 口胡允许直接落的场地效果键（其余一律拒绝，避免污染 stat_data） */
  var IMPROV_ALLOWED_KEYS = ['威力倍率', '伤害倍率', '伤害减免', '命中修正', '暴击等级', '能力阶级', '追加状态', '天气', '场地', '回复'];

  /* ---------------------------------------------------------------------------
   * 名称规范化与常见模型笔误（契约 10.6）
   * 卡里的技能名是模型手写的：既有「冷冻牙」（官方「冰冻牙」）这类错字，
   * 也有「出气」这种查无此招的幻觉名。规范化 + 别名表能救回前者，后者必须报未识别。
   * ------------------------------------------------------------------------- */
  var TRAD_TO_SIMP = {
    '鉗': '钳', '斷': '断', '頭': '头', '極': '极', '詐': '诈', '氣': '气', '斬': '斩',
    '凍': '冻', '齒': '齿', '潑': '泼', '撐': '撑', '龍': '龙', '電': '电', '擊': '击',
    '衝': '冲', '噴': '喷', '槍': '枪', '砲': '炮', '鐵': '铁', '鬧': '闹', '汙': '污',
    '彈': '弹', '強': '强', '鱗': '鳞', '劍': '剑', '應': '应', '熱': '热', '風': '风',
    '墜': '坠', '捨': '舍', '終': '终', '覺': '觉', '縮': '缩', '殼': '壳', '異': '异',
    '撓': '挠', '鑽': '钻', '鎬': '镐', '聲': '声', '奪': '夺', '擊': '击', '滅': '灭',
    '絕': '绝', '緣': '缘', '險': '险', '寶': '宝', '貝': '贝', '閃': '闪', '耀': '耀',
    '陽': '阳', '陰': '阴', '濁': '浊', '濃': '浓', '霧': '雾', '颶': '飓', '颱': '台',
    '戀': '恋', '惡': '恶', '詛': '诅', '咒': '咒', '靈': '灵', '體': '体', '轉': '转',
    '換': '换', '擋': '挡', '攔': '拦', '網': '网', '電': '电', '針': '针', '銳': '锐',
    '遲': '迟', '緩': '缓', '階': '阶', '誤': '误', '認': '认', '錄': '录', '類': '类',
    '麼': '么', '樣': '样', '後': '后', '發': '发', '動': '动', '過': '过', '這': '这',
    '們': '们', '個': '个', '將': '将', '對': '对', '當': '当', '還': '还', '進': '进',
    '開': '开', '關': '关', '間': '间', '實': '实', '現': '现', '製': '制', '氣': '气'
  };
  /* 模型常见笔误 → 数据表里的正名（只有正名确实存在时才生效，不会误改正确的名字） */
  var MOVE_TYPO_MAP = {
    '冷冻牙': '冰冻牙', '冷冻拳': '冰冻拳', '冷冻光线': '冰冻光束', '冷冻光': '冰冻光束',
    '冷冻之风': '冰冻之风', '冲浪术': '冲浪', '破空斩': '空气斩', '空气切裂': '空气斩',
    '飞叶快刀': '飞叶快刀', '影子球': '暗影球', '十万福特': '十万伏特'
  };
  /* 形态后缀：出现在括号里或名字末尾时，先去掉再用基础名解析 */
  var FORM_SUFFIX_WORDS = [
    '超级', '超极巨', '极巨', '太晶', '原始', '化身', '灵兽', '一般', '普通', '常态',
    '攻击形态', '防御形态', 'mega', 'gmax', 'tera'
  ];

  /* =========================================================================
   * 阶段 A：招式目标类别（1 vs N 群战）
   *   single            单体（默认；含 normal / adjacentFoe / any / randomNormal…）
   *   allAdjacentFoes   打**所有对手**（多目标时每个目标伤害 ×0.75，官方口径）
   *   allAdjacent       打场上**除自己外所有人**（含我方第二只；每个目标同样 ×0.75）
   *   self / ally       自身向 / 队友向 —— 为 B 阶段（双打）预留，A 阶段按单体路径结算
   * 目标类别以数据表 moves[].target 为准；表里没有（未收录/defineMove 自定义）时退回名称表。
   * ====================================================================== */
  var MOVE_TARGET_KIND = {
    normal: 'single', adjacentFoe: 'single', any: 'single', randomNormal: 'single',
    scripted: 'single', foeSide: 'single',
    allAdjacentFoes: 'allAdjacentFoes',
    allAdjacent: 'allAdjacent', all: 'allAdjacent',
    self: 'self', adjacentAllyOrSelf: 'self',
    ally: 'ally', adjacentAlly: 'ally', allySide: 'ally', allyTeam: 'ally', allies: 'ally'
  };
  /* 名称兜底：数据表缺失（未收录 / defineMove 自定义）时按名字认群体招 */
  var MOVE_TARGET_BY_NAME = {
    地震: 'allAdjacent', 冲浪: 'allAdjacent', 大爆炸: 'allAdjacent', 自爆: 'allAdjacent',
    放电: 'allAdjacent', 喷烟: 'allAdjacent', 雪崩: 'allAdjacent', 岩浆风暴: 'allAdjacent',
    热风: 'allAdjacentFoes', 喷火: 'allAdjacentFoes', 大字爆炎: 'allAdjacentFoes',
    魔法闪耀: 'allAdjacentFoes', 暴风雪: 'allAdjacentFoes', 冰冻之风: 'allAdjacentFoes',
    大声咆哮: 'allAdjacentFoes', 岩崩: 'allAdjacentFoes', 空气利刃: 'allAdjacentFoes',
    花之舞: 'allAdjacentFoes', 月亮之力: 'allAdjacentFoes', 浊流: 'allAdjacentFoes',
    污泥攻击: 'allAdjacentFoes', 巨声: 'allAdjacentFoes', 高声咆哮: 'allAdjacentFoes',
    龙之舞: 'self', 剑舞: 'self', 冥想: 'self', 铁壁: 'self', 自我再生: 'self',
    帮助: 'ally', 治愈波动: 'ally'
  };
  /* 群体招式的伤害缩放（官方：命中多个目标时每个目标 ×0.75） */
  var SPREAD_DAMAGE_SCALE = 0.75;

  /** 招式目标类别：数据表 target 优先，其次名称表，缺省 single */
  function moveTargetKind(move) {
    if (!move) return 'single';
    var t = String(move.target === undefined || move.target === null ? '' : move.target).trim();
    if (t && MOVE_TARGET_KIND[t]) return MOVE_TARGET_KIND[t];
    var nm = String(move.zh || move.name || move.名称 || '').trim();
    if (nm && MOVE_TARGET_BY_NAME[nm]) return MOVE_TARGET_BY_NAME[nm];
    return 'single';
  }
  /** 是不是「打到多个目标」的招式（只有这两类吃 ×0.75） */
  function isSpreadKind(kind) { return kind === 'allAdjacentFoes' || kind === 'allAdjacent'; }

  /** 名称规范化：全角→半角、去空白与连接符与引号、去掉包裹括号、繁→简、小写 */
  function normalizeName(v) {
    var s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return '';
    /* 全角字母数字/符号 → 半角 */
    s = s.replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    /* 去掉包裹式括号与常见分隔符 */
    s = s.replace(/[（）()【】\[\]{}]/g, '');
    s = s.replace(/[\s　·・\-—_:"'、,，./\\]+/g, '');
    s = s.toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) out += (TRAD_TO_SIMP[s[i]] || s[i]);
    return out;
  }

  /** 拆出「基础名 + 形态后缀」，用于物种解析 */
  function splitForm(key) {
    var s = String(key || '').trim();
    if (!s) return { base: '', form: '' };
    var form = '';
    var m = s.match(/[（(【\[](.*?)[）)】\]]/);
    if (m) { form = m[1]; s = s.replace(m[0], '').trim(); }
    for (var i = 0; i < FORM_SUFFIX_WORDS.length; i++) {
      var w = FORM_SUFFIX_WORDS[i];
      if (!w) continue;
      if (s.length > w.length && s.slice(-w.length) === w) { form = form || w; s = s.slice(0, -w.length).trim(); break; }
    }
    return { base: s, form: form };
  }

  /**
   * 规则集表（契约 10.1 节）。
   * official：纯主系列；card：在 official 之上叠加世界书《对战法则》的约束。
   */
  var RULESETS = {
    official: {
      id: 'official', name: '官方规则',
      锁级: null,            /* 不锁级 */
      四招判负: false,
      单场单机制: false,
      禁复苏药: false,
      濒死必须换人: true,
      野生无限制: false,
      允许道具: true,
      机制列表: ['mega', 'z', 'dmax', 'tera']
    },
    card: {
      id: 'card', name: '卡内联盟规程',
      锁级: null,            /* 仅“线上天梯模拟战”锁 50，见 resolveRuleset */
      四招判负: true,
      单场单机制: true,
      机制单场仅一只: true,
      禁复苏药: true,
      濒死必须换人: true,
      野生无限制: true,
      允许道具: true,
      机制列表: ['mega', 'z', 'dmax', 'tera']
    }
  };

  /** 规则集解析：card 下“线上天梯模拟战”才锁 50 级；对手是野生时进入野外无限制子模式 */
  function resolveRuleset(rulesetName, battleMode, foeIdentity) {
    var base = RULESETS[rulesetName] || RULESETS.official;
    var r = {};
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i++) r[keys[i]] = base[keys[i]];
    if (Array.isArray(base.机制列表)) r.机制列表 = base.机制列表.slice();

    if (r.id === 'card') {
      var online = /线上天梯|天梯模拟|模拟战/.test(String(battleMode || ''));
      r.锁级 = online ? 50 : null;
      r.四招判负 = true;
      r.单场单机制 = true;
      if (/野生/.test(String(foeIdentity || ''))) {
        r.野生无限制 = true;
        r.四招判负 = false;
        r.单场单机制 = false;
        r.禁复苏药 = false;   /* 野外无规则，复苏药不判负 */
      }
    }
    r.reason = r.id === 'card'
      ? ('卡内规程：' + (r.锁级 ? ('锁 ' + r.锁级 + ' 级、') : '') +
        (r.四招判负 ? '四招上限、' : '') + (r.单场单机制 ? '单场单机制、' : '') +
        (r.禁复苏药 ? '禁复苏药、' : '') + '濒死必须换人' + (r.野生无限制 ? '；野外无限制子模式' : ''))
      : '官方规则：不锁级、不限制机制与道具';
    return r;
  }

  function stageMul(stage) { return STAGE_MUL[clamp(toInt(stage, 0), -6, 6) + 6]; }
  function statusZh(code) { return STATUS_ZH[code] || String(code || '正常'); }

  /* ===========================================================================
   * §1 数据访问
   * ======================================================================== */

  /**
   * 建立只读数据索引。
   * 必需表：DATA = { typechart:{types,chart}, pokedex:[...], moves:[...], names:{...} }
   * 可选表：DATA = { abilities:[...], items:[...], unmapped:[...] }（10.4 节；缺表时全部按未映射处理）
   * 白名单：DATA = { abilityKinds:[...], itemKinds:[...], weathers:[...], terrains:[...] } 可覆盖默认
   */
  function buildDex(DATA, options) {
    if (!isPlainObject(DATA)) fail('createEngine(DATA)：DATA 必须是对象，形如 {typechart, pokedex, moves, names}');
    var missing = [];
    if (!isPlainObject(DATA.typechart) || !isPlainObject(DATA.typechart.chart)) missing.push('typechart（需要 {types, chart}）');
    if (!Array.isArray(DATA.pokedex)) missing.push('pokedex（需要数组）');
    if (!Array.isArray(DATA.moves)) missing.push('moves（需要数组）');
    if (!isPlainObject(DATA.names)) missing.push('names（需要 {species, moves, types, stats, status, natures, ivs}）');
    if (missing.length) fail('createEngine(DATA)：数据表缺失或不合法 → ' + missing.join('；'));

    var names = obj(DATA.names);
    var nSpecies = obj(names.species), nMoves = obj(names.moves);
    var nStatus = obj(names.status), nStatusZh = obj(names.statusZh);
    var nNatures = obj(names.natures), nIvs = obj(names.ivs);
    var nNatureMods = obj(names.natureMods);
    /* 真实数据表形态：names.natures 是 {中文性格名: 英文性格名}，
     * 而「加/减」两张表用中文性格名做键（names.natureUp / names.natureDown）。
     * 早先只读 names.natures 与 names.natureMods，导致整表性格修正失效。 */
    var nNatureUp = obj(names.natureUp), nNatureDown = obj(names.natureDown);

    /* 中文名 → 条目（同时接受英文名与 id 查询） */
    var byName = {}, byId = {};
    for (var i = 0; i < DATA.pokedex.length; i++) {
      var p = DATA.pokedex[i];
      if (!isPlainObject(p)) continue;
      if (p.zh) byName[String(p.zh)] = p;
      if (p.en) byName[String(p.en)] = p;
      if (p.id !== undefined) byId[String(p.id)] = p;
    }

    var moveByName = {}, moveList = [];
    for (var m = 0; m < DATA.moves.length; m++) {
      var mv = DATA.moves[m];
      if (!isPlainObject(mv)) continue;
      moveList.push(mv);
      if (mv.zh && !moveByName[String(mv.zh)]) moveByName[String(mv.zh)] = mv;
      if (mv.en && !moveByName[String(mv.en)]) moveByName[String(mv.en)] = mv;
    }

    var types = Array.isArray(DATA.typechart.types) && DATA.typechart.types.length
      ? DATA.typechart.types.slice()
      : Object.keys(DATA.typechart.chart);

    var opt = obj(options);
    /* 白名单：kinds 不在表内的条目一律按 mapped:false 处理（10.4 节） */
    var abilityKinds = Array.isArray(opt.abilityKinds) && opt.abilityKinds.length ? opt.abilityKinds.slice() : DEFAULT_ABILITY_KINDS.slice();
    var itemKinds = Array.isArray(opt.itemKinds) && opt.itemKinds.length ? opt.itemKinds.slice() : DEFAULT_ITEM_KINDS.slice();
    var weathers = Array.isArray(opt.weathers) && opt.weathers.length ? opt.weathers.slice() : DEFAULT_WEATHERS.slice();
    var terrains = Array.isArray(opt.terrains) && opt.terrains.length ? opt.terrains.slice() : DEFAULT_TERRAINS.slice();

    /* abilities / items 是可选表：缺表时 hasTable=false，一切特性/道具都按未映射处理 */
    var abilTable = Array.isArray(DATA.abilities) ? DATA.abilities : null;
    var itemTable = Array.isArray(DATA.items) ? DATA.items : null;
    var abilIndex = {}, itemIndex = {};
    function indexKinds(list, index, kinds) {
      if (!list) return;
      for (var i2 = 0; i2 < list.length; i2++) {
        var e = list[i2];
        if (!isPlainObject(e)) continue;
        var ks = Array.isArray(e.kinds) ? e.kinds.slice() : [];
        var mapped = e.mapped !== false;
        for (var k2 = 0; k2 < ks.length; k2++) if (kinds.indexOf(ks[k2]) < 0) mapped = false; /* 白名单外 → 不解释 */
        e.__mapped = mapped; e.__kinds = ks;
        if (e.zh) index[String(e.zh)] = e;
        if (e.en) index[String(e.en)] = e;
      }
    }
    indexKinds(abilTable, abilIndex, abilityKinds);
    indexKinds(itemTable, itemIndex, itemKinds);

    var dex = {
      raw: DATA,
      types: types,
      chart: DATA.typechart.chart,
      names: names,
      nSpecies: nSpecies, nMoves: nMoves, nStatus: nStatus,
      nStatusZh: nStatusZh, nNatures: nNatures, nIvs: nIvs, nNatureMods: nNatureMods,
      nNatureUp: nNatureUp, nNatureDown: nNatureDown,
      byName: byName, byId: byId, moveByName: moveByName, moveList: moveList,
      abilityKinds: abilityKinds, itemKinds: itemKinds,
      weathers: weathers, terrains: terrains,
      abilityIndex: abilIndex, itemIndex: itemIndex,
      hasAbilityTable: !!abilTable, hasItemTable: !!itemTable,
      unmappedTable: Array.isArray(DATA.unmapped) ? DATA.unmapped : [],
      options: opt
    };

    /* 状态码 → 中文：names.statusZh 缺失时从 names.status 反推（真实数据表即此情形） */
    if (!Object.keys(nStatusZh).length && Object.keys(nStatus).length) {
      var derived = {};
      var sKeys = Object.keys(nStatus);
      for (var s = 0; s < sKeys.length; s++) {
        var code = String(nStatus[sKeys[s]]);
        if (code && derived[code] === undefined) derived[code] = sKeys[s];
      }
      dex.nStatusZh = derived;
    }

    /**
     * 特性/道具是否已被声明式映射（10.5 节）。
     * 返回值 { known, mapped, zh, kinds, effectNote, why }
     *
     * 契约 10.25（特性全覆盖）：判定优先级为
     *   1) 引擎内置的结构化规则表 ABILITY_RULES（321 条，kinds=触发器，params=效果）
     *   2) abilities.json 的 kinds/params（缺表或缺条目时的兜底）
     * 只有「规则表里标了 residual（缺形态/道具/对手数据，真的做不了）」或
     * 「标了 noop（本身没有战斗结算）」才返回 mapped:false，并在 why 里写明原因。
     */
    dex.lookupAbility = function (name) {
      var key = String(name === undefined || name === null ? '' : name).trim();
      var rule = abilityRuleByName(key);
      if (rule) {
        if (rule.residual) {
          return {
            known: true, mapped: false, zh: rule.zh || key, kinds: [], effectNote: '', params: {},
            why: '离线引擎无法忠实结算：' + (rule.reason || '缺形态/道具/对手数据')
          };
        }
        if (rule.noop) {
          return {
            known: true, mapped: false, zh: rule.zh || key, kinds: [], effectNote: '', params: {},
            why: rule.note || '战斗外/信息类特性，无战斗结算'
          };
        }
        var e0 = abilIndex[key] || abilIndex[rule.zh] || null;
        return {
          known: true, mapped: true, zh: rule.zh || key, kinds: (rule.kinds || []).slice(),
          effectNote: (e0 && e0.effectNote) || '', params: obj(rule.params), why: ''
        };
      }
      var e = abilIndex[key] || null;
      if (!e) {
        return {
          known: false, mapped: false, zh: key, kinds: [], effectNote: '',
          why: dex.hasAbilityTable ? '特性表里没有这个条目' : '数据表 abilities.json 尚未载入'
        };
      }
      return {
        known: true, mapped: !!e.__mapped, zh: e.zh || key, kinds: e.__kinds.slice(),
        effectNote: e.effectNote || '', params: obj(e.params), why: e.__mapped ? '' : 'handler 无法声明式映射（kinds 不在白名单内或缺 kinds）'
      };
    };
    dex.lookupItem = function (name) {
      var key = String(name === undefined || name === null ? '' : name).trim();
      if (!key || key === '无') return { known: true, mapped: true, zh: '无', kinds: [], effectNote: '', why: '' };
      var e = itemIndex[key] || null;
      if (!e) {
        return {
          known: false, mapped: false, zh: key, kinds: [], effectNote: '',
          why: dex.hasItemTable ? '道具表里没有这个条目' : '数据表 items.json 尚未载入'
        };
      }
      return {
        known: true, mapped: !!e.__mapped, zh: e.zh || key, kinds: e.__kinds.slice(),
        effectNote: e.effectNote || '', params: obj(e.params), why: e.__mapped ? '' : 'handler 无法声明式映射（kinds 不在白名单内或缺 kinds）'
      };
    };
    /** 未实现提示文案（统一出口，保证日志与战报口径一致） */
    dex.unmappedText = function (holderName, what, detail, isAbility) {
      return '⚠ ' + holderName + ' 的' + (isAbility ? '特性' : '道具') + '「' + (what || '未知') + '」未参与结算（' +
        (detail || '数据未映射') + '），可走口胡通道补效果';
    };

    /* ---- 名称规范化索引（契约 10.6：两套译名 / 英文名 / Showdown id 都要命中） ---- */
    var moveByNorm = {};
    var custom = obj(opt.customMoves);
    var ck = Object.keys(custom);
    for (var ci = 0; ci < ck.length; ci++) {
      var ce = custom[ck[ci]];
      if (isPlainObject(ce)) {
        if (ce.zh && !moveByName[String(ce.zh)]) moveByName[String(ce.zh)] = ce;
        if (ce.en && !moveByName[String(ce.en)]) moveByName[String(ce.en)] = ce;
        if (moveList.indexOf(ce) < 0) moveList.push(ce);
      }
    }
    for (var mi2 = 0; mi2 < moveList.length; mi2++) {
      var e2 = moveList[mi2];
      var n2a = normalizeName(e2.zh), n2b = normalizeName(e2.en);
      if (n2a && !moveByNorm[n2a]) moveByNorm[n2a] = e2;
      if (n2b && !moveByNorm[n2b]) moveByNorm[n2b] = e2;
    }
    /* names.moves：中文官方名 / 52poke 别名 / 英文名 / 内部 id → 英文显示名 → moves 表 */
    var nMovesNorm = {};
    var nmKeys = Object.keys(nMoves);
    for (var nk = 0; nk < nmKeys.length; nk++) {
      var enName = String(nMoves[nmKeys[nk]]);
      var target = moveByName[enName] || null;
      if (!target) continue;
      var norm = normalizeName(nmKeys[nk]);
      if (norm && !moveByNorm[norm]) moveByNorm[norm] = target;
      nMovesNorm[norm] = target;
    }
    dex.addMoveToIndex = function (entry) {
      if (!isPlainObject(entry)) return false;
      if (entry.zh && !moveByName[String(entry.zh)]) moveByName[String(entry.zh)] = entry;
      if (entry.en && !moveByName[String(entry.en)]) moveByName[String(entry.en)] = entry;
      var a = normalizeName(entry.zh), b = normalizeName(entry.en);
      if (a) moveByNorm[a] = entry;
      if (b) moveByNorm[b] = entry;
      if (moveList.indexOf(entry) < 0) moveList.push(entry);
      return true;
    };
    /* names.species 规范化（官方名 / 英文名 / slug / 别名） + pokedex 自身 */
    var speciesNorm = {};
    var nsKeys = Object.keys(nSpecies);
    for (var sk2 = 0; sk2 < nsKeys.length; sk2++) {
      var spEntry = byName[String(nSpecies[nsKeys[sk2]])] || null;
      var spNorm = normalizeName(nsKeys[sk2]);
      if (spEntry && spNorm && !speciesNorm[spNorm]) speciesNorm[spNorm] = spEntry;
    }
    var pokedexKeys = Object.keys(byName);
    for (var pk2 = 0; pk2 < pokedexKeys.length; pk2++) {
      var pn = normalizeName(pokedexKeys[pk2]);
      if (pn && !speciesNorm[pn]) speciesNorm[pn] = byName[pokedexKeys[pk2]];
    }

    /* ---- 数据访问函数（挂在 dex 上，闭包捕获索引） ---- */

    /** 查种族；找不到时给出清晰报错（调用方可先 hasSpecies 判断） */
    dex.species = function (key) {
      if (key === undefined || key === null || key === '') return null;
      var raw = String(key).trim();
      /* 允许“水/飞行”这类带属性的写法只取种族部分 */
      var hit = byName[raw] || byId[raw] || byName[nSpecies[raw]] || null;
      if (!hit && raw.indexOf('/') >= 0) hit = byName[raw.split('/')[0]] || null;
      return hit || null;
    };
    dex.hasSpecies = function (key) { return !!dex.species(key); };

    /** 查招式 */
    dex.move = function (key) {
      if (key === undefined || key === null || key === '') return null;
      var raw = String(key).trim();
      return moveByName[raw] || moveByName[nMoves[raw]] || null;
    };
    dex.hasMove = function (key) { return !!dex.move(key); };

    /** 属性相性：chart[攻击][防御] */
    dex.typeEff = function (atkType, defType) {
      var row = obj(dex.chart[atkType]);
      var v = row[defType];
      return (v === undefined || v === null) ? 1 : num(v, 1);
    };

    /** 招式对某只宝可梦（可能双属性）的综合倍率 */
    dex.moveEff = function (move, typeList) {
      var list = Array.isArray(typeList) ? typeList : [typeList];
      var eff = 1;
      for (var i = 0; i < list.length; i++) eff *= dex.typeEff(move ? move.type : '一般', list[i]);
      return eff;
    };

    /** 中文档位 → IV 数值 */
    dex.ivOf = function (grade) {
      if (grade === undefined || grade === null) return DEFAULT_IV;
      if (typeof grade === 'number') return clamp(toInt(grade, DEFAULT_IV), 0, 31);
      var g = String(grade).trim();
      if (nIvs[g] !== undefined) return clamp(toInt(nIvs[g], DEFAULT_IV), 0, 31);
      if (/^\d+$/.test(g)) return clamp(toInt(g, DEFAULT_IV), 0, 31);
      return DEFAULT_IV; /* 无法识别 → 按 31（契约 3.2） */
    };

    /** 中文状态 → 引擎状态码 */
    dex.statusCode = function (zh) {
      if (!zh) return 'ok';
      var s = String(zh).trim();
      if (STATUS_CODE[s]) return STATUS_CODE[s];
      if (nStatus[s]) return nStatus[s];
      if (STATUS_ZH[s]) return s; /* 已经是代码 */
      if (/濒死|无法战斗/.test(s)) return 'fnt';
      if (/中毒|剧毒/.test(s)) return /剧毒/.test(s) ? 'tox' : 'psn';
      return 'ok';
    };

    /** 引擎状态码 → 中文 */
    dex.statusText = function (code) {
      if (!code) return STATUS_ZH.ok;
      var c = String(code);
      if (nStatusZh[c]) return nStatusZh[c];
      if (STATUS_CODE[c]) return c; /* 传进来就是中文 */
      return STATUS_ZH[c] || STATUS_ZH.ok;
    };

    /**
     * 性格修正。四种数据形态都要认：
     *   1) names.natures[名] = { up, down }（{加,减} 同义）—— 契约/夹具形态
     *   2) names.natures[名] = "atk/spa" 这类简写 —— 兼容
     *   3) names.natureMods[名] = { up, down } / "atk/spa" —— 老形态
     *   4) 真实数据表：names.natures[名] = 英文性格名，加减表 names.natureUp/natureDown
     *      用中文性格名做键（键也可能是英文性格名，两种都查）
     * 中性/未知性格一律 { up:null, down:null }（不加不减）。
     */
    dex.nature = function (name) {
      var key = String(name || '').trim();
      var n = nNatures[key];
      if (isPlainObject(n)) return { up: n.up || n.加 || null, down: n.down || n.减 || null };
      /* 真实表：natures 给的是英文名（"固执" -> "Adamant"），加减表按中文键 */
      var alias = typeof n === 'string' ? n.trim() : '';
      var up = nNatureUp[key] || (alias ? nNatureUp[alias] : null);
      var down = nNatureDown[key] || (alias ? nNatureDown[alias] : null);
      if (up || down) return { up: up || null, down: down || null };
      var mod = nNatureMods[key];
      if (isPlainObject(mod)) return { up: mod.up || null, down: mod.down || null };
      if (typeof mod === 'string') {
        /* 兼容 "atk/spa" 这类简写 */
        var pair = mod.split(/[\/,，\s]+/);
        return { up: pair[0] || null, down: pair[1] || null };
      }
      return { up: null, down: null };
    };

    /**
     * 基础经验（击败后经验 = baseExp × 等级 / 7，见契约 §5.6）。
     * 数据表没有 baseExp 时按六维种族值之和推导，保证经验结算永远有值可用。
     */
    dex.baseExpOf = function (sp) {
      if (sp && sp.baseExp !== undefined && sp.baseExp !== null) return num(sp.baseExp, 100);
      var bs = obj(sp && sp.baseStats);
      var sum = 0, keys = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
      for (var i = 0; i < keys.length; i++) sum += num(bs[keys[i]], 0);
      return Math.max(30, Math.round(sum / 3));
    };

    /**
     * 招式解析（契约 10.6）：返回 { entry, matched, 原名称, 修正自, 未识别, 原因 }
     *   命中顺序：原样 → names.moves（含 52poke 别名/英文名/内部 id）→ 规范化 → 常见笔误 → 去后缀
     */
    dex.resolveMove = function (key) {
      var raw = String(key === undefined || key === null ? '' : key).trim();
      var out = { entry: null, matched: 'none', 原名称: raw, 修正自: '', 未识别: true, 原因: '' };
      if (!raw) { out.原因 = '空名称'; return out; }
      var direct = moveByName[raw];
      if (direct) { out.entry = direct; out.matched = 'direct'; out.未识别 = false; return out; }
      var norm = normalizeName(raw);
      var hit = moveByNorm[norm] || nMovesNorm[norm] || null;
      if (hit) { out.entry = hit; out.matched = 'normalized'; out.未识别 = false; return out; }
      /* 常见笔误：冷冻牙 → 冰冻牙（仅当正名确实存在） */
      var typo = MOVE_TYPO_MAP[raw];
      if (typo) {
        var t = moveByName[typo] || moveByNorm[normalizeName(typo)] || null;
        if (t) { out.entry = t; out.matched = 'typo'; out.未识别 = false; out.修正自 = typo; return out; }
      }
      /* 去掉尾部“招式/技能”等赘词再试 */
      var cleaned = raw.replace(/[（(【\[].*?[）)】\]]/g, '').replace(/(招式|技能|绝招|大绝)$/, '').trim();
      if (cleaned && cleaned !== raw) {
        var c2 = moveByName[cleaned] || moveByNorm[normalizeName(cleaned)] || null;
        if (c2) { out.entry = c2; out.matched = 'trimmed'; out.未识别 = false; out.修正自 = cleaned; return out; }
      }
      out.原因 = '官方译名与 52poke 别名表里都没有这个名称';
      return out;
    };

    /**
     * 物种解析（契约 10.6）：返回 { entry, matched, 原名称, 基础名, 形态, 未识别 }
     */
    dex.resolveSpecies = function (key) {
      var raw = String(key === undefined || key === null ? '' : key).trim();
      var out = { entry: null, matched: 'none', 原名称: raw, 基础名: raw, 形态: '', 未识别: true };
      if (!raw) return out;
      var direct = dex.species(raw);
      if (direct) { out.entry = direct; out.matched = 'direct'; out.未识别 = false; return out; }
      var split = splitForm(raw);
      out.基础名 = split.base; out.形态 = split.form;
      if (split.base) {
        var base = byName[split.base] || speciesNorm[normalizeName(split.base)] || null;
        if (base) { out.entry = base; out.matched = 'form-stripped'; out.未识别 = false; return out; }
      }
      var byNorm = speciesNorm[normalizeName(raw)] || null;
      if (byNorm) { out.entry = byNorm; out.matched = 'normalized'; out.未识别 = false; return out; }
      return out;
    };

    return dex;
  }

  /* ===========================================================================
   * §2 能力值 / 战斗单位
   * ======================================================================== */

  /**
   * 能力值公式（第 3 代以后，EV 一律 0；卡里没有努力值字段，见 README）：
   *   HP   = floor((2*种族 + 个体) * 等级 / 100) + 等级 + 10
   *   其他 = floor((floor((2*种族 + 个体) * 等级 / 100) + 5) * 性格修正)
   * 抽样：天蝎王 Lv.18（体力种族 75、个体 31）→ 66；攻击种族 95 → 44；速度 95 → 46。
   *      烈咬陆鲨 Lv.100（体力 108、个体 31）→ 357；攻击 130 → 296。
   */
  function calcStat(key, base, iv, level, nature) {
    if (key === 'hp') return Math.floor(((2 * base + iv) * level) / 100) + level + 10;
    var v = Math.floor(((2 * base + iv) * level) / 100) + 5;
    if (nature && nature.up === key && nature.down !== key) v = Math.floor(v * 1.1);
    else if (nature && nature.down === key && nature.up !== key) v = Math.floor(v * 0.9);
    return v;
  }

  /** 经验曲线：升级所需经验 = 等级^3（沿用卡内 5 级=125、20 级附近量级的简化曲线） */
  /**
   * 契约 10.21：**与原卡完全一致**的经验曲线。
   * 卡内脚本 var_updata 用的是 `expNeed = 3L²+3L+1`（Lv5=91，与 schema 默认 经验上限:91 吻合）；
   * 早先这里是 L³（Lv20 需要 8000，而卡只要 1261，差 6.3 倍）→ 本地升级远慢于卡脚本，
   * 且卡脚本每次归一化都会按它的曲线重算经验上限 → 两边互相打架。现改为同一曲线。
   */
  function expForLevel(level) { var L = clamp(toInt(level, 1), 1, 100); return 3 * L * L + 3 * L + 1; }

  /* 能力阶级中英文键对照（口胡通道与 log 都用得上） */
  var STAGE_CODE = {
    '攻击': 'atk', '防御': 'def', '特攻': 'spa', '特防': 'spd', '速度': 'spe', '命中': 'acc', '闪避': 'eva',
    atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe', acc: 'acc', eva: 'eva'
  };

  /**
   * 把「特性」字段的不同写法统一成字符串名（契约 10.27）：
   *   '威吓'（字符串，对手战位的 已知特性） / {名称:'威吓'}（我方队伍成员） / {} → ''
   */
  function normalizeAbilityValue(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.trim();
    if (isPlainObject(v)) {
      var n = v.名称 || v.name || v.特性 || '';
      return typeof n === 'string' ? n.trim() : '';
    }
    return '';
  }

  /** 技能字符串拆分：顿号 / 逗号 / 中文逗号 / 空格 均可作分隔符 */
  function splitMoves(text) {
    if (!text) return [];
    return String(text).split(/[、,，\s\/|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /**
   * 解析变量里的 PP 值：卡面板写的是 "34/35" 这种「当前/上限」字符串，
   * 直接 Number() 会得到 NaN（→ 被当成满 PP，把玩家/模型的消耗记录清掉）。
   * 支持 34 / "34" / "34/35" / "—"（未知）。
   */
  function parsePPValue(PP) {
    if (PP === undefined || PP === null || PP === '') return undefined;
    if (typeof PP === 'string') {
      var s = PP.trim();
      if (!s || s === DASH) return undefined;
      if (s.indexOf('/') >= 0) s = s.split('/')[0].trim();
      var n = parseInt(s, 10);
      return isFinite(n) ? n : undefined;
    }
    var v = Number(PP);
    return isFinite(v) ? v : undefined;
  }

  function makeSlot(dex, name, PP) {
    var r = dex.resolveMove ? dex.resolveMove(name) : { entry: dex.move(name), 未识别: !dex.move(name), matched: 'direct', 原名称: String(name), 修正自: '' };
    var mv = r.entry || null;
    var zh = mv ? (mv.zh || name) : String(name);
    var maxPP = mv ? toInt(mv.pp, 0) : 0;
    var ppParsed = parsePPValue(PP);
    var slot = {
      name: zh, move: mv,
      curPP: mv ? (ppParsed === undefined ? maxPP : clamp(ppParsed, 0, maxPP)) : 0,
      maxPP: maxPP,
      原名称: String(name),
      未识别: !!r.未识别,
      识别方式: r.matched || '',
      修正自: r.修正自 || '',
      未识别原因: r.原因 || ''
    };
    return slot;
  }

  /** 面板用的技能位显示对象（schema：属性/分类/威力/命中/PP 都是字符串） */
  function slotDisplay(dex, move, slot) {
    if (slot && slot.未识别 && !move) {
      return {
        属性: '未知', 分类: '未识别', 威力: DASH, 命中: DASH, PP: DASH,
        效果: '该招式名称不在数据表内，已按未识别处理（可用口胡通道定义）'
      };
    }
    if (!move) return { 属性: '未知', 分类: '未知', 威力: DASH, 命中: DASH, PP: DASH, 效果: '' };
    return {
      属性: move.type || '未知',
      分类: CATEGORY_ZH[move.category] || '变化',
      威力: (move.power === null || move.power === undefined) ? DASH : String(move.power),
      命中: (move.accuracy === null || move.accuracy === undefined) ? DASH : String(move.accuracy),
      PP: (move.pp === null || move.pp === undefined) ? DASH : String(move.pp),
      效果: move.effectNote || ''
    };
  }

  /**
   * §2.1 buildUnit：由队伍成员（或 foeSpec）构造战斗单位
   *   buildUnit(teamMember, { nickname, side:'ally'|'foe', speciesZh, level, moves, curHP })
   */
  function makeBuildUnit(dex) {
    return function buildUnit(teamMember, opts) {
      var src = obj(teamMember);
      var o = obj(opts);
      var side = o.side === 'foe' ? 'foe' : 'ally';
      var speciesKey = o.speciesZh || src.种族 || src.物种 || src.species || o.species || '';
      var sp = dex.species(speciesKey);
      if (!sp) fail('buildUnit：数据表里找不到种族「' + speciesKey + '」（pokedex 中无此条目）');

      /* 契约 10.205：变量里可能只写 对战等级（真机 ✓）→ 一起认 */
      var level = clamp(toInt(o.level !== undefined ? o.level
        : (src.等级 !== undefined ? src.等级 : src.对战等级), 5), 1, 100);
      var realLevel = level;
      /* 规则集锁级：card 的“线上天梯模拟战”把 >50 压到 50 计算（等级字段仍按真实值记录） */
      var cap = o.levelCap === undefined || o.levelCap === null ? null : toInt(o.levelCap, 0);
      if (cap && cap > 0 && level > cap) level = cap;
      var levelCapped = level !== realLevel;
      var nature = dex.nature(src.性格);
      var ivs = {};
      /* 契约 10.131：**数值个体值**（真机：对手只有 个体值={体力:18,…} ✗、没有 个体评价）
       → 原来一律按 31 算 ✗。有数值时优先用数值。 */
    var __numIvs = obj(src.个体值);
    var __hasNumIvs = Object.keys(__numIvs).length > 0;
    var grades = obj(src.个体评价);
      for (var i = 0; i < STAT_KEYS.length; i++) {
        var k = STAT_KEYS[i];
        var zhKey = { hp: '体力', atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度' }[k];
        if (__hasNumIvs) {
        /* 契约 10.135：不依赖外部常量 —— 用本地中英映射（之前误用 STAT_ZH ✗ → 每次建战斗都抛错 ✓） */
        var __ZH = { hp: '体力', atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度' };
        var __nv = __numIvs[__ZH[k] || k];
        if (__nv === undefined) __nv = __numIvs[k];
        ivs[k] = isFinite(Number(__nv)) ? Math.max(0, Math.min(31, Number(__nv))) : dex.ivOf(grades[zhKey]);
      } else {
        ivs[k] = dex.ivOf(grades[zhKey]);
      }
      }

      var base = obj(sp.baseStats);
      var stats = {};
      for (var s = 0; s < STAT_KEYS.length; s++) {
        var key = STAT_KEYS[s];
        stats[key] = calcStat(key, num(base[key], 1), ivs[key], level, nature);
      }
      var maxHP = Math.max(1, stats.hp);

      /* 招式：显式 moves > 队伍成员技能字符串 > 兜底「撞击」。
       * 契约 10.16（用户决定）：**不再退化到"种族参考招式"**（那等于替作者编招式）。 */
      var declaredMoves = (typeof src.技能 === 'string' && splitMoves(src.技能).length)
        ? splitMoves(src.技能)
        : (Array.isArray(o.moves) && o.moves.length ? o.moves.slice() : BASIC.slice());
      var rawMoves = o.moves && o.moves.length ? o.moves.slice() : declaredMoves.slice();
      rawMoves = rawMoves.slice(0, 4);

      var slots = [];
      for (var mi = 0; mi < rawMoves.length; mi++) {
        var nm = rawMoves[mi];
        var ppv;
        /* 允许 {名称, PP} 形状：这样从变量里的 技能位.*.PP（"34/35"）恢复时不会把 PP 重置成满 */
        if (isPlainObject(nm)) {
          ppv = nm.PP !== undefined ? nm.PP : nm.pp;
          nm = nm.名称 || nm.name || nm.zh || '';
        }
        if (nm === undefined || nm === null || String(nm).trim() === '') continue;
        slots.push(makeSlot(dex, nm, ppv));
      }
      if (!slots.length) slots.push(makeSlot(dex, BASIC[0]));

      var status = dex.statusCode(src.状态 || src.异常状态);
      var cur = o.curHP !== undefined ? num(o.curHP, maxHP)
        : (src.当前体力 !== undefined ? num(src.当前体力, maxHP) : maxHP);
      cur = clamp(Math.round(cur), 0, maxHP);
      if (status === 'fnt') cur = 0;
      if (cur <= 0) status = 'fnt';

      var ability = obj(src.特性);
      var held = obj(src.持有物);
      /* 契约 10.27（对手特性接线）/ 10.28（写回保护）：
       *   我方：宝可梦队伍.*.特性.名称（对象）——「确实解析到」
       *   对手：对方战位.*.已知特性（字符串）或 foeSpec.特性 —— 「确实解析到」
       *   两者都没有时：沿用种族特性做兜底（不猜新东西，只是让战斗有特性可用），
       *   但把 abilityFrom 标成 'species' —— 写回 stat_data 时**不覆盖**变量里的原值，
       *   避免把 AI 侦查到的「已知特性」清成种族默认值。 */
      var specAbility = '';
      if (typeof src.特性 === 'string') specAbility = String(src.特性).trim();
      else if (ability.名称) specAbility = String(ability.名称).trim();
      var abilityFrom = specAbility ? 'explicit' : '';
      var abilityName = specAbility || (Array.isArray(sp.abilities) ? sp.abilities[0] : '未知') || '未知';
      if (!specAbility && side === 'foe' && o.ability) {
        abilityName = String(o.ability).trim() || abilityName;
        abilityFrom = 'slot';
      }
      var itemName = held.名称 || (o.item || '无') || '无';

      var unit = {
        nickname: String(o.nickname || src.昵称 || src.名称 || sp.zh || '未知'),
        species: sp.zh || String(speciesKey),
        speciesEn: sp.en || '',
        side: side,
        level: level,
        realLevel: realLevel,
        levelCapped: levelCapped,
        types: Array.isArray(sp.types) && sp.types.length ? sp.types.slice() : ['一般'],
        baseStats: { hp: num(base.hp, 1), atk: num(base.atk, 1), def: num(base.def, 1), spa: num(base.spa, 1), spd: num(base.spd, 1), spe: num(base.spe, 1) },
        ivs: ivs,
        nature: src.性格 || '未知',
        stats: stats,
        maxHP: maxHP,
        curHP: cur,
        status: status,
        statusCounter: 0,
        volatile: {},
        stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
        moves: slots,
        declaredMoveCount: declaredMoves.length,   /* 用于 card 的四招规程 */
        ability: abilityName,
        abilityNote: ability.效果 || '',
        item: itemName,
        itemNote: held.效果 || '',
        /* 契约 10.5：未映射的特性/道具必须在日志与战报里提示，不许静默忽略 */
        abilityMeta: dex.lookupAbility(abilityName),
        itemMeta: dex.lookupItem(itemName),
        exp: (src.当前经验值 !== undefined ? num(src.当前经验值, 0) : 0),
        expNext: num(src.经验上限, expForLevel(level)) || expForLevel(level),
        baseExp: dex.baseExpOf(sp),
        gender: src.性别 || '未知',
        shiny: !!src.闪光,
        form: src.形态 || '一般',
        pos: String(o.pos || (side === 'foe' ? '1' : '1')),
        abilityFrom: abilityFrom || 'species',
        fainted: status === 'fnt',
        expFrozen: level >= 100,
        seq: 0 /* 速度同值时用随机数决定，保留位 */
      };
      return unit;
    };
  }

  /** 按当前等级重算能力值（锁级后调用） */
  function applyLevelCap(dex, unit, cap) {
    if (!cap || unit.level <= cap) return false;
    unit.realLevel = unit.level;
    unit.level = cap;
    unit.levelCapped = true;
    var nature = dex.nature(unit.nature);
    for (var i = 0; i < STAT_KEYS.length; i++) {
      var k = STAT_KEYS[i];
      unit.stats[k] = calcStat(k, num(unit.baseStats[k], 1), num(unit.ivs[k], DEFAULT_IV), unit.level, nature);
    }
    unit.maxHP = Math.max(1, unit.stats.hp);
    unit.curHP = clamp(unit.curHP, 0, unit.maxHP);
    unit.expNext = num(unit.expNext, expForLevel(unit.level)) || expForLevel(unit.level);
    return true;
  }

  /** 技能字符串拆分：顿号 / 逗号 / 中文逗号 / 空格 均可作分隔符 */
  function splitMoves(text) {
    if (!text) return [];
    return String(text).split(/[、,，\s\/|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /** 能力阶级文本（仅供显示/日志用；**写回变量时必须用对象**，见 stagesRecord） */
  var STAGE_ZH = { atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度', acc: '命中', eva: '闪避' };
  function stagesText(unit) {
    var parts = [];
    var order = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      var v = toInt(unit.stages[k], 0);
      if (v > 0) parts.push(STAGE_ZH[k] + '+' + v);
      else if (v < 0) parts.push(STAGE_ZH[k] + v);
    }
    return parts.join(' ');
  }

  /**
   * 能力阶级 → **对象**（契约 10.20，修 bug）
   * 卡的 zod schema 是 `增益与减益: z.record(z.string(), z.string())` —— 必须是对象。
   * 早先这里写的是字符串（`"攻击+1 速度+1"` / `""`），导致 MVU 校验整份 stat_data 失败、
   * 之后**所有**更新被静默丢弃（变量系统假死）。现在一律写成 { 攻击: "+1", 速度: "+1" }。
   */
  /**
   * 契约 10.23：把战位里的「增益与减益」还原成能力阶级。
   * 条目形如 { 攻击: "+1", 速度: "-2" }；旧文本形态也能被 toInt 解析出数字。
   * 早先开战时 stages 一律清零，导致已龙之舞/被威吓的状态在本地结算里丢失。
   */
  function restoreStages(unit, buffs) {
    var ZH2K = { 攻击: 'atk', 防御: 'def', 特攻: 'spa', 特防: 'spd', 速度: 'spe', 命中: 'acc', 闪避: 'eva' };
    var src = obj(buffs);
    Object.keys(src).forEach(function (zh) {
      var k = ZH2K[zh];
      if (!k) return;
      var v = toInt(src[zh], 0);
      unit.stages[k] = clamp(v, -6, 6);
    });
    return unit.stages;
  }

  function stagesRecord(unit) {
    var out = {};
    var order = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      var v = toInt(unit.stages[k], 0);
      if (v > 0) out[STAGE_ZH[k]] = '+' + v;
      else if (v < 0) out[STAGE_ZH[k]] = String(v);
    }
    return out;
  }

  /** 速度线：含能力阶级、麻痹 1/2、特性倍率（拨沙/悠游自如/飞毛腿/轻装…） */
  function effSpeed(unit, ctx) {
    var raw = unit.stats.spe * stageMul(unit.stages.spe);
    /* 契约 10.121：戏法空间 —— 速度倒转（越慢越先手） */
    try {
      var __stTR = ctx && ctx.state;
      if (__stTR && toInt(__stTR.__trickRoom, 0) > 0) {
        var __raw0 = raw;
        return Math.max(1, 10000 - __raw0);
      }
    } catch (eTR) { }

    if (unit.status === 'par') raw *= 0.5;
    /* 契约 10.95：顺风速度翻倍 */
    try {
      var __stS = ctx && ctx.state;
      var __isA = (__stS && Array.isArray(__stS.battle.allies) && __stS.battle.allies.indexOf(unit) >= 0);
      var __scS = __stS && __stS.screens && __stS.screens[__isA ? 'ally' : 'foe'];
      if (__scS && __scS['顺风']) raw *= 2;
    } catch (eSw) { }
    raw *= (abilityStatMult(unit, 'spe', ctx) * itemStatMult(unit, 'spe', ctx));
    return Math.max(1, Math.floor(raw));
  }

  /** 实际攻击/防御：含能力阶级、暴击无视负面、灼伤减半物理攻击、特性加成 */
  function effAtk(unit, category, move, ctx, crit) {
    var __stg = category === 'physical' ? unit.stages.atk : unit.stages.spa;
    if (crit && __stg < 0) __stg = 0; /* [天梯补丁 05] 暴击无视攻方负面攻击/特攻阶级 */
    var raw = (category === 'physical' ? unit.stats.atk : unit.stats.spa) * stageMul(__stg);
    if (category === 'physical' && unit.status === 'brn') raw *= 0.5;
    var key = category === 'physical' ? 'atk' : 'spa';
    raw *= (abilityStatMult(unit, key, ctx, move) * itemStatMult(unit, key, ctx, move));
    if (ctx && ctx.defender) raw *= ruinStatMult(ctx, unit, key, ctx.defender);
    return Math.max(1, Math.floor(raw));
  }
  function effDef(unit, category, crit, move, ctx) {
    var stage = category === 'physical' ? unit.stages.def : unit.stages.spd;
    if (crit && stage > 0) stage = 0; /* 暴击无视目标正面防御阶级 */
    var raw = (category === 'physical' ? unit.stats.def : unit.stats.spd) * stageMul(stage);
    var key = category === 'physical' ? 'def' : 'spd';
    /* 纯朴：守方无视攻方能力阶级 / 攻方无视守方能力阶级 */
    if (ctx && ctx.attacker && hasAbility(ctx.attacker, '纯朴')) stage = 0;
    if (hasAbility(unit, '纯朴') && ctx && ctx.attacker) { /* 守方纯朴：无视攻方攻/特攻阶级 */ }
    raw *= (abilityStatMult(unit, key, ctx, move) * itemStatMult(unit, key, ctx, move));
    if (ctx && ctx.attacker) raw *= ruinStatMult(ctx, unit, key, ctx.attacker);
    return Math.max(1, Math.floor(raw));
  }

  /* ===========================================================================
   * §2.7 特性规则引擎（触发器 + 效果）
   * ---------------------------------------------------------------------------
   * 设计：
   *   - 规则表 ABILITY_RULES 是「结构化效果表」：每条特性 = {zh, en, kinds:[触发器], params}。
   *     它由「宝可梦对战-数据/ability-effects.json」生成（见交付说明），并与
   *     abilities.json 的 kinds/params 互为校验：engine 优先用本表，缺条目时回落到
   *     abilities.json 的 kinds/params。
   *   - kinds 就是触发器名；params 里用通用条件语言描述「何时生效」：
   *       when / takenWhen / healWhen / damageWhen / speedWhen …
   *       条件字段：fullHP, hpAtMost(N 分之一), hpAtLeast, hpBelowHalf, hasStatus, statuses,
   *                 superEffective, resisted, crit, contact, moveTypes, moveFlags, moveCategory,
   *                 notCategory, basePowerAtMost, weather, terrain, hasVolatile, noItem,
   *                 targetJustSwitchedIn, justSwitchedIn, activeTurnsAtMost, movesLast, targetStatus
   *   - 所有效果最终都落到真实的伤害/命中/速度/异常状态判定上，不做「只写日志」的空实现。
   * ======================================================================== */

  /** 取特性规则（按中文名或英文名；带缓存） */
  var ABILITY_RULE_INDEX = null;
  function buildAbilityRuleIndex() {
    if (ABILITY_RULE_INDEX) return ABILITY_RULE_INDEX;
    var idx = {};
    for (var i = 0; i < ABILITY_RULES.length; i++) {
      var r = ABILITY_RULES[i];
      if (r.zh) idx[r.zh] = r;
      if (r.en && !idx[r.en]) idx[r.en] = r;
    }
    ABILITY_RULE_INDEX = idx;
    return idx;
  }
  function abilityRule(unit) {
    if (!unit || !unit.ability) return null;
    return abilityRuleByName(unit.ability);
  }
  /** 按名字（中文/英文）取规则；查不到返回 null */
  function abilityRuleByName(name) {
    var key = String(name === undefined || name === null ? '' : name).trim();
    if (!key) return null;
    var idx = buildAbilityRuleIndex();
    return idx[key] || null;
  }
  /** 单位是否持有某特性（用中文名比对，同时兼容同名英文） */
  function hasAbility(unit, name) {
    if (!unit || !unit.ability) return false;
    if (unit.ability === name) return true;
    var r = abilityRule(unit);
    return !!(r && r.en && (r.en === name || r.zh === name));
  }
  /** 该单位是否「特性已被无视」（破格/兆级电压/涡轮火焰） */
  function abilityIgnoredBy(attacker, defender) {
    return !!(attacker && defender && hasAbility(attacker, '破格') === false && attacker.__ignoreAbility);
  }
  function moveFlagsOf(move) { return (move && Array.isArray(move.flags)) ? move.flags : []; }
  function moveHasFlag(move, flag) { return moveFlagsOf(move).indexOf(flag) >= 0; }
  /** 招式类型：经过「皮肤类/湿润之声」改写后的实际属性 */
  function effectiveMoveType(unit, move) {
    if (!move) return '';
    var p = abilityParams(unit, 'typeChangeMove');
    if (p && p.to && (!p.from || move.type === p.from)
      && (!p.fromFlags || moveHasFlag(move, p.fromFlags[0]))) return p.to;
    if (p && p.to && !p.from && !p.fromFlags) return p.to;
    return move.type;
  }
  /** 命中要害时的追加暴击等级 */
  function abilityCritBonus(atkU, defU, ctx) {
    var n = 0;
    var ra = abilityRule(atkU);
    if (ra && ra.kinds && ra.kinds.indexOf('calc_crit') >= 0) {
      if (condOk(ra.params && ra.params.when, atkU, { defender: defU, ctx: ctx })) n += num(ra.params.plus, 0);
    }
    return n;
  }
  function critImmune(defU) {
    var r = abilityRule(defU);
    return !!(r && r.kinds && r.kinds.indexOf('crit_immune') >= 0);
  }

  /** 取某条 kind 的 params（同一特性多 kind 共用一个 params 对象） */
  /* 契约 10.88：calcDamage 包装 —— 持有物的伤害倍率（达人带 1.2 / 生命宝珠 1.3 / 属性增强 1.2） */
  function calcDamage(dex, atkU, defU, move, crit, rng, weather, ctx, spreadScale) {
    /* 契约 10.97：招式对象可能缺失（数据表查不到/槽位未识别）→ 兜成 {}，避免读属性崩溃 */
    move = move || {};
    /* 契约 10.119：**按体重算威力的招式**（打草结/低踢/踢倒/重磅冲撞/高温重压）
       —— 引擎原来没有体重机制 ✗ → 这些招式 power 为空 → 打 0 伤害 ✓（真机：打草结"效果绝佳"但没伤害） */
    var __rW;   /* [天梯补丁 03] 体重类招式也要走下面的守住/墙/道具后处理，不再提前 return */
    try {
      var __wp = weightBasedPower(dex, move, atkU, defU);
      if (__wp && __wp > 0) {
        var __origPower = move.power;
        move.power = __wp;
        try { __rW = __calcDamageBase(dex, atkU, defU, move, crit, rng, weather, ctx, spreadScale); }
        finally { move.power = __origPower; }
      }
    } catch (eWp) { }
    var r = __rW !== undefined ? __rW : __calcDamageBase(dex, atkU, defU, move, crit, rng, weather, ctx, spreadScale);
    /* 契约 10.120：**反击类**（双倍奉还/镜面反射/金属爆炸/复仇）—— 伤害 = 本回合自己受到的伤害 × 倍率 */
    try {
      var __cnm = String((move && (move.zh || move.name)) || '');
      var __CN = { '双倍奉还': { mult: 2, cat: 'physical' }, '镜面反射': { mult: 2, cat: 'special' }, '金属爆炸': { mult: 1.5, cat: 'physical' }, '复仇': { mult: 2, cat: 'physical' } };
      if (__CN[__cnm]) {
        var __cfg = __CN[__cnm];
        var __taken = num(atkU && atkU.__dmgTakenThisTurn, 0);
        var __lastCat = String((atkU && atkU.__lastHitCat) || '');
        var __dmg = 0;
        if (__taken > 0 && (!__lastCat || __lastCat === __cfg.cat)) __dmg = Math.max(1, Math.floor(__taken * __cfg.mult));
        return { damage: __dmg, eff: 1, crit: false };
      }
    } catch (eCn) { }

    /* 契约 10.94：守住拦截 —— 目标本回合有「守住」则伤害归零（形状按原返回值类型处理） */
    try {
      if (defU && defU.volatile && toInt(defU.volatile['守住'], 0) > 0) {
        if (typeof r === 'number') return 0;
        if (r && typeof r === 'object') { if ('damage' in r) r.damage = 0; if ('dmg' in r) r.dmg = 0; return r; }
        return r;
      }
    } catch (ePr) { }
    /* 契约 10.95：光墙/反射壁/极光幕 —— 守方半场有墙则伤害减半
       [天梯补丁 04] 从守住分支里移出；暴击无视墙；0 伤害不抬成 1 */
    try {
      var __stt = ctx && ctx.state;
      var __isAllyD = (__stt && Array.isArray(__stt.battle.allies) && __stt.battle.allies.indexOf(defU) >= 0);
      var __sc = __stt && __stt.screens && __stt.screens[__isAllyD ? 'ally' : 'foe'];
      if (__sc && move && !crit) {
        var __cat = String(move.category || move.分类 || '');
        var __halve = (__cat.match(/physical|物理/i) && (__sc['反射壁'] || __sc['极光幕']))
          || (__cat.match(/special|特殊/i) && (__sc['光墙'] || __sc['极光幕']));
        if (__halve && typeof r === 'number') { if (r > 0) r = Math.max(1, Math.floor(r / 2)); }
        else if (__halve && r && typeof r === 'object' && typeof r.damage === 'number' && r.damage > 0) r.damage = Math.max(1, Math.floor(r.damage / 2));
      }
    } catch (eScr) { }
    /* [天梯补丁 03] 持有物伤害倍率：内层返回 r.damage（原来读 r.dmg，倍率从未生效） */
    try {
      var d = itemDefOf(atkU);
      if (d && (d.damageMult || d.typeBoost)) {
        var mult = 1;
        var __effI = (r && typeof r === 'object') ? num(r.eff, 1) : 1;
        if (d.damageMult && (!d.superEffectiveOnly || __effI > 1)) mult *= d.damageMult;
        if (d.typeBoost && move && (effectiveMoveType(atkU, move) || String(move.属性 || '')) === d.typeBoost.type) mult *= d.typeBoost.mult;
        if (mult !== 1) {
          if (typeof r === 'number') { if (r > 0) r = Math.max(1, Math.floor(r * mult)); }
          else if (r && typeof r === 'object' && typeof r.damage === 'number' && r.damage > 0) r.damage = Math.max(1, Math.floor(r.damage * mult));
        }
      }
    } catch (eCm) { }
    return r;
  }

  /* 契约 10.98：endOfTurn 包装 —— **保证持有物结算一定跑**（之前挂在某一个调用点之后，真机没跑到 ✗） */
  function endOfTurn(ctx) {
    __endOfTurnBase(ctx);
    /* [天梯补丁 04] 墙的回合数：使用当回合算第 1 回合，回合末倒数，5 回合后消失（光之黏土未实现） */
    try {
      var __scE = ctx && ctx.state && ctx.state.screens;
      if (__scE) {
        ['ally', 'foe'].forEach(function (sd) {
          var o = __scE[sd];
          if (!o) return;
          ['反射壁', '光墙', '极光幕'].forEach(function (k) {
            if (o[k] === undefined) return;
            var left = toInt(o[k], 0) - 1;
            if (left > 0) { o[k] = left; return; }
            delete o[k];
            addEntry(ctx.state, { turn: ctx.turn, actor: sd, actorName: sd === 'ally' ? '我方' : '对方', kind: 'status', notes: ['（' + k + '消失）'],
              text: (sd === 'ally' ? '我方' : '对方') + '的' + k + '消失了！' });
          });
        });
      }
    } catch (eScE) { }
    /* 契约 10.102：回合末**无条件**清掉所有单位的「守住」（防护罩只维持一回合；
       之前放在单位循环里会被 continue 漏掉 → 真机出现"对手开了防护罩后我几回合都打不出伤害" ✗） */
    try {
      var __stE = ctx && ctx.state;
      if (__stE && __stE.battle) {
        var __al = (Array.isArray(__stE.battle.allies) ? __stE.battle.allies : []).concat(Array.isArray(__stE.battle.foes) ? __stE.battle.foes : []);
        for (var __iE = 0; __iE < __al.length; __iE++) {
          var __uE = __al[__iE];
          if (__uE && __uE.volatile && __uE.volatile['守住'] !== undefined) delete __uE.volatile['守住'];
          if (__uE && __uE.volatile && __uE.volatile['挺住'] !== undefined) delete __uE.volatile['挺住'];
          /* 契约 10.117：畏缩同属单回合状态，回合末一并清除（已有另一处，这里双保险） */
          if (__uE && __uE.volatile && __uE.volatile['畏缩'] !== undefined) delete __uE.volatile['畏缩'];
        }
      }
    } catch (eClE) { }
    try { applyHeldItemsEndOfTurn(ctx); } catch (eHi2) { /* 忽略 */ }    /* 契约 10.121：回合末清"本回合受伤"记录 + 空间/重力计数 */
    try {
      var __stR = ctx && ctx.state;
      if (__stR && __stR.battle) {
        [__stR.battle.allies, __stR.battle.foes].forEach(function (arr) {
          (Array.isArray(arr) ? arr : []).forEach(function (u) { if (u) { u.__dmgTakenThisTurn = 0; u.__lastHitCat = ''; } });
        });
      }
    } catch (eClr) { }

  }

  /* 契约 10.86：**持有物的能力倍率/果子**（与特性同一套钩子；用户报"其他持有物呢"） */
  var ITEM_DEF = {
    '突击背心': { statMult: { spd: 1.5 } },
    '进化奇石': { statMult: { def: 1.5, spd: 1.5 } },
    '力量头带': { statMult: { atk: 1.1 } },
    '博识眼镜': { statMult: { spa: 1.1 } },
    '达人带': { damageMult: 1.2, superEffectiveOnly: true },   /* [天梯补丁 03] 只在效果绝佳时生效 */
    '生命宝珠': { damageMult: 1.3, recoil: 0.1 },
    '属性增强（火）': { typeBoost: { type: '火', mult: 1.2 } },
    /* [天梯补丁 03] 属性强化道具（实际道具名） */
    '丝绸围巾': { typeBoost: { type: '一般', mult: 1.2 } },
    '黑带': { typeBoost: { type: '格斗', mult: 1.2 } },
    '锐利鸟嘴': { typeBoost: { type: '飞行', mult: 1.2 } },
    '毒针': { typeBoost: { type: '毒', mult: 1.2 } },
    '柔软沙子': { typeBoost: { type: '地面', mult: 1.2 } },
    '硬石头': { typeBoost: { type: '岩石', mult: 1.2 } },
    '银粉': { typeBoost: { type: '虫', mult: 1.2 } },
    '诅咒之符': { typeBoost: { type: '幽灵', mult: 1.2 } },
    '金属膜': { typeBoost: { type: '钢', mult: 1.2 } },
    '木炭': { typeBoost: { type: '火', mult: 1.2 } },
    '神秘水滴': { typeBoost: { type: '水', mult: 1.2 } },
    '奇迹种子': { typeBoost: { type: '草', mult: 1.2 } },
    '磁铁': { typeBoost: { type: '电', mult: 1.2 } },
    '弯曲的汤匙': { typeBoost: { type: '超能力', mult: 1.2 } },
    '不融冰': { typeBoost: { type: '冰', mult: 1.2 } },
    '龙之牙': { typeBoost: { type: '龙', mult: 1.2 } },
    '黑色眼镜': { typeBoost: { type: '恶', mult: 1.2 } },
    '妖精之羽': { typeBoost: { type: '妖精', mult: 1.2 } },
    '海潮薰香': { typeBoost: { type: '水', mult: 1.2 } },
    '涟漪薰香': { typeBoost: { type: '水', mult: 1.2 } },
    '奇异薰香': { typeBoost: { type: '超能力', mult: 1.2 } },
    '岩石薰香': { typeBoost: { type: '岩石', mult: 1.2 } },
    '花朵薰香': { typeBoost: { type: '草', mult: 1.2 } },
    '火球石板': { typeBoost: { type: '火', mult: 1.2 } },
    '水滴石板': { typeBoost: { type: '水', mult: 1.2 } },
    '雷电石板': { typeBoost: { type: '电', mult: 1.2 } },
    '碧绿石板': { typeBoost: { type: '草', mult: 1.2 } },
    '冰柱石板': { typeBoost: { type: '冰', mult: 1.2 } },
    '拳头石板': { typeBoost: { type: '格斗', mult: 1.2 } },
    '剧毒石板': { typeBoost: { type: '毒', mult: 1.2 } },
    '大地石板': { typeBoost: { type: '地面', mult: 1.2 } },
    '蓝天石板': { typeBoost: { type: '飞行', mult: 1.2 } },
    '神奇石板': { typeBoost: { type: '超能力', mult: 1.2 } },
    '玉虫石板': { typeBoost: { type: '虫', mult: 1.2 } },
    '岩石石板': { typeBoost: { type: '岩石', mult: 1.2 } },
    '妖怪石板': { typeBoost: { type: '幽灵', mult: 1.2 } },
    '龙之石板': { typeBoost: { type: '龙', mult: 1.2 } },
    '恶颜石板': { typeBoost: { type: '恶', mult: 1.2 } },
    '钢铁石板': { typeBoost: { type: '钢', mult: 1.2 } },
    '妖精石板': { typeBoost: { type: '妖精', mult: 1.2 } },
    '气球': { immuneType: '地面' },
    '文柚果': { eotHealHalf: 0.25 },
    '木子果': { eotCure: true },
    '苹野果': { eotPP: 10 },
    '光粉': { foeAccMult: 0.9 },
    '先制之爪': { priorityChance: 0.2 },
    '厚底靴': { immuneHazards: true },
    '气势披带': { focusSash: true },
    '贝壳之铃': { shellBell: 1 / 8 },
    '讲究头带': { statMult: { atk: 1.5 }, choiceLock: true },
    '讲究眼镜': { statMult: { spa: 1.5 }, choiceLock: true },
    '讲究围巾': { statMult: { spe: 1.5 }, choiceLock: true }
  };
  function itemNameOf(unit) {
    if (!unit) return '';
    try {
      var cands = [];
      if (unit.item) cands.push(unit.item);
      if (unit.持有物) cands.push(unit.持有物);
      if (unit.携带物) cands.push(unit.携带物);
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (!c) continue;
        if (typeof c === 'string') { if (c.trim() && c !== '无' && c !== '未知') return c.trim(); continue; }
        if (typeof c === 'object') {
          var n = c.zh || c.name || c.名称 || c.item || '';
          if (typeof n === 'string' && n.trim() && n !== '无' && n !== '未知') return n.trim();
        }
      }
      return '';
    } catch (e) { return ''; }
  }
  function itemDefOf(unit) {
    var n = itemNameOf(unit);
    if (!n || n === '无' || n === '未知') return null;
    return ITEM_DEF[n] || null;
  }
  /** 持有物给某项能力（atk/spa/def/spd/spe）的倍率 */
  function itemStatMult(unit, key, ctx, move) {
    var d = itemDefOf(unit);
    if (!d || !d.statMult || !d.statMult[key]) return 1;
    return d.statMult[key];
  }

  function abilityParams(unit, kind) {
    var r = abilityRule(unit);
    if (!r || !r.kinds || r.kinds.indexOf(kind) < 0) return null;
    return r.params || {};
  }
  function abilityHas(unit, kind) {
    var r = abilityRule(unit);
    return !!(r && r.kinds && r.kinds.indexOf(kind) >= 0);
  }
  /** 该单位的全部 kinds */
  function abilityKindsOf(unit) {
    var r = abilityRule(unit);
    return (r && r.kinds) ? r.kinds : [];
  }

  /* ===========================================================================
   * 概率参数解析（全表审计修复）
   * ---------------------------------------------------------------------------
   * 问题（用户实测「火焰之躯为什么每次都中」）：数据表里同一个「触发概率」用过两种字段名 ——
   *   contactStatus 一族写 `contactChance`（火焰之躯 / 静电 / 毒刺），
   *   contactVolatile / contactStatusRandom 写 `chance`（迷人之躯 / 孢子）。
   * 早先各条路径只认一个名字，取不到就退回**「必中」默认值**（`num(p.chance, 100)`）——
   * 一旦字段名对不上，效果就变成 100% 触发（而不是 30%）。
   *
   * 统一口径（本次审计定稿；别处不许再出现裸的 `num(x, 100)` / `num(x, 30)`）：
   *   ① 按 kind 的候选字段名依次取（contactChance → chance → …），必须是合法数字；
   *   ② 取不到 → 用该 kind 的**官方默认概率**（CHANCE_DEFAULTS）；
   *   ③ 连官方默认都没有（afterDamagingHit 的追加异常：毒手 30 / 辣椒喷发 100 各不相同）
   *      → 返回 null：调用方**跳过该效果并打日志**，绝不静默按 100% 执行。
   * ======================================================================== */
  var CHANCE_FIELDS = {
    /* 接触类（守方特性）：数据表两种写法都出现过 → 两个名字都认 */
    contactStatus: ['contactChance', 'chance'],
    contactStatusRandom: ['contactChance', 'chance'],
    contactVolatile: ['contactChance', 'chance'],
    contactDamage: ['contactChance', 'chance'],
    contactStatLower: ['contactChance', 'chance'],
    contactStatLowerAll: ['contactChance', 'chance'],
    contactPerish: ['contactChance', 'chance'],
    contactAbilitySwap: ['contactChance', 'chance'],
    disableMove: ['chance', 'contactChance'],
    /* 受击追加异常（毒手 / 毒锁链 / 辣椒喷发） */
    afterDamagingHit: ['chance', 'contactChance', 'afterChance'],
    /* 回合末 */
    endTurnCure: ['chance'],
    endTurnHealAlly: ['chance'],
    /* 攻方附加效果 */
    addFlinchSecondary: ['chance'],
    /* 招式追加效果（secondaries） */
    secondary: ['chance'],
    secondaryDamage: ['chance']
  };
  var CHANCE_DEFAULTS = {
    /* —— 官方固定概率（数据表若漏写字段，按这里兜底，**绝不 100%**）—— */
    contactStatus: 30,          /* 火焰之躯 / 静电 / 毒刺：30% */
    contactStatusRandom: 30,    /* 孢子：30% */
    contactVolatile: 30,        /* 迷人之躯：30% */
    disableMove: 30,            /* 诅咒之躯：30% */
    endTurnHealAlly: 30,        /* 治愈之心：30% */
    addFlinchSecondary: 10,     /* 恶臭：10% */
    /* —— 官方「接触即生效」：概率恒为 100%（不需要掷骰）—— */
    contactDamage: 100,         /* 粗糙皮肤 / 铁刺 / 引爆 */
    contactStatLower: 100, contactStatLowerAll: 100,
    contactPerish: 100, contactAbilitySwap: 100,
    /* —— 变化招式的追加效果（secondaries）官方即「必定生效」；
     *    数据表 382 个带 secondaries 的招式全都显式写了 chance（见 verify-data 的概率审计），
     *    这条默认只是兜底，不会命中。伤害招式的追加效果缺 chance 则**不触发**（安全方向）。 —— */
    secondary: 100,
    /* —— 没有 kind 级官方默认：必须由条目自己写清，缺了就跳过并记日志 —— */
    afterDamagingHit: null,
    secondaryDamage: null
  };
  /**
   * 解析某个 kind 的触发概率。
   * @returns {{chance:number, source:'field'|'default', field:string}|null}
   *          null = 既没有字段也没有官方默认 → 调用方跳过该效果并记日志。
   */
  function resolveChance(p, kind) {
    var o = obj(p);
    var fields = CHANCE_FIELDS[kind] || ['chance'];
    for (var i = 0; i < fields.length; i++) {
      var v = o[fields[i]];
      if (v === undefined || v === null || v === '') continue;
      var n = Number(v);
      if (isFinite(n)) return { chance: n, source: 'field', field: fields[i] };
    }
    if (Object.prototype.hasOwnProperty.call(CHANCE_DEFAULTS, kind)) {
      var d = CHANCE_DEFAULTS[kind];
      if (d !== null && d !== undefined && isFinite(Number(d))) {
        return { chance: Number(d), source: 'default', field: '' };
      }
    }
    return null;
  }
  /** 概率判定：>= 100 直接成立（不消耗随机数，保持既有随机流） */
  function chanceHit(ctx, chance) {
    if (!(chance < 100)) return true;
    return ctx.rng() * 100 < chance;
  }
  /**
   * 缺概率参数 → 记一条可读日志（同一回合同一特性只记一次），并跳过该效果。
   * 绝不允许「取不到概率 → 按 100% 执行」。
   */
  function warnMissingChance(ctx, unit, kind) {
    var st = ctx && ctx.state;
    if (!st) return;
    var nm = (unit && unit.nickname) ? String(unit.nickname) : '';
    var key = toInt(ctx.turn, 0) + '|' + nm + '|' + kind;
    var warned = obj(obj(st.meta).chanceWarnings);
    if (warned[key]) return;
    warned[key] = true;
    st.meta.chanceWarnings = warned;
    var txt = '⚠ 特性「' + ((unit && unit.ability) || '未知') + '」缺少概率参数（' + kind + '），本回合不触发';
    addEntry(st, {
      turn: ctx.turn, actor: (unit && unit.side) || 'ally', actorName: nm,
      kind: 'status', notes: ['（缺概率参数）'], text: txt
    });
  }

  /**
   * 通用条件求值。
   * @param {object} cond 条件对象（见本节顶部说明）
   * @param {object} unit 条件的主体（通常是「特性持有者」）
   * @param {object} env  { attacker, defender, move, ctx, target }
   */
  function condOk(cond, unit, env) {
    if (!cond) return true;
    var e = env || {};
    var ctx = e.ctx || {};
    var move = e.move || e.attacker && e.attacker.__lastMove || null;
    var self = unit || {};
    if (cond.fullHP && num(self.curHP, 0) < num(self.maxHP, 1)) return false;
    if (cond.hpAtMost) {
      var n = num(cond.hpAtMost, 0);
      if (!(n > 0)) return false;
      if (!(num(self.curHP, 0) * n <= num(self.maxHP, 1))) return false;
    }
    if (cond.hpBelowHalf && !(num(self.curHP, 0) * 2 < num(self.maxHP, 1))) return false;
    if (cond.hpAtLeastHalf && !(num(self.curHP, 0) * 2 >= num(self.maxHP, 1))) return false;
    if (cond.hasStatus && self.status === 'ok') return false;
    if (cond.statuses && cond.statuses.indexOf(self.status) < 0) return false;
    if (cond.targetStatus) {
      var tg = e.defender || e.target;
      if (!tg || cond.targetStatus.indexOf(tg.status) < 0) return false;
    }
    if (cond.superEffective) {
      var eff = e.eff;
      if (eff === undefined && ctx && ctx.dex && move && e.defender) eff = ctx.dex.moveEff(move, e.defender.types);
      if (!(num(eff, 1) > 1)) return false;
    }
    if (cond.resisted) {
      var eff2 = e.eff;
      if (eff2 === undefined && ctx && ctx.dex && move && e.defender) eff2 = ctx.dex.moveEff(move, e.defender.types);
      if (!(num(eff2, 1) > 0 && num(eff2, 1) < 1)) return false;
    }
    if (cond.crit !== undefined && !!e.crit !== !!cond.crit) return false;
    if (cond.contact !== undefined && moveHasFlag(move, 'contact') !== !!cond.contact) return false;
    if (cond.moveTypes && (!move || cond.moveTypes.indexOf(effectiveMoveType(e.attacker || self, move)) < 0)) return false;
    if (cond.moveFlags) {
      for (var i = 0; i < cond.moveFlags.length; i++) if (!moveHasFlag(move, cond.moveFlags[i])) return false;
    }
    if (cond.moveCategory && (!move || move.category !== cond.moveCategory)) return false;
    if (cond.notCategory && move && move.category === cond.notCategory) return false;
    if (cond.basePowerAtMost !== undefined && !(num(move && move.power, 0) <= num(cond.basePowerAtMost, 0))) return false;
    if (cond.weather) {
      /* 天气来源优先级：ctx.state.battle.weather > 单位身上的当前场地状态（bounds by bindState）> 单位自带 */
      var bst = (ctx && ctx.state && ctx.state.battle) || self.__ctxState && self.__ctxState.battle || null;
      var w = (bst && bst.weather) || self.__weather || '';
      var hit = false;
      for (var wi = 0; wi < cond.weather.length; wi++) {
        if (cond.weather[wi] === '*' ? !!w : (!!w && String(w).indexOf(cond.weather[wi]) >= 0)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    if (cond.terrain) {
      var bst2 = (ctx && ctx.state && ctx.state.battle) || self.__ctxState && self.__ctxState.battle || null;
      var tr = (bst2 && bst2.__terrain) || self.__terrain || '';
      if (cond.terrain !== '*' && String(tr).indexOf(cond.terrain) < 0) return false;
    }
    if (cond.hasVolatile && !(self.volatile && self.volatile[cond.hasVolatile])) return false;
    if (cond.noItem && self.item && self.item !== '无') return false;
    if (cond.justSwitchedIn && !self.justSwitchedIn) return false;
    if (cond.targetJustSwitchedIn) {
      var tg2 = e.defender || e.target;
      if (!tg2 || !tg2.justSwitchedIn) return false;
    }
    if (cond.activeTurnsAtMost !== undefined && !(toInt(self.activeTurns, 0) <= toInt(cond.activeTurnsAtMost, 0))) return false;
    if (cond.movesLast && !e.movesLast) return false;
    if (cond.genderMult) {
      var g1 = self.gender, g2 = (e.defender || {}).gender;
      if (!g1 || !g2 || g1 === '未知' || g2 === '未知') return false;
    }
    return true;
  }

  /** [天梯补丁 01] 同侧在场的其他单位里，第一只持有 names 中任一特性的；没有（含单打）返回 null */
  function findAllyWithAbility(unit, names, ctx) {
    try {
      var st = (ctx && ctx.state) || (unit && unit.__ctxState) || null;
      if (!st || !st.battle || !unit) return null;
      var list = Array.isArray(names) ? names : (names ? [names] : []);
      if (!list.length) return null;
      var mates = alliesOf(st, unit);
      for (var i = 0; i < mates.length; i++) {
        var u = mates[i];
        if (!u || u.fainted || num(u.curHP, 0) <= 0) continue;
        for (var j = 0; j < list.length; j++) if (hasAbility(u, list[j])) return u;
      }
    } catch (eFa) { }
    return null;
  }

  /** 特性对「攻击/特攻/防御/特防/速度」的倍率（用于 effAtk / effDef / effSpeed） */
  function abilityStatMult(unit, stat, ctx, move) {
    if (!unit || !unit.ability) return 1;
    var r = abilityRule(unit);
    if (!r || !r.kinds) return 1;
    var p = r.params || {};
    var k = r.kinds;
    var mult = 1;
    var env = { ctx: ctx, move: move || (ctx && ctx.move), attacker: (ctx && ctx.attacker) || unit, defender: (ctx && ctx.defender) || null };
    if (k.indexOf('damageBound') >= 0 && condOk(p.when, unit, env)) {
      /* 两类写法：
       *   ① multStats:['atk'|'spa'|…]（大力士/毅力这类纯能力值倍率）
       *   ② multTypes:['火'|'水'…]（猛火/激流/钢能力者这类「本系招式威力」倍率） */
      var mv2 = env.move;
      if (p.multStats && p.multStats.indexOf(stat) >= 0) mult *= num(p.mult, 1);
      else if (p.multTypes && mv2 && p.multTypes.indexOf(effectiveMoveType(unit, mv2)) >= 0) mult *= num(p.mult, 1);
    }
    if (k.indexOf('modify_def') >= 0 && (stat === 'def' || stat === 'spd') && condOk(p.when, unit, env)) mult *= num(p.mult, 1);
    if (k.indexOf('modify_speed') >= 0 && stat === 'spe' && condOk(p.speedWhen || p.when, unit, env)) mult *= num(p.speedMult !== undefined ? p.speedMult : p.mult, 1);
    if (k.indexOf('allyStatBoost') >= 0 && p.stat === stat) {
      var ally = findAllyWithAbility(unit, p.requiresAllyAbility, ctx);   /* [天梯补丁 01] */
      if (ally) mult *= num(p.mult, 1);
    }
    if (k.indexOf('slowStart2') >= 0) { /* 兼容位 */ }
    return mult;
  }

  /** 场上「灾祸」类特性对攻/防的压制（影响除持有者外的所有人；同特性不互相压制） */
  function ruinStatMult(ctx, owner, stat, other) {
    var st = ctx && ctx.state;
    if (!st) return 1;
    var list = fieldUnits(st);
    var mult = 1;
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u || u.fainted || u === other) continue;
      var p = abilityParams(u, 'ruinOnField');
      if (!p || p.stat !== stat) continue;
      var rU = abilityRule(u), rO = abilityRule(other);
      if (rU && rO && rU.en && rU.en === rO.en) continue;   /* 同名「灾祸」不互相压制 */
      mult *= num(p.mult, 1);
      break;
    }
    return mult;
  }

  /** 场上所有单位（双打时含全部战位） */
  function fieldUnits(st) {
    if (!st || !st.battle) return [];
    var out = [];
    var b = st.battle;
    if (Array.isArray(b.allies) && b.allies.length) out = out.concat(b.allies);
    else if (b.ally) out.push(b.ally);
    if (Array.isArray(b.foes) && b.foes.length) out = out.concat(b.foes);
    else if (b.foe) out.push(b.foe);
    return out.filter(Boolean);
  }
  /** 同侧同伴（不含自身） */
  function alliesOf(state, unit) {
    if (!state || !unit) return [];
    return fieldUnits(state).filter(function (u) { return u.side === unit.side && u !== unit && !u.fainted; });
  }
  /** 对手单位（单打：对面的战位；双打：对面全部战位） */
  function foesOf(state, unit) {
    if (!state || !unit) return [];
    return fieldUnits(state).filter(function (u) { return u.side !== unit.side && !u.fainted; });
  }
  /** 攻击方是否无视守方特性（破格 / 兆级电压 / 涡轮火焰） */
  function ignoresFoeAbility(atkU) {
    return !!(atkU && atkU.ability && (hasAbility(atkU, '破格') || hasAbility(atkU, '兆级电压') || hasAbility(atkU, '涡轮火焰')));
  }

  /** 属性免疫判定：返回 {immune:true, params} 或 null */
  function abilityImmunity(dex, defU, move, ctx) {
    if (!defU || !move || !defU.ability) return null;
    if (ignoresFoeAbility(ctx && ctx.attacker)) return null;
    var kinds = abilityKindsOf(defU);
    if (!kinds.length || kinds.indexOf('immune') < 0) return null;
    var p = abilityParams(defU, 'immune') || {};
    var env = { ctx: ctx, move: move, attacker: (ctx && ctx.attacker) || null, defender: defU };
    if (p.immuneFromAlly) return null;   /* 双打队友伤害：单打对位里不触发 */
    if (p.when && !condOk(p.when, defU, env)) return null;
    if (p.immuneCategory && move.category !== p.immuneCategory) return null;
    if (p.immuneTypes && p.immuneTypes.indexOf(effectiveMoveType(defU, move)) < 0) return null;
    if (p.immuneFlags) {
      var hit = false;
      for (var i = 0; i < p.immuneFlags.length; i++) if (moveHasFlag(move, p.immuneFlags[i])) { hit = true; break; }
      if (!hit) return null;
    }
    if (!p.immuneTypes && !p.immuneFlags && !p.immuneCategory) return null;
    return { immune: true, params: p };
  }

  /** 特性对「造成伤害」的倍率（modify_damage / 气场） */
  function abilityDamageMult(ctx, atkU, defU, move, extra) {
    if (!atkU || !atkU.ability) return 1;
    var r = abilityRule(atkU);
    if (!r || !r.kinds) return 1;
    var p = r.params || {};
    var env = Object.assign({ ctx: ctx, move: move, attacker: atkU, defender: defU }, extra || {});
    var mult = 1;
    if (r.kinds.indexOf('modify_damage') >= 0 && condOk(p.when, atkU, env)) mult *= num(p.mult, 1);
    if (r.kinds.indexOf('auraDamage') >= 0 && p.types && p.types.indexOf(effectiveMoveType(atkU, move)) >= 0) mult *= num(p.mult, 1);
    return mult;
  }

  /** 特性对「受到伤害」的倍率（multiscale / 厚脂肪 / 过滤 / 毛茸茸…） */
  function abilityTakenMult(ctx, defU, atkU, move, extra) {
    if (!defU || !defU.ability) return 1;
    if (ignoresFoeAbility(atkU)) return 1;
    var r = abilityRule(defU);
    if (!r || !r.kinds) return 1;
    var p = r.params || {};
    var env = Object.assign({ ctx: ctx, move: move, attacker: atkU, defender: defU }, extra || {});
    var mult = 1;
    if (r.kinds.indexOf('modify_taken') >= 0) {
      var when = p.takenWhen || p.when;
      var ok = condOk(when, defU, env);
      if (ok && p.takenTypes && p.takenTypes.indexOf(effectiveMoveType(atkU, move)) < 0) ok = false;
      if (ok && p.takenMoveFlags) {
        for (var i = 0; i < p.takenMoveFlags.length; i++) if (!moveHasFlag(move, p.takenMoveFlags[i])) { ok = false; break; }
      }
      if (ok) mult *= num(p.takenMult !== undefined ? p.takenMult : p.mult, 1);
      if (p.extraMult && condOk(p.extraWhen, defU, env)) mult *= num(p.extraMult, 1);
    }
    if (r.kinds.indexOf('auraBreak') >= 0 && atkU && abilityParams(atkU, 'auraDamage')) mult *= num(p.mult, 0.75);
    return mult;
  }

  /** 同伴对「自己受伤」的减免（友人防守：双打） */
  function allyDamageTakenMult(state, defU) {
    if (!state || !defU) return 1;
    var list = alliesOf(state, defU);
    var mult = 1;
    for (var i = 0; i < list.length; i++) {
      var p = abilityParams(list[i], 'allyDamageTaken');
      if (p) mult *= num(p.mult, 1);
    }
    return mult;
  }

  /** 同伴对「自己威力」的加成（蓄电池 / 钢之意志 / 能量点） */
  function allyBasePowerMult(ctx, atkU, move) {
    var st = ctx && ctx.state;
    if (!st || !atkU) return 1;
    var list = alliesOf(st, atkU);
    var mult = 1;
    var env = { ctx: ctx, move: move, attacker: atkU, defender: ctx && ctx.defender };
    for (var i = 0; i < list.length; i++) {
      var p = abilityParams(list[i], 'allyBasePower');
      if (!p) continue;
      if (!condOk(p.when, atkU, env)) continue;
      mult *= num(p.mult, 1);
    }
    return mult;
  }

  /** 同伴对「自己命中」的加成（胜利之星） */
  function allyAccuracyMult(state, atkU) {
    if (!state || !atkU) return 1;
    var list = alliesOf(state, atkU);
    var mult = 1;
    for (var i = 0; i < list.length; i++) {
      var p = abilityParams(list[i], 'allyModifyAccuracy');
      if (p) mult *= num(p.mult, 1);
    }
    return mult;
  }

  /** 威力端的特性倍率（技术高手 / 皮肤加成 / 强行 / 亲子爱 / 喷火…） */
  function abilityPowerMult(ctx, atkU, defU, move) {
    if (!atkU || !atkU.ability || !move) return 1;
    var r = abilityRule(atkU);
    if (!r || !r.kinds) return 1;
    var p = r.params || {};
    var env = { ctx: ctx, move: move, attacker: atkU, defender: defU, movesLast: !!(ctx && ctx.movesLast) };
    var mult = 1;
    if (r.kinds.indexOf('modify_power') >= 0 && condOk(p.when, atkU, env)) {
      var ok = true;
      if (p.moveFlags) {
        for (var i = 0; i < p.moveFlags.length; i++) if (!moveHasFlag(move, p.moveFlags[i])) { ok = false; break; }
      }
      if (ok) mult *= num(p.mult, 1);
    }
    if (r.kinds.indexOf('typeChangeMove') >= 0 && p.mult && effectiveMoveType(atkU, move) !== move.type) mult *= num(p.mult, 1);
    if (r.kinds.indexOf('sheerForce') >= 0 && moveHasSecondary(move)) mult *= num(p.mult, 1.3);
    if (r.kinds.indexOf('parentalBond') >= 0 && move.category !== 'status') mult *= (1 + num(p.mult, 0.25));
    if (p.hpScale && p.hpScale.stat === 'hp') {
      mult *= 1 + (num(p.hpScale.mult, 0.5) - 1) * (num(atkU.curHP, 0) / Math.max(1, num(atkU.maxHP, 1)));
    }
    if (p.fallenScale) {
      var fallen = Math.min(toInt(atkU.__fallen, 0), 5);
      mult *= 1 + 0.1 * fallen;
    }
    if (p.genderMult) {
      var g1 = atkU.gender, g2 = (defU || {}).gender;
      if (g1 && g2 && g1 !== '未知' && g2 !== '未知') mult *= (g1 === g2 ? 1.25 : 0.75);
    }
    return mult;
  }
  function moveHasSecondary(move) {
    return !!(move && ((Array.isArray(move.secondaries) && move.secondaries.length) || move.boostsSelf || move.volatile));
  }

  /* ===========================================================================
   * §2.8 特性钩子：登场 / 出招前 / 命中后 / 濒死 / 回合末 / 换下
   * ======================================================================== */

  /** 通用：给单位加能力阶级并记日志 */
  function hookBoost(ctx, unit, boosts, tag, actorName, noLog) {
    if (!ctx || !ctx.state || !unit || !boosts) return {};
    var z = applyStages(unit, boosts);
    if (Object.keys(z).length && !noLog) {
      var txt = (actorName || unit.nickname) + ' 的' + stageChangeText(z) + '！' + (tag ? '（' + tag + '）' : '');
      addEntry(ctx.state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', notes: [txt], text: txt });
    }
    return z;
  }
  /** 通用：回血并记日志 */
  function hookHeal(ctx, unit, fraction, tag) {
    if (!ctx || !ctx.state || !unit || unit.fainted) return 0;
    var amount = Math.max(1, Math.floor(num(unit.maxHP, 1) * num(fraction, 0)));
    var before = unit.curHP;
    unit.curHP = Math.min(unit.maxHP, unit.curHP + amount);
    var got = unit.curHP - before;
    if (got > 0) {
      var txt = unit.nickname + ' 回复了 ' + got + ' 点体力！' + (tag ? '（' + tag + '）' : '');
      addEntry(ctx.state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', hpFrom: before, hpTo: unit.curHP, notes: [txt], text: txt });
    }
    return got;
  }
  /** 通用：直接扣血（不触发反伤类再结算） */
  function hookDamage(ctx, unit, fraction, tag) {
    if (!ctx || !ctx.state || !unit || unit.fainted) return 0;
    var amount = Math.max(1, Math.floor(num(unit.maxHP, 1) * num(fraction, 0)));
    var before = unit.curHP;
    unit.curHP = Math.max(0, unit.curHP - amount);
    var lost = before - unit.curHP;
    if (lost > 0) {
      var txt = unit.nickname + ' 受到了 ' + lost + ' 点伤害。' + (tag ? '（' + tag + '）' : '');
      addEntry(ctx.state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', hpFrom: before, hpTo: unit.curHP, notes: [txt], text: txt });
      if (unit.curHP <= 0) faintUnit(ctx, unit);
    }
    return lost;
  }
  /** 通用：治疗异常状态 */
  function hookCure(ctx, unit, tag) {
    if (!ctx || !ctx.state || !unit || unit.status === 'ok' || unit.status === 'fnt') return false;
    var before = unit.status;
    unit.status = 'ok'; unit.statusCounter = 0;
    var txt = unit.nickname + ' 的' + ctx.dex.statusText(before) + '被治愈了！' + (tag ? '（' + tag + '）' : '');
    addEntry(ctx.state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', notes: [txt], text: txt });
    return true;
  }
  /** 通用：设置天气 */
  function hookWeather(ctx, weather, tag) {
    if (!ctx || !ctx.state || !weather) return;
    ctx.state.battle.weather = weather;
    ctx.state.battle.场地效果 = weatherText(weather);
    ctx.weather = weather;
    var txt = '天气变成了' + weather + '！' + (tag ? '（' + tag + '）' : '');
    addEntry(ctx.state, { turn: ctx.turn, actor: 'ally', actorName: '天气', kind: 'status', notes: [txt], text: txt });
  }
  /** 通用：设置场地 */
  function hookTerrain(ctx, terrain, tag) {
    if (!ctx || !ctx.state || !terrain) return;
    ctx.state.battle.__terrain = terrain;
    try {
      if (!ctx.state.battle.场地效果 || typeof ctx.state.battle.场地效果 !== 'object') ctx.state.battle.场地效果 = {};
      ['电气场地', '精神场地', '薄雾场地', '青草场地'].forEach(function (k) { delete ctx.state.battle.场地效果[k]; });
      ctx.state.battle.场地效果[terrain] = {};
      ctx.state.battle.场地环境 = terrain;
    } catch (e) { }
    var txt = '场地变成了' + terrain + '！' + (tag ? '（' + tag + '）' : '');
    addEntry(ctx.state, { turn: ctx.turn, actor: 'ally', actorName: '场地', kind: 'status', notes: [txt], text: txt });
  }
  /** 通用：给对手/自身加状态（走异常判定） */
  function hookStatus(ctx, target, code, tag) {
    if (!ctx || !ctx.state || !target || target.fainted) return false;
    if (!canApplyStatus(ctx.dex, { type: '???' }, target, code)) return false;
    setStatus(target, code, ctx);
    var txt = target.nickname + ' 陷入了' + ctx.dex.statusText(code) + '状态！' + (tag ? '（' + tag + '）' : '');
    addEntry(ctx.state, { turn: ctx.turn, actor: target.side, actorName: target.nickname, kind: 'status', notes: [txt], text: txt });
    return true;
  }

  /** 登场钩子（威吓 + 天气 + 能力 + 形态外的全部 switch_in 效果） */
  function hookSwitchIn(dex, state, unit, opponent) {
    if (!unit || unit.fainted) return;
    unit.justSwitchedIn = true;
    unit.activeTurns = 0;
    var ctx = { dex: dex, state: state, turn: toInt(obj(state.meta).turnCount, 0), rng: state.__statRng || Math.random };
    var kinds = abilityKindsOf(unit);
    for (var i = 0; i < kinds.length; i++) {
      var k = kinds[i];
      var p = abilityParams(unit, k) || {};
      if (k === 'switchInBoost') {
        var targets = (p.boostTarget === 'foe') ? [opponent].filter(Boolean) : [unit];
        for (var t = 0; t < targets.length; t++) {
          if (p.once && targets[t].__switchBoostUsed) continue;
          var z = applyStages(targets[t], p.boosts || {});
          if (Object.keys(z).length) {
            if (p.once) targets[t].__switchBoostUsed = true;
            var txt = unit.nickname + ' 的' + (unit.ability || '特性') + '让 ' + targets[t].nickname + ' 的' + stageChangeText(z) + '！';
            addEntry(state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', notes: ['（' + unit.ability + '）' + txt], text: txt });
          }
        }
      } else if (k === 'switchInWeather') {
        var cur = state.battle.weather || '';
        if (!cur || cur !== p.weather) {
          hookWeather(ctx, p.weather, unit.ability);
          try { log2('【天气来源】特性=' + unit.ability + ' 设为=' + p.weather); } catch (e) { }
        }
      } else if (k === 'fieldEffect') {
        if (p.terrain && state.battle.__terrain !== p.terrain) hookTerrain(ctx, p.terrain, unit.ability);
      } else if (k === 'switchInBoostChoice') {
        /* 下载：比较对手防御/特防（含能力阶级），取高者对应的攻击方向 */
        var foe = opponent;
        if (foe) {
          var d = num(foe.stats.def, 1) * stageMul(foe.stages.def);
          var sd = num(foe.stats.spd, 1) * stageMul(foe.stages.spd);
          hookBoost(ctx, unit, (d >= sd ? { spa: 1 } : { atk: 1 }), '下载');
        }
      } else if (k === 'switchInWarn') {
        var foe2 = opponent;
        if (foe2 && Array.isArray(foe2.moves)) {
          var hasDanger = false;
          for (var mi = 0; mi < foe2.moves.length; mi++) {
            var mv = foe2.moves[mi] && foe2.moves[mi].move;
            if (!mv) continue;
            if (mv && (mv.ohko || (dex.moveEff(mv, unit.types) > 1 && mv.category !== 'status'))) { hasDanger = true; break; }
          }
          addEntry(state, {
            turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
            notes: ['（' + unit.ability + '）'],
            text: unit.nickname + ' 的' + unit.ability + '：' + (hasDanger ? (foe2.nickname + ' 持有危险的招式！') : (foe2.nickname + ' 没有特别危险的招式。'))
          });
        }
      } else if (k === 'switchInRevealItem') {
        var foe3 = opponent;
        if (foe3 && foe3.item && foe3.item !== '无') {
          var txt3 = unit.nickname + ' 的察觉：' + foe3.nickname + ' 携带了「' + foe3.item + '」。';
          addEntry(state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', notes: ['（察觉）'], text: txt3 });
        }
      } else if (k === 'switchInCopyAllyStages') {
        var al = alliesOf(state, unit)[0];
        if (al) {
          unit.stages = deepClone(al.stages);
          var txt4 = unit.nickname + ' 的同台共演：复制了 ' + al.nickname + ' 的能力阶级。';
          addEntry(state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', notes: ['（同台共演）'], text: txt4 });
        }
      } else if (k === 'switchInResetAllyStages') {
        var al2 = alliesOf(state, unit)[0];
        if (al2) {
          al2.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
          var txt5 = unit.nickname + ' 的怪药：解除了 ' + al2.nickname + ' 的能力变化。';
          addEntry(state, { turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status', notes: ['（怪药）'], text: txt5 });
        }
      } else if (k === 'switchInHealAlly') {
        var al3 = alliesOf(state, unit)[0];
        if (al3) hookHeal(ctx, al3, num(p.healFraction, 0.25), unit.ability);
      } else if (k === 'switchInClearScreens') {
        state.battle.场地效果 = weatherText(state.battle.weather);
        addEntry(state, {
          turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
          notes: ['（除障）'], text: unit.nickname + ' 的除障：双方场地的光墙/反射壁/极光幕被清除。'
        });
      } else if (k === 'surviveKo' && p.once) {
        unit.__shieldReady = true;   /* 画皮 / 冰冻头：一次性护盾在上场时挂好 */
      } else if (k === 'boostBestStat') {
        if (condOk(p.when, unit, { ctx: ctx })) { /* 由 modify 生效，这里只做提示 */ }
      } else if (k === 'trapFoe') {
        /* 踩影/沙穴/磁力：记录「无法逃走」提示（引擎换人由 AI 决定，这里记状态供集成层读） */
        state.meta.trapped = state.meta.trapped || {};
        state.meta.trapped[opponent ? opponent.nickname : ''] = unit.ability;
      }
    }
  }

  /** 回合末：特性回复 / 伤害 / 治愈 / 能力提升 / 特性异常处理 */
  function hookEndOfTurn(ctx) {
    /* 青草场地（契约 10.30）：站在地面上的单位每回合末回复 1/16 最大体力 */
    try {
      if (terrainOf(ctx.state) === '青草场地') {
        var __us = fieldUnits(ctx.state);
        for (var __i = 0; __i < __us.length; __i++) {
          var __u = __us[__i];
          if (!__u || __u.fainted || num(__u.curHP, 0) <= 0 || !isGrounded(__u)) continue;
          var __mx = num(__u.maxHP, 0);
          var __heal = Math.max(1, Math.floor(__mx / 16));
          if (num(__u.curHP, 0) >= __mx) continue;
          __u.curHP = Math.min(__mx, num(__u.curHP, 0) + __heal);
          fieldLog(ctx, __u.side, __u.nickname, __u.nickname + ' 受到了青草场地的回复！');
        }
      }
    } catch (e) { /* 忽略 */ }

    var st = ctx.state, dex = ctx.dex;
    if (!st || st.ended) return;
    var units = fieldUnits(st);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u || u.fainted) continue;
      bindState(u, st);
      var kinds = abilityKindsOf(u);
      for (var j = 0; j < kinds.length; j++) {
        var k = kinds[j];
        var p = abilityParams(u, k) || {};
        if (k === 'endTurnHeal') {
          if (condOk(p.healWhen || p.when, u, { ctx: ctx })) hookHeal(ctx, u, num(p.healFraction, 0), u.ability);
        } else if (k === 'endTurnDamage') {
          if (condOk(p.damageWhen || p.when, u, { ctx: ctx })) hookDamage(ctx, u, num(p.damageFraction, 0), u.ability);
        } else if (k === 'endTurnCure') {
          if (u.status === 'ok' || u.status === 'fnt') continue;
          if (p.immuneStatuses && p.immuneStatuses !== 'all' && p.immuneStatuses.indexOf(u.status) < 0) continue;
          if (!condOk(p.when, u, { ctx: ctx })) continue;
          /* chance 可写可不写：写了就是概率型（蜕皮 30%）；没写表示「无条件治愈」
           * （湿润之躯 / 免疫 / 不眠 … 的官方语义，不是概率特性）。 */
          var ecCh = resolveChance(p, 'endTurnCure');
          if (ecCh && !(ctx.rng() * 100 < ecCh.chance)) continue;
          hookCure(ctx, u, u.ability);
        } else if (k === 'endTurnBoost') {
          hookBoost(ctx, u, p.boost || {}, u.ability);
        } else if (k === 'endTurnHealAlly') {
          var al = alliesOf(st, u)[0];
          var ehCh = resolveChance(p, 'endTurnHealAlly') || { chance: 30 };
          if (al && al.status !== 'ok' && ctx.rng() * 100 < ehCh.chance) hookCure(ctx, al, u.ability);
        } else if (k === 'moody') {
          var stats = ['atk', 'def', 'spa', 'spd', 'spe'];
          var up = stats[Math.floor(ctx.rng() * stats.length)];
          var down = stats[Math.floor(ctx.rng() * stats.length)];
          var b = {}; b[up] = (b[up] || 0) + 2;
          if (down !== up) b[down] = (b[down] || 0) - 1;
          hookBoost(ctx, u, b, '心情不定');
        } else if (k === 'earlyBird') {
          if (u.status === 'slp' && toInt(u.statusCounter, 0) > 1) u.statusCounter = Math.max(1, Math.ceil(toInt(u.statusCounter, 0) / 2));
        } else if (k === 'emergencyExit') {
          if (num(u.curHP, 1) * 2 <= num(u.maxHP, 2) && !u.__exitUsed) {
            u.__exitUsed = true;
            addEntry(st, {
              turn: ctx.turn, actor: u.side, actorName: u.nickname, kind: 'status',
              notes: ['（' + u.ability + '）'], text: u.nickname + ' 的' + u.ability + '：体力过半以下，准备退场。'
            });
          }
        } else if (k === 'syncStatus') {
          if (u.__syncBack && u.__syncBack.length) {
            var back = u.__syncBack.shift();
            if (back && !back.fainted) hookStatus(ctx, back, u.status === 'ok' ? 'psn' : u.status, '同步');
          }
        }
      }
      if (u.justSwitchedIn) u.justSwitchedIn = false;
      u.activeTurns = toInt(u.activeTurns, 0) + 1;
      u.__lastMove = null;
    }
  }

  /** 换下钩子：再生力 / 自然回复 */
  function hookSwitchOut(ctx, unit) {
    if (!ctx || !ctx.state || !unit) return;
    var kinds = abilityKindsOf(unit);
    var p = abilityParams(unit, 'healOnSwitchOut');
    if (!p) return;
    if (p.healFraction) hookHeal(ctx, unit, num(p.healFraction, 0), unit.ability);
    if (p.cureStatus && unit.status !== 'ok' && unit.status !== 'fnt') hookCure(ctx, unit, unit.ability);
  }

  /** 出招前钩子：变幻自如 / 懒惰 / 一口导弹以外的出招限制 */
  function hookBeforeMove(ctx, unit, slot) {
    var st = ctx.state, move = slot && slot.move;
    if (!st || !unit) return { blocked: false };
    var kinds = abilityKindsOf(unit);
    for (var i = 0; i < kinds.length; i++) {
      var k = kinds[i];
      var p = abilityParams(unit, k) || {};
      if (k === 'typeChangeSelf' && move && move.type && unit.types.join('/') !== move.type) {
        unit.types = [move.type];
        addEntry(st, {
          turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
          notes: ['（' + unit.ability + '）'],
          text: unit.nickname + ' 的' + unit.ability + '把自身属性变成了' + move.type + '。'
        });
      } else if (k === 'goesLast' && move && condOk(p.when, unit, { ctx: ctx, move: move })) {
        ctx.forceLast = ctx.forceLast || {};
        ctx.forceLast[unit.side] = true;
      } else if (k === 'truant') {
        unit.__truant = !unit.__truant;
        if (unit.__truant) {
          addEntry(st, {
            turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
            notes: ['（懒惰）'], text: unit.nickname + ' 正在偷懒，无法行动！'
          });
          return { blocked: true };
        }
      }
    }
    return { blocked: false };
  }

  /** 命中前钩子：免疫 / 画皮 / 结实 / 我方保护类 */
  function hookTryHit(ctx, atkU, defU, move, slot) {
    var st = ctx.state;
    if (!st || !atkU || !defU || !move) return { blocked: false };
    atkU.__lastMove = move;
    /* 1. 属性/招式标记免疫（蓄电/储水/引火/防弹/隔音/黄金之躯…） */
    var imm = abilityImmunity(ctx.dex, defU, move, { ctx: ctx, attacker: atkU });
    if (imm) {
      var p = imm.params || {};
      if (p.onImmune && p.onImmune.healFraction) hookHeal(ctx, defU, num(p.onImmune.healFraction, 0.25), defU.ability);
      if (p.onImmune && p.onImmune.boost) hookBoost(ctx, defU, p.onImmune.boost, defU.ability);
      var txt = defU.nickname + ' 的' + defU.ability + '让' + move.zh + '无效了！';
      addEntry(st, {
        turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'move', move: move.zh,
        hit: true, immune: true, damage: 0, notes: ['（' + defU.ability + '）'], text: txt
      });
      return { blocked: true };
    }
    /* 2. 神奇守护：只有效果绝佳的招式才能造成伤害 */
    if (abilityHas(defU, 'wonderGuard') && move.category !== 'status') {
      var effW = ctx.dex.moveEff(move, defU.types);
      if (effW <= 1) {
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'move', move: move.zh,
          hit: true, immune: true, damage: 0, notes: ['（神奇守护）'],
          text: defU.nickname + ' 的神奇守护让' + move.zh + '无效了！'
        });
        return { blocked: true };
      }
    }
    /* 3. 画皮 / 冰冻头：一次性护盾 */
    if (num(defU.__shieldReady ? 1 : 0, 0) && abilityHas(defU, 'surviveKo')) {
      var p2 = abilityParams(defU, 'surviveKo') || {};
      if (p2.once && move.category !== 'status' && (!p2.onlyCategory || move.category === p2.onlyCategory)) {
        defU.__shieldReady = false;
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'move', move: move.zh,
          hit: true, immune: true, damage: 0, notes: ['（' + defU.ability + '）'],
          text: (p2.text || (defU.ability + '挡下了攻击')) + '！'
        });
        return { blocked: true };
      }
    }
    return { blocked: false };
  }

  /** 命中并造成伤害后的钩子：接触类 / 受击成长类 / 特殊状态 */
  function hookAfterDamagingHit(ctx, atkU, defU, move, damage, contact) {
    var st = ctx.state;
    if (!st || !defU || !atkU || defU.fainted) return;
    bindState(defU, st); bindState(atkU, st);
    var kinds = abilityKindsOf(defU);
    for (var i = 0; i < kinds.length; i++) {
      var k = kinds[i];
      var p = abilityParams(defU, k) || {};
      var env = { ctx: ctx, move: move, attacker: atkU, defender: defU };
      if (k === 'contactDamage') {
        if (!contact) continue;
        if (p.onlyOnFaint && !defU.fainted && num(defU.curHP, 0) > 0) continue;
        var cdCh = resolveChance(p, 'contactDamage');
        if (!cdCh) { warnMissingChance(ctx, defU, 'contactDamage'); continue; }
        if (!chanceHit(ctx, cdCh.chance)) continue;
        var frac = num(p.contactFraction, 0.125);
        var dmg = Math.max(1, Math.floor(num(atkU.maxHP, 1) * frac));
        atkU.curHP = Math.max(0, atkU.curHP - dmg);
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status', hpFrom: atkU.curHP + dmg, hpTo: atkU.curHP,
          notes: ['（' + defU.ability + '）'], text: defU.nickname + ' 的' + defU.ability + '让 ' + atkU.nickname + ' 受到了 ' + dmg + ' 点伤害！'
        });
        if (atkU.curHP <= 0) faintUnit(ctx, atkU);
      } else if (k === 'contactStatus') {
        if (!contact) continue;
        /* 火焰之躯 / 静电 / 毒刺：contactChance（数据表）→ chance（兼容写法）→ 官方 30% */
        var csCh = resolveChance(p, 'contactStatus');
        if (!csCh) { warnMissingChance(ctx, defU, 'contactStatus'); continue; }
        if (!(ctx.rng() * 100 < csCh.chance)) continue;
        hookStatus(ctx, atkU, ctx.dex.statusCode(p.contactStatus), defU.ability);
      } else if (k === 'contactStatusRandom') {
        if (!contact) continue;
        /* 孢子：按解析出的概率掷一次，并在候选异常里按比例分配（缺参数 → 跳过并记日志） */
        var crCh = resolveChance(p, 'contactStatusRandom');
        if (!crCh) { warnMissingChance(ctx, defU, 'contactStatusRandom'); continue; }
        var r = ctx.rng() * 100;
        if (!(r < crCh.chance)) continue;
        var codes = (p.statuses || []).map(function (x) { return ctx.dex.statusCode(x); });
        /* 官方 30% 基准下三种异常的切分是 11% / 10% / 9%；这里按解析出的概率等比缩放，
         * chance=30 时与旧口径完全一致（不改变既有行为）。 */
        var scale = crCh.chance / 30;
        var pick = r < 11 * scale ? codes[0] : (r < 21 * scale ? codes[1] : (r < 30 * scale ? codes[2] : null));
        if (pick) hookStatus(ctx, atkU, pick, defU.ability);
      } else if (k === 'contactVolatile') {
        if (!contact) continue;
        /* 迷人之躯：chance（数据表）→ contactChance（兼容写法）→ 官方 30% */
        var cvCh = resolveChance(p, 'contactVolatile');
        if (!cvCh) { warnMissingChance(ctx, defU, 'contactVolatile'); continue; }
        if (!(ctx.rng() * 100 < cvCh.chance)) continue;
        atkU.volatile[p.volatile || '着迷'] = 2;
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status',
          notes: ['（' + defU.ability + '）'], text: atkU.nickname + ' 陷入了' + (p.volatile || '着迷') + '！'
        });
      } else if (k === 'contactStatLower' || k === 'contactStatLowerAll') {
        if (!contact) continue;
        var clCh = resolveChance(p, k);
        if (!clCh) { warnMissingChance(ctx, defU, k); continue; }
        if (!chanceHit(ctx, clCh.chance)) continue;      /* 官方默认「接触即生效」= 100 */
        var targets = (k === 'contactStatLowerAll') ? fieldUnits(st).filter(function (u) { return u !== defU; }) : [atkU];
        for (var t = 0; t < targets.length; t++) hookBoost(ctx, targets[t], p.boost || { spe: -1 }, defU.ability);
      } else if (k === 'contactAbilitySwap') {
        if (!contact) continue;
        var caCh = resolveChance(p, 'contactAbilitySwap');
        if (!caCh) { warnMissingChance(ctx, defU, 'contactAbilitySwap'); continue; }
        if (!chanceHit(ctx, caCh.chance)) continue;
        var srcAbility = atkU.ability;
        if (p.swap) { atkU.ability = defU.ability; defU.ability = srcAbility; }
        else { atkU.ability = p.to; }
        atkU.abilityMeta = ctx.dex.lookupAbility(atkU.ability);
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status',
          notes: ['（' + defU.ability + '）'],
          text: defU.nickname + ' 的' + ((p && p.to) || '游魂') + '：' + atkU.nickname + ' 的特性变成了「' + atkU.ability + '」。'
        });
      } else if (k === 'contactPerish') {
        if (!contact) continue;
        var cpCh = resolveChance(p, 'contactPerish');
        if (!cpCh) { warnMissingChance(ctx, defU, 'contactPerish'); continue; }
        if (!chanceHit(ctx, cpCh.chance)) continue;      /* 灭亡之躯：官方「接触即生效」 */
        atkU.volatile['灭亡之歌'] = 3; defU.volatile['灭亡之歌'] = 3;
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status',
          notes: ['（灭亡之躯）'], text: defU.nickname + ' 的灭亡之躯：双方 3 回合后都会倒下！'
        });
      } else if (k === 'afterDamagingHit') {
        if (p.when && !condOk(p.when, defU, env)) continue;
        if (p.contact && !contact) continue;
        if (p.boost) hookBoost(ctx, defU, p.boost, defU.ability);
        if (p.charge) {
          defU.volatile['充电'] = 2;
          addEntry(st, {
            turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status',
            notes: ['（' + defU.ability + '）'], text: defU.nickname + ' 进入充电状态，下一发电属性招式威力翻倍。'
          });
        }
        if (p.status) {
          /* 毒手 30 / 毒锁链 30 / 辣椒喷发 100：**每个特性都不同，没有 kind 级默认** ——
           * 表里没写 chance 就跳过并记日志（绝不再按 100% 静默执行）。 */
          var ahCh = resolveChance(p, 'afterDamagingHit');
          if (!ahCh) {
            warnMissingChance(ctx, defU, 'afterDamagingHit');
          } else if (chanceHit(ctx, ahCh.chance)) {
            hookStatus(ctx, atkU, ctx.dex.statusCode(p.status), defU.ability);
          }
        }
        if (p.setWeather) hookWeather(ctx, p.setWeather, defU.ability);
        if (p.setTerrain) hookTerrain(ctx, p.setTerrain, defU.ability);
        if (p.setToxicSpikes) {
          st.meta.toxicSpikes = toInt(st.meta.toxicSpikes, 0) + 1;
          addEntry(st, {
            turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status',
            notes: ['（毒满地）'], text: defU.nickname + ' 的毒满地：在对手场地撒下了毒菱。'
          });
        }
      } else if (k === 'disableMove') {
        /* 诅咒之躯：chance（数据表）→ contactChance（兼容写法）→ 官方 30% */
        var dmCh = resolveChance(p, 'disableMove');
        if (!dmCh) { warnMissingChance(ctx, defU, 'disableMove'); continue; }
        if (!(ctx.rng() * 100 < dmCh.chance)) continue;
        var slot = findSlot(atkU, move.zh);
        if (slot) slot.disabled = 2;
        addEntry(st, {
          turn: ctx.turn, actor: defU.side, actorName: defU.nickname, kind: 'status',
          notes: ['（诅咒之躯）'], text: defU.nickname + ' 的诅咒之躯：' + move.zh + ' 被封锁了！'
        });
      } else if (k === 'syncStatus') {
        /* 同步在「被上异常」时记录，见 hookStatusInflicted */
      }
    }
    /* 攻方特性：吸血类/接触类反伤之外的攻方受击成长 */
    var akinds = abilityKindsOf(atkU);
    for (var m = 0; m < akinds.length; m++) {
      if (akinds[m] !== 'afterDamagingHit') continue;
      var ap = abilityParams(atkU, 'afterDamagingHit') || {};
      var aenv = { ctx: ctx, move: move, attacker: atkU, defender: defU };
      if (ap.when && !condOk(ap.when, atkU, aenv)) continue;
      /* 毒手这类「接触类招式才触发」的，非接触招式不掷骰（官方语义） */
      if (ap.contact && !contact) continue;
      if (ap.charge) {
        atkU.volatile['充电'] = 2;
        addEntry(st, {
          turn: ctx.turn, actor: atkU.side, actorName: atkU.nickname, kind: 'status',
          notes: ['（' + atkU.ability + '）'], text: atkU.nickname + ' 进入充电状态，下一发电属性招式威力翻倍。'
        });
      }
      if (ap.boost && ap.when && ap.when.moveTypes) hookBoost(ctx, atkU, ap.boost, atkU.ability);
      if (ap.status) {
        var apCh = resolveChance(ap, 'afterDamagingHit');
        if (!apCh) {
          warnMissingChance(ctx, atkU, 'afterDamagingHit');
        } else if (chanceHit(ctx, apCh.chance)) {
          hookStatus(ctx, defU, ctx.dex.statusCode(ap.status), atkU.ability);
        }
      }
    }
  }

  /** 异常状态被成功施加后的钩子：同步特性把状态弹回去 */
  function hookStatusInflicted(ctx, target, source, code) {
    if (!target || !source) return;
    var p = abilityParams(target, 'syncStatus');
    if (!p) return;
    if (['brn', 'psn', 'tox', 'par'].indexOf(code) < 0) return;
    target.__syncBack = target.__syncBack || [];
    if (target.__syncBack.indexOf(source) < 0) target.__syncBack.push(source);
  }

  /** 能力被下降时的钩子：好胜 / 不服输 / 镜甲 */
  function hookStatLowered(ctx, target, source, changed) {
    if (!ctx || !ctx.state || !target || !changed) return;
    var p = abilityParams(target, 'onStatLowered');
    if (p) hookBoost(ctx, target, p.boost || {}, target.ability);
    if (abilityHas(target, 'reflectStatDrop') && source && source !== target) {
      var back = {};
      Object.keys(changed).forEach(function (k) { if (changed[k] < 0) back[k] = changed[k]; });
      if (Object.keys(back).length) hookBoost(ctx, source, back, '镜甲');
    }
  }

  /** 击倒对手后的钩子：自信过度 / 异兽提升 / 嘶鸣 */
  function hookOnKo(ctx, atkU, defU) {
    if (!ctx || !ctx.state || !atkU || atkU.fainted) return;
    var kinds = abilityKindsOf(atkU);
    for (var i = 0; i < kinds.length; i++) {
      if (kinds[i] !== 'on_ko') continue;
      var p = abilityParams(atkU, 'on_ko') || {};
      if (p.bestStat) {
        var stats = ['atk', 'def', 'spa', 'spd', 'spe'];
        var best = stats[0];
        for (var s = 1; s < stats.length; s++) if (num(atkU.stats[stats[s]], 0) > num(atkU.stats[best], 0)) best = stats[s];
        var b = {}; b[best] = 1;
        hookBoost(ctx, atkU, b, atkU.ability);
      } else if (p.boost) {
        hookBoost(ctx, atkU, p.boost, atkU.ability);
      }
    }
  }
  /** 场上任何单位濒死时的钩子：魂心 */
  function hookOnAnyFaint(ctx, deadUnit) {
    if (!ctx || !ctx.state) return;
    var units = fieldUnits(ctx.state);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u || u === deadUnit) continue;
      if (u.side === (deadUnit && deadUnit.side)) { /* 敌我双方的倒下都算，正作里魂心是场上任意单位倒下 */ }
      var p = abilityParams(u, 'onAnyFaint');
      if (p && p.boost) hookBoost(ctx, u, p.boost, u.ability);
      if (abilityHas(u, 'on_ko') && false) { /* on_ko 只在自己击倒时触发 */ }
    }
    /* 大将：记录已倒下同伴数 */
    var st = ctx.state;
    fieldUnits(st).forEach(function (u) {
      if (abilityParams(u, 'damageBound') && abilityParams(u, 'damageBound').fallenScale) {
        u.__fallen = toInt(u.__fallen, 0) + (deadUnit && deadUnit.side === u.side ? 1 : 0);
      }
    });
  }
  /** 濒死时钩子：飞出的内在物 */
  function hookOnFaint(ctx, unit, killer) {
    if (!ctx || !ctx.state || !unit || !killer) return;
    var p = abilityParams(unit, 'on_faint');
    if (p && p.reflectDamage) {
      var lost = Math.max(0, num(unit.maxHP, 0) - num(unit.curHP, 0));
      var amount = Math.max(1, lost || Math.floor(num(unit.maxHP, 1) / 4));
      killer.curHP = Math.max(0, num(killer.curHP, 0) - amount);
      addEntry(ctx.state, {
        turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
        notes: ['（飞出的内在物）'],
        text: unit.nickname + ' 的飞出的内在物让 ' + killer.nickname + ' 受到了 ' + amount + ' 点伤害！'
      });
      if (killer.curHP <= 0) faintUnit(ctx, killer);
    }
  }


  /* ===========================================================================
   * §3 伤害与判定
   * ======================================================================== */

  /**
   * 单次伤害（契约 §5.3）：
   *   base = floor(floor(floor((2*等级)/5 + 2) * 威力 * 攻击 / 防御) / 50) + 2
   *   最终 = floor(base * 随机(0.85~1.0) * 暴击(1或1.5) * STAB(1或1.5) * 属性相性 * 天气)
   *   属性相性为 0 → 伤害 0；否则最低 1。
   * 参数 rng 每次伤害只消费 1 个随机数（随机项）。
   * ctx 可选：带上口胡通道的 威力倍率/伤害倍率（契约 10.2）。
   */
  /* ===== 契约 10.30：场地（terrain）与入场钉子（hazards）=====
     数据表里这些招式只有说明文字、没有结构化字段，所以按**招式名**做表。 */
  var FIELD_TERRAIN_MOVES = { '电气场地': '电气场地', '精神场地': '精神场地', '薄雾场地': '薄雾场地', '青草场地': '青草场地' };
  var FIELD_WEATHER_MOVES = { '大晴天': '大晴天', '求雨': '下雨', '沙暴': '沙暴', '冰雹': '冰雹' };
  var FIELD_HAZARD_MOVES = { '隐形岩': '隐形岩', '撒菱': '撒菱', '毒菱': '毒菱', '黏黏网': '黏黏网' };
  /* 折返类招式（契约 10.45）：打完在**该行动位**立即换人，不消耗回合 */
  var PIVOT_MOVES = { '急速折返': 1, '伏特替换': 1, '抛下狠话': 1, '接棒': 1, '快速折返': 1, '断尾': 1, '冷笑话': 1 };  /* 契约 10.93：按数据表实际名字 */
  /* 天气招式按**招式名**生效（数据表里这些招式只有 effectNote 说明文字，没有 weather 字段，
     所以只能靠名字映射；名字用引擎自己的口径：雨 / 大晴天 / 沙暴 / 冰雹） */
  var WEATHER_OF_MOVE = {
    '大晴天': '大晴天', '放晴': '大晴天', '晴朗': '大晴天', '日照': '大晴天',
    '求雨': '雨', '雨天': '雨', '下雨': '雨', '祈雨': '雨',
    '沙暴': '沙暴', '扬沙': '沙暴', '沙尘暴': '沙暴',
    '冰雹': '冰雹', '下雪': '冰雹', '暴雪': '冰雹'
  };
  var TERRAIN_TYPE_BOOST = { '电气场地': '电', '青草场地': '草', '精神场地': '超能力', '薄雾场地': '妖精' };

  function terrainOf(state) { return (state && state.battle && state.battle.__terrain) || ''; }

  /** 是不是"站在地面上"：飞行属性与飘浮特性不算（挖洞等状态暂不建模） */
  function isGrounded(unit) {
    if (!unit) return false;
    var types = Array.isArray(unit.types) ? unit.types : [];
    if (types.indexOf('飞行') >= 0) return false;
    if (unit.ability === '飘浮') return false;
    return true;
  }

  function hazardsOf(state, side) {
    if (!state || !state.battle) return null;
    if (!state.battle.__hazards) state.battle.__hazards = { ally: {}, foe: {} };
    if (!state.battle.__hazards[side]) state.battle.__hazards[side] = {};
    return state.battle.__hazards[side];
  }

  function fieldLog(ctx, side, name, text, kind) {
    try {
      addEntry(ctx.state, {
        turn: toInt(ctx.turn, 0), actor: side || 'ally', actorName: name || '场地',
        kind: kind || 'status', notes: [text], text: text
      });
    } catch (e) { /* 日志失败不影响结算 */ }
  }

  /** 变化招式的场地/天气/钉子效果；返回 true 表示这一招已被这里处理（不再走伤害流程） */
  function applyFieldMove(ctx, side, unit, slot) {
    if (!ctx || !ctx.state || !unit || !slot) return false;
    var nm = String((slot.move && (slot.move.zh || slot.move.name)) || slot.name || '');
    if (!nm) return false;
    if (FIELD_TERRAIN_MOVES[nm]) {
      var t = FIELD_TERRAIN_MOVES[nm];
      if (terrainOf(ctx.state) === t) {
        fieldLog(ctx, side, unit.nickname, unit.nickname + ' 使用了' + nm + '，但场地已经是' + t + '了！');
      } else {
        hookTerrain(ctx, t, unit.nickname);
      }
      return true;
    }
    /* 天气招式引擎已有实现（求雨→雨 等），这里不再重复处理，避免覆盖成别的名字 */
    if (WEATHER_OF_MOVE[nm]) {
      var __w = WEATHER_OF_MOVE[nm];
      if (String(ctx.state.battle.weather || '') === __w) {
        fieldLog(ctx, side, unit.nickname, unit.nickname + ' 使用了' + nm + '，但是天气没有变化……');
      } else {
        hookWeather(ctx, __w, unit.nickname);
      }
      return true;
    }
    if (FIELD_HAZARD_MOVES[nm]) {
      var hz = FIELD_HAZARD_MOVES[nm];
      /* 钉子下在**对方**半场（target: foeSide） */
      var tgtSide = (side === 'foe') ? 'ally' : 'foe';
      var box = hazardsOf(ctx.state, tgtSide);
      if (!box) return true;
      var layers = toInt(box[hz], 0);
      var maxLayers = (hz === '撒菱' || hz === '毒菱') ? 3 : 1;
      if (layers >= maxLayers) {
        fieldLog(ctx, side, unit.nickname, unit.nickname + ' 使用了' + nm + '，但是好像没有效果……');
        return true;
      }
      box[hz] = layers + 1;
      var extra = (hz === '撒菱' || hz === '毒菱') ? ('（第 ' + box[hz] + ' 层）') : '';
      fieldLog(ctx, side, unit.nickname, unit.nickname + ' 在对手场上布下了' + nm + '！' + extra);
      return true;
    }
    return false;
  }

  /** 入场钉子结算（换人/上场时调用；第一只首发按官方口径不踩钉子以外的判定） */
  function applyEntryHazards(ctx, unit) {
    /* 契约 10.87：**厚底靴** —— 踩不到任何入场钉子（隐形岩/撒菱/毒菱/黏黏网） */
    try { var __db = itemDefOf(unit); if (__db && __db.immuneHazards) return; } catch (eDb) { }

    if (!ctx || !ctx.state || !unit || unit.fainted) return;
    var side = (unit.side === 'foe') ? 'foe' : 'ally';
    var box = hazardsOf(ctx.state, side);
    if (!box) return;
    var maxHP = num(unit.maxHP, 0);
    if (maxHP <= 0) return;
    var grounded = isGrounded(unit);
    var effTo = function (type) {
      try { return num(ctx.dex.moveEff({ type: type }, unit.types || []), 1); } catch (e) { return 1; }
    };
    var hurt = 0;
    if (toInt(box['隐形岩'], 0) > 0) {
      var e = effTo('岩石');
      if (e > 0) {
        var d1 = Math.max(1, Math.floor(maxHP / 8 * e));
        unit.curHP = Math.max(0, num(unit.curHP, 0) - d1);
        hurt += d1;
        fieldLog(ctx, side, unit.nickname, '尖锐的岩石刺入了 ' + unit.nickname + '！（-' + d1 + '）');
      }
    }
    if (toInt(box['撒菱'], 0) > 0 && grounded) {
      var lv = Math.min(3, toInt(box['撒菱'], 1));
      var frac = lv === 1 ? 1 / 8 : (lv === 2 ? 1 / 6 : 1 / 4);
      var d2 = Math.max(1, Math.floor(maxHP * frac));
      unit.curHP = Math.max(0, num(unit.curHP, 0) - d2);
      hurt += d2;
      fieldLog(ctx, side, unit.nickname, unit.nickname + ' 被撒菱刺伤了！（-' + d2 + '）');
    }
    if (toInt(box['毒菱'], 0) > 0 && grounded && unit.status === 'ok') {
      var types = Array.isArray(unit.types) ? unit.types : [];
      if (types.indexOf('毒') < 0 && types.indexOf('钢') < 0) {
        var code = toInt(box['毒菱'], 1) >= 2 ? 'tox' : 'psn';
        try {
          if (canApplyStatus(ctx.dex, { type: '毒' }, unit, code)) {
            setStatus(unit, code, ctx);
            fieldLog(ctx, side, unit.nickname, unit.nickname + ' 中了毒菱的毒！');
          }
        } catch (e) { /* 状态接口不可用时忽略 */ }
      }
    }
    if (toInt(box['黏黏网'], 0) > 0 && grounded) {
      try {
        applyStages(unit, { spe: -1 });
        fieldLog(ctx, side, unit.nickname, unit.nickname + ' 被黏黏网缠住了，速度下降！');
      } catch (e) { /* 忽略 */ }
    }
    /* 注意：**不要**往 场地效果 写对象 —— 卡的 schema 是 record<string,string>，
       写对象会让整份变量校验失败、变量从此不再更新（真机实测"战斗不渲染"）。
       钉子状态留在 __hazards，展示走日志。 */
    if (hurt > 0 && num(unit.curHP, 0) <= 0) {
      unit.fainted = true;
      fieldLog(ctx, side, unit.nickname, unit.nickname + ' 被入场钉子击倒了！');
    }
    /* 不再把 string 写进「场地效果」：卡的 schema 要求记录型(对象)，写字符串会被形状自检拦截，
       连带整次变量写回失败（真机报错原文）。场地/钉子状态留在 __terrain / __hazards，展示走日志。 */
  }

  /* 契约 10.216（真机根因）：体重函数必须与 __calcDamageBase **同一作用域** ✓
     —— 原来它被插在另一个函数内部 ✗ → 调用时 ReferenceError 被 try/catch 静默吞掉 ✗
        → 打草结永远 0 伤害 ✓（真机 ✓） */
  /** 契约 10.119：种族名 → 体重(kg)。从 pokedex 懒加载（紧凑数据里带 体重 字段） */
  var __WEIGHT_MAP = null;
  function weightOfSpecies(dex, name) {
    try {
      if (__WEIGHT_MAP === null) {
        var __sp = null;
        try { __sp = dex.species(name); } catch (e) { }
      }
    } catch (eP2) { }
    if (__WEIGHT_MAP === null) {
      __WEIGHT_MAP = {};
      try {
        var px = (dex && dex.pokedex) || (typeof DATA !== 'undefined' && DATA && DATA.pokedex) || null;
        var arr = Array.isArray(px) ? px : (px && typeof px === 'object' ? Object.keys(px).map(function (k) { return px[k]; }) : []);
        arr.forEach(function (e) {
          if (!e) return;
          var nm = String(e.zh || e.name || '');
          var wt = e.体重 !== undefined ? e.体重 : (e.weight !== undefined ? e.weight : undefined);
          var n = parseFloat(String(wt));
          if (nm && isFinite(n) && n > 0) __WEIGHT_MAP[nm] = n;
        });
      } catch (eW) { }
    }
    return __WEIGHT_MAP[String(name || '')] || 0;
  }
  function weightBasedPower(dex, move, atkU, defU) {
    var nm = String((move && (move.zh || move.name)) || '');
    if (!nm) return 0;
    var tW = weightOfSpecies(dex, defU && (defU.species || defU.speciesZh || defU.nickname));
    if (!tW) return 0;
    if (nm === '打草结' || nm === '低踢' || nm === '踢倒') {
      if (tW < 10) return 20;
      if (tW < 25) return 40;
      if (tW < 50) return 60;
      if (tW < 100) return 80;
      if (tW < 200) return 100;
      return 120;
    }
    if (nm === '重磅冲撞' || nm === '高温重压') {
      var uW = weightOfSpecies(dex, atkU && (atkU.species || atkU.speciesZh || atkU.nickname)) || 0;
      if (!uW) return 0;
      var ratio = uW / tW;
      if (ratio >= 5) return 120;
      if (ratio >= 4) return 100;
      if (ratio >= 3) return 80;
      if (ratio >= 2) return 60;
      return 40;
    }
    return 0;
  }
  function __calcDamageBase(dex, atkU, defU, move, crit, rng, weather, ctx, spreadScale) {
    /* 契约 10.97：招式对象可能缺失（数据表查不到/槽位未识别）→ 兜成 {}，避免读属性崩溃 */
    move = move || {};
    var w = weather === undefined ? (atkU.__weather || '晴') : weather;
    var aCtx = ctx || { state: null, attacker: atkU, defender: defU, move: move };
    if (!aCtx.attacker) aCtx.attacker = atkU;
    if (!aCtx.defender) aCtx.defender = defU;
    if (!aCtx.move) aCtx.move = move;
    /* 特性可能改写招式属性（皮肤类/湿润之声）：相性按改写后的属性算 */
    var atkType = effectiveMoveType(atkU, move);
    var move2 = atkType !== move.type ? shallowMoveWithType(move, atkType) : move;
    var eff = dex.moveEff(move2, defU.types);
    /* 胆量/心眼：一般与格斗招式可以打到幽灵 */
    if (eff === 0 && abilityHas(atkU, 'ignoreTypeImmunity')) {
      var ig = abilityParams(atkU, 'ignoreTypeImmunity') || {};
      if ((ig.types || []).indexOf(atkType) >= 0 && defU.types.indexOf('幽灵') >= 0) {
        eff = dex.moveEff(move2, defU.types.filter(function (t) { return t !== '幽灵'; }));
        if (eff === 0) eff = 1;
      }
    }
    var A = effAtk(atkU, move.category, move, aCtx, crit);   /* [天梯补丁 05] */
    var D = effDef(defU, move.category, crit, move, aCtx);
    var power = num(move.power, 0);
    var powerMult = (ctx && ctx.state) ? improvMult(ctx.state, atkU, '威力倍率', 1) : 1;
    if (power > 0) powerMult *= abilityPowerMult(aCtx, atkU, defU, move);
    if (power > 0) powerMult *= allyBasePowerMult(aCtx, atkU, move);
    /* 充电状态（电力转换/风力发电）：下一发电属性招式威力翻倍 */
    if (power > 0 && atkType === '电' && atkU.volatile && toInt(atkU.volatile['充电'], 0) > 0) {
      powerMult *= 2;
      delete atkU.volatile['充电'];
    }
    var effPower = power * powerMult;
    /* 契约 10.217：**按体重算威力（内联版）** —— 打草结/低踢/踢倒/重磅冲撞/高温重压
       数据里 power 为空 ✗ → 必须在下面那个 return 之前补上 ✓
       （原来我写成外部函数 ✗ → 作用域不对 → ReferenceError 被 try/catch 吞掉 → 永远 0 伤害 ✓） */
    try {
      if (power <= 0 && move) {
        var __nmW = String(move.zh || move.name || '');
        if (__nmW === '打草结' || __nmW === '低踢' || __nmW === '踢倒' || __nmW === '重磅冲撞' || __nmW === '高温重压') {
          var __px = (typeof DATA !== 'undefined' && DATA && Array.isArray(DATA.pokedex)) ? DATA.pokedex : [];
          /* 契约 10.218：体重来自 **dex.species(名).weight** ✓
             （真机探针：dex.species('帝牙海狮') = {…, weight:150.6} ✓；DATA.pokedex 在引擎里不存在 ✗） */
          var __wOf = function (nm2) {
            var s3 = String(nm2 || '');
            if (!s3) return 0;
            try {
              var __sp2 = dex.species ? dex.species(s3) : null;
              var __w2 = __sp2 && (__sp2.weight !== undefined ? __sp2.weight : __sp2.体重);
              var __n2 = parseFloat(String(__w2 === undefined ? '' : __w2));
              if (isFinite(__n2) && __n2 > 0) return __n2;
            } catch (eSp2) { }
            return 0;
          };
          var __tW = __wOf(defU && (defU.speciesZh || defU.species || defU.nickname));
          if (__tW > 0) {
            if (__nmW === '打草结' || __nmW === '低踢' || __nmW === '踢倒') {
              power = __tW < 10 ? 20 : __tW < 25 ? 40 : __tW < 50 ? 60 : __tW < 100 ? 80 : __tW < 200 ? 100 : 120;
            } else {
              var __uW = __wOf(atkU && (atkU.speciesZh || atkU.species || atkU.nickname));
              if (__uW > 0) { var __rr = __uW / __tW; power = __rr >= 5 ? 120 : __rr >= 4 ? 100 : __rr >= 3 ? 80 : __rr >= 2 ? 60 : 40; }
            }
            if (power > 0) effPower = power * powerMult;
          } else {
          }
        }
      }
    /* 契约 10.215（真机根因）：**按体重算威力的招式**（打草结/低踢/踢倒/重磅冲撞/高温重压）
       —— 数据表里这些招式 power 为空 ✗ → 到这里就 return 0 伤害 ✗（真机：打草结"效果绝佳"但 0 伤害 ✓）
       所以在**这个提前返回之前**先把威力补上 ✓（原来我写在外层包装里 ✗，根本走不到 ✓） */
    try {
      var __wbp = weightBasedPower(dex, move, atkU, defU);
      if (__wbp > 0 && power <= 0) { power = __wbp; effPower = power * powerMult; }
    } catch (eWbp) { }
    } catch (eW217) { }
    if (power <= 0 && (!move || move.fixedDamage !== 'level') && !(move && move.ohko)) return { damage: 0, eff: eff, crit: !!crit };
    /* 口胡把威力倍率压到 0（下限 0.1×条目数）时视为无威力 */
    if (power > 0 && effPower <= 0) return { damage: 0, eff: eff, crit: !!crit };
    var base = Math.floor(Math.floor(Math.floor((2 * atkU.level) / 5 + 2) * effPower * A / D) / 50) + 2;
    var rand = 0.85 + 0.15 * rng();   /* 契约 10.23：官方随机项 0.85~1.0（原来直接用 [0,1)，期望掉 46%、小值被 Math.max(1,…) 兜成 1 点） */
    var dmg = base * rand;
    if (crit) dmg *= 1.5;
    if (atkU.types.indexOf(atkType) >= 0) dmg *= 1.5;                  /* STAB（按改写后的属性） */
    dmg *= abilityStabMult(atkU, atkType);                             /* 适应力 */
    dmg *= eff;                                                        /* 属性相性 */
    dmg *= weatherMul(w, atkType);                                     /* 天气 */
    /* 场地加成（契约 10.30）：站在地面上的攻方，对应属性 ×1.3；青草场地削弱 地震/重踏/大地之力 */
    var __terr = (ctx && ctx.state) ? terrainOf(ctx.state) : '';
    if (__terr) {
      var __bt = TERRAIN_TYPE_BOOST[__terr];
      if (__bt && atkType === __bt && isGrounded(atkU)) dmg *= 1.3;
      if (__terr === '青草场地' && isGrounded(defU) &&
          /^(?:地震|重踏|大地之力)$/.test(String((move2 && (move2.zh || move2.name)) || ''))) dmg *= 0.5;
    }
    dmg *= abilityDamageMult(aCtx, atkU, defU, move2, { crit: !!crit, eff: eff });   /* 攻方特性（狙击手/有色眼镜/脑核之力/气场） */
    dmg *= abilityTakenMult(aCtx, defU, atkU, move2, { crit: !!crit, eff: eff });    /* 守方特性（多重鳞片/厚脂肪/过滤…） */
    if (ctx && ctx.state) {
      dmg *= improvMult(ctx.state, atkU, '伤害倍率', 1);                /* 口胡：攻方伤害倍率 */
      dmg *= improvMult(ctx.state, defU, '伤害减免', 1);                /* 口胡：守方伤害减免 */
      dmg *= allyDamageTakenMult(ctx.state, defU);                     /* 友人防守（双打） */
    }
    /* 阶段 A：群体招式命中多个目标时，每个目标 ×0.75（官方口径） */
    if (spreadScale !== undefined && spreadScale !== null && spreadScale !== 1) dmg *= num(spreadScale, 1);
    if (eff === 0) return { damage: 0, eff: eff, crit: !!crit };
    return { damage: Math.max(1, Math.floor(dmg)), eff: eff, crit: !!crit };
  }

  /** 适应力：属性一致加成从 1.5 提升到 2 */
  function abilityStabMult(atkU, atkType) {
    var p = abilityParams(atkU, 'modify_stab');
    if (!p) return 1;
    if (atkU.types.indexOf(atkType) < 0) return 1;
    return num(p.mult, 1.5) / 1.5;
  }

  /** 以不同属性复制一份招式对象（不改数据表里的原对象） */
  function shallowMoveWithType(move, type) {
    var out = {};
    var keys = Object.keys(move);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = move[keys[i]];
    out.type = type;
    out.__origType = move.type;
    return out;
  }

  /**
   * 天气倍率（用户裁决的天气口径）：
   *   雨（含「下雨」「大雨」等含「雨」的文本）→ 水 ×1.5、火 ×0.5
   *   大晴天 / 日照强烈（官方大晴天口径）→ 火 ×1.5、水 ×0.5
   *   普通「晴 / 晴天」→ **没有任何战斗效果**（早先按大晴天算，等于把平时的水系砍了一半）
   */
  function weatherMul(weather, moveType) {
    var w = String(weather || '');
    if (/雨/.test(w)) { if (moveType === '水') return 1.5; if (moveType === '火') return 0.5; }
    if (/大晴天|日照强烈|大日照/.test(w)) { if (moveType === '火') return 1.5; if (moveType === '水') return 0.5; }
    return 1;
  }

  /** 命中判定：accuracy === null 必中；命中率 100 恒中；<100 时 rng()*100 < 命中率（含口胡命中修正与特性修正） */
  function hitRoll(dex, move, rng, atkU, defU, ctx) {
    if (!move) return true;
    if (move.accuracy === null || move.accuracy === undefined) return true;
    var acc = num(move.accuracy, 100);
    /* 契约 10.121：重力 —— 命中率 ×5/3（官方为 6840/4096 ≈ 1.67） */
    try {
      var __stG = ctx && ctx.state;
      if (__stG && toInt(__stG.__gravity, 0) > 0) acc = Math.min(100, acc * 5 / 3);
    } catch (eGr) { }
    /* 契约 10.87：光粉 —— 守方持有则命中率 ×0.9 */
    try { var __bp = itemDefOf(defU); if (__bp && __bp.foeAccMult) acc = acc * __bp.foeAccMult; } catch (eBp) { }
    var improvAcc = 0;
    if (ctx && ctx.state) improvAcc = improvMult(ctx.state, atkU, '命中修正', 0) - improvMult(ctx.state, defU, '命中修正', 0);
    /* 特性命中修正：复眼/活力/沙隐/雪隐/蹒跚/奇迹皮肤/胜利之星（同伴） */
    acc *= abilityAccuracyMult(atkU, defU, move, ctx);
    if (ctx && ctx.state) acc *= allyAccuracyMult(ctx.state, atkU);
    acc += abilityAccuracyAdd(atkU, defU, move, ctx);
    /* 无防守 / 心眼：无视自身命中与对手闪避阶级 */
    var ignoreEvasion = abilityHas(atkU, 'noMiss') || abilityIgnoresEvasion(atkU);
    var atkAccStage = toInt(atkU.stages.acc, 0);
    var defEvaStage = ignoreEvasion ? 0 : toInt(defU.stages.eva, 0);
    /* 奇迹皮肤把变化招式的命中率固定为 50（在 acc 上直接改） */
    var setAcc = abilitySetAccuracy(defU, move, ctx);
    if (setAcc !== null) acc = setAcc;
    if (acc >= 100 && atkAccStage >= 0 && defEvaStage <= 0 && improvAcc === 0) return true;
    var stage = clamp(atkAccStage - defEvaStage, -6, 6);
    var finalAcc = clamp(acc * stageMul(stage) + improvAcc, 0, 100);
    if (finalAcc >= 100) return true; /* 满命中后不再消费随机数，保证测试可预期 */
    return rng() * 100 < finalAcc;
  }

  /** 攻方特性对命中率的倍率（复眼 1.3 / 活力 0.8 / 沙隐雪隐 0.8 / 蹒跚 0.5） */
  function abilityAccuracyMult(atkU, defU, move, ctx) {
    var mult = 1;
    var pa = abilityParams(atkU, 'modify_accuracy');
    if (pa && condOk(pa.when, atkU, { ctx: ctx, move: move, attacker: atkU, defender: defU })) {
      mult *= num(pa.accuracyMult, 1);
      if (pa.setAccuracy !== undefined) { /* 见 abilitySetAccuracy */ }
    }
    return mult;
  }
  /** 守方特性把招式命中率固定为某值（奇迹皮肤→50） */
  function abilitySetAccuracy(defU, move, ctx) {
    var p = abilityParams(defU, 'modify_accuracy');
    if (!p || p.setAccuracy === undefined) return null;
    if (!condOk(p.when, defU, { ctx: ctx, move: move, defender: defU })) return null;
    return num(p.setAccuracy, 50);
  }
  function abilityAccuracyAdd(atkU, defU, move, ctx) { return 0; }
  /** 心眼/锐利目光/发光：无视对手闪避阶级 */
  function abilityIgnoresEvasion(unit) {
    var kinds = abilityKindsOf(unit);
    if (kinds.indexOf('ignoreTypeImmunity') < 0) return false;
    return hasAbility(unit, '心眼');
  }

  /** 暴击判定：1/24（契约 §5.3）；超幸运/不仁不义提升暴击等级，硬壳盔甲/战斗盔甲免疫 */
  function critRoll(rng) { return rng() < (1 / 24); }
  function critRollFor(dex, atkU, defU, move, rng, ctx) {
    /* 契约 10.96：幸运咒语 —— 该半场不会被击中要害 */
    try {
      var __stLc = ctx && ctx.state;
      if (__stLc && __stLc.screens) {
        var __isAlL = (Array.isArray(__stLc.battle.allies) && __stLc.battle.allies.indexOf(defU) >= 0);
        var __scL = __stLc.screens[__isAlL ? 'ally' : 'foe'];
        if (__scL && __scL['幸运咒语']) return 0;
      }
    } catch (eLc) { }

    if (critImmune(defU)) return false;
    var bonus = abilityCritBonus(atkU, defU, ctx);
    var ratio = 1 / 24;
    for (var i = 0; i < bonus; i++) ratio *= 2;
    return rng() < ratio;
  }

  /** 一击必杀判定：命中率 = 30 + (攻方等级 - 守方等级)，钳制 1~100（简化） */
  function ohkoAcc(atkU, defU) { return clamp(30 + (atkU.level - defU.level), 1, 100); }

  /** 异常状态能否上（简化免疫规则 + 特性免疫） */
  function canApplyStatus(dex, move, target, code) {
    /* 场地免疫（契约 10.30）：电气场地→地面上的不会睡眠；薄雾场地→地面上的不会陷入异常 */
    try {
      var __st = target && target.__state;
      var __tr = __st ? terrainOf(__st) : '';
      if (__tr && isGrounded(target)) {
        if (__tr === '电气场地' && (code === 'slp' || code === '睡眠')) return false;
        if (__tr === '薄雾场地') return false;
      }
    } catch (e) { /* 忽略 */ }

    if (target.fainted) return false;
    if (target.status !== 'ok') return false;                     /* 已有异常状态不再叠加 */
    /* 特性免疫（免疫/柔软/水幕/不眠/干劲/岩浆铠甲/叶子防守/洁净之盐…） */
    if (ignoresFoeAbility(null) === false && abilityStatusImmune(target, code)) return false;
    if (abilityHas(target, 'bypassStatusImmunity')) { /* 腐蚀：无视钢/毒对毒免疫 */ }
    if (code === 'brn' && target.types.indexOf('火') >= 0) return false;
    if (code === 'par' && target.types.indexOf('电') >= 0) return false;
    if (code === 'frz' && target.types.indexOf('冰') >= 0) return false;
    if (code === 'psn' || code === 'tox') {
      if (target.types.indexOf('毒') >= 0 || target.types.indexOf('钢') >= 0) return false;
    }
    if (code === 'psn' && move && move.type === '地面') return false;
    return true;
  }
  /** 特性是否免疫该异常状态（不含战斗外条件判断时的宽容处理） */
  function abilityStatusImmune(target, code) {
    var p = abilityParams(target, 'status_immune');
    if (!p) return false;
    if (p.immuneStatuses === 'all') return true;
    if (p.immuneStatuses && p.immuneStatuses.indexOf(code) >= 0) return true;
    return false;
  }
  /** 该特性是否免疫某个临时状态（混乱/畏缩/着迷…） */
  function abilityVolatileImmune(target, volatileName) {
    var p = abilityParams(target, 'volatile_immune');
    if (!p) return false;
    var list = p.immuneVolatiles || [];
    for (var i = 0; i < list.length; i++) if (volatileName === list[i] || volatileName.indexOf(list[i]) >= 0) return true;
    return false;
  }
  /** 该特性是否免疫某种能力下降 */
  function abilityStatDropImmune(unit, statKey) {
    var p = abilityParams(unit, 'stat_drop_immune');
    if (p) {
      if (p.immuneStats === 'all') return true;
      if (Array.isArray(p.immuneStats) && p.immuneStats.indexOf(statKey) >= 0) return true;
    }
    /* 双打：同伴的花幕保护草属性队友 */
    var st = unit.__ctxState;
    if (st) {
      var list = alliesOf(st, unit);
      for (var i = 0; i < list.length; i++) {
        var ap = abilityParams(list[i], 'allyStatDropImmune');
        if (!ap) continue;
        if (ap.onlyTypes && !ap.onlyTypes.some(function (t) { return unit.types.indexOf(t) >= 0; })) continue;
        return true;
      }
    }
    return false;
  }

  /**
   * 能力阶级变化（契约 10.23）。
   * 特性接入点：单纯（±2 倍）、唱反调（反向）、白色烟雾类免疫下降、好胜/不服输/镜甲（下降后反应）。
   */
  function applyStages(unit, boosts) {
    var changed = {};
    if (!isPlainObject(boosts)) return changed;
    var keys = Object.keys(boosts);
    if (abilityHas(unit, 'invertStages')) {
      var inv = {};
      for (var q = 0; q < keys.length; q++) inv[keys[q]] = -toInt(boosts[keys[q]], 0);
      boosts = inv;
    }
    if (abilityHas(unit, 'doubleStages')) {
      var dbl = {};
      for (var d2 = 0; d2 < keys.length; d2++) dbl[keys[d2]] = toInt(boosts[keys[d2]], 0) * 2;
      boosts = dbl;
    }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (STAT_KEYS.indexOf(k) < 0 && k !== 'acc' && k !== 'eva') continue;
      var delta = toInt(boosts[k], 0);
      /* 特性免疫下降（白烟/恒净之躯/怪力钳/健壮胸肌/锐利目光/看门犬…） */
      if (delta < 0 && abilityStatDropImmune(unit, k)) continue;
      var before = toInt(unit.stages[k], 0);
      var after = clamp(before + delta, -6, 6);
      if (after !== before) { unit.stages[k] = after; changed[k] = after - before; }
    }
    if (Object.keys(changed).length) unit.__stageChanged = changed;
    return changed;
  }
  function stageChangeText(changed) {
    var parts = [];
    var keys = Object.keys(changed || {});
    for (var i = 0; i < keys.length; i++) {
      var v = changed[keys[i]];
      parts.push((STAGE_ZH[keys[i]] || keys[i]) + (v > 0 ? '+' + v : String(v)));
    }
    return parts.join(' ');
  }

  /* ===========================================================================
   * §4 回合结算
   * ======================================================================== */

  /**
   * 把 dex 挂到引擎态上（非枚举，不污染 JSON 序列化与 Object.keys，
   * 因此“resolveTurn 不改动入参”与“同 rng 可复现”两条断言都成立）。
   * deepClone 不会复制它，所以每次派生新 state 后都要重新挂一次。
   */
  function ensureDex(state, dex) {
    if (!isPlainObject(state) || !dex) return state;
    if (state.__dex === dex) return state;
    try {
      Object.defineProperty(state, '__dex', { value: dex, enumerable: false, configurable: true, writable: true });
    } catch (e) {
      state.__dex = dex;
    }
    return state;
  }

  function emptyState() {
    return {
      turn: 0, ended: false, winner: null, endReason: '',
      battle: {
        处于对战中: true, 对战模式: '常规单打', 对方身份: '未登记对手', 场地环境: '标准场地',
        场地效果: {}, weather: null, ally: null, bench: [], foe: null, foeBench: []
      },
      party: {}, box: {}, bag: { 金钱: 0, 物品: {} },
      meta: {
        turnCount: 0, expGained: {}, levelUps: [], lastLog: [],
        /* 击倒台账（KO ledger）：双方每一次濒死都记一条 {turn, side, name, level}，
         * 战报/结束日志以它为准列出**全部**战果 —— 濒死单位会被 compaction 移出「当前战位」，
         * 只看当前战位会只剩最后一只（AI 因此误判战斗还没结束）。 */
        kos: [],
        allyPos: '1', foePos: '1', startLog: [],
        /* 契约 10.1：规则集与规程状态 */
        ruleset: 'official', rules: null,
        /* 契约 10.2：口胡项 */
        improvs: [], improvLog: [],
        /* 契约 10.1：特殊机制使用记录（单场单机制） */
        mechanicsUsed: { ally: [], foe: [] },
        /* 契约 10.5：未映射的特性/道具 */
        unmapped: [],
        /* 规程违例（四招 / 机制超限 / 复苏药） */
        violations: []
      }
    };
  }

  /** 把一条“未映射”提示登记进 state（幂等：同一条只记一次） */
  function noteUnmapped(state, holderName, what, meta, isAbility, side) {
    var list = obj(state.meta).unmapped;
    if (!Array.isArray(list)) { list = []; state.meta.unmapped = list; }
    var key = (isAbility ? 'A|' : 'I|') + holderName + '|' + what;
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    var text = '⚠ ' + holderName + ' 的' + (isAbility ? '特性' : '道具') + '「' + what + '」未参与结算（' +
      ((meta && meta.why) || '数据未映射') + '），可走口胡通道补效果';
    var entry = {
      key: key, side: side || '', 持有者: holderName,
      类型: isAbility ? '特性' : '道具', 名称: what, text: text
    };
    list.push(entry);
    addEntry(state, {
      turn: toInt(obj(state.meta).turnCount, 0), actor: side || 'ally', actorName: holderName,
      kind: 'status', notes: [text], text: text
    });
    return entry;
  }

  /* ===========================================================================
   * 契约（对手变量保真 / 战斗恢复）
   *
   * 背景（用户实测数据丢失 bug，真实聊天楼139）——AI 的变量补丁声明了 3 只对手：
   *   insert /当前对战/对方战位/敌方首领1  （头目鸭嘴火兽 135/135）
   *   insert /当前对战/对方战位/敌方武装1  （改装隆隆岩 105/105）
   *   insert /当前对战/对方待命/敌集群      （杂兵群 350/350，种族写的是族群描述）
   * 旧实现把键名重排成 1/2、把「敌集群」整条丢掉（种族解析不了就 continue），
   * 落库只剩 2 只、键名全变 —— 就是这次要修的 bug。
   *
   * 规则（写回时）：
   *   - 键名是**引擎自己管理的数字槽位**（"1"/"2"/…）→ 按场上顺序重排（卡面板的槽位号）；
   *   - 键名是 **AI 写的语义化键**（敌方首领1 / 敌集群 / 任何非纯数字）→ **原样保留**，
   *     绝不改成 战位1/待命2；
   *   - 种族解析不了的对手**绝不丢弃**：整条原样留在 对方待命（键名不变、字段不动）。
   *     它们无法逐只建模，所以**不参与伤害结算、也不参与回合内的全灭判定**（否则一只打不到
   *     也打不死的族群条目会把战斗永远挂住 = 软锁）；但它们参与**接管时的残局判定**
   *     （foeSideAllDown：只要还有一只是活的，就不按「对手已全灭」收场）。
   * ======================================================================== */

  /** 是不是「引擎管理的数字槽位键」（"1"/"2"/"12"） */
  function isSlotKey(k) {
    return /^\d+$/.test(String(k === undefined || k === null ? '' : k));
  }

  /**
   * 写回时该单位用哪个键：非数字的原始键（AI 的语义键名）原样继承；
   * 数字槽位键 / 没有来源（补位上来的、野生生成的）→ 用引擎派生的槽位号。
   */
  function varKeyOf(unit, fallback) {
    var k = unit && unit.varKey;
    if (k !== undefined && k !== null && String(k) !== '' && !isSlotKey(k)) return String(k);
    return String(fallback);
  }

  /** 对手槽位的**原值**是不是「已失去战斗能力」（未建模的候补只能用原值判断） */
  function rawFoeDown(v) {
    var o = obj(v);
    var hp = o.当前体力;
    if (hp !== undefined && hp !== null && String(hp) !== '' && num(hp, 0) <= 0) return true;
    return String(o.状态 || o.异常状态 || '').indexOf('濒死') >= 0;
  }

  /** 未建模的对手条目（种族解析不了但原样保留的）里还有活着的吗 */
  function rawFoeAlive(st) {
    var list = obj(obj(st).meta).未建模对手;
    if (!Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && !rawFoeDown(list[i].value)) return true;
    }
    return false;
  }

  /**
   * 记下一条「种族无法解析、但 AI 声明过、必须原样保留」的对手条目。
   * 只存原始键名 + 原始对象（深拷贝），写回时整条还原 —— 一个字段都不改、一个都不丢。
   */
  function rememberRawFoe(state, key, value) {
    var m = obj(state.meta);
    if (!Array.isArray(m.未建模对手)) m.未建模对手 = [];
    var list = m.未建模对手;
    var k = String(key);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].key) === k) { list[i].value = deepClone(obj(value)); return list[i]; }
    }
    var entry = { key: k, value: deepClone(obj(value)) };
    list.push(entry);
    return entry;
  }

  /**
   * 契约（战斗恢复）：这一侧的对手是不是**全部**失去战斗能力了。
   * 覆盖「场上 + 候补席 + 未建模的原始条目」三处 —— 只要还有一只能打，就不算全灭。
   * 一只要么都没有（本来就是空场）时返回 false：那不是我该判的局。
   */
  function foeSideAllDown(state) {
    if (!state || !state.battle) return false;
    var b = state.battle;
    ensureFieldArrays(state);
    var arr = (Array.isArray(b.foes) && b.foes.length) ? b.foes : (b.foe ? [b.foe] : []);
    var bench = Array.isArray(b.foeBench) ? b.foeBench : [];
    var any = false;
    var i;
    for (i = 0; i < arr.length; i++) {
      any = true;
      if (arr[i] && !arr[i].fainted && num(arr[i].curHP, 0) > 0) return false;
    }
    for (i = 0; i < bench.length; i++) {
      any = true;
      if (bench[i] && !bench[i].fainted && num(bench[i].curHP, 0) > 0) return false;
    }
    var raw = obj(state.meta).未建模对手;
    if (Array.isArray(raw) && raw.length) any = true;
    if (rawFoeAlive(state)) return false;
    return any;
  }

  /** 从 stat_data / foeSpec 开一场 */
  function makeStartFromStat(dex) {
    return function startFromStat(statData, opts) {
      var o = obj(opts);
      var sd = obj(statData);
      var cur = obj(sd.当前对战);
      var party = deepClone(obj(sd.宝可梦队伍));
      var box = deepClone(obj(sd.后备宝可梦));
      var state = emptyState();

      state.party = party;
      state.box = box;
      /* 契约 10.28：留一份「对手槽位原值」给 toFoeSlot 的写回保护用。
       * 不可枚举 → 不会被 deepClone 拖进战斗状态、也不会出现在 toPatches 的差异里。 */
      try {
        Object.defineProperty(state, '__stat', {
          value: { 对方战位: deepClone(obj(cur.对方战位)) },
          writable: true, configurable: true, enumerable: false
        });
      } catch (e) { state.__stat = { 对方战位: deepClone(obj(cur.对方战位)) }; }
      state.bag = { 金钱: num(obj(sd.背包栏).金钱, 0), 物品: deepClone(obj(obj(sd.背包栏).物品)) };
      state.battle.对战模式 = cur.对战模式 || '常规单打';
      state.battle.对方身份 = cur.对方身份 || (o.foeSpec ? ((obj(o.foeSpec).名称 || obj(o.foeSpec).种族 || '未知对手')) : '未登记对手');
      state.battle.场地环境 = cur.场地环境 || '标准场地';
      state.battle.weather = deriveWeather(cur, sd);
      state.battle.场地效果 = weatherText(state.battle.weather);
      state.battle.己方待命 = {};
      state.battle.对方待命 = {};
      state.battle.己方战位 = {};
      state.battle.对方战位 = {};

      /* ---- 规则集（契约 10.1）：card 的锁级取决于对战模式与对方身份 ---- */
      var rulesetName = o.ruleset || obj(dex.options).ruleset || 'official';
      if (rulesetName !== 'official' && rulesetName !== 'card') {
        fail('startFromStat：未知规则集「' + rulesetName + '」（只支持 "official" / "card"）');
      }
      var rules = resolveRuleset(rulesetName, state.battle.对战模式, state.battle.对方身份);
      state.meta.ruleset = rules.id;
      state.meta.rules = rules;

      /* ---- 己方：战位快照优先，否则取队伍第一位（或 opts.ally） ---- */
      var slots = obj(cur.己方战位);
      var slotKeys = Object.keys(slots);
      var firstKey = slotKeys.length ? slotKeys[0] : '1';
      var slot = obj(slots[firstKey]);
      /* 契约 10.205：战位里可能只有 名称（真机 ✓）—— 不能因此退回"队伍第一只" ✗ */
      var nick = o.ally || slot.昵称 || slot.名称 || Object.keys(party)[0];
      var member = obj(party[nick]);
      if (!nick || !Object.keys(member).length) {
        if (!Object.keys(party).length) fail('startFromStat：stat_data.宝可梦队伍 为空，无法开战');
        nick = Object.keys(party)[0];
        member = obj(party[nick]);
      }
      var ally = makeBuildUnit(dex)(member, {
        nickname: nick, side: 'ally', speciesZh: slot.种族 || slot.名称 || member.种族,
        level: (slot.等级 !== undefined ? slot.等级 : (slot.对战等级 !== undefined ? slot.对战等级 : member.等级)),
        curHP: slot.当前体力 !== undefined ? slot.当前体力 : member.当前体力,
        pos: firstKey
      });
      if (Array.isArray(slot.技能位) || isPlainObject(slot.技能位)) {
        var slotMoves = Object.keys(obj(slot.技能位));
        if (slotMoves.length) {
          /* 战位技能位是权威来源（含 PP 消耗） */
          var rebuilt = [];
          for (var i = 0; i < slotMoves.length; i++) {
            var sv = obj(slot.技能位)[slotMoves[i]];
            rebuilt.push(makeSlot(dex, slotMoves[i], sv ? sv.PP : undefined));
          }
          if (rebuilt.length) ally.moves = rebuilt.slice(0, 4);
        }
      }
      state.meta.allyPos = String(ally.pos || '1');
      ally.participated = true;          /* 契约 10.19：首发算参与 */
      state.battle.ally = ally;
      restoreStages(ally, slot.增益与减益);   /* 契约 10.23：开战前已有的能力阶级不能丢 */
      /* ---- 契约 10.14 / 阶段 A-B：每侧在场数量由 meta.fieldSlots 决定 ----
       * 状态层用数组当真相来源，battle.ally / battle.foe 仍是「第一只」的别名，
       * 这样单打路径与既有代码完全不受影响。
       * 我方在场只数（用户已确认的口径，别再按模式猜）：
       *   - **跟随变量**：己方战位 声明几只就上几只（上限 2，与卡面板可显示数一致）；
       *     突围 / 群战 / 单打 / 其它模式都走这一条，**不按模式自动补满**；
       *   - 唯一例外：对战模式含「双打」（或 2v2 这类写法）时按每侧 2 只的口径处理，
       *     战位不足 2 只就地按 宝可梦队伍 顺位补满（打【补位】日志，见下面的「开局补满」）；
       *   - 兜底：己方战位 完全为空 / 占位符时，按 宝可梦队伍 首发补 1 只（防 0 vs 0 空壳）。
       * 对手侧：声明的对方战位数（1..N，上限 2，第 3 只起进候补席）。 */
      var doublesMode = isDoublesMode(state.battle.对战模式);
      var neededAlly = doublesMode ? 2 : clamp(Math.max(1, slotKeys.length), 1, 2);
      state.meta.fieldSlots = obj(state.meta.fieldSlots);
      state.meta.fieldSlots.ally = neededAlly;
      if (doublesMode) {
        addEntry(state, {
          turn: 0, actor: 'ally', actorName: ally.nickname, kind: 'status',
          notes: ['（双打）'],
          text: '【双打】对战模式「' + String(state.battle.对战模式 || '') + '」按每侧 2 只同时在场结算' +
            '（己方战位声明 ' + slotKeys.length + ' 个 → 场上需要 ' + neededAlly + ' 只）。'
        });
      }
      state.battle.allies = [ally];
      var extraAllyKeys = slotKeys.slice(1, neededAlly);
      for (var ek = 0; ek < extraAllyKeys.length; ek++) {
        var eKey = extraAllyKeys[ek];
        var eSlot = obj(slots[eKey]);
        var eNick = eSlot.昵称 || eKey;
        var eMember = obj(party[eNick]);
        if (!Object.keys(eMember).length) { /* 队伍里没有这只 → 跳过，避免开不起来 */
          addEntry(state, {
            turn: 0, actor: 'ally', actorName: eNick, kind: 'status',
            notes: ['（双打战位无法读队伍）'],
            text: '⚠ 双打战位「' + eKey + '」（' + eNick + '）在 宝可梦队伍 里找不到，本场忽略该战位。'
          });
          continue;
        }
        var eUnit = makeBuildUnit(dex)(eMember, {
          nickname: eNick, side: 'ally', speciesZh: eSlot.种族 || eSlot.名称 || eMember.种族, level: (eSlot.等级 !== undefined ? eSlot.等级 : (eSlot.对战等级 !== undefined ? eSlot.对战等级 : eMember.等级)),
          curHP: eSlot.当前体力 !== undefined ? eSlot.当前体力 : eMember.当前体力,
          pos: eKey
        });
        if (isPlainObject(eSlot.技能位) || Array.isArray(eSlot.技能位)) {
          var eMoves = Object.keys(obj(eSlot.技能位));
          if (eMoves.length) {
            var eRebuilt = [];
            for (var em = 0; em < eMoves.length; em++) {
              eRebuilt.push(makeSlot(dex, eMoves[em], obj(obj(eSlot.技能位)[eMoves[em]]).PP));
            }
            if (eRebuilt.length) eUnit.moves = eRebuilt.slice(0, 4);
          }
        }
        state.battle.allies.push(eUnit);
        eUnit.participated = true;     /* 契约 10.19：双打首发也算参与 */
      }
      /* 开局补满（与 fillFieldSlots 同一条规则）：战位为空/占位符/不足时，按 宝可梦队伍 顺位取前 N 只。
       * neededAlly 就是「变量声明的己方战位数」，所以这里只在两种情况触发：
       *   - 双打：己方战位只声明了 1 个（甚至占位符）→ 把第 2 只从队伍顺位补上场（原有行为，不变）；
       *   - 己方战位为空/占位符（neededAlly = 1）→ 补 1 只（防 0 vs 0 空壳）。
       * 突围 / 群战等模式声明 1 只时 neededAlly = 1，这里一次都不触发（不按模式多拉一只）。
       * 日志格式与 fillFieldSlots 完全一致：【补位】我方场上空缺 N 只 → 派出 A、B。 */
      if (state.battle.allies.length < neededAlly) {
        var usedNick = {};
        for (var ua = 0; ua < state.battle.allies.length; ua++) usedNick[state.battle.allies[ua].nickname] = true;
        var partyOrder = Object.keys(party);
        var emptySlots = neededAlly - state.battle.allies.length;
        var filledNames = [];
        for (var po = 0; po < partyOrder.length && state.battle.allies.length < neededAlly; po++) {
          if (usedNick[partyOrder[po]]) continue;
          var poMember = obj(party[partyOrder[po]]);
          if (!Object.keys(poMember).length) continue;
          var poUnit = makeBuildUnit(dex)(poMember, {
            nickname: partyOrder[po], side: 'ally', speciesZh: poMember.种族 || poMember.名称, level: poMember.等级,
            curHP: poMember.当前体力, pos: String(state.battle.allies.length + 1)
          });
          poUnit.participated = true;
          state.battle.allies.push(poUnit);
          usedNick[partyOrder[po]] = true;
          filledNames.push(poUnit.nickname);
        }
        if (filledNames.length) {
          addEntry(state, {
            turn: 0, actor: 'ally', actorName: filledNames[0], kind: 'switch',
            notes: ['（开局补位）'],
            text: '【补位】我方场上空缺 ' + emptySlots + ' 只 → 派出 ' + filledNames.join('、') +
              (filledNames.length < emptySlots ? '（队伍不足，有多少上多少）' : '')
          });
        }
      }
      /* 补齐后，第一只仍然是 battle.ally（别名不变） */
      state.battle.ally = state.battle.allies[0];
      if (doublesMode) state.battle.双打 = true;
      if (state.battle.allies.length > 1) {
        state.battle.双打 = true;
        addEntry(state, {
          turn: 0, actor: 'ally', actorName: ally.nickname, kind: 'status',
          notes: ['（双打）'],
          text: '本场按双打结算：我方 ' + state.battle.allies.map(function (u) { return u.nickname; }).join('、') + ' 同时在场。'
        });
      }

      /* ---- 己方待命 ---- */
      var benchSrc = obj(cur.己方待命);
      var bKeys = Object.keys(benchSrc);
      if (bKeys.length) {
        for (var b = 0; b < bKeys.length; b++) {
          var bm = obj(benchSrc[bKeys[b]]);
          var bname = bm.名称 || bKeys[b];
          var bMember = obj(party[bname]);
          var bu = makeBuildUnit(dex)(bMember, {
            nickname: bname, side: 'ally', speciesZh: bMember.种族,
            level: bMember.等级,
            curHP: bm.当前体力 !== undefined ? bm.当前体力 : bMember.当前体力,
            moves: bMember.技能 ? splitMoves(bMember.技能) : null
          });
          state.battle.bench.push(bu);
        }
      }
      /* 队伍里没上场的都是待命 */
      var onField = state.battle.allies.map(function (u) { return u.nickname; });
      var partyNames = Object.keys(party);
      for (var pn = 0; pn < partyNames.length; pn++) {
        if (onField.indexOf(partyNames[pn]) >= 0) continue;
        if (state.battle.bench.some(function (u) { return u.nickname === partyNames[pn]; })) continue;
        var pm = obj(party[partyNames[pn]]);
        state.battle.bench.push(makeBuildUnit(dex)(pm, {
          nickname: partyNames[pn], side: 'ally', speciesZh: pm.种族, level: pm.等级,
          curHP: pm.当前体力, moves: pm.技能 ? splitMoves(pm.技能) : null
        }));
      }

      /* ---- 对方：foeSpec 优先，其次 stat_data.对方战位 ---- */
      var foePositions = obj(cur.对方战位);
      var foeKeys = Object.keys(foePositions);
      var fSlot = foeKeys.length ? obj(foePositions[foeKeys[0]]) : {};
      var foePos = foeKeys.length ? foeKeys[0] : '1';
      var spec = obj(o.foeSpec);
      var foeMoves = spec.技能 || spec.moves || (Array.isArray(spec.技能位) ? spec.技能位 : null);
      if (!foeMoves && isPlainObject(spec.技能位)) foeMoves = Object.keys(spec.技能位);
      var foeSpeciesKey = spec.种族 || spec.species || fSlot.种族 || fSlot.名称;
      var foeSpeciesEntry = dex.species(foeSpeciesKey);

      /* ---- 契约 10.7：卡的开战断点只写 名称/种族/显现属性/当前体力/体力上限/状态，
              没有 等级 与 技能位，所以引擎必须自己补出来 ---- */
      var foeLevel = spec.等级 || spec.level || fSlot.等级 || null;
      var levelDerived = false;
      if (!foeLevel && foeSpeciesEntry) {
        var derived = deriveLevelFromHP(dex, foeSpeciesEntry, fSlot.体力上限, spec.体力上限);
        if (derived) { foeLevel = derived; levelDerived = true; }
      }
      if (!foeLevel) foeLevel = ally.level;   /* 连体力上限都没有 → 退回我方首发等级 */

      var foeSlotMoves = null;
      if (isPlainObject(fSlot.技能位) && Object.keys(fSlot.技能位).length) {
        /* 带上变量里记的 PP（"34/35"），开战/接管时不把对手 PP 重置成满 */
        foeSlotMoves = Object.keys(fSlot.技能位).map(function (m) {
          return { 名称: m, PP: obj(fSlot.技能位[m]).PP };
        });
      }
      /* 契约 10.16（用户决定）：**不做招式合成**。
       * 我们没有"招式学习面"数据，合成会替作者编出该宝可梦学不会的招式
       * （实测：给 Lv.17 可可多拉合成了「彗星拳」）。缺技能位时退化为兜底招式，
       * 并在开战日志里明确要求模型/作者把 技能位 写进变量。 */
      var slotMovesMissing = (!foeMoves && !foeSlotMoves);
      if (!foeMoves && foeSlotMoves) foeMoves = foeSlotMoves;

      /* 契约 10.27（对手特性接线）：把 对方战位.*.已知特性（字符串）读成对手单位的 ability。
       * 优先级：foeSpec.特性（调用方显式给出，对象或字符串） > 对方战位.已知特性（AI 写下的侦查结果）。 */
      var foeAbility = normalizeAbilityValue(spec.特性);
      var foeAbilityFrom = foeAbility ? 'explicit' : '';
      if (!foeAbility) {
        foeAbility = normalizeAbilityValue(fSlot.已知特性);
        if (foeAbility) foeAbilityFrom = 'slot';
      }

      var foe = makeBuildUnit(dex)({
        种族: foeSpeciesKey,
        等级: foeLevel,
        当前体力: spec.当前体力 !== undefined ? spec.当前体力 : fSlot.当前体力,
        状态: spec.状态 || fSlot.状态,
        技能: '',
        性别: spec.性别,
        特性: foeAbility,
        持有物: spec.持有物
      }, {
        nickname: spec.名称 || spec.nickname || fSlot.名称 || fSlot.种族,
        side: 'foe',
        speciesZh: foeSpeciesKey,
        level: foeLevel,
        moves: foeMoves,
        curHP: spec.当前体力 !== undefined ? spec.当前体力 : fSlot.当前体力,
        pos: foePos,
        ability: foeAbility
      });
      if (foeAbilityFrom) foe.abilityFrom = foeAbilityFrom;
      if (foe.ability && foe.ability !== '未知' && foe.abilityFrom === 'slot') {
        addEntry(state, {
          turn: 0, actor: 'foe', actorName: foe.nickname, kind: 'status',
          notes: ['（已知特性）'],
          text: '已登记 ' + foe.nickname + ' 的特性为「' + foe.ability + '」（来自 对方战位.已知特性），本场按该特性结算。'
        });
      }
      if (spec.属性 && !dex.hasSpecies(spec.种族 || spec.species)) foe.types = String(spec.属性).split('/');
      state.meta.foePos = String(foePos);
      state.meta.foeLevelDerived = levelDerived;
      state.battle.foe = foe;
      /* 契约（对手变量保真）：记下它**从变量里的哪个键**读出来 —— 写回时键名原样用这个。
       * 非数字键（敌方首领1/敌方武装1…）永远保持 AI 的原键名，绝不改成 战位1/战位2。 */
      foe.varKey = String(foePos);
      /* 契约 10.28（写回保护）：记下 stat_data 里对手槽位的**原值**。
       * toFoeSlot 写回时，只有引擎确实解析到非空值才覆盖；否则保留变量里原有的值
       * （典型场景：AI 在 对方战位.已知特性 写了「结实」，但引擎这一局没给出特性 →
       *  绝不允许把「结实」写成空/未知，把 AI 的侦查结果清掉）。 */
      setOrig(foe, {
        已知特性: (fSlot.已知特性 !== undefined && fSlot.已知特性 !== null && String(fSlot.已知特性).trim())
          ? String(fSlot.已知特性).trim() : '',
        已知携带: (fSlot.已知携带 !== undefined && fSlot.已知携带 !== null && String(fSlot.已知携带).trim())
          ? String(fSlot.已知携带).trim() : ''
      });
      restoreStages(foe, fSlot.增益与减益);
      /* ---- 契约 10.14 / 阶段 A：对手侧多战位（1 vs N；B 阶段每侧 2 只同一条路）----
       * **场上上限 = 卡面板能显示的数量**（panel-contract 已确认：`.mon.foe.s1/.s2` + `slice(0,2)`）。
       * 所以对手侧场上最多 2 只（单打/只声明 1 只时就是 1 只）；
       * 变量里声明了第 3 只及以上 → 第 3 只起**进候补席（foeBench）**，绝不新开第 3 个战位。 */
      state.battle.foes = [foe];
      var foeCap = Math.min(2, Math.max(1, foeKeys.length));
      state.meta.fieldSlots.foe = doublesMode ? 2 : foeCap;
      var extraFoeKeys = foeKeys.slice(1, foeCap);
      var benchFoeKeys = foeKeys.slice(foeCap);
      for (var efk = 0; efk < extraFoeKeys.length; efk++) {
        var efKey = extraFoeKeys[efk];
        var efSlot = obj(foePositions[efKey]);
        var efName = efSlot.名称 || efSlot.昵称 || efKey;
        var efSpecies = efSlot.种族 || efName;
        if (!dex.hasSpecies(efSpecies)) {
          addEntry(state, {
            turn: 0, actor: 'foe', actorName: efName, kind: 'status',
            notes: ['（多对手战位无法解析）'],
            text: '⚠ 对方战位「' + efKey + '」（' + efName + '）种族无法解析，本场无法逐只建模；' +
              '已按原键名原样保留在 对方待命，绝不写丢。'
          });
          /* 契约（对手变量保真）：解析不了 ≠ 丢弃。整条原样记住，写回时原键名还原。 */
          rememberRawFoe(state, efKey, efSlot);
          continue;
        }
        /* 与第 1 只完全同一条读法：等级 / 技能位（对象或数组）/ 已知特性 / 状态 / 增益减益 */
        var efAbility = normalizeAbilityValue(efSlot.已知特性);
        var efMoves = null;
        if (isPlainObject(efSlot.技能位) && Object.keys(efSlot.技能位).length) {
          efMoves = Object.keys(efSlot.技能位).map(function (m) {
            return { 名称: m, PP: obj(efSlot.技能位[m]).PP };
          });
        } else if (Array.isArray(efSlot.技能位) && efSlot.技能位.length) efMoves = efSlot.技能位.slice();
        else if (efSlot.技能) efMoves = splitMoves(efSlot.技能);
        var efLevel = efSlot.等级 || foe.level;
        if (!efSlot.等级) {
          var efDerived = deriveLevelFromHP(dex, dex.species(efSpecies), efSlot.体力上限);
          if (efDerived) efLevel = efDerived;
        }
        var efUnit = makeBuildUnit(dex)({
          种族: efSpecies,
          等级: efLevel,
          当前体力: efSlot.当前体力,
          状态: efSlot.状态,
          技能: '',
          性别: efSlot.性别,
          特性: efAbility,
          持有物: efSlot.持有物
        }, {
          nickname: efName, side: 'foe', speciesZh: efSpecies,
          level: efLevel, curHP: efSlot.当前体力,
          moves: efMoves, pos: efKey,
          ability: efAbility
        });
        if (efAbility && efAbility !== '未知') efUnit.abilityFrom = 'slot';
        setOrig(efUnit, {
          已知特性: (efSlot.已知特性 !== undefined && efSlot.已知特性 !== null && String(efSlot.已知特性).trim())
            ? String(efSlot.已知特性).trim() : '',
          已知携带: (efSlot.已知携带 !== undefined && efSlot.已知携带 !== null && String(efSlot.已知携带).trim())
            ? String(efSlot.已知携带).trim() : ''
        });
        restoreStages(efUnit, efSlot.增益与减益);
        /* 契约（对手变量保真）：第 2 个场上对手同样记住它的变量原键名 */
        efUnit.varKey = String(efKey);
        state.battle.foes.push(efUnit);
      }
      /* 第 3 只起：不占场上战位，按顺序进候补席（面板只能画 2 个对手槽） */
      for (var bfk = 0; bfk < benchFoeKeys.length; bfk++) {
        var bfKey = benchFoeKeys[bfk];
        var bfSlot = obj(foePositions[bfKey]);
        var bfName = bfSlot.名称 || bfSlot.昵称 || bfKey;
        var bfSpecies = bfSlot.种族 || bfName;
        var bfUnit = null;
        if (dex.hasSpecies(bfSpecies)) {
          var bfAbility = normalizeAbilityValue(bfSlot.已知特性);
          var bfMoves = null;
          if (isPlainObject(bfSlot.技能位) && Object.keys(bfSlot.技能位).length) {
            bfMoves = Object.keys(bfSlot.技能位).map(function (m) {
              return { 名称: m, PP: obj(bfSlot.技能位[m]).PP };
            });
          } else if (Array.isArray(bfSlot.技能位) && bfSlot.技能位.length) bfMoves = bfSlot.技能位.slice();
          else if (bfSlot.技能) bfMoves = splitMoves(bfSlot.技能);
          var bfLevel = bfSlot.等级 || foe.level;
          if (!bfSlot.等级) {
            var bfDerived = deriveLevelFromHP(dex, dex.species(bfSpecies), bfSlot.体力上限);
            if (bfDerived) bfLevel = bfDerived;
          }
          bfUnit = makeBuildUnit(dex)({
            种族: bfSpecies, 等级: bfLevel, 当前体力: bfSlot.当前体力, 状态: bfSlot.状态,
            技能: '', 性别: bfSlot.性别, 特性: bfAbility, 持有物: bfSlot.持有物
          }, {
            nickname: bfName, side: 'foe', speciesZh: bfSpecies,
            level: bfLevel, curHP: bfSlot.当前体力, moves: bfMoves, pos: bfKey, ability: bfAbility
          });
          setOrig(bfUnit, {
            已知特性: (bfSlot.已知特性 !== undefined && bfSlot.已知特性 !== null && String(bfSlot.已知特性).trim())
              ? String(bfSlot.已知特性).trim() : '',
            已知携带: (bfSlot.已知携带 !== undefined && bfSlot.已知携带 !== null && String(bfSlot.已知携带).trim())
              ? String(bfSlot.已知携带).trim() : ''
          });
          restoreStages(bfUnit, bfSlot.增益与减益);
          /* 契约（对手变量保真）：候补也记住它原来的键名（第 3 只起的 AI 语义键照原样保留） */
          bfUnit.varKey = String(bfKey);
          state.battle.foeBench.push(bfUnit);
        } else {
          /* 契约（对手变量保真）：种族解析不了 ≠ 丢弃 —— 整条原样保留（原键名 + 原字段） */
          rememberRawFoe(state, bfKey, bfSlot);
        }
        addEntry(state, {
          turn: 0, actor: 'foe', actorName: bfName, kind: 'status',
          notes: ['（进入候补席）'],
          text: '对手第 ' + (bfk + foeCap + 1) + ' 只 ' + bfName + ' 进入候补席（卡面板仅能显示 2 只场上对手）' +
            (bfUnit ? '' : '；⚠ 该战位种族无法解析，本场无法逐只建模，已按原键名原样保留在 对方待命')
        });
      }
      if (state.battle.foes.length > 1) {
        addEntry(state, {
          turn: 0, actor: 'foe', actorName: foe.nickname, kind: 'status',
          notes: ['（多对手）'],
          text: '本场对手共 ' + state.battle.foes.length + ' 只在场：' +
            state.battle.foes.map(function (u) { return u.nickname; }).join('、') + '。'
        });
      }

      /* 把补出来的信息写回 stat_data 的 对方战位（面板直接读它）—— 每个槽位都要写 */
      for (var ori = 0; ori < foeKeys.length && ori < state.battle.foes.length; ori++) {
        var outSlot = obj(cur.对方战位)[foeKeys[ori]];
        var outUnit = state.battle.foes[ori];
        if (isPlainObject(outSlot) && outUnit) {
          if (!outSlot.等级 || toInt(outSlot.等级, 0) !== toInt(outUnit.level, 0)) outSlot.等级 = outUnit.level;
          if (!isPlainObject(outSlot.技能位) || !Object.keys(outSlot.技能位).length) {
            outSlot.技能位 = {};
            for (var smi = 0; smi < outUnit.moves.length; smi++) outSlot.技能位[outUnit.moves[smi].name] = {};
          }
        }
      }

      var foeBenchSrc = obj(cur.对方待命);
      var fbKeys = Object.keys(foeBenchSrc);
      for (var fb = 0; fb < fbKeys.length; fb++) {
        var fbm = obj(foeBenchSrc[fbKeys[fb]]);
        var fSpecies = fbm.种族 || fbm.名称;
        if (!dex.hasSpecies(fSpecies)) {
          /* 契约（对手变量保真·用户实测 bug 的直接根因）：
           * 旧实现在这里 `continue` —— AI 声明的「敌集群」（种族写的是族群描述，数据表查不到）
           * 就此整条消失，落库后对手只剩 2 只。现在改成「原键名 + 原字段」整条保留，
           * 它依然算一个还没被打倒的对手（全灭判定要把它算进去）。 */
          rememberRawFoe(state, fbKeys[fb], fbm);
          addEntry(state, {
            turn: 0, actor: 'foe', actorName: String(fbm.名称 || fbKeys[fb]), kind: 'status',
            notes: ['（候补无法逐只建模）'],
            text: '⚠ 对方待命「' + fbKeys[fb] + '」（' + (fbm.名称 || '未命名') + '）种族无法解析，' +
              '本场无法逐只建模；已按原键名原样保留（当前体力 ' + num(fbm.当前体力, 0) + '/' + num(fbm.体力上限, 0) +
              '，全灭判定仍把它算作对手）。'
          });
          continue;
        }
        var fbUnit = makeBuildUnit(dex)(fbm, {
          nickname: fbm.名称 || fSpecies, side: 'foe', speciesZh: fSpecies,
          level: fbm.等级 || foe.level, curHP: fbm.当前体力,
          ability: (fbm.已知特性 !== undefined && fbm.已知特性 !== null) ? String(fbm.已知特性).trim() : ''
        });
        /* 契约（对手变量保真）：候补记住原来的键名，写回时键名照旧 */
        fbUnit.varKey = String(fbKeys[fb]);
        state.battle.foeBench.push(fbUnit);
      }

      state.meta.turnCount = 0;
      state.meta.startLog = [];

      /* ---- 契约 10.7：把“补出来的等级 / 合成招式”在开战日志里讲清楚 ---- */
      if (levelDerived) {
        addEntry(state, {
          turn: 0, actor: 'foe', actorName: foe.nickname, kind: 'status',
          notes: ['（对手等级由体力上限反推）'],
          text: foe.nickname + ' 的等级由体力上限 ' + num(fSlot.体力上限, 0) + ' 反推为 Lv.' + foe.level + '（对手等级由体力上限反推）'
        });
      }
      if (slotMovesMissing) {
        addEntry(state, {
          turn: 0, actor: 'foe', actorName: foe.nickname, kind: 'status',
          notes: ['（对手未提供技能位）'],
          text: '⚠ ' + foe.nickname + ' 的变量里没有「技能位」，本引擎**不会替它编招式**，本场按兜底招式「' +
            (foe.moves[0] ? foe.moves[0].name : BASIC[0]) + '」处理。请在开战时把对手招式写进 对方战位.技能位（或让作者补数据）。'
        });
      }
      if (!foe.moves.length || (foe.moves.length === 1 && foe.moves[0].name === BASIC[0])) {
        addEntry(state, {
          turn: 0, actor: 'foe', actorName: foe.nickname, kind: 'status',
          notes: ['（兜底招式）'],
          text: '⚠ ' + foe.nickname + ' 的招式无法从数据表合成（未识别/兜底），已退化为「' + (foe.moves[0] ? foe.moves[0].name : BASIC[0]) + '」，可用口胡通道定义'
        });
      }
      if (foe.moves.some(function (s) { return s && s.未识别; })) {
        for (var fmi = 0; fmi < foe.moves.length; fmi++) {
          if (foe.moves[fmi] && foe.moves[fmi].未识别) {
            addEntry(state, {
              turn: 0, actor: 'foe', actorName: foe.nickname, kind: 'status',
              notes: ['（未收录招式）'], text: unrecognizedMoveText(foe.nickname, foe.moves[fmi])
            });
          }
        }
      }

      /* ---- 规则集落地：锁级 / 四招规程 / 未映射提示（契约 10.1、10.5） ---- */
      applyRulesToState(dex, state, rules);

      addEntry(state, {
        turn: 0, actor: 'ally', actorName: ally.nickname, kind: 'status',
        text: '战斗开始！' + ally.nickname + '（Lv.' + ally.level + '） 对上 ' + foe.nickname + '（Lv.' + foe.level + '）。',
        notes: ['对方身份：' + state.battle.对方身份, '规则集：' + rules.name]
      });
      onSwitchIn(dex, state, ally, foe);
      onSwitchIn(dex, state, foe, ally);

      /* ---- 契约（战斗恢复）：接管/重建时对手已经全灭 → 立刻按结束处理 ----
       * 用户实测坏存档：处于对战中=true，但 对方战位 + 对方待命 里两只都是 0 血濒死，
       * 引擎照样建出「还能继续打」的战况 —— 面板上挂着两只 0 血继续「对战中」。
       * 这里在开局阶段就判一次：对手（含候补、含种族解析不了但原样保留的条目）
       * 一只能打的都没有 → 走 checkEnd 正常收尾（winner + 战报 + 结束日志），
       * 并额外写一条明确的【战斗恢复】日志。 */
      if (!state.ended && foeSideAllDown(state)) {
        var restoreCtx = { state: state, dex: dex, turn: 0, errors: [] };
        checkEnd(restoreCtx);           /* 正常判胜：winner / endReason / 结束日志 / 击倒台账 */
        addEntry(state, {
          turn: 0, actor: 'ally', actorName: state.battle.ally ? state.battle.ally.nickname : '我方', kind: 'end',
          notes: ['【战斗恢复】', state.endReason],
          text: '【战斗恢复】检测到对手已全部失去战斗能力，本场按结束处理'
        });
      }

      /* 开战日志独立留一份，后面 resolveTurn 会重置 meta.lastLog */
      state.meta.startLog = state.meta.lastLog.slice();
      return state;
    };
  }

  /**
   * 把规则集落到一场战斗上（契约 10.1）：
   *   - 锁级：把双方所有单位压到锁级等级并重算能力值（card 的线上天梯模拟战）
   *   - 四招规程：任一单位申报的招式数 > 4 即判负
   *   - 未映射提示：特性/道具没有声明式映射时输出「未参与结算」提示（契约 10.5）
   */
  function applyRulesToState(dex, state, rules) {
    var r = obj(rules);
    var units = [];
    if (state.battle.ally) units.push(state.battle.ally);
    units = units.concat(state.battle.bench || []);
    if (state.battle.foe) units.push(state.battle.foe);
    units = units.concat(state.battle.foeBench || []);

    /* --- 锁级 --- */
    if (r.锁级) {
      var cappedNames = [];
      for (var i = 0; i < units.length; i++) {
        if (applyLevelCap(dex, units[i], r.锁级)) cappedNames.push(units[i].nickname + '（' + units[i].realLevel + '→' + units[i].level + '）');
      }
      if (cappedNames.length) {
        var txt = '规则集生效：' + r.锁级 + ' 级上限，' + cappedNames.join('、') + ' 的面板被压制到 ' + r.锁级 + ' 级计算。';
        addEntry(state, { turn: 0, actor: 'ally', actorName: cappedNames[0], kind: 'status', notes: [txt], text: txt });
      }
    }

    /* --- 四招规程 --- */
    if (r.四招判负) {
      var over = [];
      for (var j = 0; j < units.length; j++) {
        if (toInt(units[j].declaredMoveCount, 0) > 4) over.push(units[j].nickname + '（' + units[j].declaredMoveCount + ' 招）');
      }
      if (over.length) {
        state.meta.violations = state.meta.violations || [];
        state.meta.violations.push({ kind: 'fourMoves', detail: over.join('、') });
        var vtxt = '⚠ 四招规程违例：' + over.join('、') + ' 申报招式超过 4 个，立即判负。';
        addEntry(state, { turn: 0, actor: 'ally', actorName: over[0], kind: 'end', notes: [vtxt], text: vtxt });
        state.ended = true;
        state.winner = 'foe';
        state.endReason = '四招规程违例（判负）';
        return;
      }
    }

    /* --- 未映射提示（特性 + 道具） ---
     * 契约 10.25：只有「真的做不了的残差」才提示。标了 silent（例如 As One 里的
     * 紧张感那种「无战斗结算」条目）不再输出泛泛的「未参与结算」。 */
    for (var k = 0; k < units.length; k++) {
      var u = units[k];
      var am = u.abilityMeta || {};
      if (u.ability && u.ability !== '未知' && !am.mapped && !isSilentAbility(am)) {
        noteUnmapped(state, u.nickname, u.ability, am, true, u.side);
      }
      var im = u.itemMeta || {};
      if (u.item && u.item !== '无' && !im.mapped && !obj(im.params).silent) {
        noteUnmapped(state, u.nickname, u.item, im, false, u.side);
      }
    }

    /* --- 未收录招式的警告（契约 10.6：绝不静默当普通招式） --- */
    if (!Array.isArray(state.meta.unrecognizedMoves)) state.meta.unrecognizedMoves = [];
    for (var q = 0; q < units.length; q++) {
      var uu = units[q];
      var mlist = Array.isArray(uu.moves) ? uu.moves : [];
      for (var mi3 = 0; mi3 < mlist.length; mi3++) {
        var slot = mlist[mi3];
        if (!slot || !slot.未识别) continue;
        var dup = false;
        for (var ri2 = 0; ri2 < state.meta.unrecognizedMoves.length; ri2++) {
          var x = state.meta.unrecognizedMoves[ri2];
          if (x.holder === uu.nickname && x.原名称 === slot.原名称) { dup = true; break; }
        }
        if (dup) continue;
        state.meta.unrecognizedMoves.push({ holder: uu.nickname, side: uu.side, 原名称: slot.原名称, 招式: slot.name });
        addEntry(state, {
          turn: 0, actor: uu.side || 'ally', actorName: uu.nickname, kind: 'status',
          notes: ['（未收录招式）'], text: unrecognizedMoveText(uu.nickname, slot)
        });
      }
    }

    /* --- 名称修正留痕（契约 10.6：别名/笔误命中也要说明，不静默改名） --- */
    if (!Array.isArray(state.meta.nameCorrections)) state.meta.nameCorrections = [];
    for (var q2 = 0; q2 < units.length; q2++) {
      var u2 = units[q2];
      var mlist2 = Array.isArray(u2.moves) ? u2.moves : [];
      for (var mi4 = 0; mi4 < mlist2.length; mi4++) {
        var sl = mlist2[mi4];
        if (!sl || !sl.修正自 || sl.修正自 === sl.原名称) continue;
        var dup2 = false;
        for (var rc = 0; rc < state.meta.nameCorrections.length; rc++) {
          var y = state.meta.nameCorrections[rc];
          if (y.holder === u2.nickname && y.原名称 === sl.原名称 && y.正式名称 === sl.修正自) { dup2 = true; break; }
        }
        if (dup2) continue;
        state.meta.nameCorrections.push({ holder: u2.nickname, side: u2.side, 原名称: sl.原名称, 正式名称: sl.修正自, 方式: sl.识别方式 });
        addEntry(state, {
          turn: 0, actor: u2.side || 'ally', actorName: u2.nickname, kind: 'status',
          notes: ['（名称修正）'],
          text: '名称修正：「' + sl.原名称 + '」不是官方/52poke 译名，已按「' + sl.修正自 + '」结算（如需别的效果请走口胡通道）'
        });
      }
    }
  }

  /** 未收录招式的统一警告文案（契约 10.6） */
  function unrecognizedMoveText(holder, slot) {
    var nm = (slot && (slot.原名称 || slot.name)) || '未知';
    return '⚠ 招式「' + nm + '」未收录，已按未识别处理（可用口胡通道定义）';
  }

  /** 「本身没有战斗结算」的特性（无特性/战斗外效果）：不输出「未参与结算」提示 */
  function isSilentAbility(meta) {
    if (!meta) return false;
    if (obj(meta.params).silent) return true;
    var why = String(meta.why || '');
    return /战斗外|信息类|无战斗结算|无需结算/.test(why);
  }

  /**
   * 口胡项的回合推进：持续回合 -1，归零则失效并记一条日志（契约 10.2）。
   * 返回失效项的日志（会并入本回合的 log）。
   */
  function tickImprovs(state) {
    var list = obj(state.meta).improvs;
    var out = [];
    if (!Array.isArray(list) || !list.length) return out;
    var turn = toInt(obj(state.meta).turnCount, 0);
    for (var i = 0; i < list.length; i++) {
      var im = list[i];
      if (im.剩余回合 === null || im.剩余回合 === undefined) continue;   /* 本回合有效项 */
      var left = toInt(im.剩余回合, 0) - 1;
      im.剩余回合 = left;
      if (left <= 0) {
        out.push(addEntry(state, {
          turn: turn, actor: 'ally', actorName: '引擎', kind: 'improv', improveId: im.id,
          notes: ['口胡项已过期'], text: '口胡：[' + im.来源 + '] ' + im.描述 + ' 的持续回合已结束，修正失效。'
        }));
      }
    }
    return out;
  }

  /* ===========================================================================
   * §5 口胡通道 / 规则集判定辅助（契约 10.1、10.2、10.5）
   * ======================================================================== */

  /* ---- 口胡项与伤害/命中的联动 ---- */

  /** 某个单位是否被口胡项覆盖 */
  function improvCovers(im, unit) {
    var a = im['作用'];
    if (a === 'both') return true;
    return a === unit.side;
  }
  /** 汇总某单位当前生效的口胡修正（倍率相乘、加减项相加、能力阶级取单次上限） */
  function improvMult(state, unit, key, seed) {
    var list = obj(state.meta).improvs || [];
    var v = seed === undefined ? 1 : seed;
    for (var i = 0; i < list.length; i++) {
      var im = list[i];
      if (!im || im.剩余回合 !== null && toInt(im.剩余回合, 0) <= 0) continue;
      if (!improvCovers(im, unit)) continue;
      var val = num(obj(im.修正)[key], key === '命中修正' || key === '暴击等级' ? 0 : 1);
      v = (key === '命中修正' || key === '暴击等级') ? v + val : v * val;
    }
    return v;
  }
  function improvStages(state, unit) {
    var out = {};
    var list = obj(state.meta).improvs || [];
    for (var i = 0; i < list.length; i++) {
      var im = list[i];
      if (!im || (im.剩余回合 !== null && toInt(im.剩余回合, 0) <= 0)) continue;
      if (!improvCovers(im, unit)) continue;
      var b = obj(obj(im.修正).能力阶级);
      var keys = Object.keys(b);
      for (var k = 0; k < keys.length; k++) {
        out[keys[k]] = clamp(toInt(out[keys[k]], 0) + toInt(b[keys[k]], 0), IMPROV_LIMITS.能力阶级[0], IMPROV_LIMITS.能力阶级[1]);
      }
    }
    return out;
  }

  /** 夹紧并返回 {value, clamped, reason} */
  function clampImprov(key, raw) {
    var lim = IMPROV_LIMITS[key];
    if (!lim) return { value: raw, clamped: false };
    var v = num(raw, 0);
    var c = clamp(v, lim[0], lim[1]);
    return { value: c, clamped: c !== v, reason: key + ' 允许范围 ' + lim[0] + '~' + lim[1] + '，已夹到 ' + c };
  }

  /**
   * ENG.applyImprov(state, {来源,描述,作用,修正,持续回合}) → {state, log}
   *   - 倍率/加减项一律夹紧，越界写 warning 日志
   *   - 不接受直接改 HP 的字段（只有「回复」这一条受控的体力通道）
   *   - log 里 kind:'improv'，text 以「口胡：」开头，并单独记录到 meta.improvLog
   */
  function applyImprovImpl(state, spec) {
    if (!isEngineState(state)) fail('applyImprov：state 不是 startFromStat 的产物');
    var st = state;
    var s = obj(spec);
    var desc = String(s.描述 || '').trim();
    if (!desc) fail('applyImprov：缺少「描述」字段（用于日志与战报，必填）');
    var src = String(s.来源 || 'AI');
    var effect = String(s.作用 || 'ally');
    if (['ally', 'foe', 'both'].indexOf(effect) < 0) fail('applyImprov：「作用」只能是 ally / foe / both');
    var raw = obj(s.修正);
    var logs = [];
    var warnings = [];
    var applied = {};

    /* 明确拒绝直接改体力 */
    var forbidden = ['体力', '当前体力', 'hp', 'HP', '体力值', '伤害值'];
    for (var fi = 0; fi < forbidden.length; fi++) {
      if (raw[forbidden[fi]] !== undefined) {
        warnings.push('口胡通道不能直接改体力（收到字段「' + forbidden[fi] + '」已忽略）；请改用「伤害倍率」或「回复」');
      }
    }
    /* 白名单之外的修正字段 */
    var rk = Object.keys(raw);
    for (var ri = 0; ri < rk.length; ri++) {
      if (IMPROV_ALLOWED_KEYS.indexOf(rk[ri]) < 0) {
        warnings.push('修正字段「' + rk[ri] + '」不在白名单内，已忽略');
      }
    }

    ['威力倍率', '伤害倍率', '伤害减免', '命中修正', '暴击等级'].forEach(function (key) {
      if (raw[key] === undefined) return;
      var c = clampImprov(key, raw[key]);
      applied[key] = c.value;
      if (c.clamped) warnings.push('口胡修正越界：' + c.reason);
    });
    if (raw.能力阶级 !== undefined) {
      var b = obj(raw.能力阶级), out = {};
      var bk = Object.keys(b);
      for (var bi = 0; bi < bk.length; bi++) {
        var code = STAGE_CODE[bk[bi]] || (STAGE_ZH[bk[bi]] ? bk[bi] : null);
        if (!code) { warnings.push('能力阶级字段「' + bk[bi] + '」无法识别，已忽略'); continue; }
        var cb = clampImprov('能力阶级', b[bk[bi]]);
        out[code] = cb.value;
        if (cb.clamped) warnings.push('口胡修正越界：能力阶级.' + bk[bi] + ' ' + cb.reason);
      }
      if (Object.keys(out).length) applied.能力阶级 = out;
    }
    if (raw.追加状态 !== undefined) {
      var stZh = String(raw.追加状态);
      if (IMPROV_STATUS.indexOf(stZh) < 0) warnings.push('口胡追加状态「' + stZh + '」不在允许列表（' + IMPROV_STATUS.join('/') + '）内，已忽略');
      else applied.追加状态 = stZh;
    }
    if (raw.天气 !== undefined) {
      var w = String(raw.天气);
      if (dex.weathers.indexOf(w) < 0) warnings.push('口胡天气「' + w + '」不在允许列表（' + dex.weathers.join('/') + '）内，已忽略');
      else applied.天气 = w;
    }
    if (raw.场地 !== undefined) {
      var t = String(raw.场地);
      if (dex.terrains.indexOf(t) < 0) warnings.push('口胡场地「' + t + '」不在允许列表（' + dex.terrains.join('/') + '）内，已忽略');
      else applied.场地 = t;
    }
    if (raw.回复 !== undefined) {
      var ch = clampImprov('回复', raw.回复);
      applied.回复 = ch.value;
      if (ch.clamped) warnings.push('口胡修正越界：回复 ' + ch.reason);
    }
    if (s.持续回合 !== undefined) {
      var ct = clampImprov('持续回合', s.持续回合);
      applied.持续回合 = Math.round(ct.value);
      if (ct.clamped) warnings.push('口胡持续回合越界：' + ct.reason);
    }

    var entry = {
      id: 'IMP' + (toInt(obj(st.meta).turnCount, 0)) + '-' + ((obj(st.meta).improvs || []).length + 1),
      来源: src, 描述: desc, 作用: effect, 修正: applied,
      持续回合: applied.持续回合 === undefined ? null : applied.持续回合,
      剩余回合: applied.持续回合 === undefined ? null : applied.持续回合,
      回合: toInt(obj(st.meta).turnCount, 0)
    };
    if (!Array.isArray(st.meta.improvs)) st.meta.improvs = [];
    st.meta.improvs.push(entry);

    /* warning 日志 */
    for (var wi = 0; wi < warnings.length; wi++) {
      logs.push(addEntry(st, {
        turn: entry.回合, actor: 'ally', actorName: '引擎', kind: 'improv', improveId: entry.id,
        notes: ['（warning）' + warnings[wi]], text: '⚠ 口胡告警：' + warnings[wi]
      }));
    }

    /* 正面效果落地：能力阶级 / 状态 / 天气 / 场地 / 回复 */
    var targets = effect === 'both' ? [st.battle.ally, st.battle.foe]
      : (effect === 'foe' ? [st.battle.foe] : [st.battle.ally]);
    var notes = [];
    for (var ti = 0; ti < targets.length; ti++) {
      var u = targets[ti];
      if (!u) continue;
      if (applied.能力阶级) {
        var ch2 = applyStages(u, applied.能力阶级);
        if (Object.keys(ch2).length) notes.push(u.nickname + ' 的' + stageChangeText(ch2));
      }
      if (applied.追加状态) {
        var code2 = dex.statusCode(applied.追加状态);
        if (canApplyStatus(dex, null, u, code2)) { setStatus(u, code2, { rng: Math.random }); notes.push(u.nickname + ' 陷入' + dex.statusText(code2)); }
        else notes.push(u.nickname + ' 未能进入' + dex.statusText(code2));
      }
      if (applied.回复 && u.curHP > 0) {
        var heal = Math.max(1, Math.floor(u.maxHP * num(applied.回复, 0)));
        var before = u.curHP;
        u.curHP = Math.min(u.maxHP, u.curHP + heal);
        notes.push(u.nickname + ' 回复 ' + (u.curHP - before) + ' 点体力（口胡「回复」，上限为体力上限的一半）');
      }
    }
    if (applied.天气) { st.battle.weather = applied.天气; st.battle.场地效果 = weatherText(applied.天气); notes.push('天气变为 ' + applied.天气); }
    if (applied.场地) { st.battle.场地效果[applied.场地] = {}; notes.push('场地变为 ' + applied.场地); }

    var text = '口胡：[' + src + '] ' + desc + '（作用：' + effect + '；修正：' + improvText(applied) + '）' +
      (notes.length ? ' → ' + notes.join('，') : '');
    var main = addEntry(st, {
      turn: entry.回合, actor: 'ally', actorName: '口胡/' + src, kind: 'improv', improveId: entry.id,
      notes: notes, text: text
    });
    logs.unshift(main);
    if (!Array.isArray(st.meta.improvLog)) st.meta.improvLog = [];
    st.meta.improvLog.push(main);
    return { state: st, log: logs };
  }

  /** 口胡修正的可读描述 */
  function improvText(mod) {
    var m = obj(mod);
    var order = ['威力倍率', '伤害倍率', '伤害减免', '命中修正', '暴击等级', '回复', '追加状态', '天气', '场地', '持续回合'];
    var parts = [];
    for (var i = 0; i < order.length; i++) {
      if (m[order[i]] !== undefined) parts.push(order[i] + '=' + m[order[i]]);
    }
    if (m.能力阶级) {
      var b = obj(m.能力阶级), sub = [];
      var bk = Object.keys(b);
      for (var j = 0; j < bk.length; j++) sub.push((STAGE_ZH[bk[j]] || bk[j]) + (b[bk[j]] > 0 ? '+' + b[bk[j]] : b[bk[j]]));
      parts.push('能力阶级[' + sub.join(' ') + ']');
    }
    return parts.length ? parts.join(' ') : '无实质修正';
  }

  function listImprovsImpl(state) {
    var list = obj(obj(state).meta).improvs || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push({
        来源: list[i].来源, 描述: list[i].描述, 作用: list[i].作用,
        修正: deepClone(list[i].修正), 剩余回合: list[i].剩余回合,
        回合: list[i].回合, id: list[i].id
      });
    }
    return out;
  }

  function clearImprovsImpl(state) {
    if (!isEngineState(state)) fail('clearImprovs：state 不是 startFromStat 的产物');
    var n = (obj(state.meta).improvs || []).length;
    state.meta.improvs = [];
    /* 撤销时把口胡带来的能力阶级一并归零，避免“撤了描述还留着数值” */
    var units = [state.battle.ally, state.battle.foe].concat(state.battle.bench || [], state.battle.foeBench || []);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u || !u.stages) continue;
      u.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
    }
    addEntry(state, {
      turn: toInt(obj(state.meta).turnCount, 0), actor: 'ally', actorName: '引擎', kind: 'improv',
      notes: ['已撤销 ' + n + ' 条口胡项'], text: '口胡：已清空全部口胡项（共 ' + n + ' 条），能力阶级一并归零。'
    });
    return { state: state, cleared: n };
  }

  /**
   * 由「体力上限」反推等级（契约 10.7）。
   * 卡的开战断点只写 对方战位.体力上限，没有等级，所以按
   *   floor((2×体力种族 + 31) × L / 100) + L + 10
   * 在 L=1..100 里找使体力上限等于（或最接近）槽位值的那一级。
   * 验证算例：大嘴娃（体力种族 50）体力上限 56 → L=20。
   */
  function deriveLevelFromHP(dex, speciesEntry, targetHP, targetHP2) {
    var target = num(targetHP !== undefined ? targetHP : targetHP2, 0);
    if (!speciesEntry || !target) return null;
    var base = num(obj(speciesEntry.baseStats).hp, 0);
    if (!base) return null;
    var best = null, bestDiff = Infinity;
    for (var L = 1; L <= 100; L++) {
      var hp = calcStat('hp', base, DEFAULT_IV, L, { up: null, down: null });
      var diff = Math.abs(hp - target);
      if (diff < bestDiff) { bestDiff = diff; best = L; if (diff === 0) break; }
    }
    return best;
  }

  /**
   * 为没有技能位的对手合成 3~4 个合理招式（契约 10.7）。
   *   优先该种族属性的攻击招式（威力 40~90）→ 按 atk/spa 决定偏物理还是偏特殊
   *   → 不足再补变化招式 → 最后兜底「撞击」。
   * 合成结果走名称解析，写回时用中文官方名。
   */
  /**
   * 【已移除·契约 10.16】招式合成。
   * 用户决定：不再替作者/模型编招式 —— 我们没有"招式学习面"数据，合成会给出该宝可梦
   * 根本学不会的招式（实测：给 Lv.17 可可多拉合成了「彗星拳」）。缺技能位时一律走
   * 兜底招式 + 开战日志明确提示，交由卡/作者修。
   */
  function synthesizeMoves() {
    return [];
  }

  /**
   * 变量 → 引擎天气（用户裁决口径）：
   *   当前对战.场地效果.天气 / 世界与系统.当前天气 里含「雨」→ 雨；
   *   含「大晴天」或「日照强烈」→ 大晴天（火 ×1.5 / 水 ×0.5）；
   *   普通「晴 / 晴天」→ 晴，但 weatherMul 对它不产生任何倍率（口径见 weatherMul）；
   *   沙暴 / 冰雹（雪）保持原样。
   */
  function deriveWeather(cur, sd) {
    var eff = obj(cur.场地效果);
    /* 真机/卡里的形态：场地效果 = { 天气: '晴', 电气场地: {}, 戏法空间: {} } —— 读它的**值** */
    var effWeather = String(eff.天气 === undefined || eff.天气 === null ? '' : eff.天气).trim();
    if (effWeather && !/^(无|无天气|正常|—|-|none)$/i.test(effWeather)) {
      if (/大晴天/.test(effWeather)) return '大晴天';
      if (/日照强烈/.test(effWeather)) return '日照强烈';
      if (/雨/.test(effWeather)) return '雨';
      if (/晴/.test(effWeather)) return '晴';
      if (/沙暴/.test(effWeather)) return '沙暴';
      if (/雪|冰雹/.test(effWeather)) return '冰雹';
      return effWeather;   /* 自定义天气原样带入（weatherMul 不认识就不产生倍率） */
    }
    /* 兼容「把天气名当键」的老形态：{ 雨: true } / { 大晴天: {} } */
    var keys = Object.keys(eff);
    for (var i = 0; i < keys.length; i++) {
      if (/雨|大晴天|日照强烈|晴|沙暴|冰雹|雪/.test(keys[i])) return keys[i];
    }
    var world = String(obj(sd.世界与系统).当前天气 || '');
    if (/雨/.test(world)) return '雨';
    if (/大晴天/.test(world)) return '大晴天';
    if (/日照强烈/.test(world)) return '日照强烈';
    if (/晴/.test(world)) return '晴';
    if (/沙暴/.test(world)) return '沙暴';
    if (/雪|冰雹/.test(world)) return '冰雹';
    return null;
  }

  /** 招式自带天气的规范化：招式名是「大晴天/日照强烈」时，数据表里写的「晴」按大晴天落地 */
  function normalizeMoveWeather(move, value) {
    var v = String(value === undefined || value === null ? '' : value);
    var nm = String((move && (move.zh || move.en)) || '');
    if (/大晴天|日照强烈/.test(nm) && !/雨|沙暴|冰雹|雪/.test(v)) return '大晴天';
    return v;
  }
  function weatherText(w) { return w ? { 天气: w } : {}; }

  /** 记一条日志（内部用，深拷贝进 state.meta.lastLog） */
  function addEntry(state, entry) {
    var e = deepClone(entry);
    if (!Array.isArray(e.notes)) e.notes = e.notes ? [String(e.notes)] : [];
    if (!e.text) e.text = entryText(e);
    state.meta.lastLog.push(e);
    return e;
  }

  function entryText(e) {
    var who = e.actorName || '';
    if (e.kind === 'move') {
      var s = who + ' 使用了 ' + (e.move || '招式') + '！';
      if (e.hit === false) return s + '但是没有命中' + (e.targetName ? ' ' + e.targetName : '') + '。';
      var notes = (e.notes || []).join('');
      if (e.damage) return s + notes + '对 ' + (e.targetName || '目标') + ' 造成 ' + e.damage + ' 点伤害。';
      return s + notes;
    }
    if (e.kind === 'switch') return who + ' 上场了！';
    if (e.kind === 'faint') return who + ' 倒下了！';
    if (e.kind === 'status') return (e.notes || []).join('') || who + ' 状态变化。';
    if (e.kind === 'end') return (e.notes || []).join('') || '战斗结束。';
    return who;
  }

  /**
   * 登场时触发（特性总入口）：
   *   威吓、天气类、场地类、下载、预知梦/危险预知、察觉、复制类、画皮护盾挂载…
   *   实现见 §2.8 hookSwitchIn；这里保留一个薄封装以兼容原有调用点。
   */
  function onSwitchIn(dex, state, unit, opponent) {
    if (!unit || unit.fainted) return;
    if (state && state.battle) {
      var field = fieldUnits(state);
      for (var i = 0; i < field.length; i++) bindState(field[i], state);
    }
    hookSwitchIn(dex, state, unit, opponent);
    try { applyEntryHazards({ dex: dex, state: state, turn: toInt(obj(state.meta).turnCount, 0) }, unit); } catch (e) { /* 钉子钩子失败绝不影响上场流程 */ }
  }

  /** 该侧在场数组（阶段 A：我方 1 只 + 对手 N 只；B 阶段每侧 2 只） */
  function sideArray(st, side) {
    ensureFieldArrays(st);
    return side === 'ally' ? st.battle.allies : st.battle.foes;
  }
  /** 该侧的第 index 只（越界时为 null） */
  function unitAt(st, side, index) {
    var arr = sideArray(st, side);
    return arr[toInt(index, 0)] || null;
  }
  /** 第一个存活单位（按在场顺序） */
  function firstAliveOf(arr) {
    for (var i = 0; i < (arr || []).length; i++) {
      if (arr[i] && !arr[i].fainted && num(arr[i].curHP, 0) > 0) return arr[i];
    }
    return null;
  }

  /**
   * 回合动作列表归一化（阶段 A 的**列表接口**；B 阶段只需往列表里加我方第二个动作）。
   *   新形状：{ actions: [{ side:'ally'|'foe', unitIndex:0, action:{kind:'move', move, target} }] }
   *   旧形状：{ allyAction, foeAction }  —— 等价于上面列表的两条（unitIndex = 0），完全兼容
   */
  function normalizeRoundActions(act) {
    var out = [];
    if (Array.isArray(act.actions)) {
      for (var i = 0; i < act.actions.length; i++) {
        var raw = act.actions[i];
        if (!isPlainObject(raw)) continue;
        var side = raw.side === 'foe' ? 'foe' : 'ally';
        var idxRaw = raw.unitIndex !== undefined ? raw.unitIndex : raw.index;
        out.push({
          side: side,
          unitIndex: Math.max(0, toInt(idxRaw, 0)),
          action: raw.action !== undefined ? raw.action : raw
        });
      }
      return out;
    }
    out.push({ side: 'ally', unitIndex: 0, action: act.allyAction });
    out.push({ side: 'foe', unitIndex: 0, action: act.foeAction });
    return out;
  }

  /**
   * §4.1 resolveRound（旧名 resolveTurn，两个名字指向同一个函数）
   *   返回 { state, log, patches, ended, winner, error? }
   *   - state 是新对象（不改入参）
   *   - error 非空表示本回合有行动被拒绝/替换（如 PP 耗尽）
   *   - 动作列表 actions.actions（阶段 A：玩家 1 个 + 每只对手各 1 个）
   */
  function makeResolveTurn(dex) {
    return function resolveRound(battleState, actions) {
      if (!isEngineState(battleState)) fail('resolveRound：state 不是 startFromStat 的产物');
      var act = obj(actions);
      var opts = obj(act.opts);
      var st = deepClone(battleState);
      st.meta.lastLog = [];
      /* 契约 10.28：__stat / __orig 都是不可枚举属性，deepClone 会丢掉。
       * 这里在克隆体上重建，保证「对手槽位原值」在每一回合都可用（写回保护不会退化）。 */
      var prevStat = battleState && battleState.__stat;
      if (prevStat) {
        try {
          Object.defineProperty(st, '__stat', { value: prevStat, writable: true, configurable: true, enumerable: false });
        } catch (e2) { st.__stat = prevStat; }
      }
      restoreFoeOrig(st);
      if (st.ended) {
        return { state: st, log: [], patches: [], ended: true, winner: st.winner || null, error: '战斗已结束，无法继续结算' };
      }
      var rng = mkRng(act.rng);
      st.meta.turnCount = toInt(st.meta.turnCount, 0) + 1;
      var turn = st.meta.turnCount;
      var errors = [];
      var ctx = {
        dex: dex, state: st, rng: rng, turn: turn, errors: errors,
        weather: st.battle.weather, opts: opts
      };
      /* 兼容直接传入序列化后 state 的情况：保证 dex 一定在 ctx 上 */
      if (!ctx.dex || typeof ctx.dex.statusText !== 'function') ctx.dex = dex;

      ensureFieldArrays(st);

      /* ---- 0. 动作列表归一化 + 特殊机制规程（契约 10.1：card 单场单机制、四选一且仅限一只） ---- */
      var actList = normalizeRoundActions(act);
      for (var mi = 0; mi < actList.length; mi++) {
        var mit = actList[mi];
        mit.unit = unitAt(st, mit.side, mit.unitIndex);
        mit.action = normalizeAction(mit.action, mit.unit);
        mit.action = ladderRewriteAction(ctx, mit.side, mit.action, mit.unit);   /* [天梯补丁 02/06] */
        checkMechanics(ctx, mit.side, mit.action, mit.unit);
        if (st.ended) return finishTurn(ctx);
      }

      /* ---- 1. 换人/道具优先，在回合开始立即执行 ---- */
      var switched = {};
      var switchKey = function (it) { return it.side + ':' + it.unitIndex; };
      for (var e = 0; e < actList.length; e++) {
        var item = actList[e];
        if (!item.action) continue;
        if (item.action.kind === 'switch') {
          var r = doSwitch(ctx, item.side, item.action, item.unit, item.unitIndex);
          if (r.err) {
            errors.push(r.err);
            /* 契约 10.9：拒绝原因要能看见（面板日志/战报都会带上） */
            addEntry(st, {
              turn: turn, actor: item.side, actorName: item.unit ? item.unit.nickname : '', kind: 'status',
              notes: ['（换人被拒绝）'], text: '⚠ ' + r.err
            });
          } else switched[switchKey(item)] = true;
        } else if (item.action.kind === 'item') {
          doItem(ctx, item.side, item.action);
        } else if (item.action.kind === 'run') {
          doRun(ctx, item.side, item.action);
        }
      }
      if (st.ended) return finishTurn(ctx);

      /* ---- 2. 行动顺序：priority → 速度 → 同速随机 ----
       * 特性接入：恶作剧之心/疾风之翼/先行治疗/速击（优先度）、
       *           慢出/菌丝之力（一定后手）、拨沙/悠游自如/飞毛腿（速度）。 */
      var order = [];
      for (var ai = 0; ai < actList.length; ai++) {
        var it = actList[ai];
        if (!it.action) continue;
        if (switched[switchKey(it)]) continue;
        var ak = it.action.kind;
        if (ak === 'item' || ak === 'run') continue;
        if (ak === 'skip') {
          /* 该单位本回合无法行动（AI 判定无可用招式）：如实记日志，不静默吞掉。
           * 已经倒下的单位不记（它会由补位逻辑处理）。 */
          if (it.unit && !it.unit.fainted && num(it.unit.curHP, 0) > 0) {
            addEntry(st, {
              turn: turn, actor: it.side, actorName: it.unit.nickname, kind: 'status',
              notes: ['（无法行动）'],
              text: it.unit.nickname + ' 没有可用的招式，本回合无法行动。'
            });
          }
          continue;
        }
        if (!it.unit || it.unit.fainted || it.unit.curHP <= 0) continue;
        /* 目标记录在 step 上，执行前才解析 —— 这样"目标倒下→自动重定向"才有意义 */
        order.push({
          side: it.side, unitIndex: it.unitIndex, unit: it.unit,
          targetIndex: it.action.target, action: it.action
        });
      }
      /* 特性出招前钩子（形态/属性改写、懒惰、菌丝之力后手） */
      for (var oi0 = 0; oi0 < order.length; oi0++) {
        var oUnit = order[oi0].unit;
        if (!oUnit) continue;
        bindState(oUnit, st);
        var oSlot = findSlot(oUnit, order[oi0].action.move) || firstUsable(oUnit);
        var bm = hookBeforeMove(ctx, oUnit, oSlot);
        if (bm && bm.blocked) order[oi0].blocked = true;
      }
      for (var oi = 0; oi < order.length; oi++) {
        order[oi].action.unit = order[oi].unit;
        order[oi].action.__rng = rng;
        order[oi].prio = actionPriority(dex, order[oi].action);
        if (order[oi].blocked) order[oi].prio = -99;      /* 懒惰：本回合不行动 */
        if (ctx.forceLast && ctx.forceLast[order[oi].side]) order[oi].prio = -100;  /* 慢出/菌丝之力 */
      }
      /* 同优先度：速度降序；同速用 rng 决定 */
      order.sort(function (a, b) {
        if (b.prio !== a.prio) return b.prio - a.prio;
        var sa = effSpeed(a.unit, ctx), sb = effSpeed(b.unit, ctx);
        if (sb !== sa) return sb - sa;
        return rng() < 0.5 ? -1 : 1;
      });
      /* 最后一个行动的单位标记（分析特性需要） */
      for (var ol = 0; ol < order.length; ol++) order[ol].movesLast = (ol === order.length - 1);

      /* ---- 3. 逐条执行：每次行动前**重新校验目标是否存活**（触发自动重定向） ---- */
      for (var k = 0; k < order.length; k++) {
        if (st.ended) break;
        var step = order[k];
        if (!step.unit || step.unit.fainted) continue;
        if (step.blocked) continue;
        ctx.movesLast = !!step.movesLast;
        executeMoveForAction(ctx, step, act.keepGoing);
        /* 契约 10.45：折返类招式 —— 在**这个行动位**立刻换人：
           · 不消耗回合（同一回合内完成攻击+换人）
           · 后面的行动打的是**换上来的**那只（原单位不再吃本回合后续伤害）
           · 换上来的那只照常触发出场钩子（含入场钉子）
           换谁：优先用调用方给的 action.pivotTo（玩家自选）；没给就取待命第一只健康。 */
        try {
          var __mv = step && step.action ? String(step.action.move || '') : '';
          if (PIVOT_MOVES[__mv] && step.unit && !step.unit.fainted && num(step.unit.curHP, 0) > 0 && !ctx.state.ended) {
            var __bench = (step.side === 'foe') ? st.battle.foeBench : st.battle.bench;
            var __healthy = (__bench || []).filter(function (u) { return u && !u.fainted && num(u.curHP, 0) > 0; });
            if (__healthy.length) {
              /* 契约 10.55：折返换人**必须由调用方指定**（玩家自选）。
                 没有指定就不换人、并写清原因 —— 绝不替玩家挑一只（用户口径：自选切）。 */
              var __to = String(step.action.pivotTo || '').trim();
              var __okTo = __to && __healthy.some(function (u) { return u.nickname === __to || u.species === __to; });
              if (!__okTo) {
                addEntry(st, { turn: turn, actor: step.side, actorName: step.unit.nickname, kind: 'status',
                  notes: ['（折返未指定换上场的宝可梦）'],
                  text: '⚠ ' + __mv + '：没有指定换上场的宝可梦，本次不换人（请在待命列表里选一只）。' });
              } else {
                var __r = doSwitch(ctx, step.side, { to: __to }, step.unit, step.unitIndex);
                if (__r && __r.err) {
                  addEntry(st, { turn: turn, actor: step.side, actorName: step.unit.nickname, kind: 'status',
                    notes: ['（折返换人失败）'], text: '⚠ ' + __mv + ' 换人失败：' + __r.err });
                } else {
                  var __new = unitAt(st, step.side, step.unitIndex);
                  addEntry(st, { turn: turn, actor: step.side, actorName: step.unit.nickname, kind: 'switch',
                    notes: ['（折返）'], text: __mv + '！' + step.unit.nickname + ' 退场，换上了 ' + ((__new && __new.nickname) || __to) + '。' });
                }
              }
            }
          }
        } catch (e) { /* 折返失败绝不影响本轮其他行动 */ }
        forceSwitchIfNeeded(ctx);
      }

      /* ---- 4. 回合末 ---- */
      endOfTurn(ctx);
      forceSwitchIfNeeded(ctx);
      checkEnd(ctx);
      return finishTurn(ctx);
    };
  }

  function finishTurn(ctx) {
    var st = ctx.state;
    ensureDex(st, ctx.dex || ctx.state.__dex);
    /* 口胡项持续回合推进（契约 10.2） */
    var improvLog = tickImprovs(st);
    var log = st.meta.lastLog.slice().concat(improvLog);
    var patches = toPatchesImpl(st, undefined, ctx.dex);
    return {
      state: st, log: log, patches: patches,
      ended: !!st.ended, winner: st.winner || null,
      error: ctx.errors.length ? ctx.errors.join('；') : null
    };
  }

  /**
   * 特殊机制规程检查（契约 10.1）：
   *   card 且非野外无限制子模式时，单场一方只能激活一次特殊机制（四选一且单场仅限一只），超限判负。
   * official 不限制机制，只做记录。
   */
  function checkMechanics(ctx, side, action, unitOverride) {
    var st = ctx.state, dex = ctx.dex;
    var rules = obj(st.meta.rules);
    /* normalizeAction 会把机制 action 归一成 kind:'move'，原始机制名留在 specialKind 上 */
    var mechKind = (action && (action.specialKind || action.special)) || '';
    if (!mechKind || ['mega', 'tera', 'dmax', 'z'].indexOf(mechKind) < 0) return;
    var kindKey = mechKind;
    /* 注意：不能用 obj() 取数组（isPlainObject 排除数组，会返回 {} 并每回合重建记录，
       导致「单场单机制」永远累计不到第 2 次、判负永不触发）。这里直接按数组取用。 */
    if (!isPlainObject(st.meta.mechanicsUsed)) st.meta.mechanicsUsed = { ally: [], foe: [] };
    var mu = st.meta.mechanicsUsed;
    if (!Array.isArray(mu[side])) mu[side] = [];
    var used = mu[side];
    var unit = unitOverride || (side === 'ally' ? st.battle.ally : st.battle.foe);
    var who = unit ? unit.nickname : side;
    var label = { mega: '超级进化', z: 'Z招式', dmax: '极巨化', tera: '太晶化' }[kindKey] || kindKey;

    var exceeds = false;
    var why = '';
    if (rules.单场单机制) {
      if (used.length >= 1) {
        exceeds = true;
        why = '本场已激活过 ' + (used[0].机制中文 || used[0].机制) + '（' + used[0].使用者 + '），单场仅限一次';
      } else {
        /* 单场仅限一只：同一场里换过人的话，机制要绑在场上那只 */
        var firstUser = used.length ? used[0].使用者 : '';
        if (firstUser && firstUser !== who) {
          exceeds = false; /* 未被使用过，允许 */
        }
      }
    }
    if (exceeds) {
      st.meta.violations = st.meta.violations || [];
      st.meta.violations.push({ kind: 'mechanic', side: side, detail: who + ' 尝试再次激活 ' + label });
      var txt = '⚠ 单场单机制规程违例：' + who + ' 尝试激活 ' + label + '，' + why + '，立即判负。';
      addEntry(st, {
        turn: ctx.turn, actor: side, actorName: who, kind: 'end', notes: [txt], text: txt
      });
      st.ended = true;
      st.winner = side === 'ally' ? 'foe' : 'ally';
      st.endReason = '单场单机制规程违例（判负）';
      return;
    }
    used.push({ 机制: kindKey, 机制中文: label, 使用者: who, 回合: ctx.turn });
    action.__recorded = true;
    addEntry(st, {
      turn: ctx.turn, actor: side, actorName: who, kind: 'status',
      notes: ['激活特殊机制：' + label],
      text: who + ' 激活了特殊机制：' + label + '（本场第 ' + used.length + ' 次' +
        (rules.单场单机制 ? '，规程上限 1 次' : '') + '）'
    });
  }

  /* [天梯补丁 02] 挣扎用的临时技能位：无属性（???）、必中、反伤由 moveAgainstTarget 按 1/4 最大体力结算 */
  function makeStruggleSlot(dex) {
    var base = (dex && typeof dex.move === 'function' && dex.move('挣扎')) ||
      { en: 'Struggle', zh: '挣扎', category: 'physical', power: 50, pp: 1, priority: 0, target: 'randomNormal', flags: ['contact', 'protect'], secondaries: [] };
    var mv = {};
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i++) mv[keys[i]] = base[keys[i]];
    mv.type = '???'; mv.accuracy = null; mv.recoil = null; mv.drain = null; mv.secondaries = [];
    mv.__struggle = true;
    return { name: '挣扎', move: mv, curPP: 1, maxPP: 1, 原名称: '挣扎', 未识别: false, 识别方式: 'struggle', 修正自: '', 未识别原因: '', __struggle: true };
  }
  /* [天梯补丁 02] 这一次出招是否只能挣扎：全部招式 PP 为 0，或该动作不允许换招（讲究锁招）且所选招式 PP 为 0 */
  function needsStruggle(unit, action) {
    if (!unit || !Array.isArray(unit.moves) || !unit.moves.length) return false;
    if (action && action.__struggle) return true;
    if (!firstUsable(unit)) return true;
    if (action && action.__noFallback) {
      var s = findSlot(unit, action.move);
      return !!(s && s.curPP <= 0);
    }
    return false;
  }
  /* [天梯补丁 02/06] 回合开始、排序之前改写出招：先套讲究锁招，再判断是否只能挣扎 */
  function ladderRewriteAction(ctx, side, action, unit) {
    if (!action || action.kind !== 'move' || !unit || unit.fainted) return action;
    /* [天梯补丁 06] 讲究锁招：已锁定时只能使用锁定的招式 */
    try {
      var __lk = unit.volatile && unit.volatile['锁招'];
      if (__lk) {
        var __cd = itemDefOf(unit);
        var __ls = (__cd && __cd.choiceLock) ? findSlot(unit, __lk) : null;
        if (!__ls) {
          delete unit.volatile['锁招'];   /* 道具没了 / 不再是讲究系 / 招式不在了 → 解除 */
        } else {
          var a1 = {};
          for (var k1 in action) if (Object.prototype.hasOwnProperty.call(action, k1)) a1[k1] = action[k1];
          a1.__noFallback = true;
          if (findSlot(unit, action.move) !== __ls) {
            a1.__lockedFrom = action.move;
            a1.move = __ls.name;
            if (__ls.curPP > 0) addEntry(ctx.state, {
              turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status', move: __ls.name,
              notes: ['（' + itemNameOf(unit) + '·锁招）'],
              text: unit.nickname + ' 受到' + itemNameOf(unit) + '的影响，只能使出 ' + __ls.name + '！'
            });
          }
          action = a1;
        }
      }
    } catch (eLk) { }
    if (needsStruggle(unit, action) && !findSlot(unit, '挣扎')) {
      var a2 = {};
      for (var k in action) if (Object.prototype.hasOwnProperty.call(action, k)) a2[k] = action[k];
      a2.__struggleFrom = action.move;
      a2.move = '挣扎';
      a2.__struggle = true;
      addEntry(ctx.state, {
        turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status', move: '挣扎',
        notes: ['（挣扎）'], text: unit.nickname + ' 已经没有可以使用的招式了！'
      });
      return a2;
    }
    return action;
  }

  function normalizeAction(raw, unit) {
    var a = raw;
    if (typeof a === 'string') a = { kind: 'move', move: a };
    a = obj(a);
    var kind = a.kind || (a.move ? 'move' : (a.to ? 'switch' : (a.item ? 'item' : 'move')));
    /* 阶段 A：目标索引（对手侧战位，0 基）。缺省 = 第一个存活对手，执行前才解析。 */
    var target = a.target !== undefined ? a.target : a.目标;
    if (kind === 'mega' || kind === 'tera' || kind === 'dmax' || kind === 'z') {
      /* 特殊机制：MVP 只当成一次普通出招，但保留原始机制名供规程检查（契约 10.1） */
      return { kind: 'move', move: a.move, target: target, special: kind, specialKind: kind, raw: a, unit: unit };
    }
    var __out = { kind: kind, move: a.move, target: target, to: a.to, item: a.item, special: a.special || '', specialKind: '', raw: a, unit: unit };
    /* 契约 10.56：`pivotTo`（折返换人指定谁）必须原样带下去 ——
       之前被这里吃掉，导致"玩家自选"根本没到引擎（被自动挑一只的兜底掩盖了）。 */
    if (a.pivotTo !== undefined) __out.pivotTo = a.pivotTo;
    return __out;
  }

  function actionPriority(dex, action) {
    /* 契约 10.87：先制之爪 —— 20% 概率抢在全部招式之前行动 */
    /* 契约 10.101：先制之爪**不在 actionPriority 里随机**（那里拿不到确定性 rng ✗，
       用 Math.random 会污染所有时序测试）。改由行动顺序阶段处理，见 resolveRound。 */

    var prio = 0;
    var mv = null;
    if (action.kind !== 'move') return 6;
    mv = dex.move(action.move);
    if (!mv) {
      /* 可能是 PP 已耗尽的招式或数据缺失：按兜底招式优先度 */
      var fb = dex.move(BASIC[0]);
      prio = fb ? toInt(fb.priority, 0) : 0;
    } else {
      prio = toInt(mv.priority, 0);
    }
    /* 特性优先度：恶作剧之心 / 疾风之翼 / 先行治疗 / 速击 */
    if (mv) {
      var unit = action.unit;
      var p = unit ? abilityParams(unit, 'modify_priority') : null;
      if (p && condOk(p.when, unit, { move: mv, attacker: unit })) {
        var plus = num(p.plus, 0);
        if (p.chance !== undefined) {
          /* 概率型先制（速击）：用引擎随机源判定 */
          var rr = (action.__rng || Math.random)();
          if (rr * 100 < num(p.chance, 0)) prio += plus;
        } else {
          prio += plus;
        }
      }
    }
    return prio;
  }

  /**
   * 出招前的统一准备（技能位解析 / 未收录替换 / PP 判定 / 异常状态闸门）。
   * 返回 { move, slot } 表示「这一招可以打出去了」（PP 已扣 1）；null 表示本次出招作废。
   * **群体招式也只扣 1 次 PP** —— 所以这段与「打到谁身上」必须分开。
   */
  /* 契约 10.108：**自爆/大爆炸类招式用完自身濒死**（真机：双弹瓦斯 自爆后没退场 ✗） */
  var SELFDESTRUCT_MOVES = { '自爆': 1, '大爆炸': 1, '薄雾炸裂': 1, '惊爆大头': 1, '豁命攻击': 1 };
  function executeMoveForAction(ctx, step, keepGoing) {
    var __r = __executeMoveForActionBase(ctx, step, keepGoing);
    try {
      var __mvName = String((step && step.action && step.action.move) || (step && step.move) || '');
      var __u = (step && step.unit) || null;
      if (SELFDESTRUCT_MOVES[__mvName] && __u && !__u.fainted) {
        /* 湿气特性可以阻止自爆 */
        var __blocked = false;
        try { __blocked = abilityHas(__u, 'damp'); } catch (eD) { }
        if (!__blocked) {
          /* 契约 10.115：走**引擎的倒下结算**（faintUnit）—— 直接标记 fainted 会绕过经验/日志/补位 ✗
             （用户报："自爆不给经验"✓） */
          addEntry(ctx.state, { turn: ctx.turn, actor: step.side, actorName: __u.nickname, kind: 'status', notes: ['（自爆）'],
            text: __u.nickname + ' 因为使用了 ' + __mvName + ' 而倒下了！' });
          try { faintUnit(ctx, __u); } catch (eFu) { __u.curHP = 0; __u.fainted = true; }
        }
      }
    } catch (eSd) { }
    return __r;
  }

  /* 契约 10.106：**PP 记忆表** —— 真机每回合都从变量重建战斗，而变量里没有 PP ✗
     → PP 每回合被重置，等于无限 PP ✗。这里按 昵称/招式 记住已消耗的 PP，行动前恢复。 */
  function prepareMove(ctx, side, unit, action) {
    var dex = ctx.dex, st = ctx.state, turn = ctx.turn;
    var fallbackTarget = firstAliveOf(sideArray(st, side === 'ally' ? 'foe' : 'ally'));
    /* 契约 10.103：招式名缺失兜底（真机日志出现 使用了 undefined ✗） */
    try {
      var __nm0 = (action && action.move == null) ? '' : String(action.move).trim();
      if (!__nm0 || __nm0 === 'undefined' || __nm0 === 'null') {
        var __pick0 = null;
        (unit.moves || []).forEach(function (sl) {
          if (__pick0) return;
          if (sl && sl.name && String(sl.name) !== 'undefined' && sl.curPP > 0) __pick0 = sl;
        });
        var __fixed = __pick0 ? String(__pick0.name) : '';
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（招式丢失）'],
          text: unit.nickname + ' 的招式名丢失（收到 ' + JSON.stringify(action && action.move) + '）'
            + (__fixed ? '，已改用「' + __fixed + '」' : '，本回合无法行动') + '。' });
        if (!__fixed) return { ok: false, reason: 'no-move' };
        action.move = __fixed;
      }
    } catch (eNm0) { }
    var slot = findSlot(unit, action.move);
    if (!slot && action && action.__struggle) slot = makeStruggleSlot(dex);   /* [天梯补丁 02] */
    /* 契约 10.122：灭亡之歌 / 无理取闹 / 吵闹 / 白雾 / 交换场地 / 道具操作 / 属性改写 / 特性操作 */
    try {
      var __nmY = String((slot && slot.name) || action.move || '');
      var __sideY = (side === 'ally') ? 'ally' : 'foe';
      var __oppY = sideArray(st, side === 'ally' ? 'foe' : 'ally');
      var __tgtY = __oppY[toInt(action && action.target, 0)] || firstAliveOf(__oppY);
      st.screens = st.screens || {};
      st.screens[__sideY] = st.screens[__sideY] || {};
      /* 灭亡之歌：双方场上都挂 3 回合倒数（倒计时逻辑引擎已有 ✓） */
      if (__nmY === '灭亡之歌') {
        [unit].concat(__oppY.filter(function (u) { return u && !u.fainted; })).forEach(function (u) {
          u.volatile = u.volatile || {}; u.volatile['灭亡之歌'] = 3;
        });
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（灭亡之歌）'], text: '所有宝可梦都听到了灭亡之歌！' });
      }
      /* 无理取闹：对手不能连续两回合用同一招（在下一次 prepareMove 里拦） */
      if (__nmY === '无理取闹' && __tgtY) { __tgtY.volatile = __tgtY.volatile || {}; __tgtY.volatile['无理取闹'] = 3; }
      /* 吵闹：4 回合内全场无法入睡 */
      if (__nmY === '吵闹') { st.__uproar = 4; }
      /* 白雾：5 回合内我方不会被降低能力 */
      if (__nmY === '白雾') { st.screens[__sideY]['白雾'] = 5; }
      /* 交换场地：单打无意义，只记日志 */
      if (__nmY === '交换场地') { addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（交换场地）'], text: '（单打中没有可交换的位置）' }); }
      /* 妖精之锁：下回合双方都不能换人 */
      if (__nmY === '妖精之锁') { st.__fairyLock = 1; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（妖精之锁）'], text: '双方被锁住，暂时无法替换！' }); }
      /* —— 道具操作（运行时转移）—— */
      if ((__nmY === '小偷' || __nmY === '渴望') && __tgtY && !itemNameOf(unit) && itemNameOf(__tgtY)) {
        var __stolen = __tgtY.item; __tgtY.item = null;
        unit.item = __stolen;
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'item', item: itemNameOf(unit), notes: ['（' + __nmY + '）'], text: unit.nickname + ' 偷走了 ' + __tgtY.nickname + ' 的 ' + itemNameOf(unit) + '！' });
      }
      if (__nmY === '拍落' && __tgtY && itemNameOf(__tgtY)) {
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'item', item: itemNameOf(__tgtY), notes: ['（拍落）'], text: __tgtY.nickname + ' 的 ' + itemNameOf(__tgtY) + ' 被打落了！' });
        __tgtY.item = null;
      }
      if ((__nmY === '戏法' || __nmY === '掉包') && __tgtY) {
        var __a1 = unit.item; unit.item = __tgtY.item; __tgtY.item = __a1;
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'item', notes: ['（' + __nmY + '）'], text: '双方交换了携带的道具！' });
      }
      if (__nmY === '腐蚀气体' && __tgtY && itemNameOf(__tgtY)) { var __g = itemNameOf(__tgtY); __tgtY.item = null; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'item', item: __g, notes: ['（腐蚀气体）'], text: __tgtY.nickname + ' 的 ' + __g + ' 被腐蚀掉了！' }); }
      if (__nmY === '大快朵颐') { unit.__ateBerry = true; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'item', notes: ['（大快朵颐）'], text: unit.nickname + ' 吃掉了携带的树果！' }); }
      /* —— 属性改写 —— */
      var __typeSet = { '浸水': ['水'], '魔法粉': ['超能力'], '万圣夜': null, '森林诅咒': null };
      if (__nmY === '浸水' && __tgtY) { __tgtY.types = ['水']; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（浸水）'], text: __tgtY.nickname + ' 变成了水属性！' }); }
      if (__nmY === '魔法粉' && __tgtY) { __tgtY.types = ['超能力']; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（魔法粉）'], text: __tgtY.nickname + ' 变成了超能力属性！' }); }
      if (__nmY === '万圣夜' && __tgtY && __tgtY.types.indexOf('幽灵') < 0) { __tgtY.types = __tgtY.types.concat(['幽灵']); addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（万圣夜）'], text: __tgtY.nickname + ' 加上了幽灵属性！' }); }
      if (__nmY === '森林诅咒' && __tgtY && __tgtY.types.indexOf('草') < 0) { __tgtY.types = __tgtY.types.concat(['草']); addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（森林诅咒）'], text: __tgtY.nickname + ' 加上了草属性！' }); }
      if (__nmY === '电磁飘浮') { unit.volatile = unit.volatile || {}; unit.volatile['电磁飘浮'] = 5; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（电磁飘浮）'], text: unit.nickname + ' 浮了起来！' }); }
      if ((__nmY === '奇迹之眼' || __nmY === '识破' || __nmY === '气味侦测') && __tgtY) { __tgtY.volatile = __tgtY.volatile || {}; __tgtY.volatile['被识破'] = 1; }
      if (__nmY === '变小') { unit.stages.eva = Math.min(6, toInt(unit.stages.eva, 0) + 2); }
      if (__nmY === '变圆') { unit.stages.def = Math.min(6, toInt(unit.stages.def, 0) + 1); }
      /* —— 特性操作 —— */
      if (__nmY === '特性互换' && __tgtY) { var __ab = unit.ability; unit.ability = __tgtY.ability; __tgtY.ability = __ab; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（特性互换）'], text: '双方交换了特性！' }); }
      if (__nmY === '烦恼种子' && __tgtY) { __tgtY.ability = '不眠'; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（烦恼种子）'], text: __tgtY.nickname + ' 的特性变成了不眠！' }); }
      if (__nmY === '胃液' && __tgtY) { __tgtY.__abilitySuppressed = true; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（胃液）'], text: __tgtY.nickname + ' 的特性被抑制了！' }); }
      if (__nmY === '扮演' && __tgtY) { unit.ability = __tgtY.ability; }
      if (__nmY === '找伙伴' && __tgtY) { __tgtY.ability = unit.ability; }
      if (__nmY === '单纯光束' && __tgtY) { __tgtY.__simple = true; }
    } catch (eY) { }
    /* 契约 10.121：戏法空间 / 重力 / 交换与平分 / 清钉（这批都是"名字驱动"的简单机制） */
    try {
      var __nmX = String((slot && slot.name) || action.move || '');
      /* 契约 10.123：无理取闹 —— 不能连续两回合用同一招 */
      if (toInt(unit.volatile && unit.volatile['无理取闹'], 0) > 0 && unit.__lastMove && String(unit.__lastMove) === __nmX) {
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（无理取闹）'], text: unit.nickname + ' 被无理取闹影响，不能连续使用同一招！' });
        return { ok: false, reason: 'torment' };
      }

      var __foe0 = sideArray(st, side === 'ally' ? 'foe' : 'ally')[toInt(action && action.target, 0)] || firstAliveOf(sideArray(st, side === 'ally' ? 'foe' : 'ally'));
      var __mine = (side === 'ally') ? 'ally' : 'foe';
      /* 戏法空间：5 回合速度倒转 */
      if (__nmX === '戏法空间') { st.__trickRoom = 5; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（戏法空间）'], text: '空间扭曲了！' }); return { ok: false, reason: 'trickroom' }; }
      /* 重力：5 回合命中 ×5/3 */
      if (__nmX === '重力') { st.__gravity = 5; addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（重力）'], text: '重力变强了！' }); return { ok: false, reason: 'gravity' }; }
      /* 清钉 */
      if (__nmX === '高速旋转' || __nmX === '大扫除') {
        st.battle.__hazards = st.battle.__hazards || { ally: {}, foe: {} };
        st.battle.__hazards[__mine] = {};
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（清钉）'], text: unit.nickname + ' 清除了我方场上的钉子！' });
      }
      if (__nmX === '清除浓雾') {
        st.battle.__hazards = { ally: {}, foe: {} };
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（清雾）'], text: '浓雾散去了，双方场上的钉子都被清除！' });
      }
      /* 交换 / 平分 / 反转（用能力阶级模拟，官方是交换实际数值；这里按阶级互换，误差可接受） */
      var __swap = {
        '力量互换': ['atk'], '防守互换': ['def'], '速度互换': ['spe'], '心灵互换': ['spa', 'spd'],
        '力量平分': ['atk'], '防守平分': ['def', 'spd']
      };
      if (__swap[__nmX] && __foe0) {
        __swap[__nmX].forEach(function (k2) {
          var a2 = toInt((unit.stages || {})[k2], 0), b2 = toInt((__foe0.stages || {})[k2], 0);
          unit.stages[k2] = b2; __foe0.stages[k2] = a2;
        });
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（' + __nmX + '）'], text: unit.nickname + ' 使用了 ' + __nmX + '！' });
      }
      if (__nmX === '分担痛楚' && __foe0) {
        var avg = Math.floor((num(unit.curHP, 0) + num(__foe0.curHP, 0)) / 2);
        unit.curHP = Math.min(num(unit.maxHP, 0), avg);
        __foe0.curHP = Math.min(num(__foe0.maxHP, 0), avg);
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（分担痛楚）'], text: '双方的体力被平分了！' });
      }
      if (__nmX === '吸取力量' && __foe0) {
        var __heal2 = Math.max(1, Math.floor(num(__foe0.stats && __foe0.stats.atk, 0) || 0));
        unit.curHP = Math.min(num(unit.maxHP, 0), num(unit.curHP, 0) + __heal2);
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（吸取力量）'], text: unit.nickname + ' 吸取了力量，回复了体力！' });
      }
      if (__nmX === '颠倒' && __foe0) {
        Object.keys(__foe0.stages || {}).forEach(function (k3) { __foe0.stages[k3] = -toInt(__foe0.stages[k3], 0); });
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（颠倒）'], text: __foe0.nickname + ' 的能力变化被颠倒了！' });
      }
      if (__nmX === '自我暗示' && __foe0) {
        unit.stages = JSON.parse(JSON.stringify(__foe0.stages || {}));
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（自我暗示）'], text: unit.nickname + ' 复制了对手的能力变化！' });
      }
      if (__nmX === '点穴') {
        var __keys = ['atk', 'def', 'spa', 'spd', 'spe'];
        var __k4 = __keys[Math.floor(((ctx && ctx.rng ? ctx.rng() : Math.random)()) * __keys.length)] || 'atk';
        unit.stages[__k4] = Math.min(6, toInt(unit.stages[__k4], 0) + 2);
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（点穴）'], text: unit.nickname + ' 的 ' + __k4 + ' 大幅提升了！' });
      }
    } catch (eX) { }

    /* 契约 10.106：行动前按记忆恢复 PP（跨回合保留） */
    try {
      var __ppMem = (st.__ppMemory = st.__ppMemory || {});
      (unit.moves || []).forEach(function (sl) {
        if (!sl || !sl.name) return;
        var __k = String(unit.nickname || '') + '/' + String(sl.name);
        if (__ppMem[__k] !== undefined) sl.curPP = toInt(__ppMem[__k], sl.curPP);
      });
    } catch (ePp0) { }
    /* 契约 10.105：槽位缺招式对象时**现场补解析**（真机病根：名字在、对象空 ✗）
       → 出招不再打 undefined ✓；挑衅也能正确判出"变化招式"从而拦住 ✓ */
    try {
      if (slot && !slot.move && slot.name && dex && typeof dex.move === 'function') {
        var __rsv = dex.move(slot.name);
        if (__rsv) {
          slot.move = __rsv;
          /* 契约 10.106：只补 maxPP；**不要**把已有的 curPP 重置成满（那也会造成无限 PP ✗） */
          if (!(slot.maxPP > 0)) { slot.maxPP = toInt(__rsv.pp, 0); }
          if (!(slot.curPP > 0)) { slot.curPP = Math.max(1, slot.maxPP); }
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（招式补解析）'], text: '（已补解析 ' + unit.nickname + ' 的「' + slot.name + '」）' });
        } else {
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（招式查不到）'], text: unit.nickname + ' 的「' + slot.name + '」在数据表里查不到，本次行动无效。' });
          return { ok: false, reason: 'unknown-move' };
        }
      }
    } catch (eRsv) { }
    /* 契约 10.102：**已移除的旧招式**（数据表还留着，但当前世代不存在）→ 不可用并明确提示
       （用户实测：对手用「屏障」，而屏障在第 8 世代已被删除 ✗） */
    try {
      var LEGACY_MOVES = { '屏障': 1 };
      var __nmL = String((slot && slot.name) || action.move || '');
      if (LEGACY_MOVES[__nmL]) {
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（旧招式）'],
          text: '「' + __nmL + '」在当前世代已不存在，本次行动无效！' });
        return { ok: false, reason: 'legacy' };
      }
    } catch (eLg) { }
    /* 契约 10.100：兜底 —— action.move 不得为空（否则日志会打 "使用了 undefined!" ✗） */
    if (!String(action.move == null ? '' : action.move).trim()) action.move = String((slot && slot.name) == null ? '' : (slot && slot.name)).trim();
    /* 契约 10.94：P0 机制 —— 需休息（破坏光线类）/ 蓄力（日光束类）/ 守住类 */
    try {
      var __mvObj = slot && slot.move;
      var __flags = (__mvObj && __mvObj.flags) || null;
      var __hasFlag = function (f) {
        if (!__flags) return false;
        if (Array.isArray(__flags)) return __flags.indexOf(f) >= 0;
        if (typeof __flags === 'string') return __flags.indexOf(f) >= 0;
        return !!__flags[f];
      };
      var __nmP = String((slot && slot.name) || action.move || '');
      unit.volatile = unit.volatile || {};
      /* 需休息：上一招是破坏光线这类 → 本回合只能休息 */
      if (toInt(unit.volatile['需休息'], 0) > 0) {
        delete unit.volatile['需休息'];
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（需休息）'],
          text: unit.nickname + ' 因反作用力必须休息，本回合无法行动！' });
        return { ok: false, reason: 'recharge' };
      }
      /* 蓄力：第一回合只蓄力，第二回合才打出去（大晴天下的日光束不蓄力） */
      if (__hasFlag('charge')) {
        var __skipCharge = false;
        try {
          var __w = deriveWeather ? deriveWeather(st) : '';
          if (/大晴天|日照/.test(String(__w)) && /日光束|日光刃/.test(__nmP)) __skipCharge = true;
        } catch (eW) { }
        if (!__skipCharge) {
          if (String(unit.volatile['蓄力'] || '') !== __nmP) {
            unit.volatile['蓄力'] = __nmP;
            addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（蓄力）'],
              text: unit.nickname + ' 开始蓄力（' + __nmP + '）！' });
            return { ok: false, reason: 'charge' };
          }
          delete unit.volatile['蓄力'];
        }
      }
      /* 守住类：本回合挡住一切指向自己的招式 */
      var PROTECT_MOVES = { '守住': 1, '看穿': 1, '见切': 1, '广域防守': 1, '快速防守': 1, '掀榻榻米': 1, '戏法防守': 1, '尖刺防守': 1, '王者盾牌': 1, '火焰守护': 1, '碉堡': 1, '拦堵': 1, '极巨防壁': 1 };
      if (PROTECT_MOVES[__nmP]) {
        /* 契约 10.104：**连续使用守住的成功率衰减**（官方 1/3 → 1/9 → …；用户口径"第二次只有 30%"）
           失败则本次不生成防护罩，并把连击数重置。 */
        var __streak = toInt(unit.__protectStreak, 0);
        if (__streak > 0) {
          var __pr = (ctx && typeof ctx.rng === 'function') ? ctx.rng() : Math.random();
          var __need = Math.pow(1 / 3, __streak);
          if (!(__pr < __need)) {
            unit.__protectStreak = 0;
            addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（守住失败）'],
              text: unit.nickname + ' 连续使用守住，但是失败了！' });
            return { ok: false, reason: 'protect-fail' };
          }
        }
        unit.__protectStreak = __streak + 1;
        unit.volatile['守住'] = 1;
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（守住）'],
          text: unit.nickname + ' 张开了防护罩！' });
        return { ok: false, reason: 'protect' };
      }
      /* 用完"需休息"招式 → 挂上标记，下一回合强制休息 */
      if (__hasFlag('recharge')) unit.volatile['需休息'] = 1;
      /* 契约 10.95（P1）：着迷 50% 无法行动 / 定身法 / 挺住 / 顺风 / 光墙·反射壁·极光幕 / 哈欠 */
      try {
        var __rng = (ctx && typeof ctx.rng === 'function') ? ctx.rng : Math.random;
        if (toInt(unit.volatile['着迷'], 0) > 0 && __rng() < 0.5) {
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（着迷）'],
            text: unit.nickname + ' 着迷了，无法行动！' });
          return { ok: false, reason: 'attract' };
        }
        if (String(unit.volatile['定身法'] || '') && String(unit.volatile['定身法']) === __nmP) {
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（定身法）'],
            text: unit.nickname + ' 的「' + __nmP + '」被定住了，无法使用！' });
          return { ok: false, reason: 'disable' };
        }
        /* 契约 10.104：只要不是守住类招式，连击数归零 */
        if (!PROTECT_MOVES[__nmP]) unit.__protectStreak = 0;
        if (__nmP === '挺住') { unit.volatile['挺住'] = 1; }
        st.screens = st.screens || {};
        var __mySide = (side === 'ally') ? 'ally' : 'foe';
        st.screens[__mySide] = st.screens[__mySide] || {};
        if (__nmP === '顺风') st.screens[__mySide]['顺风'] = 4;
        if (__nmP === '光墙') st.screens[__mySide]['光墙'] = 5;
        if (__nmP === '反射壁') st.screens[__mySide]['反射壁'] = 5;
        if (__nmP === '极光幕') st.screens[__mySide]['极光幕'] = 5;
        var __tauntT2 = (action && action.target !== undefined && action.target !== null)
          ? (sideArray(st, side === 'ally' ? 'foe' : 'ally')[toInt(action.target, 0)] || null) : null;
        if (__nmP === '哈欠' && __tauntT2) { __tauntT2.volatile = __tauntT2.volatile || {}; __tauntT2.volatile['哈欠'] = 1; }
        if (__nmP === '定身法' && __tauntT2 && __tauntT2.__lastMove) { __tauntT2.volatile = __tauntT2.volatile || {}; __tauntT2.volatile['定身法'] = __tauntT2.__lastMove; }
        if (__nmP === '寄生种子' && __tauntT2) { __tauntT2.volatile = __tauntT2.volatile || {}; __tauntT2.volatile['寄生种子'] = 1; }
        if (__nmP === '紧束' || __nmP === '盐腌' || __nmP === '糖浆炸弹' || __nmP === '蛸固') { if (__tauntT2) { __tauntT2.volatile = __tauntT2.volatile || {}; __tauntT2.volatile[__nmP] = 1; } }
        if (__nmP === '恶梦' && __tauntT2) { __tauntT2.volatile = __tauntT2.volatile || {}; __tauntT2.volatile['恶梦'] = 1; }
        if (__nmP === '扎根') { unit.volatile['扎根'] = 1; }
        if (__nmP === '水流环') { unit.volatile['水流环'] = 1; }
        unit.__lastMove = __nmP;
      /* 契约 10.96：再来一次（强制重复上一招）/ 锁定招式（逆鳞类 2~3 回合）/ 替身 / 同命 */
      try {
        var __LOCK = { '逆鳞': 2, '大闹一番': 2, '花瓣舞': 2, '大愤慨': 2 };
        if (toInt(unit.volatile['再来一次'], 0) > 0 && String(unit.__lastMove == null ? '' : unit.__lastMove).trim() && String(unit.__lastMove) !== String(__nmP)) {
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（再来一次）'],
            text: unit.nickname + ' 被再来一次影响，只能使用「' + unit.__lastMove + '」！' });
          action.move = unit.__lastMove;
        }
        if (__LOCK[__nmP] && !toInt(unit.volatile['锁定招式'], 0)) {
          unit.volatile['锁定招式'] = __LOCK[__nmP];
          unit.volatile['锁定招式名'] = __nmP;
        } else if (toInt(unit.volatile['锁定招式'], 0) > 0 && String(unit.volatile['锁定招式名'] || '') !== String(__nmP)) {
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（锁定招式）'],
            text: unit.nickname + ' 正陷入混乱，只能继续使用「' + unit.volatile['锁定招式名'] + '」！' });
          /* 契约 10.100：名字非空才替换（之前名字缺失 → action.move=undefined → 日志 '使用了 undefined!' ✗） */
          var __lkName = String(unit.volatile['锁定招式名'] == null ? '' : unit.volatile['锁定招式名']).trim();
          if (__lkName) action.move = __lkName; else delete unit.volatile['锁定招式'];
        }
        if (__nmP === '替身' && num(unit.curHP, 0) > Math.floor(num(unit.maxHP, 0) / 4)) {
          unit.volatile['替身'] = Math.floor(num(unit.maxHP, 0) / 4);
          unit.curHP = num(unit.curHP, 0) - Math.floor(num(unit.maxHP, 0) / 4);
        }
        if (__nmP === '同命') unit.volatile['同命'] = 1;
        if (__nmP === '再来一次' && __tauntT2) { __tauntT2.volatile = __tauntT2.volatile || {}; __tauntT2.volatile['再来一次'] = 3; }
        if (__nmP === '神秘守护') { st.screens = st.screens || {}; var __ms = (side === 'ally') ? 'ally' : 'foe'; st.screens[__ms] = st.screens[__ms] || {}; st.screens[__ms]['神秘守护'] = 5; }
        if (__nmP === '幸运咒语') { st.screens = st.screens || {}; var __lc = (side === 'ally') ? 'ally' : 'foe'; st.screens[__lc] = st.screens[__lc] || {}; st.screens[__lc]['幸运咒语'] = 5; }
      } catch (eP2) { }

      } catch (eP1) { }

    } catch (eP0) { }
    /* 契约 10.89：挑衅 —— 1) 命中后给目标挂 3 回合；2) 期间不能用变化招式（真机：盔甲鸟被挑衅还照用隐形岩 ✗） */
    var __isStatusMv = function (e) {
      if (!e) return false;
      var c = String(e.category || e.分类 || e.damageClass || '');
      return /status|变化/i.test(c);
    };
    try {
      var __tauntTarget = (action && action.target !== undefined && action.target !== null)
        ? (sideArray(st, side === 'ally' ? 'foe' : 'ally')[toInt(action.target, 0)] || null) : null;
      if (slot && String(slot.name) === '挑衅' && __tauntTarget) {
        __tauntTarget.volatile = __tauntTarget.volatile || {};
        __tauntTarget.volatile[(function(k){ return String(k) === '蓄电' ? '充电' : k; })('挑衅')] = 3;
      }
    } catch (eT1) { }
    try {
      if (slot && unit.volatile && toInt(unit.volatile['挑衅'], 0) > 0 && __isStatusMv(slot.move)) {
        /* 换成第一个攻击招式；没有则本次行动失败 */
        var __alt = null;
        (unit.moves || []).forEach(function (sl) {
          if (__alt) return;
          if (sl && sl.curPP > 0 && !__isStatusMv(sl.move)) __alt = sl;
        });
        /* 契约 10.90（用户口径）：被挑衅时选了变化招式 = **空过这一回合** ——
           不替玩家/对手自动改成攻击招式（那是我上一版自作主张 ✗）。 */
        addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: ['（被挑衅·空过）'], text: unit.nickname + ' 被挑衅了，无法使用「' + (slot.name || action.move) + '」，本回合空过！' });
        return { ok: false, reason: 'taunt' };
      }
    } catch (eT2) { }
    if (!slot) {
      /* 招式不在技能位 → 尝试兜底替换 */
      var alt = firstUsable(unit);
      if (alt) {
        ctx.errors.push(unit.nickname + ' 没有学会「' + action.move + '」，自动改用「' + alt.name + '」');
        slot = alt;
      } else {
        ctx.errors.push(unit.nickname + ' 没有可用招式，行动失败');
        return null;
      }
    }
    /* 场地/天气/钉子类变化招式（契约 10.30）：**放在未收录判定之前**，
       这样即使招式表里没有（口胡/新招式），只要名字是场地/钉子就照样生效。 */
    var __fm = false;
    try { __fm = applyFieldMove(ctx, side, unit, slot); } catch (e) { __fm = false; }
    if (__fm) return null;

    /* 未收录招式（契约 10.6）：优先于 PP 判定，给出明确警告，绝不静默当成普通招式 */
    if (slot.未识别) {
      var altEarly = firstUsable(unit);
      var warnEarly = unrecognizedMoveText(unit.nickname, slot);
      ctx.errors.push(warnEarly);
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'improv', move: slot.name || slot.原名称,
        notes: ['（未收录招式）'], text: warnEarly
      });
      if (altEarly && altEarly !== slot) {
        ctx.substituted = ctx.substituted || {};
        var keyEarly = side + '|' + unit.nickname + '|' + slot.原名称;
        if (ctx.substituted[keyEarly]) {
          ctx.errors.push('「' + slot.原名称 + '」未收录且已尝试过替换，本次出招取消');
          return null;
        }
        ctx.substituted[keyEarly] = true;
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: ['自动改用可用招式 ' + altEarly.name], text: unit.nickname + ' 自动改用了 ' + altEarly.name + '。'
        });
        return executeMove(ctx, side, unit, fallbackTarget, { kind: 'move', move: altEarly.name });
      }
      ctx.errors.push('「' + (slot.原名称 || slot.name) + '」未收录且没有其他可用招式，本次出招失败');
      return null;
    }
    if (slot.curPP <= 0 && slot.name !== '挣扎') {
      var alt2 = firstUsable(unit);
      if (alt2 && alt2 !== slot) {
        ctx.errors.push('「' + slot.name + '」的 PP 已耗尽，自动改用「' + alt2.name + '」');
        slot = alt2;
      } else {
        ctx.errors.push('「' + slot.name + '」的 PP 已耗尽，且没有其他可用招式');
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status', move: slot.name,
          notes: ['但是没有可用的 PP 了。'],
          text: unit.nickname + ' 想使用 ' + slot.name + '，但 PP 已经耗尽了！'
        });
        return null;
      }
    }

    /* 睡眠 / 冰冻 / 麻痹 判定 */
    if (!statusGate(ctx, side, unit, slot)) return null;


    var move = slot.move;
    if (!move) {
      /* 未收录招式（契约 10.6）：给出明确警告，绝不静默当成普通招式 */
      if (slot.未识别) {
        var altU = firstUsable(unit);
        var warn = unrecognizedMoveText(unit.nickname, slot);
        ctx.errors.push(warn);
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'improv', move: slot.name,
          notes: ['（未收录招式）'], text: warn
        });
        if (altU && altU !== slot) {
          addEntry(st, {
            turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
            notes: ['自动改用可用招式 ' + altU.name], text: unit.nickname + ' 自动改用了 ' + altU.name + '。'
          });
          /* 防重入：替换后的行动若还打不开，就直接结束这次出招 */
          ctx.substituted = ctx.substituted || {};
          if (ctx.substituted[side + '|' + unit.nickname + '|' + slot.原名称]) {
            ctx.errors.push('「' + slot.原名称 + '」未收录且已尝试过替换，本次出招取消');
            return null;
          }
          ctx.substituted[side + '|' + unit.nickname + '|' + slot.原名称] = true;
          return executeMove(ctx, side, unit, fallbackTarget, { kind: 'move', move: altU.name });
        }
        return null;
      }
      ctx.errors.push('数据表里找不到招式「' + slot.name + '」');
      return null;
    }
    slot.curPP = Math.max(0, slot.curPP - 1);
    /* 契约 10.106：记录已消耗的 PP（供下回合重建后恢复） */
    try {
      var __stPp = (ctx && ctx.state) ? ctx.state : null;
      if (__stPp) { __stPp.__ppMemory = __stPp.__ppMemory || {}; __stPp.__ppMemory[String(unit.nickname || '') + '/' + String(slot.name)] = slot.curPP; }
    } catch (ePp1) { }
    /* [天梯补丁 06] 讲究系：本次出招成立后锁定该招式（挣扎不锁） */
    try {
      var __cl = itemDefOf(unit);
      if (__cl && __cl.choiceLock && !slot.__struggle) {
        unit.volatile = unit.volatile || {};
        if (!unit.volatile['锁招']) unit.volatile['锁招'] = slot.name;
      }
    } catch (eCl) { }
    return { move: move, slot: slot };
  }

  /** ③ 单次出招：单体路径（群体招式的每个目标也走这里） */
  function executeMove(ctx, side, unit, target, action) {
    var prep = prepareMove(ctx, side, unit, action);
    if (!prep) return null;
    return moveAgainstTarget(ctx, side, unit, target, prep.move, prep.slot, null);
  }

  /**
   * 群体招式（allAdjacentFoes / allAdjacent）：把同一招打到每个合法目标身上。
   * 多目标时每个目标伤害 ×0.75（官方口径，见 SPREAD_DAMAGE_SCALE）。
   */
  function executeMoveOnTargets(ctx, side, unit, targets, action) {
    var prep = prepareMove(ctx, side, unit, action);
    if (!prep) return null;
    var spread = targets.length > 1;
    var scale = spread ? SPREAD_DAMAGE_SCALE : 1;
    for (var i = 0; i < targets.length; i++) {
      if (ctx.state.ended) break;
      var tg = targets[i];
      if (!tg || tg.fainted || num(tg.curHP, 0) <= 0) continue;
      moveAgainstTarget(ctx, side, unit, tg, prep.move, prep.slot, { spreadScale: scale, spread: spread });
    }
    return prep;
  }

  /**
   * 阶段 A：解析本次行动的目标，然后出招。
   *   - single：用 action.target（对手战位索引，0 基）；缺省 = 第一个存活对手
   *   - allAdjacentFoes：打所有对手；allAdjacent：打场上除自己外所有人（含我方第二只）
   *   - 目标已倒下 → 自动重定向到第一个存活对手，并在日志写明「目标已倒下，自动转向 X」
   *   - 无存活目标 → 记一条日志后走正常的结束判定
   */
  function __executeMoveForActionBase(ctx, step, keepGoing) {
    var st = ctx.state, side = step.side, unit = step.unit, action = step.action;
    var oppArr = sideArray(st, side === 'ally' ? 'foe' : 'ally');
    var slot = findSlot(unit, action.move);
    var kind = (slot && slot.move) ? moveTargetKind(slot.move) : 'single';

    if (isSpreadKind(kind)) {
      var list = [];
      if (kind === 'allAdjacentFoes') {
        for (var i = 0; i < oppArr.length; i++) {
          if (oppArr[i] && !oppArr[i].fainted && num(oppArr[i].curHP, 0) > 0) list.push(oppArr[i]);
        }
      } else {
        var field = fieldUnits(st);
        for (var f = 0; f < field.length; f++) {
          var u = field[f];
          if (!u || u === unit || u.fainted || num(u.curHP, 0) <= 0) continue;
          list.push(u);
        }
      }
      if (!list.length) {
        addEntry(st, {
          turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: ['（没有目标）'],
          text: unit.nickname + ' 使出了 ' + (slot && slot.move ? slot.move.zh : action.move) + '，但没有可命中的目标。'
        });
        return;
      }
      executeMoveOnTargets(ctx, side, unit, list, action);
      return;
    }

    /* 阶段 B：自身向（龙之舞/剑舞/自我再生…）与队友向（帮助/治愈波动…）必须走自己的目标，
     * 不能再落进"单体 = 打对手"的分支（否则龙之舞会对着对手跳舞、帮助会打队友）。 */
    if (kind === 'self') {
      executeMove(ctx, side, unit, unit, action);
      return;
    }
    if (kind === 'ally') {
      var mate = alliesOf(st, unit)[0] || null;   /* 同侧另一只存活单位（双打）；单打没有则退回自己 */
      if (!mate && sideArray(st, side).length > 1) {
        addEntry(st, {
          turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: ['（无队友目标）'],
          text: unit.nickname + ' 想对队友使用 ' + (slot && slot.move ? slot.move.zh : action.move) +
            '，但场上没有其他还能战斗的同伴，改为对自己使用。'
        });
      }
      executeMove(ctx, side, unit, mate || unit, action);
      return;
    }

    /* 单体：解析目标（缺省 = 第一个存活对手） */
    var want = action.target;
    var hasWant = !(want === undefined || want === null || want === '');
    var tgt = null;
    if (hasWant) {
      var wi = toInt(want, -1);
      if (wi >= 0 && wi < oppArr.length) tgt = oppArr[wi];
    } else {
      tgt = firstAliveOf(oppArr);
    }
    if (keepGoing === false) {
      /* 旧语义：keepGoing:false 时不因目标倒下而跳过 */
      if (!tgt) tgt = firstAliveOf(oppArr);
      if (!tgt) return;
      executeMove(ctx, side, unit, tgt, action);
      return;
    }
    if (!tgt || tgt.fainted || num(tgt.curHP, 0) <= 0) {
      var first = firstAliveOf(oppArr);
      var asked = hasWant
        ? ('战位 ' + (toInt(want, 0) + 1) + (tgt ? '「' + tgt.nickname + '」' : ''))
        : ('指定目标' + (tgt ? '「' + tgt.nickname + '」' : ''));
      if (!first) {
        /* 没有存活对手 → 正常结束判定（由 endOfTurn/checkEnd 收尾，这里只记日志） */
        addEntry(st, {
          turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: ['（没有目标）'],
          text: unit.nickname + ' 想出手，但' + (side === 'ally' ? '对方' : '我方') + '已经没有可战斗的宝可梦了。'
        });
        checkEnd(ctx);
        return;
      }
      addEntry(st, {
        turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status',
        notes: ['（目标重定向）'], targetName: first.nickname,
        text: '⚠ ' + asked + '目标已倒下，自动转向 ' + first.nickname + '。'
      });
      tgt = first;
    }
    executeMove(ctx, side, unit, tgt, action);
  }

  /** 单次出招对一个目标结算（move / slot 已由 prepareMove 决定） */
  function moveAgainstTarget(ctx, side, unit, target, move, slot, mopt) {
    /* 契约 10.97：招式对象可能缺失（数据表查不到/槽位未识别）→ 兜成 {}，避免读属性崩溃 */
    move = move || {};
    var dex = ctx.dex, st = ctx.state, rng = ctx.rng, turn = ctx.turn;
    var spreadScale = mopt && mopt.spreadScale !== undefined ? mopt.spreadScale : undefined;
    var isSpread = !!(mopt && mopt.spread);

    /* 一击必杀 */
    if (move && move.ohko) {
      var oa = ohkoAcc(unit, target);
      var ok = rng() * 100 < oa;
      if (!ok) {
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'move', move: move.zh, hit: false,
          targetName: target.nickname, notes: ['一击必杀没有命中。'],
          text: unit.nickname + ' 使用了 ' + move.zh + '！但是没有命中 ' + target.nickname + '。'
        });
        return;
      }
      var dealt0 = target.curHP;
      applyDamage(ctx, side, unit, target, dealt0, move, false, 1);
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'move', move: move.zh, hit: true, crit: false,
        typeEff: 1, damage: dealt0, hpFrom: target.curHP + dealt0, hpTo: target.curHP,
        targetName: target.nickname, notes: ['一击必杀！'],
        text: unit.nickname + ' 使用了 ' + move.zh + '！一击必杀！对 ' + target.nickname + ' 造成 ' + dealt0 + ' 点伤害。'
      });
      if (target.curHP <= 0) faintUnit(ctx, target);
      return;
    }

    /* 特性钩子（命中前）：引火/蓄电/储水/食草/食土/飘浮/防弹/隔音/黄金之躯/神奇守护/画皮… */
    var tryHit = hookTryHit(ctx, unit, target, move, slot);
    if (tryHit && tryHit.blocked) {
      applySelfBoosts(ctx, side, unit, move, false);
      return;
    }

    /* 命中判定（含口胡命中修正与特性命中修正） */
    var hit = hitRoll(dex, move, rng, unit, target, ctx);
    if (!hit) {
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'move', move: move.zh, hit: false,
        targetName: target.nickname, notes: ['但是没有命中。'],
        text: unit.nickname + ' 使用了 ' + move.zh + '！但是没有命中 ' + target.nickname + '。'
      });
      /* 变化招式未命中也不触发追加效果 */
      applySelfBoosts(ctx, side, unit, move, false);
      return;
    }

    var hpFrom = target.curHP;
    var totalDamage = 0;
    var totalEff = dex.moveEff(move, target.types);
    var anyCrit = false;

    /* 固定伤害（地球上投 = 自身等级 / 黑夜魔影等数字威力） */
    var fixedDamage = 0;
    if (move && move.fixedDamage === 'level') fixedDamage = unit.level;
    else if (move && typeof move.fixedDamage === 'number') fixedDamage = move.fixedDamage;

    if (move.category === 'status') {
      var notes = [];
      if (move.boosts && !move.boostsSelf) {
        var changed = applyStages(unit, move.boosts);
        if (Object.keys(changed).length) notes.push('（' + unit.nickname + ' 的' + stageChangeText(changed) + '）');
      }
      if (move.status) {
        var code = dex.statusCode(move.status);
        if (canApplyStatus(dex, move, target, code)) {
          setStatus(target, code, ctx);
          notes.push(target.nickname + ' 陷入了' + dex.statusText(code) + '状态！');
        } else {
          notes.push('但是' + target.nickname + ' 没有受到影响。');
        }
      }
      if (move.volatile) {
        if (abilityVolatileImmune(target, move.volatile)) {
          notes.push('但是' + target.nickname + ' 没有受到影响。');
        } else {
          target.volatile[(function(k){ return String(k) === '蓄电' ? '充电' : k; })(move.volatile)] = toInt(move.volatile === '混乱' ? (1 + Math.floor(rng() * 4)) : 2, 2);
          notes.push(target.nickname + ' 陷入了' + move.volatile + '！');
        }
      }
      if (move.weather) {
        var mw = normalizeMoveWeather(move, move.weather);
        ctx.weather = mw; st.battle.weather = mw; st.battle.场地效果 = weatherText(mw);
        notes.push('天气变成了' + mw + '！');
      }
      if (move.rest) {
        target.curHP = target.maxHP;
        target.status = 'slp';
        target.statusCounter = toInt(opts_num(ctx.opts.restTurns, 2), 2);
        notes.push(unit.nickname + ' 睡着了，体力全满！');
      }
      /* 变化招式的效果在数据表里统一存在 secondaries（chance:100）——早先只读了
       * 顶层 boosts/status（本数据表里全空），导致龙之舞/剑舞/电磁波/泼沙这类变化招式全部空转。
       * 这里补上：按 self 决定作用对象，能力阶级/异常/临时状态都走同一套结算与日志。 */
      if (Array.isArray(move.secondaries)) {
        for (var psi = 0; psi < move.secondaries.length; psi++) {
          var psec = obj(move.secondaries[psi]);
          /* 变化招式的追加效果走同一条概率解析：chance 缺失时按「变化招式效果必定生效」的
           * 官方口径（100%；数据表 382 个带 secondaries 的招式全都显式写了 chance）。 */
          var pRes = resolveChance(psec, 'secondary');
          if (!pRes) { warnMissingChance(ctx, unit, 'secondary'); continue; }
          if (!(pRes.chance >= 100 || rng() * 100 < pRes.chance)) continue;
          var pRecv = (psec.self || move.target === 'self') ? unit : target;
          if (psec.status) {
            var psc = dex.statusCode(psec.status);
            if (canApplyStatus(dex, move, pRecv, psc)) {
              setStatus(pRecv, psc, ctx);
              notes.push(pRecv.nickname + ' 陷入了' + dex.statusText(psc) + '状态！');
            } else {
              notes.push('但是' + pRecv.nickname + ' 没有受到影响。');
            }
          }
          if (psec.boosts) {
            var pch = applyStages(pRecv, psec.boosts);
            if (Object.keys(pch).length) notes.push(pRecv.nickname + ' 的' + stageChangeText(pch) + '！');
          }
          if (psec.volatile) {
            pRecv.volatile[psec.volatile] = 2;
            notes.push(pRecv.nickname + ' 陷入了' + psec.volatile + '！');
          }
        }
      }
      /* 纯回复类变化招式（自我再生/光合作用…）：数据表用 effectNote 描述，这里按 note 兜底 */
      if (move.category === 'status' && !move.drain && /回复|恢复/.test(String(move.effectNote || '')) && num(move.power, 0) <= 0) {
        var healFrac = /一半|1\/2/.test(String(move.effectNote || '')) ? 0.5 : 0.5;
        var healAmt = Math.max(1, Math.floor(unit.maxHP * healFrac));
        var hpB = unit.curHP;
        unit.curHP = Math.min(unit.maxHP, unit.curHP + healAmt);
        if (unit.curHP > hpB) notes.push(unit.nickname + ' 回复了 ' + (unit.curHP - hpB) + ' 点体力！');
      }
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'move', move: move.zh, hit: true,
        hpFrom: hpFrom, hpTo: target.curHP, notes: notes, targetName: target.nickname,
        text: unit.nickname + ' 使用了 ' + move.zh + '！' + notes.join('')
      });
      /* 注意：变化招式的 boosts 已在上面的分支里结算，这里只处理 boostsSelf（逆鳞/近身战这类） */
      if (move.boostsSelf) applySelfBoosts(ctx, side, unit, move, true);
      return;
    }

    /* 攻击招式：多段 or 单段（连续攻击特性把浮动段数固定为最大；亲子爱按 1.25 倍威力折算） */
    var hits = 1;
    var multi = move.multihit;
  

  /* 契约 10.118：**固定段数写成数字/字符串时也要认**（真机：双翼 multihit=2 是数字 ✗，
       引擎只处理数组 → 只打一次 ✗，还不出"命中了 N 次！" ✓） */
    if ((typeof multi === 'number' && multi > 1) || (typeof multi === 'string' && toInt(multi, 1) > 1)) {
      hits = Math.max(1, toInt(multi, 1));
      if (abilityHas(unit, 'fixMultiHit')) hits = hits;   /* 连续攻击对固定段数无影响 */
    } else if (Array.isArray(multi) && multi.length >= 2) {
      var lo = toInt(multi[0], 2), hi = toInt(multi[1], 2);
      if (abilityHas(unit, 'fixMultiHit') && hi > lo) { hits = hi; }
      else if (lo === hi) hits = lo;
      else hits = lo + Math.floor(rng() * (hi - lo + 1));
    }
    for (var h = 0; h < hits; h++) {
      if (target.curHP <= 0) break;
      var res;
      if (fixedDamage) {
        /* 固定伤害不看能力值、不看相性（契约 fixedDamage 语义） */
        res = { damage: fixedDamage, eff: totalEff, crit: false };
      } else {
        var isCrit = critRollFor(dex, unit, target, move, rng, ctx);
        anyCrit = anyCrit || isCrit;
        res = calcDamage(dex, unit, target, move, isCrit, rng, st.battle.weather, ctx, spreadScale);
        totalEff = res.eff;
      }
      if (res.eff === 0) { totalDamage = 0; break; }
      /* 结实（满血留 1 血）/ 画皮与冰冻头由 hookTryHit 处理；结实在此处兜底 */
      var dealt = res.damage;
      var sturdyP = abilityParams(target, 'surviveKo');
      if (sturdyP && !sturdyP.once && target.curHP - dealt <= 0 && target.curHP >= target.maxHP
        && condOk(sturdyP.when, target, { ctx: ctx, move: move })) {
        dealt = Math.max(0, target.curHP - toInt(sturdyP.surviveHp, 1));
        addEntry(st, {
          turn: turn, actor: target.side, actorName: target.nickname, kind: 'status',
          notes: ['（结实）'], text: target.nickname + ' 的结实撑住了这一击！'
        });
      }
      totalDamage += dealt;
      /* 契约 10.87：气势披带（满血被一击打空 → 留 1 点） */
    var __hpBefore = num(target.curHP, 0);    /* 契约 10.120：记下本回合受到的伤害（反击类要用） */
    try { target.__dmgTakenThisTurn = num(target.__dmgTakenThisTurn, 0) + num(dealt, 0); target.__lastHitCat = String((move && (move.category || move.分类)) || ''); } catch (eRec) { }

    target.curHP = Math.max(0, target.curHP - dealt);
    /* 契约 10.88：贝壳之铃（攻击方回复伤害的 1/8）/ 生命宝珠（攻击方反伤 1/10 最大体力） */
    try {
      var __atk2 = (ctx && (ctx.attacker || ctx.atkU || ctx.attackerUnit)) || null;
      var __da = itemDefOf(__atk2);
      if (__da && __atk2 && !__atk2.fainted) {
        if (__da.shellBell && dealt > 0) {
          var __hb = Math.max(1, Math.floor(dealt * __da.shellBell));
          var __b0 = num(__atk2.curHP, 0);
          __atk2.curHP = Math.min(num(__atk2.maxHP, 0), __b0 + __hb);
          if (__atk2.curHP > __b0) addEntry(st, { turn: ctx && ctx.turn, actor: (st.battle.allies || []).indexOf(__atk2) >= 0 ? 'ally' : 'foe',
            actorName: __atk2.nickname, kind: 'item', item: itemNameOf(__atk2), notes: ['（贝壳之铃）'],
            text: __atk2.nickname + ' 通过贝壳之铃回复了体力。' });
        }
        if (__da.recoil) {
          __atk2.curHP = Math.max(0, num(__atk2.curHP, 0) - Math.max(1, Math.floor(num(__atk2.maxHP, 0) * __da.recoil)));
          if (__atk2.curHP <= 0) { try { faintUnit(ctx, __atk2); } catch (eF1) { __atk2.fainted = true; } }
          addEntry(st, { turn: ctx && ctx.turn, actor: (st.battle.allies || []).indexOf(__atk2) >= 0 ? 'ally' : 'foe',
            actorName: __atk2.nickname, kind: 'item', item: itemNameOf(__atk2), notes: ['（生命宝珠）'],
            text: __atk2.nickname + ' 受到了生命宝珠的反噬。' });
        }
      }
    } catch (eSb) { }

    try {
      /* 契约 10.95：挺住 —— 本回合被打空也留 1 点 */
      try {
        if (target.volatile && toInt(target.volatile['挺住'], 0) > 0 && num(target.curHP, 0) <= 0) {
          target.curHP = 1; delete target.volatile['挺住'];
          addEntry(st, { turn: ctx && ctx.turn, actor: 'ally', actorName: target.nickname, kind: 'status', notes: ['（挺住）'],
            text: target.nickname + ' 挺住了！' });
        }
      } catch (eEnd) { }
      var __fs = itemDefOf(target);      /* 契约 10.96：替身先吃伤害；同命则攻击方一起倒下 */
      try {
        if (target.volatile && toInt(target.volatile['替身'], 0) > 0) {
          var __sub = toInt(target.volatile['替身'], 0) - num(dealt, 0);
          target.curHP = Math.min(num(target.maxHP, 0), num(target.curHP, 0) + num(dealt, 0));  /* 撤回对本体伤害 */
          if (__sub <= 0) {
            delete target.volatile['替身']; target.curHP = Math.min(num(target.maxHP, 0), num(target.curHP, 0));
            addEntry(st, { turn: ctx && ctx.turn, actor: 'ally', actorName: target.nickname, kind: 'status', notes: ['（替身）'],
              text: target.nickname + ' 的替身被打碎了！' });
          } else {
            target.volatile['替身'] = __sub;
            addEntry(st, { turn: ctx && ctx.turn, actor: 'ally', actorName: target.nickname, kind: 'status', notes: ['（替身）'],
              text: target.nickname + ' 的替身承受了伤害（剩余 ' + __sub + '）！' });
          }
        }
      } catch (eSub) { }

      if (__fs && __fs.focusSash && __hpBefore >= num(target.maxHP, 0) && num(target.curHP, 0) <= 0) {
        target.curHP = 1;
        addEntry(st, { turn: ctx && ctx.turn, actor: (st.battle.allies || []).indexOf(target) >= 0 ? 'ally' : 'foe',
          actorName: target.nickname, kind: 'item', item: itemNameOf(target),
          notes: ['（气势披带）'], text: target.nickname + ' 靠气势披带撑住了！' });
      }
    } catch (eFs) { }

    }

    var effNotes = [];
    if (totalEff === 0) effNotes.push('对' + target.nickname + ' 没有效果……');
    else if (totalEff >= 2) effNotes.push('效果绝佳！');
    else if (totalEff > 0 && totalEff < 1) effNotes.push('效果不理想……');
    if (anyCrit) effNotes.push('击中了要害！');
    if (hits > 1) effNotes.push('命中了 ' + hits + ' 次！');
    if (isSpread) effNotes.push('（群体招式，伤害 ×0.75）');

    var moveEntry = addEntry(st, {
      turn: turn, actor: side, actorName: unit.nickname, kind: 'move', move: move.zh, hit: true,
      crit: anyCrit, typeEff: totalEff, damage: totalDamage, targetName: target.nickname,
      hpFrom: hpFrom, hpTo: target.curHP, notes: effNotes,
      text: unit.nickname + ' 使用了 ' + move.zh + '！' + effNotes.join('') +
        (totalDamage ? '对 ' + target.nickname + ' 造成 ' + totalDamage + ' 点伤害。' : '')
    });

    /* 追加效果（secondaries）：鳞粉免疫守方追加；强行舍弃追加换 1.3 倍威力；天恩翻倍；恶臭加畏缩 */
    var blockSec = abilityHas(target, 'blockSecondary');
    var sheer = abilityHas(unit, 'sheerForce');
    if (totalDamage > 0 && !sheer && Array.isArray(move.secondaries)) {
      var secChanceMult = abilityHas(unit, 'doubleSecondaryChance') ? 2 : 1;
      for (var si = 0; si < move.secondaries.length; si++) {
        var sec = obj(move.secondaries[si]);
        /* 伤害招式的追加效果：缺 chance **不触发**（安全方向），并记一条日志而不是静默按 100% */
        var secRes = resolveChance(sec, 'secondaryDamage');
        if (!secRes) { warnMissingChance(ctx, unit, 'secondaryDamage'); continue; }
        var chance = secRes.chance * secChanceMult;
        if (blockSec && !sec.self) continue;
        if (!(rng() * 100 < chance)) continue;
        var recv = sec.self ? unit : target;
        var secNotes = [];
        if (sec.status) {
          var sc = dex.statusCode(sec.status);
          if (canApplyStatus(dex, move, recv, sc)) { setStatus(recv, sc, ctx); hookStatusInflicted(ctx, recv, unit, sc); secNotes.push(recv.nickname + ' 陷入了' + dex.statusText(sc) + '状态！'); }
        }
        if (sec.boosts) {
          var sch = applyStages(recv, sec.boosts);
          if (Object.keys(sch).length) { secNotes.push(recv.nickname + ' 的' + stageChangeText(sch) + '！'); hookStatLowered(ctx, recv, unit, sch); }
        }
        if (sec.volatile) {
          if (!abilityVolatileImmune(recv, sec.volatile)) {
            recv.volatile[sec.volatile] = 2;
            secNotes.push(recv.nickname + ' 陷入了' + sec.volatile + '！');
          }
        }
        if (secNotes.length) {
          moveEntry.notes = moveEntry.notes.concat(secNotes);
          moveEntry.text += secNotes.join('');
        }
      }
    }
    /* 恶臭：攻击招式附带 10% 畏缩（守方有鳞粉时无效） */
    if (totalDamage > 0 && abilityHas(unit, 'addFlinchSecondary') && !blockSec && move.category !== 'status') {
      var flRes = resolveChance(abilityParams(unit, 'addFlinchSecondary') || {}, 'addFlinchSecondary');
      var flinchChance = flRes ? flRes.chance : 10;   /* 恶臭：官方 10% */
      if (rng() * 100 < flinchChance && !abilityVolatileImmune(target, '畏缩')) {
        target.volatile[(function(k){ return String(k) === '蓄电' ? '充电' : k; })('畏缩')] = 1;
        moveEntry.notes.push(target.nickname + ' 畏缩了！');
        moveEntry.text += target.nickname + ' 畏缩了！';
      }
    }

    /* 吸取 / 反作用力 */
    if (totalDamage > 0 && move.drain) {
      /* 契约 10.114：drain 同样是 [分子,分母] 数组对 */
      var __dr = move.drain;
      var __dfrac = Array.isArray(__dr) ? (num(__dr[0], 0) / Math.max(1, num(__dr[1], 100))) : num(__dr, 0);
      var heal = Math.max(1, Math.floor(totalDamage * __dfrac));
      var before = unit.curHP;
      unit.curHP = Math.min(unit.maxHP, unit.curHP + heal);
      /* 契约 10.123：污泥浆 —— 被吸取者的特性让吸取方受伤而不是回复 */
      try {
        if (target && abilityHas(target, 'liquidOoze')) {
          unit.curHP = Math.max(0, before - heal);
          addEntry(st, { turn: turn, actor: side, actorName: unit.nickname, kind: 'status', notes: ['（污泥浆）'], text: unit.nickname + ' 因污泥浆受到了伤害！' });
          return;
        }
      } catch (eLo) { }

      if (unit.curHP > before) {
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status', move: move.zh,
          hpFrom: before, hpTo: unit.curHP, notes: ['吸取了体力。'],
          text: unit.nickname + ' 吸取了 ' + (unit.curHP - before) + ' 点体力。'
        });
      }
    }
    if (totalDamage > 0 && move.recoil && !abilityHas(unit, 'noRecoil')) {
      /* 契约 10.114：数据里 recoil 是 **[分子,分母]**（如勇鸟猛攻 [33,100] = 1/3），
         原来直接 num() 解析数组 ✗ → 真机日志出现"只受到 1 点反作用力伤害" ✓ */
      var __rf = move.recoil;
      var __rfrac = Array.isArray(__rf) ? (num(__rf[0], 0) / Math.max(1, num(__rf[1], 100))) : num(__rf, 0);
      var __base = (totalDamage > 0) ? totalDamage : num(dealt, 0);
      var rc = Math.max(1, Math.floor(__base * __rfrac));
      unit.curHP = Math.max(0, unit.curHP - rc);
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'status', move: move.zh,
        hpFrom: unit.curHP + rc, hpTo: unit.curHP, notes: ['受到了反作用力伤害。'],
        text: unit.nickname + ' 受到了 ' + rc + ' 点反作用力伤害。'
      });
      if (unit.curHP <= 0) faintUnit(ctx, unit);
    }

    /* [天梯补丁 02] 挣扎反伤：固定为最大体力的 1/4（四舍五入），与造成的伤害无关 */
    if (totalDamage > 0 && move.__struggle && !unit.fainted) {
      var __sr0 = num(unit.curHP, 0);
      var __sr = Math.max(1, Math.round(num(unit.maxHP, 0) / 4));
      unit.curHP = Math.max(0, __sr0 - __sr);
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'status', move: move.zh,
        hpFrom: __sr0, hpTo: unit.curHP, notes: ['受到了反作用力伤害。'],
        text: unit.nickname + ' 受到了 ' + (__sr0 - unit.curHP) + ' 点反作用力伤害。'
      });
      if (unit.curHP <= 0) faintUnit(ctx, unit);
    }

    /* 命中后特性钩子：接触类（粗糙皮肤/静电/木乃伊…）与受击成长类（持久力/碎裂铠甲…） */
    if (totalDamage > 0) {
      ctx.__lastAttacker = unit;
      bindState(target, st); bindState(unit, st);
      hookAfterDamagingHit(ctx, unit, target, move, totalDamage, moveHasFlag(move, 'contact') && !abilityHas(unit, 'noContact'));
    }

    applySelfBoosts(ctx, side, unit, move, true);

    if (target.curHP <= 0) {
      ctx.__lastAttacker = unit;
      faintUnit(ctx, target);
      hookOnKo(ctx, unit, target);
    }
  }

  function opts_num(v, d) { return v === undefined || v === null ? d : num(v, d); }

  /** 睡眠/冰冻/麻痹 行动判定 */
  function statusGate(ctx, side, unit, slot) {
    var st = ctx.state, dex = ctx.dex, rng = ctx.rng, turn = ctx.turn;
    if (unit.status === 'slp') {
      unit.statusCounter = toInt(unit.statusCounter, 0) - 1;
      if (unit.statusCounter <= 0) {
        unit.status = 'ok'; unit.statusCounter = 0;
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: [unit.nickname + ' 醒过来了！'], text: unit.nickname + ' 醒过来了！'
        });
        return true;
      }
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
        notes: [unit.nickname + ' 正在睡觉，无法行动。'], text: unit.nickname + ' 正在睡觉，无法行动。'
      });
      return false;
    }
    if (unit.status === 'frz') {
      var thaw = num(ctx.opts.thawChance, 0.2);
      if (rng() < thaw) {
        unit.status = 'ok';
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: [unit.nickname + ' 解冻了！'], text: unit.nickname + ' 解冻了！'
        });
        return true;
      }
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
        notes: [unit.nickname + ' 被冻住了，无法行动。'], text: unit.nickname + ' 被冻住了，无法行动。'
      });
      return false;
    }
    if (unit.status === 'par') {
      var p = num(ctx.opts.parChance, 0.25);
      if (rng() < p) {
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: [unit.nickname + ' 因麻痹而无法行动！'], text: unit.nickname + ' 因麻痹而无法行动！'
        });
        return false;
      }
    }
    /* 畏缩（恶臭/追加效果造成）：本回合无法行动（精神力免疫） */
    if (unit.volatile && toInt(unit.volatile['畏缩'], 0) > 0) {
      delete unit.volatile['畏缩'];
      addEntry(st, {
        turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
        notes: [unit.nickname + ' 畏缩了，无法行动！'], text: unit.nickname + ' 畏缩了，无法行动！'
      });
      return false;
    }
    /* 懒惰（每两回合只能行动一次，已在 hookBeforeMove 里翻面） */
    if (unit.volatile && toInt(unit.volatile['灭亡之歌'], 0) > 0) {
      unit.volatile[(function(k){ return String(k) === '蓄电' ? '充电' : k; })('灭亡之歌')] = toInt(unit.volatile['灭亡之歌'], 0) - 1;
      if (unit.volatile['灭亡之歌'] <= 0) {
        delete unit.volatile['灭亡之歌'];
        unit.curHP = 0;   /* 灭亡之歌：下面统一走 faintUnit 发经验 */
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          notes: ['灭亡之歌生效了！'], text: unit.nickname + ' 倒下了（灭亡之歌生效）！'
        });
        faintUnit(ctx, unit);
        return false;
      }
    }
    if (unit.volatile && unit.volatile['混乱'] > 0) {
      unit.volatile[(function(k){ return String(k) === '蓄电' ? '充电' : k; })('混乱')] = toInt(unit.volatile['混乱'], 0) - 1;
      if (unit.volatile['混乱'] <= 0) delete unit.volatile['混乱'];
      if (rng() < 0.33) {
        var self = Math.max(1, Math.floor(unit.maxHP / 8));
        unit.curHP = Math.max(0, unit.curHP - self);
        addEntry(st, {
          turn: turn, actor: side, actorName: unit.nickname, kind: 'status',
          hpFrom: unit.curHP + self, hpTo: unit.curHP,
          notes: [unit.nickname + ' 在混乱中打中了自己！'], text: unit.nickname + ' 在混乱中打中了自己！'
        });
        if (unit.curHP <= 0) faintUnit(ctx, unit);
        return false;
      }
    }
    return true;
  }

  /** 攻击招式的自伤副作用（近身战等 boostsSelf） */
  function applySelfBoosts(ctx, side, unit, move, afterHit) {
    var st = ctx.state;
    var boosts = move.boostsSelf || null;
    if (!boosts) return;
    var changed = applyStages(unit, boosts);
    if (!Object.keys(changed).length) return;
    var txt = unit.nickname + ' 的' + stageChangeText(changed) + '！';
    addEntry(st, {
      turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'status', move: move.zh,
      notes: [txt], text: txt
    });
  }

  function applyDamage(ctx, side, unit, target, amount, move, crit, eff) {
    target.curHP = Math.max(0, target.curHP - Math.max(0, toInt(amount, 0)));
  }

  function findSlot(unit, moveName) {
    /* 契约 10.87：**讲究锁招** —— 用过哪招之后只能继续用那招 */
    try {
      var __ch = itemDefOf(unit);
      if (__ch && __ch.choiceLock && unit && unit.__choiceMove && String(name) !== String(unit.__choiceMove)) {
        name = unit.__choiceMove;
      }
    } catch (eCh) { }

    if (!unit || !Array.isArray(unit.moves)) return null;
    var want = String(moveName || '').trim();
    for (var i = 0; i < unit.moves.length; i++) {
      if (unit.moves[i].name === want) return unit.moves[i];
      if (unit.moves[i].move && (unit.moves[i].move.zh === want || unit.moves[i].move.en === want)) return unit.moves[i];
    }
    return null;
  }
  function firstUsable(unit) {
    if (!unit || !Array.isArray(unit.moves)) return null;
    for (var i = 0; i < unit.moves.length; i++) if (unit.moves[i].curPP > 0) return unit.moves[i];
    return null;
  }

  function setStatus(unit, code, ctx) {
    /* 契约 10.123：吵闹期间全场无法入睡 */
    try {
      var __stU = ctx && ctx.state;
      if (code === 'slp' && __stU && toInt(__stU.__uproar, 0) > 0) return;
    } catch (eUp) { }
    /* 契约 10.96：神秘守护 —— 守方半场有效时挡下所有异常状态 */
    try {
      var __stSg = ctx && ctx.state;
      if (__stSg && __stSg.screens) {
        var __isAl = (Array.isArray(__stSg.battle.allies) && __stSg.battle.allies.indexOf(unit) >= 0);
        var __scSg = __stSg.screens[__isAl ? 'ally' : 'foe'];
        if (__scSg && __scSg['神秘守护']) return;
      }
    } catch (eSg) { }

    var rngFn = (ctx && typeof ctx.rng === 'function') ? ctx.rng : Math.random;
    unit.status = code;
    /* 睡眠回合数：随机 1~2（1 + floor(rng*2)）；早起特性把睡眠回合减半 */
    unit.statusCounter = code === 'slp' ? 1 + Math.floor(rngFn() * 2) : 0;
    if (code === 'slp' && abilityHas(unit, 'earlyBird')) unit.statusCounter = Math.max(1, Math.ceil(unit.statusCounter / 2));
    if (code === 'fnt') unit.fainted = true;
  }

  /** 濒死处理 + 经验结算 + 特性濒死钩子（飞出的内在物等） */
  function faintUnit(ctx, unit) {
    if (!unit || unit.fainted) return;
    unit.curHP = 0;
    unit.fainted = true;
    unit.status = 'fnt';
    var st = ctx.state, dex = ctx.dex;
    /* 击倒台账：**双方都记**（双打/多对手全覆盖），name+side 去重 */
    recordKO(ctx, unit);
    addEntry(st, {
      turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'faint',
      hpFrom: 0, hpTo: 0, notes: [unit.nickname + ' 倒下了！'], text: unit.nickname + ' 倒下了！'
    });
    /* 特性：濒死时（飞出的内在物反伤） */
    var killer = ctx.__lastAttacker && ctx.__lastAttacker.side !== unit.side ? ctx.__lastAttacker : null;
    hookOnFaint(ctx, unit, killer);
    /* 特性：场上任意单位濒死（魂心 / 大将计数） */
    hookOnAnyFaint(ctx, unit);
    if (unit.side === 'foe') {
      /* 契约 10.19：卡的世界书规定「全队经验分配」（第8/9世代机制）——
       * 出场作战并做出贡献的拿大头（100%），未出场待命的拿基础被动经验（50%），
       * 且只发给**未濒死**的同伴。 */
      awardBattleExp(ctx, unit);
    }
  }

  /**
   * 全队经验分配（契约 10.19）
   * @param {object} ctx
   * @param {object} foeUnit 被击倒的对手（经验来源）
   */
  function awardBattleExp(ctx, foeUnit) {
    var st = ctx.state;
    var base = Math.max(1, Math.floor(num(foeUnit.baseExp, 0) * num(foeUnit.level, 1) / 7));
    var pool = [];
    var seen = {};
    var push = function (u) {
      if (!u || !u.nickname || seen[u.nickname]) return;
      seen[u.nickname] = true;
      pool.push(u);
    };
    ensureFieldArrays(st);
    for (var i = 0; i < st.battle.allies.length; i++) push(st.battle.allies[i]);
    for (var j = 0; j < (st.battle.bench || []).length; j++) push(st.battle.bench[j]);
    var shareN = 0;
    for (var k = 0; k < pool.length; k++) {
      var u = pool[k];
      if (u.fainted || num(u.curHP, 0) <= 0) continue;      /* 濒死不参与分配 */
      var full = u.participated === true || k < st.battle.allies.length;  /* 场上/出场过的拿大头 */
      var amount = full ? base : Math.max(1, Math.floor(base / 2));
      if (!full) shareN++;
      gainExp(ctx, u, amount, full ? '' : '（全队经验·未出场）');
    }
    if (shareN > 0) {
      addEntry(st, {
        turn: ctx.turn, actor: 'ally', actorName: '队伍', kind: 'status',
        notes: ['（全队经验分配）'],
        text: '（全队经验分配：另有 ' + shareN + ' 只未出场的宝可梦各获得 ' + Math.max(1, Math.floor(base / 2)) + ' 点基础经验）'
      });
    }
  }

  /** 经验与升级 */
  function gainExp(ctx, unit, amount, note) {
    var st = ctx.state;
    if (!amount || amount <= 0 || unit.expFrozen) return;
    unit.exp += amount;
    st.meta.expGained[unit.nickname] = toInt(st.meta.expGained[unit.nickname], 0) + amount;
    addEntry(st, {
      turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
      notes: [unit.nickname + ' 获得了 ' + amount + ' 点经验值！' + (note || '')],
      text: unit.nickname + ' 获得了 ' + amount + ' 点经验值！' + (note || '')
    });
    while (!unit.expFrozen && unit.exp >= unit.expNext) {
      if (unit.level >= 100) { unit.expFrozen = true; unit.exp = unit.expNext; break; }
      unit.exp -= unit.expNext;
      unit.level += 1;
      var beforeMax = unit.maxHP;
      recalcHP(ctx.dex, unit);
      var delta = unit.maxHP - beforeMax;
      unit.curHP = clamp(unit.curHP + Math.max(0, delta), 0, unit.maxHP);
      /* 契约 10.21（用户要求）：升级**只加"提升的那部分体力"**，不回满、也不把濒死拉起。
       * （正作口径：上限 +2 → 当前体力 +2；已濒死的靠经验升级不会复活。） */
      if (unit.curHP <= 0) unit.curHP = 0;
      /* 经验上限沿用卡内经验曲线；升级后按等级重算，避免卡住不涨 */
      unit.expNext = expForLevel(unit.level);
      st.meta.levelUps.push({ nickname: unit.nickname, level: unit.level, maxHP: unit.maxHP, curHP: unit.curHP });
      addEntry(st, {
        turn: ctx.turn, actor: unit.side, actorName: unit.nickname, kind: 'status',
        notes: [unit.nickname + ' 升级了！现在是 Lv.' + unit.level + '（体力上限 ' + unit.maxHP + '）'],
        text: unit.nickname + ' 升级了！现在是 Lv.' + unit.level + '，体力上限提升到 ' + unit.maxHP + '。'
      });
      if (unit.level >= 100) { unit.expFrozen = true; unit.expNext = expForLevel(100); break; }
    }
  }

  /** 升级后重算体力上限/当前体力 */
  function recalcHP(dex, unit) {
    var hpBase = num(unit.baseStats.hp, 1);
    var hpIV = num(unit.ivs.hp, DEFAULT_IV);
    unit.maxHP = Math.max(1, calcStat('hp', hpBase, hpIV, unit.level, { up: null, down: null }));
    var other = ['atk', 'def', 'spa', 'spd', 'spe'];
    var nature = dex.nature(unit.nature);
    for (var i = 0; i < other.length; i++) {
      unit.stats[other[i]] = calcStat(other[i], num(unit.baseStats[other[i]], 1), num(unit.ivs[other[i]], DEFAULT_IV), unit.level, nature);
    }
    unit.stats.hp = unit.maxHP;
    unit.curHP = clamp(unit.curHP, 0, unit.maxHP);
  }

  /** 换人（契约 10.14：slotIndex/unitOverride 支持双打里的第 2 个战位） */
  function doSwitch(ctx, side, action, unitOverride, slotIndex) {
    var st = ctx.state;
    ensureFieldArrays(st);
    var arr = side === 'ally' ? st.battle.allies : st.battle.foes;
    var slotIdx = (slotIndex === undefined || slotIndex === null) ? -1 : toInt(slotIndex, -1);
    if (slotIdx < 0 && unitOverride) {
      for (var su = 0; su < arr.length; su++) { if (arr[su] === unitOverride || arr[su].nickname === unitOverride.nickname) { slotIdx = su; break; } }
    }
    if (slotIdx < 0) slotIdx = 0;
    if (slotIdx > arr.length) return { err: '换人失败：战位 ' + (slotIdx + 1) + ' 不存在' };
    /* slotIdx === arr.length 且场上还没占满 → 追加到新战位（阶段 A/B 通用补位用） */
    /* 空槽位时为 null：绝不能退化成「把场上第一只塞回待命」（补位会把它误当成被换下的那只） */
    var cur = arr[slotIdx] || null;
    var bench = side === 'ally' ? st.battle.bench : st.battle.foeBench;
    var want = String(action.to || '').trim();
    if (cur && !cur.fainted) { /* 正常换人 */ }
    var idx = -1;
    for (var i = 0; i < bench.length; i++) {
      if (bench[i].nickname === want || bench[i].species === want) { idx = i; break; }
    }
    if (idx < 0) return { err: '换人失败：' + (want || '(未指定)') + ' 不在待命列表中' };
    if (bench[idx].fainted || bench[idx].curHP <= 0) return { err: '换人失败：' + bench[idx].nickname + ' 已经濒死，无法上场' };
    var incoming = bench.splice(idx, 1)[0];
    incoming.participated = true;      /* 契约 10.19：出场即算"参与"，经验拿大头 */
    incoming.status = incoming.status === 'fnt' ? 'ok' : incoming.status;
    incoming.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
    incoming.volatile = {};
    /* 换下钩子：再生力 / 自然回复（在把 cur 放回待命前结算） */
    if (cur && !cur.__switchedOut) {
      bindState(cur, st);
      hookSwitchOut(ctx, cur);
      cur.__switchedOut = true;
    }
    if (cur && cur.volatile) delete cur.volatile['锁招'];   /* [天梯补丁 06] 换下解除锁招 */
    if (cur) bench.push(cur);   /* 濒死的也要回待命（后续 firstHealthy 会跳过它） */
    incoming.__switchedOut = false;
    incoming.pos = String(slotIdx + 1);   /* 战位号随槽位走，多对手写回 对方战位.1..N 才不会串位 */
    arr[slotIdx] = incoming;
    if (side === 'ally') { st.battle.bench = bench; st.battle.ally = arr[0]; }
    else { st.battle.foeBench = bench; st.battle.foe = arr[0]; }
    /* 契约 10.9：记账，避免 AI 连续换人来回横跳 */
    if (side === 'foe') st.meta.foeLastSwitchTurn = ctx.turn;
    else st.meta.allyLastSwitchTurn = ctx.turn;
    addEntry(st, {
      turn: ctx.turn, actor: side, actorName: incoming.nickname, kind: 'switch',
      hpFrom: incoming.curHP, hpTo: incoming.curHP,
      notes: [incoming.nickname + ' 上场了！（体力 ' + incoming.curHP + '/' + incoming.maxHP + '）'],
      text: (side === 'foe'
        ? (cur && !cur.fainted ? '对手收回了 ' + cur.nickname + '！' : '') + '对手派出了 ' + incoming.nickname + '！'
        : (cur ? '回来吧，' + cur.nickname + '！' : '') + '去吧，' + incoming.nickname + '！')
    });
    onSwitchIn(ctx.dex, st, incoming, side === 'ally' ? st.battle.foe : st.battle.ally);
    return { ok: true, unit: incoming };
  }

  /* 契约 10.85：**持有物回合末效果**（真机：天蝎王带剧毒宝珠毫无反应 ✗ —— 之前引擎只有背包回复类道具） */
  var HELD_ITEM_EOT = {
    '剧毒宝珠': { status: 'tox' },
    '火焰宝珠': { status: 'brn' },
    '剩饭': { healFraction: 1 / 16 },
    '黑色污泥': { healFraction: 1 / 16 },
    /* 契约 10.113：**果子类也要进这张表**（否则 applyHeldItemsEndOfTurn 一开始就 return ✗
       → 真机：文柚果/木子果/苹野果 全都不生效）。具体效果仍由 ITEM_DEF 的字段驱动。 */
    '文柚果': { berry: true },
    '木子果': { berry: true },
    '苹野果': { berry: true }
  };
  /**
   * 回合末结算持有物（官方顺序里在异常伤害之后）。只在**回合末**调用一次。
   * 剧毒宝珠/火焰宝珠：给持有者上异常（毒疗持有者照样中毒 ✓ 毒疗的免疫只针对伤害）；
   * 剩饭/黑色污泥：回复 1/16。
   */
  function applyHeldItemsEndOfTurn(ctx) {
    var st = ctx.state;
    if (!st || !st.battle) return;
    /* 契约 10.99：道具诊断（只报一次，写进战报）—— 看清引擎到底读到了哪些持有物 */
    try {
      if (ctx.turn === 1) {
        var __all2 = [];
        [st.battle.allies, st.battle.foes].forEach(function (arr) {
          (Array.isArray(arr) ? arr : []).forEach(function (u2) { if (u2) __all2.push(itemNameOf(u2) || '（无）'); });
        });
        addEntry(st, { turn: ctx.turn, actor: 'ally', actorName: '道具诊断', kind: 'status', notes: ['（道具诊断）'],
          text: '【道具诊断】' + __all2.join(' | ') });
      }
    } catch (eIt) { }
    var list = [];
    [st.battle.allies, st.battle.foes].forEach(function (arr) {
      (Array.isArray(arr) ? arr : []).forEach(function (u) { if (u && !u.fainted) list.push(u); });
    });
    list.forEach(function (u) {
      var it = '';
      /* 契约 10.99：**统一走 itemNameOf**（这里原来是自己那份内联读法 ✗，itemNameOf 修好了它却没修 → 道具永远读不到 ✓） */
      try { it = itemNameOf(u); } catch (eI) { it = ''; }
      if (!it || it === '无' || it === '未知') return;
      var eff = HELD_ITEM_EOT[it];
      if (!eff) return;
      if (eff.status) {
        if (!u.status || u.status === 'ok' || u.status === '健康') {
          try { setStatus(u, eff.status, ctx); } catch (eS) { u.status = eff.status; }
          addEntry(st, {
            turn: ctx.turn, actor: (st.battle.allies || []).indexOf(u) >= 0 ? 'ally' : 'foe',
            actorName: u.nickname, kind: 'item', item: it,
            notes: ['（' + it + '）'], text: u.nickname + ' 受到了 ' + it + ' 的影响！'
          });
        }
        return;
      }
      /* 契约 10.86b：果子类（文柚果=半血以下回 1/4；木子果=解异常；苹野果=回 10 PP） */
      try {
        var __d2 = itemDefOf(u);
        if (__d2 && __d2.eotHealHalf && u.curHP > 0 && u.curHP <= Math.floor(u.maxHP / 2)) {
          var __h2 = Math.max(1, Math.floor(u.maxHP * __d2.eotHealHalf));
          u.curHP = Math.min(u.maxHP, u.curHP + __h2);
          addEntry(st, { turn: ctx.turn, actor: (st.battle.allies || []).indexOf(u) >= 0 ? 'ally' : 'foe', actorName: u.nickname,
            kind: 'item', item: it, notes: ['（' + it + '）'], text: u.nickname + ' 吃了 ' + it + '，回复了体力！' });
          return;
        }
        if (__d2 && __d2.eotCure && u.status && u.status !== 'ok' && u.status !== '健康') {
          u.status = 'ok'; u.statusCounter = 0;
          addEntry(st, { turn: ctx.turn, actor: (st.battle.allies || []).indexOf(u) >= 0 ? 'ally' : 'foe', actorName: u.nickname,
            kind: 'item', item: it, notes: ['（' + it + '）'], text: u.nickname + ' 吃了 ' + it + '，异常状态解除了！' });
          return;
        }
        if (__d2 && __d2.eotPP && Array.isArray(u.moves)) {
          u.moves.forEach(function (sl) { if (sl && sl.curPP < sl.maxPP) sl.curPP = Math.min(sl.maxPP, sl.curPP + __d2.eotPP); });
          return;
        }
      } catch (eB) { }
      if (eff.healFraction && u.curHP > 0 && u.curHP < u.maxHP) {
        var heal = Math.max(1, Math.floor(u.maxHP * eff.healFraction));
        var before = u.curHP;
        u.curHP = Math.min(u.maxHP, u.curHP + heal);
        addEntry(st, {
          turn: ctx.turn, actor: (st.battle.allies || []).indexOf(u) >= 0 ? 'ally' : 'foe',
          actorName: u.nickname, kind: 'item', item: it,
          notes: ['（' + it + ' 回复 ' + (u.curHP - before) + '）'], text: u.nickname + ' 通过 ' + it + ' 回复了体力。'
        });
      }
    });
  }

  /** 道具（MVP：只做回复类，见 README） */
  var HEAL_ITEMS = { '好伤药': 60, '伤药': 20, '厉害伤药': 120, '全满药': 9999, '全复药': 9999, '特制能量方块（高纯）': 50, '特制能量方块': 50 };
  /* 复苏类药物（契约 10.1：正规对战禁止当场复活） */
  var REVIVE_ITEM = /元气碎片|活力碎片|复活|复苏|元气之块|活力之块|圣灰|Revive/i;
  function doItem(ctx, side, action) {
    var st = ctx.state;
    var unit = side === 'ally' ? st.battle.ally : st.battle.foe;
    var bag = st.bag.物品;
    var name = String(action.item || '').trim();
    var entry = obj(bag[name]);
    if (!Object.keys(entry).length || toInt(entry.数量, 0) <= 0) {
      ctx.errors.push('使用道具失败：背包里没有「' + name + '」');
      return;
    }
    if (/精灵球|球$/.test(String(entry.类型 || '') || name) && side === 'ally') {
      entry.数量 = Math.max(0, toInt(entry.数量, 1) - 1);
      if (entry.数量 <= 0) delete bag[name];
      addEntry(st, {
        turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'item', item: name,
        notes: ['投出了 ' + name + '！'], text: '投出了 ' + name + '！'
      });
      return;
    }
    var heal = HEAL_ITEMS[name];
    if (heal === undefined && !REVIVE_ITEM.test(name)) {
      ctx.errors.push('使用道具失败：引擎暂不支持「' + name + '」的效果');
      return;
    }
    /* 复苏类药物（契约 10.1）：card 且非野外时，正规对战禁止复活已濒死目标 */
    var rules = obj(st.meta.rules);
    if (rules.禁复苏药 && REVIVE_ITEM.test(name)) {
      var deadBench = (st.battle.bench || []).some(function (u) { return u.fainted; }) ||
        (st.battle.foeBench || []).some(function (u) { return u.fainted; });
      if (deadBench || (unit && unit.fainted)) {
        var txt = '⚠ 规程禁止：正规对战中不得使用复苏药物「' + name + '」让已濒死的宝可梦重新投入本场战斗，该操作已拒绝。';
        st.meta.violations = st.meta.violations || [];
        st.meta.violations.push({ kind: 'revive', side: side, detail: name });
        ctx.errors.push(txt);
        addEntry(st, {
          turn: ctx.turn, actor: side, actorName: unit ? unit.nickname : side, kind: 'item', item: name,
          notes: ['规程禁止'], text: txt
        });
        return;
      }
    }
    if (heal === undefined) {
      /* 允许使用的复苏药：引擎仍不做复活结算，交由集成层/口胡通道 */
      ctx.errors.push('使用道具失败：引擎暂不支持「' + name + '」的效果');
      return;
    }
    entry.数量 = Math.max(0, toInt(entry.数量, 1) - 1);
    if (entry.数量 <= 0) delete bag[name];
    var before = unit.curHP;
    unit.curHP = Math.min(unit.maxHP, unit.curHP + heal);
    if (/全/.test(name) && unit.status !== 'fnt') unit.status = 'ok';
    addEntry(st, {
      turn: ctx.turn, actor: side, actorName: unit.nickname, kind: 'item', item: name,
      hpFrom: before, hpTo: unit.curHP,
      notes: [unit.nickname + ' 恢复了 ' + (unit.curHP - before) + ' 点体力。'],
      text: '使用了 ' + name + '，' + unit.nickname + ' 恢复了 ' + (unit.curHP - before) + ' 点体力。'
    });
  }

  /** 逃跑 / 认输 */
  function doRun(ctx, side, action) {
    var st = ctx.state;
    var unit = side === 'ally' ? st.battle.ally : st.battle.foe;
    var wild = /野生/.test(String(st.battle.对方身份 || ''));
    if (side === 'foe') {
      st.ended = true; st.winner = 'ally'; st.endReason = '对方逃走';
      addEntry(st, {
        turn: ctx.turn, actor: 'foe', actorName: unit ? unit.nickname : '对手', kind: 'end',
        notes: ['对手逃走了，战斗结束。'], text: '对手逃走了，战斗结束。'
      });
      return;
    }
    var success = wild ? true : false; /* 训练家对战不能逃跑，只能认输 */
    st.ended = true; st.winner = 'foe';
    st.endReason = success ? '成功逃走' : '举手认输';
    addEntry(st, {
      turn: ctx.turn, actor: 'ally', actorName: unit ? unit.nickname : '我方', kind: 'end',
      notes: [success ? '成功逃离了战斗。' : '我方举起了手，认输了。'],
      text: success ? '成功逃离了战斗。' : '我方举起了手，认输了。'
    });
  }

  /** 濒死后必须换人：能换就自动换，没得换就判负 */
  /** 补上 allies/foes 数组（老状态、外部构造的状态都能兼容） */
  function ensureFieldArrays(st) {
    if (!st || !st.battle) return;
    var b = st.battle;
    if (!Array.isArray(b.allies) || !b.allies.length) b.allies = b.ally ? [b.ally] : [];
    if (!Array.isArray(b.foes) || !b.foes.length) b.foes = b.foe ? [b.foe] : [];
    if (b.allies[0] !== b.ally && b.ally) b.allies[0] = b.ally;
    if (b.foes[0] !== b.foe && b.foe) b.foes[0] = b.foe;
  }

  /**
   * 对战模式是不是「双打」（阶段 B）：卡里写的是 常规双打 / 官方道馆考核2V2 / 无限制双打…
   * 只认模式名，不看战位数 —— 战位数由这里的结论反推（不足则补位），避免两处口径打架。
   * 注意：**只有「双打」这一族模式才按 2 只口径**；「突围 / 群战」等模式一律跟随变量声明的
   * 己方战位数（声明 1 只就 1 只，不自动补满），别把这里当成「我方要 2 只」的通用开关。
   */
  function isDoublesMode(mode) {
    var s = String(mode === undefined || mode === null ? '' : mode);
    return /双打|双人|双宠|连携|2\s*[vV]\s*2/.test(s);
  }

  /**
   * 每侧「场上需要几只」——我方 = 变量声明的己方战位数（突围/群战/单打都跟随变量；双打在
   * startFromStat 里已按 2 只写好）；对手 = 声明的对方战位数（上限 2）。
   * 优先级：meta.fieldSlots[side]（startFromStat 按变量战位声明数写好）
   *         > meta.rules.场上每侧数量 > 默认（我方 1 / 对手 = 当前在场的只数）。
   * 「需要几只」只在这一个函数里决定 —— **别处不许硬编码 1 或 2**。
   * 补位（fillFieldSlots / compactFieldSlots）也一律读这个函数，所以补位**只会在已声明的
   * 槽位数之内**进行：声明 2 只 → 倒下后补回 2；声明 1 只 → 只补 1，不会因为补位多出一只。
   */
  function fieldSlotCount(st, side) {
    var isAlly = side !== 'foe';
    var meta = obj(obj(st).meta);
    var fs = obj(meta.fieldSlots);
    var raw = isAlly ? fs.ally : fs.foe;
    if (raw === undefined || raw === null) {
      var rules = obj(meta.rules);
      if (rules.场上每侧数量 !== undefined) raw = rules.场上每侧数量;
      else raw = isAlly ? 1 : Math.max(1, sideArray(st, 'foe').length);
    }
    return clamp(toInt(raw, 1), 1, 2);
  }

  /**
   * 通用补位（阶段 A 用 neededSlots = 1；B 阶段只改 fieldSlotCount 就变成「空场一次补 2 只」）：
   *   - 算出「场上空缺数」（需要几只 - 在场存活只数），从该侧待命**按顺序一次补齐**；
   *   - 空场（0 只在场）也走同一条路：一次补满；
   *   - 待命不足 → 有多少上多少；一只可出战的都没有 → 交给 checkEnd 正常判负；
   *   - 日志写明补位数量与名单：`【补位】对手场上空缺 2 只 → 派出 A、B`。
   * @returns {{filled:number, names:string[]}}
   */
  function fillFieldSlots(ctx, side, neededSlots) {
    var st = ctx.state;
    ensureFieldArrays(st);
    var sideLabel = side === 'ally' ? '我方' : '对手';
    var needed = (neededSlots === undefined || neededSlots === null)
      ? fieldSlotCount(st, side) : clamp(toInt(neededSlots, 1), 1, 6);
    var arr = sideArray(st, side);
    var bench = side === 'ally' ? st.battle.bench : st.battle.foeBench;
    var i;
    /* 1) 先算「空缺数」：在场存活几只 vs 需要几只 */
    var alive = 0;
    for (i = 0; i < arr.length; i++) {
      if (arr[i] && !arr[i].fainted && num(arr[i].curHP, 0) > 0) alive++;
    }
    var empty = Math.max(0, needed - alive);
    if (empty <= 0) return { filled: 0, names: [] };
    /* 2) 空位候选：先补 [0, needed) 里空着/已濒死的槽位，再追加到末尾（战位为空时就是"一次补满"） */
    var slots = [];
    for (i = 0; i < arr.length && i < needed; i++) {
      if (!arr[i] || arr[i].fainted || num(arr[i].curHP, 0) <= 0) slots.push(i);
    }
    for (i = arr.length; i < needed; i++) slots.push(i);
    slots = slots.slice(0, empty);
    if (!slots.length) return { filled: 0, names: [] };
    /* 3) 待命名单（按顺序）：待命不足就有多少上多少。
     * 防重复：变量里的 己方待命 有可能把已经在场的同伴也写进去（模型手写/旧楼层残留），
     * 同名的已经在场就不再"补"一次（否则双打会派出两只同名宝可梦）。 */
    var onFieldNick = {};
    for (i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].nickname) onFieldNick[arr[i].nickname] = true;
    }
    var pool = [], seen = {};
    for (i = 0; i < (bench || []).length; i++) {
      var bu = bench[i];
      if (!bu || bu.fainted || num(bu.curHP, 0) <= 0) continue;
      if (seen[bu.nickname] || onFieldNick[bu.nickname]) continue;
      seen[bu.nickname] = true;
      pool.push(bu);
    }
    var n = Math.min(slots.length, pool.length);
    if (!n) return { filled: 0, names: [] };
    var plan = pool.slice(0, n);
    var names = plan.map(function (u) { return u.nickname; });
    /* 4) 日志写在补位动作之前：`【补位】对手场上空缺 2 只 → 派出 A、B` */
    addEntry(st, {
      turn: ctx.turn, actor: side, actorName: names[0], kind: 'switch',
      notes: ['（补位）'],
      text: '【补位】' + sideLabel + '场上空缺 ' + empty + ' 只 → 派出 ' + names.join('、') +
        (empty > n ? '（待命不足，有多少上多少）' : '')
    });
    /* 5) 逐个派上场（**顶进同一槽位**：slots[p] 就是空缺的那个战位号） */
    var filled = [];
    for (var p = 0; p < plan.length && !st.ended; p++) {
      arr = sideArray(st, side);           /* doSwitch 内部可能重建数组，每轮重新取 */
      var slot = slots[p];
      if (slot > arr.length) slot = arr.length;
      if (slot < 0) break;
      var rr = doSwitch(ctx, side, { to: names[p], fill: true }, arr[slot] || null, slot);
      if (!rr || rr.err) {
        ctx.errors.push((rr && rr.err) ? rr.err : (sideLabel + ' 补位失败'));
        break;
      }
      filled.push(names[p]);
      /* 每个战位单独记一条，格式：`【补位】对手 战位1 空缺 → 派出 鸭嘴火兽C` */
      addEntry(st, {
        turn: ctx.turn, actor: side, actorName: names[p], kind: 'switch',
        notes: ['（补位）'],
        text: '【补位】' + sideLabel + ' 战位' + (slot + 1) + ' 空缺 → 派出 ' + names[p]
      });
    }
    if (filled.length < names.length) {
      ctx.errors.push(sideLabel + ' 补位只完成了 ' + filled.length + '/' + names.length + ' 只');
    }
    return { filled: filled.length, names: filled };
  }

  function forceSwitchIfNeeded(ctx) {
    var st = ctx.state;
    ensureFieldArrays(st);
    var changed = true;
    while (changed && !st.ended) {
      changed = false;
      var sides = ['ally', 'foe'];
      for (var s = 0; s < sides.length; s++) {
        /* 阶段 A/B 通用：按「空缺数」一次补齐（B 阶段 fieldSlotCount 返回 2 就自动补 2 只） */
        var r = fillFieldSlots(ctx, sides[s]);
        if (r.filled > 0) changed = true;
        /* 再压紧战位：死掉的移出场上（进候补席），超编（> 卡面板可显示数）的也退回候补席。
         * 这样绝不允许出现「战位 3 是活的、战位 1/2 是死的」这种写法。 */
        var c = compactFieldSlots(ctx, sides[s]);
        if (c.moved > 0) changed = true;
      }
    }
    checkEnd(ctx);
  }

  /**
   * 压紧战位（compaction）：
   *   - 场上最多 fieldSlotCount(side) 只（我方 1/2、对手 2 —— 与卡面板能显示的数量一致）；
   *   - 已濒死的单位**移出场上**（退回候补席，濒死单位不会被补位逻辑再次派上场）；
   *   - 超编的存活单位（例如旧状态里占着战位 3）也退回候补席，保证战位号连续 1..N。
   * 战果/经验不会丢：单位对象仍在候补席里，日志与战报照常记录。
   * @returns {{moved:number, names:string[]}}
   */
  function compactFieldSlots(ctx, side) {
    var st = ctx.state;
    if (!st || !st.battle || st.ended) return { moved: 0, names: [] };
    ensureFieldArrays(st);
    var cap = fieldSlotCount(st, side);
    var arr = sideArray(st, side);
    var bench = side === 'ally' ? st.battle.bench : st.battle.foeBench;
    if (!Array.isArray(bench)) { bench = []; if (side === 'ally') st.battle.bench = bench; else st.battle.foeBench = bench; }
    var sideLabel = side === 'ally' ? '我方' : '对手';
    var keep = [], moved = [];
    var seenNick = {};
    var i;
    for (i = 0; i < arr.length; i++) {
      var u = arr[i];
      if (!u) continue;
      var alive = !u.fainted && num(u.curHP, 0) > 0;
      var nick = String(u.nickname || '');
      /* 同名重复（脏状态/旧楼层残留）只保留第一只，其余移出场上，避免同一只结算两次 */
      if (alive && keep.length < cap && !(nick && seenNick[nick])) {
        if (nick) seenNick[nick] = true;
        keep.push(u);
      } else moved.push(u);            /* 死掉的 / 超编的 / 同名的 */
    }
    if (!keep.length) return { moved: 0, names: [] };   /* 全灭：保留现状交给 checkEnd 判负 */
    if (moved.length) {
      for (i = 0; i < moved.length; i++) {
        var mu = moved[i];
        if (bench.indexOf(mu) < 0) bench.push(mu);
        addEntry(st, {
          turn: ctx.turn, actor: side, actorName: mu.nickname, kind: 'status',
          notes: ['（退出场上战位）'],
          text: (mu.fainted || num(mu.curHP, 0) <= 0)
            ? '【战位】' + sideLabel + ' ' + mu.nickname + ' 已失去战斗能力，退出场上战位（战果照常记录）。'
            : '【战位】' + sideLabel + ' ' + mu.nickname + ' 超出卡面板可显示的战位数（每侧最多 ' + cap + ' 只），退回候补席。'
        });
      }
      if (side === 'ally') { st.battle.allies = keep; st.battle.ally = keep[0]; }
      else { st.battle.foes = keep; st.battle.foe = keep[0]; }
      /* 战位号跟随新槽位（写回 对方战位.1..N 才不会串位） */
      for (i = 0; i < keep.length; i++) keep[i].pos = String(i + 1);
    }
    return { moved: moved.length, names: moved.map(function (u) { return u.nickname; }) };
  }
  function firstHealthy(list) {
    for (var i = 0; i < list.length; i++) if (!list[i].fainted && list[i].curHP > 0) return list[i];
    return null;
  }

  /* ---------------------------------------------------------------------------
   * 击倒台账（state.meta.kos）—— 战果的**唯一**权威来源
   *
   * 为什么需要它：阶段 A/B 的 compaction 会把濒死单位**移出当前战位**（候补顶进同一槽位），
   * 于是 `buildReport` 读当前战位时只看得到「最后一只倒下的」，AI 看到「敌方 1 只濒死」
   * 会误判战斗还没结束。台账与战位解耦：任何单位濒死都记一行，双方都记、按回合排序、去重。
   * ------------------------------------------------------------------------- */
  function koLedgerOf(state) {
    var m = obj(state && state.meta);
    if (!Array.isArray(m.kos)) m.kos = [];
    return m.kos;
  }
  /** 单位在台账里的名字（昵称优先，其次种族） */
  function koNameOf(unit) {
    var n = String((unit && (unit.nickname || unit.species)) || '').trim();
    return n || '未知';
  }
  /**
   * 记一条击倒。**同一侧同名只记一次**（name+side 去重，脏状态/旧楼层残留不会重复计功）。
   * @returns {object|null} 新记的条目；重复时返回 null
   */
  function recordKO(ctx, unit) {
    var st = ctx && ctx.state;
    if (!st || !unit) return null;
    var list = koLedgerOf(st);
    var side = unit.side === 'ally' ? 'ally' : 'foe';
    var name = koNameOf(unit);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      if (it.side === side && String(it.name) === name) return null;
    }
    var turn = toInt(ctx.turn, 0);
    if (!turn) turn = toInt(obj(st.meta).turnCount, 0);
    var entry = { turn: turn, side: side, name: name, level: toInt(unit.level, 0) };
    list.push(entry);
    return entry;
  }
  /**
   * 补记扫描：濒死处理散落在多处（招式伤害/异常扣血/特性反伤/直接改 HP 的脏状态…），
   * 统一在胜负判定前扫一遍「场上 + 候补席」，凡濒死（fainted 或 curHP<=0）而台账里没有的补记。
   * 去重靠 recordKO，重复调用无副作用。
   */
  function syncKOLedger(ctx) {
    var st = ctx && ctx.state;
    if (!st || !st.battle) return 0;
    ensureFieldArrays(st);
    var sides = ['ally', 'foe'];
    var added = 0;
    for (var s = 0; s < sides.length; s++) {
      var arr = sideArray(st, sides[s]);
      var bench = sides[s] === 'ally' ? (st.battle.bench || []) : (st.battle.foeBench || []);
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && (arr[i].fainted || num(arr[i].curHP, 0) <= 0) && recordKO(ctx, arr[i])) added++;
      }
      for (var j = 0; j < bench.length; j++) {
        if (bench[j] && (bench[j].fainted || num(bench[j].curHP, 0) <= 0) && recordKO(ctx, bench[j])) added++;
      }
    }
    return added;
  }
  /** 台账按回合升序（同回合保持记录顺序），返回副本（不改动台账本身） */
  function koSorted(state) {
    var list = koLedgerOf(state);
    var decorated = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name) decorated.push({ k: list[i], i: i });
    }
    decorated.sort(function (a, b) {
      var d = toInt(a.k.turn, 0) - toInt(b.k.turn, 0);
      return d !== 0 ? d : (a.i - b.i);
    });
    return decorated.map(function (x) { return x.k; });
  }
  /** `名字(T回合)`；去重（同侧同名只留第一次） */
  function koTagText(list) {
    var seen = {}, out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var k = list[i];
      if (!k || !k.name) continue;
      var key = k.side + '|' + k.name;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(k.name + '(T' + toInt(k.turn, 0) + ')');
    }
    return out.join('、');
  }
  /** 某一侧被击倒的条目（按回合升序） */
  function koOfSide(state, side) {
    return koSorted(state).filter(function (k) { return k.side === (side === 'ally' ? 'ally' : 'foe'); });
  }
  /**
   * 结束首行文案：【战斗结束·我方胜利】对手 2 只全部失去战斗能力：A(T2)、B(T5)
   * 败方按台账列全部战果；非「全员倒下」的收场（逃跑/认输/判负）写原因，不编造数量。
   */
  function endHeaderText(state) {
    if (!state || !state.ended) {
      return '【战斗进行中·第 ' + toInt(obj(state && state.meta).turnCount, 0) + ' 回合】';
    }
    var win = state.winner === 'ally' ? '我方胜利' : (state.winner === 'foe' ? '我方失败' : '平局');
    var reason = String(state.endReason || '');
    var allDown = /全员失去战斗能力|全部失去战斗能力/.test(reason);
    var foeKos = koOfSide(state, 'foe');
    var allyKos = koOfSide(state, 'ally');
    var body = '';
    if (state.winner === 'ally') {
      if (foeKos.length) {
        body = '对手 ' + foeKos.length + ' 只' + (allDown ? '全部' : '') + '失去战斗能力：' + koTagText(foeKos);
      } else if (reason) body = reason;
    } else if (state.winner === 'foe') {
      if (allyKos.length) {
        body = '我方 ' + allyKos.length + ' 只' + (allDown ? '全部' : '') + '失去战斗能力：' + koTagText(allyKos);
      } else if (reason) body = reason;
    } else {
      var all = koSorted(state);
      if (all.length) body = '双方同时失去战斗能力：' + koTagText(all);
      else if (reason) body = reason;
    }
    if (body && reason && !allDown && state.winner !== 'draw' && body !== reason) body += '（' + reason + '）';
    return '【战斗结束·' + win + '】' + (body || reason);
  }

  /** 胜负判定 */
  function checkEnd(ctx) {
    var st = ctx.state;
    /* 判胜负之前先补齐击倒台账（濒死处理散落多处，这里兜底不漏记） */
    syncKOLedger(ctx);
    if (st.ended) return;
    ensureFieldArrays(st);
    var alive = function (arr, bench) {
      for (var i = 0; i < arr.length; i++) { if (arr[i] && !arr[i].fainted && arr[i].curHP > 0) return true; }
      return !!firstHealthy(bench);
    };
    var allyAlive = alive(st.battle.allies, st.battle.bench);
    /* 关于「未建模对手」（种族解析不了、只按原样保留在变量里的条目）：
     * 它们**不参与伤害结算**，所以也**不参与全灭判定** —— 否则一只打不到、
     * 也打不死的族群条目会把战斗永远挂住（软锁）。它们的作用是：
     *   ① 写回时不丢（变量里原键名 + 原字段原样保留）；② 接管坏存档时参与
     *   「对手是不是已经全部倒下」的判断（见 foeSideAllDown）。 */
    var foeAlive = alive(st.battle.foes, st.battle.foeBench);
    if (!allyAlive && !foeAlive) {
      st.ended = true; st.winner = 'draw'; st.endReason = '双方同时失去战斗能力';
    } else if (!foeAlive) {
      st.ended = true; st.winner = 'ally'; st.endReason = '对方全员失去战斗能力';
    } else if (!allyAlive) {
      st.ended = true; st.winner = 'foe'; st.endReason = '我方全员失去战斗能力';
    }
    if (st.ended) {
      var text = st.winner === 'ally' ? '对手已经无法战斗，我方获得了胜利！'
        : st.winner === 'foe' ? '我方已经无法战斗……战斗失败了。' : '双方同时倒下，战斗以平局告终。';
      addEntry(st, {
        turn: st.meta.turnCount, actor: 'ally',
        actorName: st.battle.ally ? st.battle.ally.nickname : '我方', kind: 'end',
        notes: [text, st.endReason], text: text
      });
    }
  }

  /** 回合末：异常状态扣血 + 特性（毒疗/雨盘/加速/心情不定/蜕皮/湿润之躯…） */
  function __endOfTurnBase(ctx) {
    var st = ctx.state;
    if (st.ended) return;
    var units = [];
    ensureFieldArrays(st);
    /* 契约 10.84：**畏缩只在本回合有效** —— 回合末必须清掉。
       真机现象：后手（更慢）的对手打出追加畏缩，我方当回合已经行动过、flag 没被消费 ✗，
       于是残留到下一回合让我方"无法行动"（用户报："他后发我还会被出特效"）。 */
    try {
      var __fl = (Array.isArray(st.battle.allies) ? st.battle.allies : []).concat(Array.isArray(st.battle.foes) ? st.battle.foes : []);
      for (var __fi = 0; __fi < __fl.length; __fi++) {
        var __fu = __fl[__fi];
        if (__fu && __fu.volatile && __fu.volatile['畏缩'] !== undefined) delete __fu.volatile['畏缩'];
        /* 守住只用一回合（蓄力不清，要跨回合） */
        if (__fu && __fu.volatile && __fu.volatile['守住'] !== undefined) delete __fu.volatile['守住'];
        /* 契约 10.95（P1）回合末：寄生种子/紧束类/恶梦/扎根/水流环/哈欠，以及墙与顺风计数 */
        try {
          var __u = __fu;
          if (__u && !__u.fainted) {
            var __max2 = num(__u.maxHP, 0) || 1;
            var __opp = null;
            try {
              var __isAlly = (Array.isArray(st.battle.allies) && st.battle.allies.indexOf(__u) >= 0);
              var __foes = __isAlly ? (st.battle.foes || []) : (st.battle.allies || []);
              __opp = __foes.filter(function (x) { return x && !x.fainted; })[0] || null;
            } catch (eO) { }
            if (__u.volatile['寄生种子']) {
              var __d1 = Math.max(1, Math.floor(__max2 / 8));
              __u.curHP = Math.max(0, num(__u.curHP, 0) - __d1);
              if (__opp) __opp.curHP = Math.min(num(__opp.maxHP, 0), num(__opp.curHP, 0) + __d1);
              addEntry(st, { turn: ctx.turn, actor: 'foe', actorName: __u.nickname, kind: 'status', notes: ['（寄生种子）'],
                text: __u.nickname + ' 被寄生种子吸取了体力！' });
            }
            ['紧束', '盐腌', '糖浆炸弹', '蛸固'].forEach(function (k) {
              if (__u.volatile[k]) {
                var __d2 = Math.max(1, Math.floor(__max2 / 8));
                __u.curHP = Math.max(0, num(__u.curHP, 0) - __d2);
                addEntry(st, { turn: ctx.turn, actor: 'foe', actorName: __u.nickname, kind: 'status', notes: ['（' + k + '）'],
                  text: __u.nickname + ' 受到了 ' + k + ' 的持续伤害！' });
              }
            });
            if (__u.volatile['恶梦'] && __u.status === 'slp') {
              var __d3 = Math.max(1, Math.floor(__max2 / 4));
              __u.curHP = Math.max(0, num(__u.curHP, 0) - __d3);
              addEntry(st, { turn: ctx.turn, actor: 'foe', actorName: __u.nickname, kind: 'status', notes: ['（恶梦）'],
                text: __u.nickname + ' 被恶梦折磨！' });
            }
            if (__u.volatile['扎根'] || __u.volatile['水流环']) {
              var __h3 = Math.max(1, Math.floor(__max2 / 16));
              __u.curHP = Math.min(num(__u.maxHP, 0), num(__u.curHP, 0) + __h3);
              addEntry(st, { turn: ctx.turn, actor: 'ally', actorName: __u.nickname, kind: 'status', notes: ['（回复）'],
                text: __u.nickname + ' 回复了体力。' });
            }
            if (__u.volatile['哈欠'] && (!__u.status || __u.status === 'ok' || __u.status === '健康')) {
              try { setStatus(__u, 'slp', ctx); } catch (eSl) { __u.status = 'slp'; }
              delete __u.volatile['哈欠'];
              addEntry(st, { turn: ctx.turn, actor: 'foe', actorName: __u.nickname, kind: 'status', notes: ['（哈欠）'],
                text: __u.nickname + ' 睡着了！' });
            }
            if (__u.curHP <= 0) { try { faintUnit(ctx, __u); } catch (eF2) { __u.fainted = true; } }
            /* 契约 10.96：各种回合计数递减 */
            ['再来一次', '锁定招式', '着迷'].forEach(function (k) {
              if (toInt(__u.volatile[k], 0) > 0) { __u.volatile[k] = toInt(__u.volatile[k], 0) - 1; if (__u.volatile[k] <= 0) { delete __u.volatile[k]; if (k === '锁定招式') delete __u.volatile['锁定招式名']; } }
            });

          }
        } catch (eEot) { }

        /* 挑衅计数：每回合递减，归零即解除 */
        if (__fu && __fu.volatile && toInt(__fu.volatile['挑衅'], 0) > 0) {
          __fu.volatile['挑衅'] = toInt(__fu.volatile['挑衅'], 0) - 1;
          if (__fu.volatile['挑衅'] <= 0) delete __fu.volatile['挑衅'];
        }
      }
    } catch (eFl) { /* 忽略 */ }
    /* 防重复结算（用户实测：同一回合出现两条「XXX 受到灼伤伤害」）：
     * 脏状态里同一只（同一对象或同名）可能出现在场上两次 → 这里按对象 + 昵称去重，
     * 保证每只每回合只结算一次异常伤害。 */
    var seenUnit = [];
    var seenNick = {};
    var pushUnit = function (u) {
      if (!u || seenUnit.indexOf(u) >= 0) return;
      var nick = String(u.nickname || '');
      if (nick && seenNick[nick]) return;
      if (nick) seenNick[nick] = true;
      seenUnit.push(u);
      units.push(u);
    };
    for (var ai = 0; ai < st.battle.allies.length; ai++) pushUnit(st.battle.allies[ai]);
    for (var fi2 = 0; fi2 < st.battle.foes.length; fi2++) pushUnit(st.battle.foes[fi2]);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u || u.fainted) continue;
      /* 特性跳过异常伤害：毒疗（中毒/剧毒改成回复）、魔法防守（不吃间接伤害） */
      if (u.status === 'brn' || u.status === 'psn' || u.status === 'tox') {
        if (abilityHas(u, 'noIndirectDamage')) continue;
        if (abilityHas(u, 'liquidOoze')) { /* 污泥浆只影响吸血，不影响自身 */ }
        var poisonHeal = abilityParams(u, 'endTurnHeal');
        var phWhen = poisonHeal && (poisonHeal.healWhen || poisonHeal.when);
        var phOk = !!(poisonHeal && phWhen && phWhen.statuses && phWhen.statuses.indexOf(u.status) >= 0);
        if (phOk) continue;   /* 毒疗：中毒不扣血（回复在 hookEndOfTurn 里做） */
        var dmg;
        if (u.status === 'tox') {
          u.statusCounter = toInt(u.statusCounter, 0) + 1;
          dmg = Math.max(1, Math.floor(u.maxHP * u.statusCounter / 16));
        } else {
          dmg = Math.max(1, Math.floor(u.maxHP / 8));
        }
        var from = u.curHP;
        u.curHP = Math.max(0, u.curHP - dmg);
        addEntry(st, {
          turn: ctx.turn, actor: u.side, actorName: u.nickname, kind: 'status',
          hpFrom: from, hpTo: u.curHP,
          notes: [u.nickname + ' 受到' + ctx.dex.statusText(u.status) + '伤害！'],
          text: u.nickname + ' 受到' + ctx.dex.statusText(u.status) + '伤害，失去 ' + (from - u.curHP) + ' 点体力。'
        });
        if (u.curHP <= 0) faintUnit(ctx, u);
      }
      /* 梦魇：对手睡眠时每回合掉 1/8（恶属性与特性无关） */
      var kinds = abilityKindsOf(u);
      for (var dk = 0; dk < kinds.length; dk++) {
        if (kinds[dk] !== 'endTurnDamage') continue;
        var dp = abilityParams(u, 'endTurnDamage') || {};
        if (dp.damageWhen || dp.when) continue;   /* 天气型（太阳之力）已在 hookEndOfTurn 处理 */
        var foes = foesOf(st, u);
        for (var df = 0; df < foes.length; df++) {
          if (foes[df].status === 'slp' && foes[df].types.indexOf('恶') < 0) {
            hookDamage(ctx, foes[df], num(dp.damageFraction, 0.125), u.ability);
          }
        }
      }
    }
    /* 特性回合末总钩子（回复/治愈/能力提升/心情不定/懒惰等） */
    ctx.rng = ctx.rng || mkRng(Math.random);
    for (var q = 0; q < units.length; q++) if (units[q]) bindState(units[q], st);
    hookEndOfTurn(ctx);
    if (st.battle.weather) {
      /* 简化：天气不做倒计时，MVP 里由场地效果决定（见 README） */
    }
    checkEnd(ctx);
  }

  /* ===========================================================================
   * §5 AI 决策
   * ======================================================================== */

  function makeDecideFoe(dex) {
    /**
     * 为**一只**对手选招（阶段 A：每只对手各自选招、各自消耗 PP）。
     * @param {object} st       引擎战斗态
     * @param {object} me       这只对手
     * @param {object} you      它瞄的对手（我方第一只存活单位）
     * @param {string|number} difficulty
     * @param {number} unitIndex 战位索引（写进 action.target，指明它打的是哪只）
     * @returns {object} {kind:'move'|'switch'|'skip', move, target?}
     */
    function decideForUnit(st, me, you, difficulty, unitIndex) {
      var b = obj(st.battle);
      var diffRaw = difficulty === undefined ? (obj(st.meta).difficulty || 'normal') : difficulty;
      var diff = typeof diffRaw === 'number' ? (diffRaw <= 0 ? 'easy' : (diffRaw >= 2 ? 'hard' : 'normal')) : String(diffRaw);
      var bench = b.foeBench || [];
      if (!me || me.fainted || num(me.curHP, 0) <= 0) {
        var alt = firstHealthy(bench);
        if (alt) return { kind: 'switch', to: alt.nickname, unitIndex: unitIndex };
        return { kind: 'skip', unitIndex: unitIndex };
      }
      var moves = Array.isArray(me.moves) ? me.moves : [];
      var usable = [];
      for (var i = 0; i < moves.length; i++) {
        /* 契约 10.6：未收录招式不会被 AI 主动选中（除非已无其他可用招式） */
        if (moves[i].curPP > 0 && moves[i].move && !moves[i].未识别) usable.push(moves[i]);
      }
      if (!usable.length) {
        /* 已无「已收录且可用」的招式时，才退而求其次 */
        for (var i2 = 0; i2 < moves.length; i2++) {
          if (moves[i2].curPP > 0 && moves[i2].move) usable.push(moves[i2]);
        }
      }
      /* [天梯补丁 06] 讲究锁招：AI 只在锁定的招式里选；锁定招式没 PP 时照样报它，由引擎改成挣扎 */
      try {
        var __lkA = me.volatile && me.volatile['锁招'];
        var __cdA = __lkA ? itemDefOf(me) : null;
        var __lsA = (__cdA && __cdA.choiceLock) ? findSlot(me, __lkA) : null;
        if (__lsA) {
          if (__lsA.curPP > 0 && __lsA.move) usable = [__lsA];
          else return { kind: 'move', move: __lsA.name, unitIndex: unitIndex };
        }
      } catch (eLkA) { }
      if (!usable.length) {
        /* 所有招式的 PP 都耗尽：官方口径是改用「挣扎」（挣扎不消耗 PP，可无限使用） */
        for (var i4 = 0; i4 < moves.length; i4++) {
          if (moves[i4].name === '挣扎' && moves[i4].move) usable.push(moves[i4]);
        }
      }
      if (!usable.length) {
        /* 连挣扎都没有：退回「已知招式」（引擎会记「PP 已耗尽」的日志），绝不静默不出手 */
        var known = null;
        for (var i3 = 0; i3 < moves.length; i3++) if (moves[i3].move) { known = moves[i3]; break; }
        if (known) usable.push(known);
      }
      /* 实在一招都没有（技能位全空）→ 本回合跳过，由引擎记日志 */
      if (!usable.length) return { kind: 'skip', unitIndex: unitIndex };
      if (diff === 'easy') return { kind: 'move', move: usable[0].name, unitIndex: unitIndex };

      var tgtIndex = 0;
      var allyArr = sideArray(st, 'ally');
      for (var t = 0; t < allyArr.length; t++) {
        if (allyArr[t] && !allyArr[t].fainted && num(allyArr[t].curHP, 0) > 0) { tgtIndex = t; break; }
      }
      if (you) {
        for (var t2 = 0; t2 < allyArr.length; t2++) { if (allyArr[t2] === you) { tgtIndex = t2; break; } }
      }

      /* 阶段 B：双打 —— 先在我方两只之间按威胁择一
       * （一击可带走 > 相性 > 速度 > 血量低），再对选中的那只选威力/相性最好的招。 */
      var aliveCands = [];
      for (var at = 0; at < allyArr.length; at++) {
        if (allyArr[at] && !allyArr[at].fainted && num(allyArr[at].curHP, 0) > 0) aliveCands.push({ u: allyArr[at], i: at });
      }
      if (!aliveCands.length && you) aliveCands.push({ u: you, i: tgtIndex });
      var threat = pickThreatTarget(st, me, aliveCands, usable);
      if (threat) { you = threat.u; tgtIndex = threat.i; }

      var best = usable[0], bestScore = -1e9;
      for (var k = 0; k < usable.length; k++) {
        var slot = usable[k], mv = slot.move;
        var score = 0;
        if (mv.category === 'status') {
          score = 12;
          /* 变化招式的目标：self/ally 的招不该按"打对手"来估分 */
          var stKind = moveTargetKind(mv);
          if (stKind === 'ally' && aliveCands.length < 2) score = -30;
          if (mv.status === '睡眠' && you && you.status !== 'ok') score = -50;
          if (mv.boosts && toInt(obj(me.stages).atk, 0) >= 4) score = -20;
          if (mv.rest && me.curHP > me.maxHP * 0.4) score = -40;
          if (mv.weather && st.battle.weather === mv.weather) score = -30;
        } else {
          /* 群体招式按「所有对手里相性最好的那个」估分 */
          var kind = moveTargetKind(mv);
          var cands = (kind === 'allAdjacentFoes' || kind === 'allAdjacent')
            ? sideArray(st, 'ally').filter(function (u) { return u && !u.fainted && num(u.curHP, 0) > 0; })
            : (you ? [you] : []);
          var mEff = 0;
          for (var c = 0; c < cands.length; c++) mEff = Math.max(mEff, dex.moveEff(mv, cands[c].types));
          if (!cands.length) mEff = 1;
          if (mEff === 0) score = -100;
          else {
            var A = effAtk(me, mv.category);
            var D = you ? effDef(you, mv.category, false) : 1;
            var pw = num(mv && mv.power, 0) || (mv && mv.fixedDamage === 'level' ? me.level : 1);
            score = (pw * A / Math.max(1, D)) * mEff * (me.types.indexOf(mv.type) >= 0 ? 1.5 : 1) * 0.4;
            score *= weatherMul(st.battle.weather, mv.type);
            if (you && you.curHP > 0) {
              var est = Math.max(1, Math.floor(score));
              if (est >= you.curHP) score += 40; /* 能一击带走就优先 */
            }
          }
        }
        score += (toInt(mv.priority, 0) > 0 ? 4 : 0);
        score += (slot.curPP / Math.max(1, slot.maxPP)) * 2;
        if (diff !== 'hard') score = Math.round(score * 10) / 10;
        if (score > bestScore) { bestScore = score; best = slot; }
      }
      return { kind: 'move', move: best.name, target: tgtIndex, unitIndex: unitIndex };
    }

    /**
     * 阶段 B：双打里在我方多只之间按威胁择一（返回 {u, i} 或 null）。
     * 判据顺序（严格字典序，前者优先）：
     *   ① 一击可带走（这只有招能一发带走它）
     *   ② 相性（对它最好的伤害倍率）
     *   ③ 速度（速度越高越该优先处理）
     *   ④ 血量低（残血的更好收）
     * 单只候选时原样返回（单打行为不变）。
     */
    function pickThreatTarget(st, me, cands, usable) {
      if (!cands || !cands.length) return null;
      if (cands.length === 1) return cands[0];
      var scored = [];
      for (var c = 0; c < cands.length; c++) {
        var u = cands[c].u;
        var ko = false, bestEff = 0;
        for (var k = 0; k < usable.length; k++) {
          var mv = usable[k] && usable[k].move;
          if (!mv || mv.category === 'status') continue;
          var kind = moveTargetKind(mv);
          if (kind === 'self' || kind === 'ally') continue;
          var eff = dex.moveEff(mv, u.types);
          if (eff > bestEff) bestEff = eff;
          if (eff <= 0) continue;
          var A = effAtk(me, mv.category);
          var D = effDef(u, mv.category, false);
          var pw = num(mv && mv.power, 0) || (mv && mv.fixedDamage === 'level' ? me.level : 0);
          var est = Math.floor((pw * A / Math.max(1, D)) * eff * 0.4 * weatherMul(st.battle.weather, mv.type));
          if (est >= num(u.curHP, 1)) ko = true;
        }
        var hpMax = Math.max(1, num(u.maxHP, 1));
        scored.push({
          u: u, i: cands[c].i, ko: ko, eff: bestEff,
          speed: effSpeed(u, { state: st, weather: st.battle.weather, dex: dex }),
          hpRatio: num(u.curHP, 0) / hpMax
        });
      }
      var bestT = scored[0];
      for (var s = 1; s < scored.length; s++) {
        var a = scored[s], b = bestT;
        var better = false;
        if (a.ko !== b.ko) better = a.ko;
        else if (a.eff !== b.eff) better = a.eff > b.eff;
        else if (a.speed !== b.speed) better = a.speed > b.speed;
        else if (a.hpRatio !== b.hpRatio) better = a.hpRatio < b.hpRatio;
        if (better) bestT = a;
      }
      return { u: bestT.u, i: bestT.i };
    }

    /**
     * decideFoe(state, difficulty, unitIndex)
     *   difficulty: 'easy' | 'normal' | 'hard'（默认 normal），也接受数字 0/1/2
     *   unitIndex: 对手战位索引（默认 0，即第一只）；阶段 A 里每只对手各调一次
     *   返回契约里的 action 形状：{kind:'move', move:'地震', target:0}
     */
    function decideFoe(state, difficulty, unitIndex) {
      var st = isPlainObject(state) ? state : {};
      var b = obj(st.battle);
      var arr = (Array.isArray(b.foes) && b.foes.length) ? b.foes : (b.foe ? [b.foe] : []);
      var idx = Math.max(0, toInt(unitIndex, 0));
      var me = arr[idx] || b.foe || null;
      var you = firstAliveOf(sideArray(st, 'ally')) || b.ally || null;
      var out = decideForUnit(st, me, you, difficulty, idx);
      /* 换人/跳过不需要 target；出招则把目标索引写进 action（缺省 = 第一个存活的我方战位） */
      if (out && out.kind === 'move' && out.target === undefined) {
        var aArr = sideArray(st, 'ally');
        var firstAlive = 0;
        for (var ai2 = 0; ai2 < aArr.length; ai2++) {
          if (aArr[ai2] && !aArr[ai2].fainted && num(aArr[ai2].curHP, 0) > 0) { firstAlive = ai2; break; }
        }
        out.target = firstAlive;
      }
      return out;
    }

    /**
     * decideFoeRound(state, difficulty) —— 阶段 A：一次给出**每只对手**的动作
     * @returns {Array} [{side:'foe', unitIndex, action}]
     */
    function decideFoeRound(state, difficulty) {
      var st = isPlainObject(state) ? state : {};
      var b = obj(st.battle);
      var arr = (Array.isArray(b.foes) && b.foes.length) ? b.foes : (b.foe ? [b.foe] : []);
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var you = firstAliveOf(sideArray(st, 'ally')) || b.ally || null;
        out.push({ side: 'foe', unitIndex: i, action: decideForUnit(st, arr[i], you, difficulty, i) });
      }
      return out;
    }

    decideFoe.forUnit = decideForUnit;
    decideFoe.round = decideFoeRound;
    return decideFoe;
  }

  /* ===========================================================================
   * §6 patch 输出（字段名严格对齐 stat_data，见契约第 3 节）
   * ======================================================================== */

  /** 单位 → 己方战位对象（含 昵称/种族/当前体力/体力上限/异常状态/携带物/技能位/增益与减益） */
  function toAllySlot(dex, unit) {
    var moves = {};
    for (var i = 0; i < unit.moves.length && i < 4; i++) {
      var s = unit.moves[i];
      var disp = slotDisplay(dex, s.move, s);
      disp.PP = s.未识别 ? DASH : (s.maxPP ? (disp.PP === DASH ? String(s.curPP) : String(s.curPP) + '/' + s.maxPP) : disp.PP);
      moves[s.name] = disp;
    }
    return {
      昵称: unit.nickname,
      种族: unit.species,
      当前体力: unit.curHP,
      体力上限: unit.maxHP,
      异常状态: dex.statusText(unit.fainted ? 'fnt' : unit.status),
      携带物: unit.item,
      技能位: moves,
      增益与减益: stagesRecord(unit)
    };
  }

  /**
   * 单位 → 对方战位对象（字段名是 名称/种族/显现属性/状态/已探明信息）
   * @param {object} base 可选的 stat_data 里该槽位的**原对象**（写回保护用，契约 10.28）
   */
  function toFoeSlot(dex, unit, base) {
    var moves = {};
    for (var i = 0; i < unit.moves.length && i < 4; i++) {
      var s = unit.moves[i];
      var disp = slotDisplay(dex, s.move, s);
      disp.PP = s.未识别 ? DASH : (s.maxPP ? String(s.curPP) + '/' + s.maxPP : disp.PP);
      moves[s.name] = disp;
    }
    var baseSlot = obj(base);
    /* 写回保护：只有当我方（引擎）确实解析到非空特性时才覆盖 已知特性；
       否则保留变量里原有的值 —— AI 写在卡里的侦查结果（例如「结实」）不会被清空。 */
    var origAbility = origOf(unit, '已知特性');
    if (origAbility === undefined || origAbility === null || origAbility === '') {
      var bv = baseSlot.已知特性;
      origAbility = (bv === undefined || bv === null) ? '' : String(bv).trim();
    }
    var abilityOut = (unit.ability && unit.ability !== '未知' && unit.abilityFrom !== 'species') ? unit.ability : origAbility;
    var origItem = origOf(unit, '已知携带');
    if (origItem === undefined || origItem === null || origItem === '') {
      var bi = baseSlot.已知携带;
      origItem = (bi === undefined || bi === null) ? '' : String(bi).trim();
    }
    var itemOut = (unit.item && unit.item !== '无') ? unit.item : origItem;
    return {
      名称: unit.nickname,
      种族: unit.species,
      显现属性: unit.types.join('/'),
      等级: unit.level,                    /* 契约 10.7：反推出来的等级要写回槽位 */
      当前体力: unit.curHP,
      体力上限: unit.maxHP,
      状态: dex.statusText(unit.fainted ? 'fnt' : unit.status),
      增益与减益: stagesRecord(unit),
      已知特性: abilityOut,
      已知携带: itemOut,
      技能位: moves
    };
  }

  function toBenchEntry(unit) {
    return { 名称: unit.nickname, 当前体力: unit.curHP, 体力上限: unit.maxHP, 状态: unit.fainted ? '濒死' : '健康' };
  }

  /**
   * 场上存活单位（写回战位用）：只保留还能战斗的，且按场上顺序。
   * 全灭时返回空数组（调用方退回「最后快照」，避免面板一片空白）。
   */
  function aliveOnField(arr, first) {
    var list = Array.isArray(arr) && arr.length ? arr.slice() : (first ? [first] : []);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u && !u.fainted && num(u.curHP, 0) > 0) out.push(u);
    }
    return out;
  }

  /** 单位 → stat_data 形状快照 */
  function snapshotImpl(state, dexOverride) {    var dex = dexOverride || state.__dex || null;
    var b = state.battle;
    var out = {};
    var battle = {};
    battle.处于对战中 = !state.ended;
    battle.对战模式 = b.对战模式 || '常规单打';
    battle.对方身份 = b.对方身份 || '未登记对手';
    battle.场地环境 = b.场地环境 || '标准场地';
    battle.场地效果 = b.场地效果 ? deepClone(b.场地效果) : weatherText(b.weather);
    battle.己方战位 = {};
    /* 写回的槽位数 = 场上上限（我方 1 / 双打 2、对手 2）：**只写还在场上的活单位**，
     * 槽位号按场上顺序重新编号 1..N —— 死掉的不再占战位（它的战果在日志/战报里）。 */
    var allyField = aliveOnField(b.allies, b.ally);
    if (allyField.length) {
      for (var aa = 0; aa < allyField.length; aa++) {
        battle.己方战位[String(aa + 1)] = dex ? toAllySlot(dex, allyField[aa]) : {};
      }
    } else if (b.ally) battle.己方战位[String(b.ally.pos || '1')] = dex ? toAllySlot(dex, b.ally) : {};
    battle.己方待命 = {};
    for (var i = 0; i < (b.bench || []).length; i++) battle.己方待命[b.bench[i].nickname] = toBenchEntry(b.bench[i]);
    battle.对方战位 = {};
    var baseFoeSlots = obj(obj(state.__stat).对方战位);
    var foeField = aliveOnField(b.foes, b.foe);
    /* 契约（对手变量保真）：**写回键名 = 单位从变量里读出来时用的那个键**。
     *   - AI 的语义键（敌方首领1 / 敌方武装1 / 敌集群 …）→ 原样保留，绝不改成 战位1/待命2；
     *   - 引擎自己的数字槽位键（"1"/"2"）→ 按场上顺序重排（卡面板的槽位号，补位顶进同一槽位）。
     * 场上同时登场的上限仍然是 2（卡面板只有 2 个对手槽），但那只限制只由
     * fillFieldSlots / compactFieldSlots 的「候补顶进同一槽位」实现，**绝不靠删变量里的单位**。 */
    if (foeField.length) {
      for (var ff = 0; ff < foeField.length; ff++) {
        var fKey = varKeyOf(foeField[ff], String(ff + 1));
        battle.对方战位[fKey] = dex
          ? toFoeSlot(dex, foeField[ff], baseFoeSlots[fKey] || baseFoeSlots[String(ff + 1)])
          : {};
      }
    } else if (b.foe) {
      var fPos = varKeyOf(b.foe, String(b.foe.pos || '1'));
      battle.对方战位[fPos] = dex ? toFoeSlot(dex, b.foe, baseFoeSlots[fPos]) : {};
    }
    battle.对方待命 = {};
    for (var j = 0; j < (b.foeBench || []).length; j++) {
      /* 候补同样用原键名（非数字键原样；数字槽位键沿用「从 2 起」的槽位号） */
      var bKey = varKeyOf(b.foeBench[j], String(j + 2));
      battle.对方待命[bKey] = toBenchEntry(b.foeBench[j]);
    }
    /* 契约（对手变量保真）：种族解析不了、本场无法逐只建模的对手条目 ——
     * **整条原样写回**（原键名 + 原字段，一个都不改、一个都不丢）。
     * 它们不参与伤害结算（打不到也打不死），所以不参与回合内的全灭判定；
     * 但接管残局时会被 foeSideAllDown 计入（还有活着的就不按「对手已全灭」收场）。 */
    var rawFoes = obj(state.meta).未建模对手;
    if (Array.isArray(rawFoes)) {
      for (var rj = 0; rj < rawFoes.length; rj++) {
        var rEntry = obj(rawFoes[rj]);
        var rKey = String(rEntry.key === undefined || rEntry.key === null ? '' : rEntry.key);
        if (!rKey) continue;
        if (battle.对方待命[rKey] !== undefined) continue;   /* 已经建模的那只优先 */
        battle.对方待命[rKey] = deepClone(obj(rEntry.value));
      }
    }
    out.当前对战 = battle;

    /* 队伍：把战位上的体力/经验写回对应成员 */
    var party = deepClone(obj(state.party));
    var field = {};
    if (b.ally) field[b.ally.nickname] = b.ally;
    for (var k = 0; k < (b.bench || []).length; k++) field[b.bench[k].nickname] = b.bench[k];
    var names = Object.keys(party);
    for (var n = 0; n < names.length; n++) {
      var u = field[names[n]];
      if (!u) continue;
      party[names[n]].当前体力 = u.curHP;
      party[names[n]].体力上限 = u.maxHP;
      party[names[n]].等级 = u.level;
      party[names[n]].当前经验值 = u.exp;
      party[names[n]].经验上限 = u.expNext;
      party[names[n]].状态 = u.fainted ? '濒死' : (u.status === 'ok' ? '健康' : dex.statusText(u.status));
    }
    out.宝可梦队伍 = party;
    out.后备宝可梦 = deepClone(obj(state.box));
    out.背包栏 = { 金钱: num(obj(state.bag).金钱, 0), 物品: deepClone(obj(obj(state.bag).物品)) };
    return out;
  }

  /** 只保留引擎真正拥有的顶层字段，避免把 stat_data 其余内容写坏 */
  function rootsOf(state) {
    var roots = ['当前对战', '宝可梦队伍', '背包栏'];
    if (state.box && Object.keys(obj(state.box)).length) roots.push('后备宝可梦');
    return roots;
  }

  /** 递归求 replace op（只在值不同时产出） */
  function diffOps(out, node, path) {
    var keys = Object.keys(obj(node));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = node[k];
      var p = path + '/' + esc(k);
      if (isPlainObject(v)) { out.push({ op: 'replace', path: p, value: {} }); diffOps(out, v, p); }
      else out.push({ op: 'replace', path: p, value: deepClone(v) });
    }
    return out;
  }

  /**
   * toPatches(state) —— 与 stat_data 的差异
   *   toPatches(state, stat_data)  → 精确差异（推荐）
   *   toPatches(state)             → 全量 replace（幂等，可直接顺序应用）
   */
  function toPatchesImpl(state, statData, dexOverride) {
    if (!isEngineState(state)) fail('toPatches：state 不是 startFromStat 的产物');
    var snap = snapshotImpl(state, dexOverride || state.__dex);
    var base = statData;
    var ops = [];
    var roots = rootsOf(state);
    for (var i = 0; i < roots.length; i++) {
      var key = roots[i];
      if (key !== '宝可梦队伍' && key !== '后备宝可梦') {
        var existed = base && isPlainObject(obj(base)[key]);
        ops.push({ op: existed ? 'replace' : 'insert', path: '/' + esc(key), value: {} });
      }
      diffOps(ops, snap[key], '/' + esc(key));
    }
    /* 战位/候补是「按只数变长变短」的容器：只 replace 不 remove 会把上一回合的
     * 对方战位.3（死的/超编的）留在变量里 —— 面板于是画出第三个对手槽。
     * 这里按 base（没有 base 就用开战时的快照 __stat）把多余的槽位显式 remove。
     * 注意 __stat 有两种形状：完整 stat_data（含 当前对战）与 { 对方战位 } 快照。 */
    var baseRoot = (base && isPlainObject(base)) ? obj(base) : obj(state.__stat);
    var baseAll = obj(baseRoot['当前对战']);
    if (!Object.keys(baseAll).length && (baseRoot['对方战位'] || baseRoot['己方战位'])) baseAll = baseRoot;
    var snapBattle = obj(snap['当前对战']);
    ['己方战位', '对方战位', '己方待命', '对方待命'].forEach(function (container) {
      var bSlots = obj(baseAll[container]);
      var sSlots = obj(snapBattle[container]);
      Object.keys(bSlots).forEach(function (k) {
        if (sSlots[k] === undefined) {
          ops.push({ op: 'remove', path: '/当前对战/' + esc(container) + '/' + esc(k) });
        }
      });
    });
    return ops;
  }

  /* ===========================================================================
   * §7 战报
   * ======================================================================== */

  function buildReportImpl(state, log) {
    if (!isEngineState(state)) fail('buildReport：state 不是 startFromStat 的产物');
    var dex = state.__dex || null;
    var b = state.battle;
    var entries = Array.isArray(log) ? log : (Array.isArray(obj(state.meta).lastLog) ? state.meta.lastLog : []);
    var ally = b.ally, foe = b.foe;

    /* 回合摘要 */
    var byTurn = {};
    var order = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var t = toInt(e.turn, 0);
      if (!byTurn[t]) { byTurn[t] = []; order.push(t); }
      byTurn[t].push(e);
    }
    order.sort(function (a, c) { return a - c; });
    var turns = [];
    for (var o = 0; o < order.length; o++) {
      var tn = order[o];
      var lines = [];
      for (var j = 0; j < byTurn[tn].length; j++) lines.push(byTurn[tn][j].text);
      turns.push({ turn: tn, title: tn === 0 ? '开战' : '第 ' + tn + ' 回合', lines: lines });
    }

    var resultText = state.ended
      ? (state.winner === 'ally' ? '胜利！' : state.winner === 'foe' ? '败北……' : '平局')
      : '战斗进行中';
    var expected = (ally && !ally.fainted) ? ally.nickname : '';
    var rewards = {
      exp: deepClone(obj(state.meta).expGained || {}),
      levelUps: deepClone(obj(state.meta).levelUps || []),
      random: expected,
      note: expected ? ('若为野生宝可梦，可由集成层追加捕获/掉落判定（引擎不做）') : '我方没有存活的宝可梦，无奖励'
    };
    if (state.rewards && state.rewards.exp) rewards = state.rewards;

    /* 阶段 A：战报必须列出**全部**对手（1 vs N 群战时不能只写第一只） */
    var foeList = (Array.isArray(b.foes) && b.foes.length) ? b.foes : (foe ? [foe] : []);
    var allyList = (Array.isArray(b.allies) && b.allies.length) ? b.allies : (ally ? [ally] : []);
    var unitTag = function (u) {
      return u ? (u.nickname + '（' + (u.types || []).join('/') + ' Lv.' + u.level + '）') : '未知';
    };
    var summary = [
      (b.对方身份 || '对手') + '：' + (foeList.length
        ? foeList.map(function (u) { return unitTag(u) + (u.fainted ? '【已倒下】' : ''); }).join('、')
        : '未知'),
      '我方：' + (allyList.length ? allyList.map(unitTag).join('、') : '未知'),
      '回合数：' + toInt(obj(state.meta).turnCount, 0),
      '结果：' + resultText + (state.endReason ? '（' + state.endReason + '）' : '')
    ].join('；');

    var hpLine = [];
    for (var hi = 0; hi < allyList.length; hi++) {
      if (allyList[hi]) hpLine.push(allyList[hi].nickname + ' ' + allyList[hi].curHP + '/' + allyList[hi].maxHP);
    }
    for (var hj = 0; hj < foeList.length; hj++) {
      if (foeList[hj]) hpLine.push(foeList[hj].nickname + ' ' + foeList[hj].curHP + '/' + foeList[hj].maxHP);
    }

    /* 击倒台账：战报/结束日志的权威战果（不受 compaction 影响） */
    var kos = koSorted(state);
    var kosFoe = kos.filter(function (k) { return k.side === 'foe'; });
    var kosAlly = kos.filter(function (k) { return k.side === 'ally'; });
    var endHeader = endHeaderText(state);

    return {
      title: state.ended
        ? ('对战结果：' + resultText)
        : ('对战进行中 · 第 ' + toInt(obj(state.meta).turnCount, 0) + ' 回合'),
      summary: summary,
      turns: turns,
      result: {
        ended: !!state.ended,
        winner: state.winner || null,
        winnerText: resultText,
        reason: state.endReason || '',
        hp: hpLine.join(' / '),
        turns: toInt(obj(state.meta).turnCount, 0),
        /* —— 战报首行：结束状态 + 原因/全部战果（简略版与详细版共用） —— */
        endHeader: endHeader,
        koLine: kos.length ? ('击倒：' + koTagText(kos)) : '',
        /* —— 击倒台账（双方都列、按回合排序、去重）：战果的权威来源 —— */
        kos: deepClone(kos),
        koCount: { ally: kosAlly.length, foe: kosFoe.length, total: kos.length },
        koText: koTagText(kos),
        koFoeText: koTagText(kosFoe),
        koAllyText: koTagText(kosAlly)
      },
      rewards: rewards,
      improvs: listImprovsImpl(state),          /* 契约 10.2：口胡项单独成节 */
      improvsText: improvsSection(state),       /* 供消息直接拼接的文本块 */
      unmapped: deepClone(obj(state.meta).unmapped || []),         /* 契约 10.5 */
      unrecognizedMoves: deepClone(obj(state.meta).unrecognizedMoves || []),
      customMoves: deepClone(obj(state.meta).customMoves || []),
      ruleset: obj(state.meta).ruleset || 'official',
      violations: deepClone(obj(state.meta).violations || []),
      statusSnapshot: statusSnapshotImpl(state),
      log: entries.slice()
    };
  }

  /* ===========================================================================
   * §8 中途交棒 / 一行状态（契约 10.3）
   * ======================================================================== */

  function pctText(u) {
    var pct = u.maxHP > 0 ? Math.round((u.curHP / u.maxHP) * 100) : 0;
    return u.curHP + '/' + u.maxHP + '（' + pct + '%）';
  }
  function mechText(list) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '未使用';
    var label = { mega: '超级进化', z: 'Z招式', dmax: '极巨化', tera: '太晶化' };
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      var nm = m && typeof m === 'object' ? m.机制 : m;
      var who = m && typeof m === 'object' ? m.使用者 : '';
      out.push((who ? who + '：' : '') + (label[nm] || nm));
    }
    return out.join('、');
  }

  function unitLine(u, side) {
    if (!u) return '（无）';
    var st = dexStatusText(u);
    var stages = stagesText(u) || '无';
    return u.nickname + '（' + (u.species || '') + ' Lv.' + u.level + (u.levelCapped ? '／实际 ' + u.realLevel : '') + '）' +
      ' HP ' + pctText(u) + '　异常：' + st + '　能力阶级：' + stages +
      (u.fainted ? '　【已濒死】' : '') +
      (u.ability ? '　特性：' + u.ability : '') +
      (u.item && u.item !== '无' ? '　携带：' + u.item : '');
  }
  function dexStatusText(u) {
    if (u.fainted) return '濒死';
    var code = u.status || 'ok';
    return STATUS_ZH[code] || code;
  }
  function benchLine(list, label) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return '（无待命）';
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var u = arr[i];
      out.push(u.nickname + ' Lv.' + u.level + ' ' + u.curHP + '/' + u.maxHP + (u.fainted ? '（濒死）' : ''));
    }
    return out.join('、');
  }
  function movesLine(u) {
    if (!u || !Array.isArray(u.moves) || !u.moves.length) return '（无）';
    var out = [];
    for (var i = 0; i < u.moves.length; i++) {
      var s = u.moves[i];
      out.push(s.name + '（PP ' + s.curPP + '/' + s.maxPP + (s.未识别 ? '，未识别' : '') + '）');
    }
    return out.join('、');
  }
  function weatherLines(state) {
    var w = state.battle.weather ? String(state.battle.weather) : '无';
    var eff = obj(state.battle.场地效果);
    var keys = Object.keys(eff).filter(function (k) { return k !== '天气'; });
    return '天气：' + w + '　场地环境：' + (state.battle.场地环境 || '标准场地') +
      (keys.length ? '　场地效果：' + keys.join('、') : '') +
      (state.battle.场地效果 && state.battle.场地效果.天气 ? '　场地效果.天气：' + state.battle.场地效果.天气 : '');
  }
  function endConditionText(state) {
    if (state.ended) {
      var t = state.winner === 'ally' ? '我方胜利' : state.winner === 'foe' ? '我方败北' : '平局';
      return '已结束（' + t + (state.endReason ? '：' + state.endReason : '') + '）';
    }
    var allyLeft = ((Array.isArray(state.battle.allies) && state.battle.allies.length
      ? state.battle.allies : [state.battle.ally]).filter(function (u) { return u && !u.fainted; }).length) +
      (state.battle.bench || []).filter(function (u) { return !u.fainted; }).length;
    var foeLeft = ((Array.isArray(state.battle.foes) && state.battle.foes.length
      ? state.battle.foes : [state.battle.foe]).filter(function (u) { return u && !u.fainted; }).length) +
      (state.battle.foeBench || []).filter(function (u) { return !u.fainted; }).length;
    return '一方场上与待命全部失去战斗能力即判负（我方剩余 ' + allyLeft + ' 只，对方剩余 ' + foeLeft + ' 只）；认输／逃跑立即结束';
  }
  /** 口胡项文本节（契约 10.2：单独成节） */
  function improvsSection(state) {
    var list = listImprovsImpl(state);
    if (!list.length) return '口胡项：无（本场没有超出规则的临场发挥）';
    var lines = ['口胡项（共 ' + list.length + ' 条，均可撤销）：'];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      lines.push('  ' + (i + 1) + '. [' + it.来源 + '] ' + it.描述 + '｜作用：' + it.作用 + '｜修正：' +
        improvText(it.修正) + '｜剩余回合：' + (it.剩余回合 === null ? '本回合' : it.剩余回合));
    }
    return lines.join('\n');
  }
  function unmappedSection(state) {
    var u = obj(state.meta).unmapped || [];
    var m = obj(state.meta).unrecognizedMoves || [];
    var lines = [];
    if (u.length) {
      lines.push('未实现项（已提示、未参与结算，可走口胡通道）：');
      for (var i = 0; i < u.length; i++) lines.push('  - ' + u[i].text);
    }
    if (m.length) {
      lines.push('未收录招式（按未识别处理，可用 defineMove 定义）：');
      for (var j = 0; j < m.length; j++) lines.push('  - ' + m[j].holder + '：' + m[j].原名称);
    }
    return lines.length ? lines.join('\n') : '';
  }

  /** ENG.statusSnapshot(state) → 一行状态（面板/交棒都用） */
  function statusSnapshotImpl(state) {
    if (!isEngineState(state)) fail('statusSnapshot：state 不是 startFromStat 的产物');
    var foe = state.battle.foe;
    var parts = [];
    parts.push('第' + toInt(obj(state.meta).turnCount, 0) + '回合');
    var oneLine = function (u) {
      if (!u) return '无';
      return u.nickname + ' ' + u.curHP + '/' + u.maxHP +
        (u.fainted ? ' 濒死' : (u.status && u.status !== 'ok' ? ' ' + dexStatusText(u) : '')) +
        (stagesText(u) ? ' ' + stagesText(u) : '');
    };
    /* 阶段 A：一行状态里列出**全部**战位（我方 1 只 + 对手 N 只） */
    var allyList = (Array.isArray(state.battle.allies) && state.battle.allies.length)
      ? state.battle.allies : (state.battle.ally ? [state.battle.ally] : []);
    var foeList = (Array.isArray(state.battle.foes) && state.battle.foes.length)
      ? state.battle.foes : (foe ? [foe] : []);
    parts.push('我方 ' + (allyList.length ? allyList.map(oneLine).join('、') : '无'));
    parts.push('敌方 ' + (foeList.length ? foeList.map(oneLine).join('、') : '无'));
    if (state.battle.weather) parts.push('天气 ' + state.battle.weather);
    if (state.ended) parts.push('已结束·' + (state.winner === 'ally' ? '我方胜' : state.winner === 'foe' ? '我方负' : '平局'));
    return parts.join('｜');
  }

  /**
   * ENG.buildHandoff(state, log, {规则集, 口胡项}) → { 标题, 正文, 变量补丁, 给模型的要求 }
   */
  function buildHandoffImpl(state, log, opts) {
    if (!isEngineState(state)) fail('buildHandoff：state 不是 startFromStat 的产物');
    var o = obj(opts);
    var entries = Array.isArray(log) && log.length ? log
      : (Array.isArray(obj(state.meta).lastLog) ? obj(state.meta).lastLog : []);
    var ally = state.battle.ally, foe = state.battle.foe;
    var improvs = o.口胡项 ? listImprovsImpl(state) : listImprovsImpl(state);
    var lines = [];
    lines.push('【战斗交接】规则集：' + (o.规则集 || obj(state.meta).ruleset || 'official') +
      '（' + ((obj(state.meta).rules || {}).reason || '') + '）');
    lines.push('当前回合：第 ' + toInt(obj(state.meta).turnCount, 0) + ' 回合');
    lines.push('对手身份：' + (state.battle.对方身份 || '未登记对手') + '　对战模式：' + (state.battle.对战模式 || '常规单打'));
    lines.push('');
    lines.push('— 我方场上 —');
    var allyAll = (Array.isArray(state.battle.allies) && state.battle.allies.length)
      ? state.battle.allies : (ally ? [ally] : []);
    for (var al = 0; al < allyAll.length; al++) lines.push('  ' + unitLine(allyAll[al], 'ally'));
    lines.push('  我方待命：' + benchLine(state.battle.bench));
    lines.push('— 对方场上 —');
    var foeAll = (Array.isArray(state.battle.foes) && state.battle.foes.length)
      ? state.battle.foes : (foe ? [foe] : []);
    for (var fl = 0; fl < foeAll.length; fl++) {
      lines.push('  [' + (fl + 1) + '] ' + unitLine(foeAll[fl], 'foe'));
    }
    lines.push('  对方待命：' + benchLine(state.battle.foeBench));
    /* 契约（对手变量保真）：种族解析不了、本场无法逐只建模的对手条目 ——
     * 它们原样留在变量里（写回时不丢），这里也要如实告诉模型，免得模型以为"对手少了"。 */
    var rawFoeList = obj(state.meta).未建模对手;
    if (Array.isArray(rawFoeList) && rawFoeList.length) {
      var rawTxt = [];
      for (var rf = 0; rf < rawFoeList.length; rf++) {
        var rv = obj(obj(rawFoeList[rf]).value);
        rawTxt.push('「' + String(obj(rawFoeList[rf]).key) + '」' + String(rv.名称 || '未命名') +
          ' ' + num(rv.当前体力, 0) + '/' + num(rv.体力上限, 0) + '（' + String(rv.状态 || '') + '）');
      }
      lines.push('  对方待命（种族无法解析·按原样保留、本场不参与结算）：' + rawTxt.join('、'));
    }
    lines.push('');
    lines.push('— 场地 —');
    lines.push('  ' + weatherLines(state));
    lines.push('— 特殊机制 —');
    lines.push('  我方：' + mechText(obj(state.meta.mechanicsUsed).ally) + '　对方：' + mechText(obj(state.meta.mechanicsUsed).foe));
    if ((obj(state.meta).rules || {}).单场单机制) {
      lines.push('  规程：单场比赛一方仅限激活一次特殊机制（四选一且单场仅限一只），超限使用直接判负');
    }
    lines.push('— 我方剩余招式与 PP —');
    lines.push('  ' + movesLine(ally));
    if (ally && Array.isArray(ally.moves)) {
      for (var mi = 0; mi < ally.moves.length; mi++) {
        var s = ally.moves[mi];
        if (s.未识别) {
          lines.push('  ⚠ 「' + s.原名称 + '」未收录，未参与结算（可用口胡通道或 defineMove 定义）');
        }
      }
    }
    lines.push('— 终局条件 —');
    lines.push('  ' + endConditionText(state));
    if (improvs.length) {
      lines.push('— 口胡项（必须体现在正文里，且不得自行改动数值） —');
      for (var i = 0; i < improvs.length; i++) {
        var it = improvs[i];
        lines.push('  ' + (i + 1) + '. [' + it.来源 + '] ' + it.描述 + '（作用 ' + it.作用 + '，修正 ' +
          improvText(it.修正) + '，剩余 ' + (it.剩余回合 === null ? '本回合' : it.剩余回合 + ' 回合') + '）');
      }
    } else {
      lines.push('— 口胡项 —');
      lines.push('  无');
    }
    var unmap = unmappedSection(state);
    if (unmap) { lines.push('— 未实现项提示 —'); lines.push(unmap); }
    lines.push('— 最近关键日志 —');
    var tail = entries.slice(-5);
    if (!tail.length) lines.push('  （暂无）');
    for (var k = 0; k < tail.length; k++) {
      lines.push('  · ' + (tail[k].text || ''));
    }
    lines.push('');
    lines.push('— 一行状态 —');
    lines.push('  ' + statusSnapshotImpl(state));

    var patches = toPatchesImpl(state, o.stat_data, state.__dex);
    var requirements = [
      '只描写，不重算数值：HP、伤害、命中、PP、经验等一律以上面提供的快照为准。',
      '不要自行新增招式/特性/道具效果；需要临场发挥时，回来调用 applyImprov 并写明来源与描述。',
      improvs.length ? '上面列出的口胡项必须在正文里体现出来，并且不要重复叠加倍率。' : '本场暂无口胡项，按官方规则描写即可。',
      '若出现「未收录招式」或「未参与结算」的提示，正文里要自然带过（例如“那一招并没有打出预想的效果”），不要凭空补数值。',
      '战斗终结条件按上面写明的判负规则推进；分出胜负时把结果交回本地引擎确认。'
    ].join('\n');
    return {
      标题: '【战斗交接】',
      正文: lines.join('\n'),
      变量补丁: patches,
      给模型的要求: requirements,
      statusSnapshot: statusSnapshotImpl(state),
      improvs: improvs
    };
  }

  /* ===========================================================================
   * 入口：createEngine(DATA)
   * ======================================================================== */

  /**
   * 构造一个引擎实例。
   * 实例上除契约要求的 7 个函数外，另有 instance.utils（测试/集成用的稳定小工具）。
   * 工厂底部会把 instance.utils 提升为 createEngine.utils，见文件末尾的 UMD 区块。
   */
  function createEngineImpl(DATA, options) {
    /* 自定义招式表（defineMove 写入）：与口胡通道共用留痕机制，可撤销 */
    var customMoves = {};
    var opt = obj(options);
    var dex = buildDex(DATA, {
      ruleset: opt.ruleset || 'official',
      abilityKinds: opt.abilityKinds, itemKinds: opt.itemKinds,
      weathers: opt.weathers, terrains: opt.terrains,
      customMoves: customMoves
    });
    var defaultRuleset = opt.ruleset || 'official';
    if (defaultRuleset !== 'official' && defaultRuleset !== 'card') {
      fail('createEngine(DATA, {ruleset})：只支持 "official" 或 "card"，收到「' + defaultRuleset + '」');
    }
    var buildUnit = makeBuildUnit(dex);
    var startFromStat = makeStartFromStat(dex);
    var resolveTurn = makeResolveTurn(dex);
    var decideFoe = makeDecideFoe(dex);

    /**
     * 把 dex 挂到引擎态上（非枚举，不会污染 JSON 序列化与 Object.keys）。
     * deepClone 不会复制它，所以每次派生新 state 后都会重新挂一次。
     */
    function withDex(state) {
      ensureDex(state, dex);
      return state;
    }

    var api = {
      version: '1.0.0',
      dex: dex,

      /** createEngine(DATA) 二次调用：用同一份数据换引擎 */
      createEngine: createEngineImpl,
      buildUnit: buildUnit,

      startFromStat: function (statData, opts) {
        var st = startFromStat(statData, opts);
        withDex(st);
        return st;
      },

      resolveTurn: function (state, actions) {
        var res = resolveTurn(state, actions);
        withDex(res.state);
        return res;
      },

      /* 阶段 A：resolveRound 与 resolveTurn 是同一个函数（动作列表接口，见 §4.1） */
      resolveRound: function (state, actions) {
        var res = resolveTurn(state, actions);
        withDex(res.state);
        return res;
      },

      decideFoe: decideFoe,
      /** 阶段 A：一次给出**每只对手**的动作 [{side:'foe', unitIndex, action}] */
      decideFoeRound: function (state, difficulty) {
        return decideFoe.round(state, difficulty);
      },
      /** 通用补位：按「场上空缺数」一次补齐（A 阶段 neededSlots = 1；B 阶段改成 2 即可） */
      fillFieldSlots: function (state, side, neededSlots) {
        var st = withDex(state);
        /* 直接补位时要有一个可用的 ctx（日志/回合号）*/
        var ctx = {
          dex: dex, state: st, rng: mkRng(Math.random), turn: toInt(obj(st.meta).turnCount, 0),
          errors: [], weather: st.battle.weather, opts: {}
        };
        var r = fillFieldSlots(ctx, side === 'foe' ? 'foe' : 'ally', neededSlots);
        return { state: st, filled: r.filled, names: r.names, errors: ctx.errors };
      },
      /** 本场每侧在场数量（A：我方 1 / 对手 N；B：2） */
      fieldSlots: function (state, side) {
        return fieldSlotCount(withDex(state), side === 'foe' ? 'foe' : 'ally');
      },

      toPatches: function (state, statData) {
        return toPatchesImpl(state, statData);
      },

      buildReport: function (state, log) {
        return buildReportImpl(state, log);
      },

      /* ---- 契约 10.2：口胡通道 ---- */
      applyImprov: function (state, spec) {
        var res = applyImprovImpl(withDex(state), spec);
        withDex(res.state);
        return res;
      },
      listImprovs: function (state) { return listImprovsImpl(state); },
      clearImprovs: function (state) {
        var res = clearImprovsImpl(withDex(state));
        return res;
      },

      /* ---- 契约 10.6：自定义/未收录招式 ---- */
      defineMove: function (state, name, def) {
        var st = withDex(state);
        var raw = String(name === undefined || name === null ? '' : name).trim();
        if (!raw) fail('defineMove：需要一个招式名称');
        var d = obj(def);
        var category = String(d.类别 || d.category || 'physical');
        if (['physical', 'special', 'status'].indexOf(category) < 0) {
          fail('defineMove：类别只能是 physical / special / status，收到「' + category + '」');
        }
        var entry = {
          zh: raw,
          en: d.英文名 || raw,
          type: d.属性 || '一般',
          category: category,
          power: d.威力 === undefined || d.威力 === null || d.威力 === '' ? null : toInt(d.威力, 0),
          accuracy: d.命中 === undefined || d.命中 === null || d.命中 === '' ? null : toInt(d.命中, 100),
          pp: d.PP === undefined || d.PP === null || d.PP === '' ? 20 : Math.max(1, toInt(d.PP, 20)),
          priority: toInt(d.优先度, 0),
          target: (function () {
            /* 阶段 A：允许口胡通道定义群体招式（目标类别 single/allAdjacentFoes/allAdjacent/self/ally） */
            var raw2 = String(d.目标类别 || d.target || d.targetKind || 'normal');
            var canon = {
              single: 'normal', allAdjacentFoes: 'allAdjacentFoes', allAdjacent: 'allAdjacent',
              self: 'self', ally: 'adjacentAlly'
            }[raw2] || raw2;
            return MOVE_TARGET_KIND[canon] ? canon : 'normal';
          })(),
          flags: [], secondaries: [], drain: null, recoil: null,
          multihit: null, ohko: false, fixedDamage: null,
          effectNote: String(d.效果 || '自定义招式（defineMove 定义，来源：' + (d.来源 || 'AI') + '）'),
          __custom: true, __source: String(d.来源 || 'AI'), __desc: String(d.描述 || '')
        };
        dex.addMoveToIndex(entry);
        customMoves[raw] = entry;
        customMoves[normalizeName(raw)] = entry;

        /* 把场上/待命里所有该名称的未识别技能位就地补齐 */
        if (isPlainObject(st) && isPlainObject(st.battle)) {
          var units = [st.battle.ally, st.battle.foe].concat(st.battle.bench || [], st.battle.foeBench || []);
          for (var i = 0; i < units.length; i++) {
            var u = units[i];
            if (!u || !Array.isArray(u.moves)) continue;
            for (var j = 0; j < u.moves.length; j++) {
              var slot = u.moves[j];
              if (!slot) continue;
              if (slot.原名称 !== raw && slot.name !== raw) continue;
              slot.move = entry; slot.name = raw; slot.未识别 = false;
              slot.maxPP = entry.pp; slot.curPP = entry.pp; slot.识别方式 = 'defineMove'; slot.未识别原因 = '';
            }
          }
          if (!Array.isArray(st.meta.customMoves)) st.meta.customMoves = [];
          st.meta.customMoves.push({ 名称: raw, 来源: entry.__source, 描述: entry.__desc, 定义: deepClone(entry) });
          var note = '动作：[' + entry.__source + '] 定义招式「' + raw + '」（' + entry.type + '/' +
            (CATEGORY_ZH[entry.category] || entry.category) + ' 威力 ' + (entry.power === null ? DASH : entry.power) +
            ' 命中 ' + (entry.accuracy === null ? DASH : entry.accuracy) + ' PP ' + entry.pp + '）' +
            (entry.__desc ? '：' + entry.__desc : '');
          addEntry(st, {
            turn: toInt(obj(st.meta).turnCount, 0), actor: 'ally', actorName: '定义招式', kind: 'improv',
            move: raw, notes: ['defineMove'], text: note
          });
        }
        return { state: st, entry: deepClone(entry) };
      },
      listCustomMoves: function () {
        var out = [];
        var keys = Object.keys(customMoves);
        for (var i = 0; i < keys.length; i++) {
          var e = customMoves[keys[i]];
          if (out.indexOf(e) < 0) out.push(e);
        }
        return deepClone(out);
      },
      /** 撤销全部自定义招式（与 clearImprovs 同源的留痕/撤销语义） */
      clearCustomMoves: function (state) {
        var st = withDex(state);
        var n = Object.keys(customMoves).length;
        var arr = this.listCustomMoves();
        for (var i = 0; i < arr.length; i++) {
          var e = arr[i];
          delete customMoves[e.zh]; delete customMoves[normalizeName(e.zh)];
          delete dex.moveByName[e.zh]; delete dex.moveByName[e.en];
        }
        if (isPlainObject(st) && isPlainObject(st.battle)) {
          var units = [st.battle.ally, st.battle.foe].concat(st.battle.bench || [], st.battle.foeBench || []);
          for (var j = 0; j < units.length; j++) {
            var u = units[j];
            if (!u || !Array.isArray(u.moves)) continue;
            for (var k = 0; k < u.moves.length; k++) {
              var slot = u.moves[k];
              if (slot && slot.识别方式 === 'defineMove') {
                slot.move = null; slot.未识别 = true; slot.curPP = 0; slot.maxPP = 0; slot.识别方式 = '';
              }
            }
          }
          st.meta.customMoves = [];
          addEntry(st, {
            turn: toInt(obj(st.meta).turnCount, 0), actor: 'ally', actorName: '引擎', kind: 'improv',
            notes: ['撤销自定义招式'], text: '动作：已撤销 ' + n + ' 条自定义招式定义。'
          });
        }
        return { state: st, cleared: n };
      },

      /* ---- 契约 10.3：中途交棒 ---- */
      buildHandoff: function (state, log, opts) {
        return buildHandoffImpl(withDex(state), log, opts);
      },
      statusSnapshot: function (state) {
        return statusSnapshotImpl(withDex(state));
      },

      /** 便于测试/集成的小工具（不属于契约必需项，但对外公开且稳定） */
      utils: {
        makeRng: mkRng, lcg: lcg, expForLevel: expForLevel,
        calcStat: function (key, base, iv, level, natureName) {
          return calcStat(key, num(base, 1), num(iv, DEFAULT_IV), clamp(toInt(level, 5), 1, 100), dex.nature(natureName));
        },
        baseExpOf: function (speciesZh) {
          var sp = dex.species(speciesZh);
          if (!sp) fail('utils.baseExpOf：找不到种族「' + speciesZh + '」');
          return dex.baseExpOf(sp);
        },
        calcDamage: function (atkU, defU, moveName, crit, rng, weather) {
          var mv = dex.move(moveName);
          if (!mv) fail('utils.calcDamage：找不到招式「' + moveName + '」');
          return calcDamage(dex, atkU, defU, mv, !!crit, mkRng(rng), weather === undefined ? null : weather, arguments.length > 6 ? arguments[6] : null);
        },
        typeEff: dex.typeEff,
        moveEff: dex.moveEff,
        effSpeed: effSpeed,
        stagesText: stagesText,
        splitMoves: splitMoves,
        /* 阶段 A：招式目标类别（single / allAdjacentFoes / allAdjacent / self / ally） */
        moveTargetKind: moveTargetKind,
        isSpreadKind: isSpreadKind,
        SPREAD_DAMAGE_SCALE: SPREAD_DAMAGE_SCALE,
        /* 阶段 A/B：每侧在场数量与通用补位（neededSlots 不硬编码） */
        fieldSlotCount: fieldSlotCount,
        /* 概率参数解析（本次审计）：字段名不统一/缺参数时的**唯一**判定入口，
         * 返回 {chance, source:'field'|'default', field} 或 null（= 跳过该效果并记日志）。 */
        resolveChance: resolveChance,
        chanceFields: function () { return JSON.parse(JSON.stringify(CHANCE_FIELDS)); },
        chanceDefaults: function () { return JSON.parse(JSON.stringify(CHANCE_DEFAULTS)); },
        /* 特性规则表（实例侧也要有：createEngine(DATA) 会把 createEngine.utils 换成实例 utils，
         * 审计脚本/集成层从任一形状取都必须拿得到这三样） */
        abilityRule: abilityRuleByName,
        abilityParamsOf: function (name, kind) {
          var r = abilityRuleByName(name);
          if (!r || !r.kinds || r.kinds.indexOf(kind) < 0) return null;
          return JSON.parse(JSON.stringify(r.params || {}));
        },
        abilityRules: function () {
          return ABILITY_RULES.map(function (r) {
            return { zh: r.zh, en: r.en, kinds: (r.kinds || []).slice(), residual: !!r.residual, noop: !!r.noop };
          });
        },
        /* 阶段 B：对战模式是否双打（我方 2 只同时在场） */
        isDoublesMode: isDoublesMode,
        snapshot: function (state) { return snapshotImpl(withDex(state)); },
        statusText: dex.statusText,
        statusCode: dex.statusCode
      }
    };
    return api;
  }

  /**
   * 公开入口：createEngine(DATA) → 引擎实例。
   * 契约第 4 节的 7 个函数都在实例上；另外把 instance.utils 提升为 createEngine.utils，
   * 让集成层与测试可以直接取到确定性的工具函数（不影响契约形状）。
   */
  function createEngine(DATA, options) {
    var instance = createEngineImpl(DATA, options);
    createEngine.utils = instance.utils;
    return instance;
  }

  /* ---- 工厂返回值（UMD 桥接：Node 是 module.exports，浏览器是 window.__PKMN_ENGINE__） ---- */
  /* 数据无关的工具函数直接挂在 createEngine 上：这样无论宿主导出对象后面怎么被覆盖，
     require('./engine.js').createEngine.utils 与 window.__PKMN_ENGINE__.createEngine.utils 始终可用。 */
  createEngine.utils = {
    mkRng: mkRng, lcg: lcg, expForLevel: expForLevel, calcStat: calcStat, weatherMul: weatherMul,
    statKeys: STAT_KEYS.slice(), statusZh: STATUS_ZH, DASH: DASH, DEFAULT_IV: DEFAULT_IV,
    /* 契约 10.25：把特性规则表与速度线暴露出去，方便测试/集成层断言「特性真的接上了」 */
    effSpeed: effSpeed, abilityRule: abilityRuleByName,
    moveTargetKind: moveTargetKind, isSpreadKind: isSpreadKind, SPREAD_DAMAGE_SCALE: SPREAD_DAMAGE_SCALE,
    isDoublesMode: isDoublesMode,
    /* 概率参数解析（不依赖数据表）：审计脚本/单测可直接断言字段名与官方默认 */
    resolveChance: resolveChance,
    chanceFields: function () { return JSON.parse(JSON.stringify(CHANCE_FIELDS)); },
    chanceDefaults: function () { return JSON.parse(JSON.stringify(CHANCE_DEFAULTS)); },
    abilityParamsOf: function (name, kind) {
      var r = abilityRuleByName(name);
      if (!r || !r.kinds || r.kinds.indexOf(kind) < 0) return null;
      return JSON.parse(JSON.stringify(r.params || {}));
    },
    abilityRules: function () {
      return ABILITY_RULES.map(function (r) {
        return { zh: r.zh, en: r.en, kinds: (r.kinds || []).slice(), residual: !!r.residual, noop: !!r.noop };
      });
    }
  };
  var fullApi = {
    createEngine: createEngine,
    EngineError: EngineError,
    utils: createEngine.utils
  };
  /* 先按完整形状挂好宿主导出；紧随其后的两行 UMD 约定会把它收敛成 { createEngine }。 */
  if (module && module.exports) module.exports = fullApi;
  if (window) window.__PKMN_ENGINE__ = fullApi;

  /* ==========================================================================
   * 文件末尾必须有的 UMD 约定（见任务书，逐字保留）
   * 直接作为工厂尾部语句，使 createEngine 处于作用域内、并保证是本文件最后两行；
   * 判定处加了 `module &&` / `window &&` 判空，避免非 Node 宿主上存在同名 null 全局时崩溃。
   * ======================================================================= */
  if (typeof module !== 'undefined' && module && module.exports) module.exports = { createEngine };
  if (typeof window !== 'undefined' && window) window.__PKMN_ENGINE__ = { createEngine };
});

