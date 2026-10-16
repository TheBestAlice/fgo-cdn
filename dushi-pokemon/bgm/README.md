# 都市宝可梦 · BGM 曲目目录

`enls-catalog.json` 是图鉴状态栏 BGM 曲库使用的曲目目录，**只包含曲名、地址、循环点和情境标签，不包含任何音频**。播放时由玩家的浏览器直接从原网站读取文件。

- 音乐来源：[ENLS's Pre-Looped Music Library](https://enls.eu/prelooped/)（credit: “ENLS's Pre-Looped Music Library”；贡献者 ENLS、Thundaga、YTKrakerwat、Sulucnal、FrivolousAqua）。
- 音乐著作权归任天堂、宝可梦公司、Game Freak、Creatures 及各作品权利人所有。本目录为非官方同人用途，仅供非商业使用。
- 循环点读自各文件内的 `LOOPSTART` / `LOOPLENGTH` 标签，换算成毫秒；情境标签按英文原声曲名自动生成，玩家可以在曲库页修改。
- 收录宝可梦主系列与《暗之旋风 XD》《对战革命》《巡护员》两作；不收弹珠台、卡牌、打字、绘图方块等与场景无关的作品，也不收非宝可梦作品。
- 生成工具：`BGM/tools/enls-catalog.mjs`（逐首只读取文件开头 16 KB，请求间隔 0.6 秒，带缓存，一次性生成）。

## 格式

```js
{
  v: 1, source, home, base,          // base + 相对地址 = 音频地址
  games: [{ code, name, count }],
  tracks: [[作品序号, 相对地址, 曲名, 循环起点毫秒, 循环终点毫秒（0 表示整首循环）, [情境标签]]]
}
```

如原作者希望署名方式调整或撤下目录，请提 issue。
