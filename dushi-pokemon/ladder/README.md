# 都市宝可梦 · 图鉴天梯

都市宝可梦角色卡的图鉴内天梯对战模块。在状态栏里本地结算 3V3 单打排位，结果写回 `训练家档案.天梯`。本目录下由我们编写的代码按 AGPL-3.0-or-later 发布，许可全文见 `LICENSE`。

| 目录 | 内容 | 来源与许可 |
|---|---|---|
| `ladder.js` | 大厅、匹配、选人、对战舱、结算界面与对手 AI | 本项目，AGPL-3.0-or-later |
| `anim/` | 招式动画模块与特效图 | 移植自 Pokémon Showdown 客户端，逐项说明见 `anim/NOTICE.md` |
| `engine/` | 对战结算引擎与数据表 | 玩家脚本「宝可梦本地对战引擎 v1.24.0」加天梯补丁，版权归原作者 |

## 关于 `engine/`

`engine/engine.js` 与 `engine/data.js` 来自玩家制作的酒馆助手脚本「宝可梦本地对战引擎 v1.24.0」（脚本 id `ac50dde1-554c-4b9d-99ad-56d33b70d122`），我们只加了天梯所需的修复补丁，补丁清单写在 `engine.js` 文件头。**引擎的著作权归原脚本作者所有，不适用本目录的 AGPL 许可**；原脚本未署名，若原作者希望署名或撤下，请提 issue 联系。

宝可梦相关的名称、形象和设定，著作权属于 Nintendo、The Pokémon Company、Game Freak 和 Creatures。本模块是非官方的同人作品，仅供非商业使用。

## 宿主接口

界面由图鉴状态栏自己渲染（`statusbar/ladder-page.js`，经 `statusbar/patch.py` 并入状态栏正则）；`ladder.js` 只提供规则与数据：

```js
const C = PkLadder.createController({ base });  // base：本目录的 CDN 地址
PkLadder.summary(stat_data);    // 大厅数据：积分、段位、排名、战绩、距下一段位
PkLadder.canMatch(stat_data);   // { ok, reason }
await C.newMatch(stat_data);    // 匹配对手（六只阵容公开）
C.party(stat_data); C.togglePick(stat_data, i); C.toggleMove(昵称, 招式); C.ready(stat_data);
C.begin(stat_data);             // 开战，返回录像；C.resume(录像) 从录像恢复
C.battleSD(stat_data);          // 给状态栏 pgBattle 渲染用的 当前对战 结构
C.commands(); C.act(指令);      // 可下指令；结算一回合，返回逐条播放的事件
await C.finish(结果, 写回函数); // 写入 训练家档案.天梯、补贴与奖章
```

积分换算排名的公式在 `src/rating.js`，世界书 #169 用的是同一条公式。
