# 旅途手记 · 太阳系空间扩展蓝图（v2.0）

> 架构基线：Cloudflare Workers + Hono + D1 + 私有 R2 + React 19 / Vite 6  
> 美学原则：**谷歌克制之骨 × 旅途与星穹之魂**（零第三方追踪、零外部字体与 CDN 依赖、零 AI 装饰噪音、零意外云账单）

---

## 1. 八大行星空间路由总图

首页太阳系星环作为整座个人数字观测站的空间索引，将八颗行星逐一映射为职责单一、气质统一的独立模块：

| 序号 | 星体 | 路由 | 模块名称 | 阶段 | 当前状态与定位 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 水星 Mercury | `/toolkit`（`/tools` 重定向） | 水星 · 实用工具台 | **Phase 2 / 2.5** | 10 项影像调色、Log 视频 LUT 还原、本地隐私与跨端效率工具（含零 R2 成本 D1 闪传剪贴板） |
| 2 | 金星 Venus | `/gallery` | 金星 · 暗房影集 | **Phase 1** | 复用 `/api/library` 零重复存储的纯享摄影接触印相墙 |
| 3 | 地球 Earth | `/atlas` | 地球 · 旅图 | **Phase 1** | 地理轨迹手记、足迹总览与同行私密分享阅览（`?share=`） |
| 4 | 火星 Mars | `/arcade`（`/arena` 重定向）& `/arcade/arena` | 火星 · 游乐竞技场 | **Phase 3 / 4** | 6 款高精度街机 + D1 双轨榜单 + 旗舰 3D 战术射击「沙暴行动 · SANDSTORM v2.0.0（3 张地图 · 9 款皮肤 3D 军械库）」与 DO 云端联机 |
| 5 | 木星 Jupiter | `/projects` | 木星 · 作品展柜 | **Phase 1** | 工程作品集与发行说明展柜（D1 持久化 + 密匣定向分发联动） |
| 6 | 土星 Saturn | `/observatory` | 土星 · 观星台 | **Phase 1** | 实时星图、任意日期观测、天象年历、旅图星空书签与明信片导出 |
| 7 | 天王星 Uranus | `/explore/uranus` | 天王星 · 实时星历 | **Phase 1** | 基于本地 `astronomy-engine` 的实时行星星历观测活页 |
| 8 | 海王星 Neptune | `/vault` | 海王星 · 文件密匣 | **Phase 1** | 口令直链提取（`?code=`）、范围流式下载与安全白名单沙箱预览（`?inline=1`） |

管理中枢：`/admin`（整理台）统一收敛旅图整理、文件密匣、展柜与首页精选配置、用量与备份、安全与会话、竞技榜单与沙暴行动治理六大运营面板。

---

## 2. 四阶段演进路线图

### Phase 1：核心闭环补完 + 零新增基础设施成本上线（已落地）
1. **数据契约与 D1 迁移（`migrations/0002_expansion.sql`）**：
   - 新增 `projects` 表存储木星作品展柜，并在首次访问且 `admin_settings.projects_seeded` 不存在时自动灌入两项真实代表作：《流量观察 · TrafficObserver 1.0.0》与《VideoVault V2 0.7.1》。
   - 纳入 `/api/admin/backup` 的 `cloudflare-1` 完整 ZIP 备份清单。
2. **核心模块深化**：
   - **旅图（地球）**：`Journey.shareToken` 支持 12–48 位同行私密分享令牌，通过 `?share=<token>` 仅解锁该私密旅程及其封面/站点关联影像；对未认证访客彻底剥离 `shareToken` 字段，并保持 F2.7 严格 404 隐私隔离。
   - **首页精选展台**：`SiteSettings.homeShowcase` 支持至多 8 帧站内相对路径影像（严禁外链，守住 `img-src 'self'` CSP），`/api/files/:mediaId` 放行明确编入首页展台的影像。
   - **文件密匣（海王星）**：`GET /api/vault/download/:ticketId?inline=1` 仅对严格安全白名单 MIME（位图、纯文本/Markdown/JSON、常见音频，明确排除 `image/svg+xml` 与 `text/html`）输出 `Content-Disposition: inline` 与 `Content-Security-Policy: sandbox; default-src 'none'`。
   - **暗房影集（金星）**、**观星台年历与明信片（土星）**、**实时星历活页（天王星）**：完全基于已有 `/api/library` 与本地 `astronomy-engine` / Canvas 渲染，不增加任何外部请求与存储开销。
3. **整理台（Admin Studio）闭环**：
   - 补齐旅图封面选择、站点配图绑定、地图选点、EXIF 时空自动归集、同行私密链接签发与撤销。
   - 补齐回收站物理彻底销毁 `POST /api/admin/trash/purge`（同步清除 D1 记录与 R2 原图/缩略图/预览图或密匣全部分片）。
   - 补齐木星作品展柜与首页山海展台可视化配置、密匣二维码直链取件签条与安全策略/封禁/改密全套管理。

### Phase 2：水星 · 实用工具台（`/toolkit`，8 项工具 + 零 R2 成本 D1 闪传，已落地）
- 路由正式升级为 `/toolkit`（`/tools` 自动规范跳转，水星轨道直达），整合 8 项克制实用的隐私与效率工具，全部按需懒加载且零第三方依赖：
  1. **影像暗房与隐私工坊（`image`）**：批量 WebP/JPEG/PNG 压制与 EXIF/GPS 隐私剥离 + 骨白/深碳邮戳装裱冲印台（本地 `exifr` + Canvas + `fflate`）；
  2. **跨端闪传剪贴板（`clipboard`）**：新增 D1 轻量表 `clipboard_drops`（`migrations/0003_clipboard.sql`）与 `/api/clipboard` 路由，支持 6 位防混淆口令、32 KiB UTF-8 文本上限、60 秒–24 小时过期自动清扫、原子计数阅后即焚与 SHA-256 哈希销毁凭证，**零 R2 存储与读写消耗**；
  3. **开发者极速工作台（`dev`）**：JSON 格式化与结构对比、JWT 本地解析、时间戳/Base64/URL/Hex 编解码、正则实时高亮与本地 SubtleCrypto SHA-256/1/512 文件校验；
  4. **零联网二维码工坊（`qr`）**：扩展本地 `qr-svg.ts` 至 Version 14，支持链接/纯文本/Wi-Fi/vCard、三种光学码点风格、对比度扫描安全预警与 SVG/1024px PNG 导出；
  5. **晨昏与蓝调时刻罗盘（`twilight`）**：基于本地 `astronomy-engine` 计算日出日落、蓝调/黄金时刻、三类暮光、月相与银心可见窗口，绘制 24 小时 SVG 罗盘并一键直达观星台；
  6. **证件防盗水印与长图 / PDF 工坊（`watermark`）**：离线斜纹证件防盗水印 + 多图无缝拼接与纯 TypeScript ISO PDF 1.4 合成；
  7. **专注番茄钟与环境白噪音台（`focus`）**：纯 Web Audio API 合成四轨环境声景（山脊风声、高原夜雨、木柴篝火、深棕底噪）+ 番茄计时，配合全站可隐藏右下角陪伴胶囊 `AmbienceDock`（空闲或在 `/toolkit` 时返回 `null`，零 DOM 污染）；
  8. **光学配色与对比度尺（`color`）**：本地影像主色板提取（HEX/RGB/HSL/OKLCH）与 WCAG 2.1 日/夜对比度实时测算。

### Phase 3：火星 · 游乐竞技场（`/arcade`，6 款经典重制小游戏 + D1 双轨榜单，已落地）
- 路由正式升级为 `/arcade`（`/arena` 自动规范跳转，火星轨道直达），完整收录 6 款零外部依赖、高帧率 DPR Canvas / 几何排版小游戏，与 `localStorage` 个人最佳 + Cloudflare D1 全站英雄榜双轨联动：
  1. **荒原小恐龙（`dino`）**：火星红漠地平线、日暮星空渐进过渡、郊狼时间与跳跃缓冲、地空双类障碍（按分数降序排名）；
  2. **星轨贪吃蛇（`snake`）**：60fps 帧间插值、经典边界/星轨穿墙双模式、双步输入缓冲与轨道加速倍率（按分数降序排名）；
  3. **俄罗斯方块 · 重力井（`tetris`）**：10×20 棋盘、7-bag 随机袋、完整 SRS 踢墙表、锁定延迟、Ghost/Hold/Next 3 与 T-Spin 判定（按分数降序排名）；
  4. **2048 · 天体演化（`2048`）**：星尘至黑洞演化阶梯、一步撤销与达成 2048 后的无尽演化模式（按分数降序排名）；
  5. **极简扫雷（`minesweeper`）**：初/中/高三档难度、首击绝对安全、左右键/双击和弦展开与移动端插旗切换（按完成耗时毫秒升序排名）；
  6. **轨道打砖块（`breakout`）**：子步进连续碰撞防穿墙、5 组轨道阵型循环与 4 种极简几何道具胶囊（按分数降序排名）。
- **后端榜单与治理（`migrations/0004_arcade.sql` + `src/server/routes/arcade.ts`）**：
  - 新增 `arcade_scores` 表及升序/降序复合索引，单游戏按分值合理区间校验并自动裁剪至 Top 50 防止 D1 膨胀，公开接口永不暴露原始 `visitor_id`；
  - 纳入 `/api/admin/backup` 完整备份，并在整理台新增第 6 个页签「竞技榜单」（`GET /api/admin/arcade/scores`、`DELETE /api/admin/arcade/scores/:id`、`POST /api/admin/arcade/scores/reset`）。
- 下方提供 Phase 4 旗舰入口卡，直连「沙暴行动 · SANDSTORM（炽沙小镇 3D 战术射击）」（`/arcade/arena`）、5v5 爆破竞技、团队死斗、压枪靶场与 6 位房间码直连。

### Phase 4：火星 · 沙暴行动 · SANDSTORM（v2.0.0）与云端实时联机（`/arcade/arena`，已落地）
基于 MIT 开源项目 `Kwusv55/Cla-Go` 深度站点化改造与 Cloudflare Durable Objects WebSocket Hibernation API，在 Cloudflare Free 套餐零账单与严格 `default-src 'self'` CSP 边界下正式落地高画质 3D 战术射击与云端 5v5 实时联机：

```text
Host / Clients <── WebSocket (proto=sandstorm, 64Hz) ──> ArenaRoomDO (Hibernation 高速内存转发，0 次 D1 Tick)
                                                               │
                                                               │ 仅在开房/进退房同步 arena_lobbies，完局单次落盘
                                                               ▼
                                                        Cloudflare D1 (arena_matches 战绩归档)
```

1. **高画质 3D 战术射击客户端（`public/sandstorm/` + `src/client/features/arena/ArenaPage.tsx`）**：
   - 内置 3 张 `96m × 96m` 实战地图——**炽沙小镇（`dust`）**、**极地科研站（`frost`）**与**黄昏货运港（`harbor`）**，配备程序化 PBR 砖石/墙体/金属/冰雪/沥青材质、顶点烘焙 AO、各图独立太阳/雾效/高光阴影调色、对应天气粒子（沙尘/飘雪/火星）、全本地自托管字体与静态 `js/bg-pump.js`（严格遵守 `worker-src 'self'` CSP）；
   - 收录 20 项武器装备（含近战 **爪子刀 `karambit`** / 蝴蝶刀 / 匕首、副武器 **P250** / USP-S / Glock-18 / DE-50、微冲 **P90** / MP9、霰弹枪 **Nova** 单发 8 弹丸 + 可打断逐发装填、步枪 **Galil AR** / AK-47 / **M4A1-S** 消音 / M4A4、狙击 **SSG 08 鸟狙** / AWP 及投掷物 / C4）、**9 款纯程序化 PBR 武器皮肤与单 WebGL 上下文 3D 军械库（`#armory`）**（支持 64Hz 联机第三人称皮肤同步）、购买菜单 `B` 与 `F1`/`F2` 快购/复购；
   - 优化画质与操控手感：5-tap CAS 锐化后处理（`sharpness`）、视场角 `fov` 调节、85ms 跳跃输入缓冲、滚轮跳/切枪切换、开镜模式（切换/按住）、准星随动后坐（`crossFollow`）、安全正缩放左手视角（`leftHand`）、爆头/击杀命中标记、128-Tick 急停压枪 + 爆发滑铲、15 点布娃娃物理，以及 5v5 爆破竞技（`comp`）、团队死斗（`tdm`）与全武器靶场训练（`range`）；
   - 路由 `/arcade/arena` 通过全视口隔离容器（`data-only-dark="true"`）懒加载挂载 `/sandstorm/index.html` 并自动隐藏全局右下角 `AmbienceDock`，冻结初始 `iframeSrc` 并经由同源 `postMessage` 与 URL `?map=` / `?room=XXXXXX` 参数无刷新同步，支持返回 `/arcade` 导航。
2. **零 D1 Tick 原则与 Durable Objects 64Hz 云端中继（`migrations/0005_arena.sql` + `src/server/arena/ArenaRoomDO.ts` + `src/server/routes/arena.ts`）**：
   - `wrangler.jsonc`（本地模拟）与 `wrangler.production.jsonc`（生产部署）启用 `ARENA_ROOM` SQLite Durable Object 绑定；
   - 新增 `proto=sandstorm` 64Hz 多端高速中继模式（单房支持至多 10 名真人玩家 `5v5`、800/220 msg/s 限流、Hibernation 持久化单调 `pid` 分配、支持地图与武器皮肤状态同步），高频快照转发全程 **0 次 D1 读写**，仅在开房/进退房/销毁同步公开大厅索引 `arena_lobbies`，并在 `comp`/`tdm` 完局时向 `POST /api/arena/matches` 单次归档（自动保留最新 100 局并纳入 `/api/admin/backup` 备份），同时保持既有默认模式完全兼容。
3. **游乐场直连入口与后台治理（`ArcadePage.tsx` + `ArcadeAdminPanel.tsx`）**：
   - `/arcade` 底部旗舰卡升级为「3D 战术射击 · 沙暴行动 SANDSTORM（v2.0）」，实时展示公开房间数、公开大厅直达胶囊、四大模式/多地图快捷入口与 6 位房号直连；
   - 整理台「竞技榜单」页签同步提供「沙暴行动 · SANDSTORM」活跃大厅检视与 D1 战报清理治理面板（`/api/admin/arena/snapshot`、单条删除与一键清空）。

---

## 3. 安全与成本不变量（全阶段适用）

1. **成本护栏（`src/server/middleware/cost-limits.ts`）**：
   - 保持 2 GiB 终生上传容量预算、10,000/月 R2 Class A、100,000/月 R2 Class B、20,000/月 API 请求硬上限；
   - `POST /api/admin/trash/purge` 删除 R2 对象计入 Class A 预算，且绝不回退终生上传字节计数。
2. **隐私隔离（F2.7）**：
   - 未认证访客永不可探测私密旅程、私密媒体或密匣文件；
   - 同行分享令牌采用 `timingSafeEqualText` 恒定时间比对，且从不在未认证 JSON 响应中回传令牌明文。
3. **内容安全策略（CSP）与 XSS 防护**：
   - 站点默认坚持全本地资源加载（`default-src 'self'`，`img-src 'self' data: blob:`）；
   - 首页展台与项目封面仅允许站内 `/` 相对路径，项目外链严格限制为站内路径或 `http(s)://`；
   - 密匣内联预览强制采用严格安全白名单 + `Content-Security-Policy: sandbox; default-src 'none'` + `X-Content-Type-Options: nosniff`，永远禁止 `image/svg+xml` 与 `text/html` 内联执行。
