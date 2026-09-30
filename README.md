# fgo-cdn

型月机关（SillyTavern 角色卡）组件使用的图片镜像，经 jsDelivr 加载：

```
https://testingcf.jsdelivr.net/gh/TheBestAlice/fgo-cdn@main/<path>
```

- `wiki/`：来自 [fgo.wiki（Mooncell）](https://fgo.wiki) 的 media.fgo.wiki，路径与原站相同（界面素材、英灵头像）。
- `catbox/`：原卡使用的 files.catbox.moe 图片（职阶默认立绘等）。
- `atlas/`：[Atlas Academy](https://atlasacademy.io) 的剧情背景（static.atlasacademy.io/JP）。
- `fandom/`：来自 [Fate/Grand Order Wiki（fandom）](https://fategrandorder.fandom.com)，补 fgo.wiki 缺的内容：
  - `fandom/sprite/{序号}_{战斗形象}.webp`：战斗小人（按不透明区域裁剪，最长边 512）。
  - `fandom/voice/{序号}.json`：语音台词文本（日文原文；能对上 fgo.wiki 的行带中文与 mp3 文件名）。

由卡片项目的 `tools/mirror-assets.mjs`、`tools/fetch-fandom.mjs` 生成，请勿手改。游戏素材与台词版权归 TYPE-MOON / FGO PROJECT 所有；fandom 的台词整理遵循其 CC BY-SA 许可。
