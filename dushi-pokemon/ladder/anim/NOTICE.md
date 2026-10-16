# 天梯动画 · 来源与许可说明

本目录是“都市宝可梦”角色卡里天梯对战舱的招式动画模块。招式动画、特效图片和场景坐标换算都移植自 Pokémon Showdown 客户端。

## 本模块自己的代码

`src/scene.ts`、`src/entry.ts`、`src/shim.ts`、`build.js`、`demo.html` 和 `fx/bone.svg` 以 **GNU Affero General Public License v3.0 或更新版本（AGPL-3.0-or-later）** 发布，许可全文见同目录 `LICENSE`。构建产物 `dist/ps-anim.js` 整体也按 AGPL-3.0-or-later 发布。

宝可梦相关的名称、形象和设定，著作权属于 Nintendo、The Pokémon Company、Game Freak 和 Creatures。本模块是非官方的同人作品，与上述公司无关。

## 移植自 Pokémon Showdown 客户端的部分

- 上游仓库：https://github.com/smogon/pokemon-showdown-client
- 使用的提交：`74056bbbb55d6ce15f9dd254186b94a51fe94b14`
- 原文件原样保存在 `upstream/` 目录。构建时由 `build.js` 生成 `src/_gen/`，每一处改动都写在 `build.js` 的 `patch(...)` 列表里，并附有原因。

上游客户端整体以 AGPLv3 发布。下面几份文件各自在文件头里另有更宽松的许可声明：

| 文件 | 本模块里的用途 | 许可（依据原文件头） |
|---|---|---|
| `battle-animations.ts` | 只收录从 jQuery 缓动定义到文件末尾的部分：特效表 `BattleEffects`、通用动画 `BattleOtherAnims`、异常状态动画 `BattleStatusAnims`。`src/scene.ts` 中的 `pos`、`posT`、`showEffect`、`animateEffect`、`backgroundEffect`、`Sprite.anim` 等方法也照此文件移植 | 文件声明为 MIT，并说明文件大部分内容为 CC0 |
| `battle-animations-moves.ts` | 招式动画表 `BattleMoveAnims`，整份收录 | CC0-1.0 |

MIT 许可原文（适用于上表中声明为 MIT 的部分）：

```
Copyright (c) Guangcong Luo and other contributors
http://pokemonshowdown.com/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 特效图片 `fx/`

图片取自上游 `play.pokemonshowdown.com/fx/`，提交同上。按 `battle-animations.ts` 文件头的说明：

- 下面列出的文件以外，`fx/` 中的图片均为 **CC0**（公有领域）。
- `icicle.png`、`lightning.png`：作者 Clint Bellanger，以 GPLv2、GPLv3、CC-BY-SA-3.0 三重许可发布。本模块按 **CC-BY-SA-3.0** 使用，并保留作者署名。来源：http://opengameart.org/content/icicle-spell 和 http://opengameart.org/content/lightning-shock-spell
- `icicle-pink.png`：由 Kalalokki 对上面的 `icicle.png` 重新上色，沿用 **CC-BY-SA-3.0**。
- `rocks.png`、`rock1.png`、`rock2.png`：作者为 PO 用户“Gilad”，以 **GPLv3** 发布。本模块整体使用 AGPL-3.0，与 GPLv3 兼容。
- `bone.png`：上游没有说明许可，**本模块不收录**。改用本仓库自绘的 `bone.svg`，按 AGPL-3.0 发布。

没有收录上游 `sprites/` 目录下的任何文件（官方游戏素材，不在上游的 CC0 范围内）：

- 两处冰窟背景、三处土窟背景改成了 CSS 渐变。
- 米立龙的图改为从本卡的数据仓库加载。

## 宝可梦图片

舞台上的宝可梦图片不在本模块内，运行时从数据仓库 `xianjiu0926/Pokemon` 加载。
