# 旅途手记 · Lvtushouji

> **个人数字观测站 & 太阳系空间索引全栈 Web 应用**  
> 基于 **Cloudflare Workers + Hono + D1 + R2 + Durable Objects + React 19 / Vite 6** 构建，全程采用本地自托管静态字体与同源资产，零第三方追踪与零外部 CDN 请求，严格遵循 `default-src 'self'` CSP。

---

## 核心特性与行星空间路由

首页以太阳系物理粒子星环作为空间索引，将八颗行星映射为独立模块，并配备统一整理台：

| 星体 | 路由 | 模块名称 | 核心能力 |
| :--- | :--- | :--- | :--- |
| **太阳 / 观测者** | `/` | 个人门面 & 实验馆索引 | OGL WebGL Bokeh 粒子星环、昼夜双态切换（`color-scheme` + View Transitions）、精选展台与滚动展开 |
| **水星 Mercury** | `/toolkit` | 实用工具台 | 10 项纯本地 / 零 R2 成本工具：影像暗房与 EXIF 剥离、Log LUT 视频/照片调色、D1 闪传剪贴板（`/api/clipboard`）、开发者工作台、本地 SVG 二维码、晨昏罗盘、证件水印与 PDF 合成、白噪音番茄钟、配色对比度尺 |
| **金星 Venus** | `/gallery` | 暗房影集 | 复用 `/api/library` 的零冗余摄影接触印相墙 |
| **地球 Earth** | `/atlas` | 旅图 | 2.5D MapLibre 交互路线地图、沿途回放、原比例相纸装裱、原生 `<dialog>` 暗房灯箱与同行私密分享（`?share=`） |
| **火星 Mars** | `/arcade`、`/arcade/arena` | 火星游乐场 & 沙暴行动 | 6 款 DPR Canvas 街机（荒原小恐龙、星轨贪吃蛇、重力井俄罗斯方块、2048 天体演化、极简扫雷、轨道打砖块）配 D1 双轨英雄榜；以及旗舰 **3D 战术射击「沙暴行动 · SANDSTORM v2.0.0」** |
| **木星 Jupiter** | `/projects` | 作品展柜 | 工程作品集与发行说明展柜（D1 持久化，首次启动自动填充默认项目并与密匣联动分发） |
| **土星 Saturn** | `/observatory` | 观星台 | 本地同源 Stellarium Web Engine WASM + 923 颗亮星降级方位图、任意时刻推演、天象年历、星空明信片，支持从旅图一键「查看当夜星空」 |
| **天王星 Uranus** | `/explore/uranus` | 实时星历 | 基于 `astronomy-engine` 的实时行星位置观测活页 |
| **海王星 Neptune** | `/vault` | 文件密匣 | 6 位口令直链提取（`?code=`）、分片上传至私有 R2、范围流式下载、限时限次与安全白名单沙箱预览（`?inline=1`） |
| **整理台** | `/admin` | 后台管理中枢 | 统一管理旅图与 EXIF 批量归集、文件密匣与回收站彻底清除、作品与首页展台配置、用量硬配额熔断面板、安全审计与封禁、竞技榜单与沙暴大厅治理、`cloudflare-1` 一键 ZIP 备份导出 |

### 旗舰模式：沙暴行动 · SANDSTORM v2.0.0（`/arcade/arena`）

- **3 张实战地图**：`炽沙小镇（dust）`、`极地科研站（frost）`、`黄昏货运港（harbor）`，具备程序化 PBR 材质、顶点烘焙 AO、各图独立光照/雾效/色彩分级、天气粒子与动态 `NavGrid` A* 寻路。
- **20 项武器装备**：包含爪子刀（`karambit`）/蝴蝶刀/匕首、P250 / USP-S / Glock-18 / 沙漠之鹰、P90 / MP9、Nova 霰弹枪（8 弹丸 + 可被开火打断的逐发装填）、Galil AR / AK-47 / M4A1-S（消音）/ M4A4、SSG 08 鸟狙 / AWP，以及投掷物、防弹衣与拆弹器。
- **程序化 PBR 皮肤工坊（3D 军械库）**：内置 9 款 256×256 纯程序化武器皮肤（原厂战术、二西莫夫、渐变之色、炽焰龙纹、多普勒蓝宝石、印花集、赛博霓虹、极地雪迷彩、鎏金纪念），支持单 WebGL 上下文 360° 检视及 64Hz 联机第三人称同步。
- **云端 5v5 实时联机与零 D1 Tick 架构**：依托 Cloudflare Durable Objects WebSocket Hibernation（`ArenaRoomDO`）进行 64Hz 快照中继与 128-Tick 移动/弹道判定；高频同步零 D1 读写，仅在房间生命周期同步公开大厅索引并在对局结束时单次归档战报。

---

## 技术架构

- **前端**：React 19、Vite 6、TypeScript、Tailwind CSS v4、OGL、MapLibre GL JS、Motion、Lucide Icons、`astronomy-engine`、`exifr`、`fflate`
- **后端 & 存储**：Cloudflare Workers + Hono、Cloudflare D1（SQLite 业务表 + 原子硬预算熔断）、Cloudflare R2（私有媒体与密匣分片）、Cloudflare Durable Objects（`ArenaRoomDO`）
- **安全与成本边界**：
  - 本地配置 `wrangler.jsonc` 默认锁定 `"remote": false`、`"workers_dev": false`、`"preview_urls": false`，与线上生产配置隔离。
  - D1 原子配额硬上限防意外账单；管理员采用 PBKDF2 口令哈希 + `HttpOnly SameSite=Strict` 会话 Cookie + CSRF 校验 + 常量时间令牌比对。

---

## 目录结构

```text
.
├── src/
│   ├── client/              # React 前端页面与各行星功能模块
│   ├── server/              # Hono Worker 路由、安全与配额中间件、ArenaRoomDO
│   └── shared/              # 前后端共享类型、校验证明与常量
├── public/
│   ├── fonts/               # 自托管静态 WOFF2 字体子集（build-fonts.py 生成）
│   ├── stellarium/          # 本地同源 Stellarium Web Engine WASM 与星表
│   ├── sandstorm/           # 沙暴行动 v2.0.0 Three.js 客户端与程序化资产
│   ├── cosmos/              # 行星视觉纹理
│   ├── demo/                # 开发期示例影像（严禁写入生产库）
│   └── _headers             # 静态资源缓存与安全响应头规则
├── migrations/              # D1 增量迁移脚本（0001_init.sql ~ 0005_arena.sql）
├── scripts/                 # 字体构建、密钥配置与线上只读核验脚本
├── tests/
│   ├── unit/                # Vitest + Cloudflare Workers pool 单元测试
│   └── e2e/                 # Playwright 全端到端与视觉审计套件
├── backups/milky-way/       # 历史银河首屏方案备份参考
├── wrangler.jsonc           # 本地开发与模拟专用 Wrangler 配置
├── wrangler.production.example.jsonc  # 生产环境部署配置示例模板
├── PROJECT_BLUEPRINT.md     # 初代全站规划与视觉规范蓝图
└── EXPANSION_BLUEPRINT.md   # 四阶段太阳系空间扩展蓝图
```

---

## 本地开发与测试

### 1. 环境准备

- Node.js 22+
- 复制本地环境变量示例并填写随机 32+ 位密钥：

```bash
npm install
cp .dev.vars.example .dev.vars
```

### 2. 本地 D1 初始化与启动开发服务器

```bash
npm run d1:migrate:local
npm run dev
```

默认监听 `http://127.0.0.1:5173`，Vite 通过 `@cloudflare/vite-plugin` 在本地自动模拟 D1、R2 与 Durable Objects。首次启动后可使用 `.dev.vars` 中的 `SETUP_TOKEN` 访问 `/__setup?token=...` 完成本地管理员初始化。

### 3. 质量检查与测试

```bash
# TypeScript 类型检查
npm run typecheck

# Vitest 单元测试（含 Cloudflare Workers runtime / DO / D1 / R2 模拟）
npm run test:unit

# 本地隔离边界与 E2E 套件静态校验
node tests/e2e/verify-suite.mjs

# Playwright 快速回归测试（需已安装浏览器）
npm run test:e2e:fast

# 本地生产构建验证
npm run build
```

> 可选字体子集重建：`uv run --with fonttools==4.66.1 --with brotli python scripts/build-fonts.py`（可通过环境变量 `NOTO_SANS_SC_TTF` / `FONT_SRC_DIR` 指定本地中文字体源）。

---

## Cloudflare Workers 生产部署指南

1. 复制 `wrangler.production.example.jsonc` 为 `wrangler.production.jsonc`（已加入 `.gitignore`，不会提交到仓库），填入你自己的 Cloudflare Account ID、D1 Database ID 与自定义域名。
2. 创建 D1 / R2 资源并配置生产密钥（至少设置 `SESSION_SECRET` 与首次初始化用 `SETUP_TOKEN`）。
3. 按顺序执行远程 D1 迁移、显式生产构建与部署：

```bash
# 应用远程 D1 迁移（0001 ~ 0005）
npx wrangler d1 migrations apply lvtushouji-db --config wrangler.production.jsonc --remote

# 使用生产配置构建产物（生成 .wrangler/deploy/config.json 指向 dist/lvtushouji_site）
CLOUDFLARE_CONFIG_PATH=wrangler.production.jsonc npm run build

# 部署 Worker、静态资产与 ArenaRoomDO
npx wrangler deploy

# 部署完成后恢复本地默认构建指针，避免后续误部署到生产
npm run build
```

4. 可使用只读核验脚本检测线上静态资源与接口状态：

```bash
node scripts/verify-cloudflare.mjs --origin https://your-domain.example
```

---

## 第三方组件与开源致谢

- **Stellarium Web Engine**：GNU AGPL v3，附完整声明与天文星表署名见 [public/stellarium/NOTICE.txt](public/stellarium/NOTICE.txt)
- **沙暴行动原型灵感**：参考 MIT 开源项目 [Kwusv55/Cla-Go](https://github.com/Kwusv55/Cla-Go) 深度站点化重构，许可见 [public/sandstorm/LICENSE](public/sandstorm/LICENSE)
- **Three.js 与后处理着色器**：Copyright © three.js authors（MIT License），见 [public/sandstorm/THIRD-PARTY-NOTICES.md](public/sandstorm/THIRD-PARTY-NOTICES.md)
- **其余主要开源依赖**：React、Hono、MapLibre GL JS、OGL、`astronomy-engine`、`exifr`、`fflate`、Motion、Lucide Icons，字体使用 Google Fonts OFL（Inter、JetBrains Mono、Noto Sans SC、Noto Serif SC）
