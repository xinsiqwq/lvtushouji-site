import {
  lazy,
  Suspense,
  useMemo,
  type ComponentType,
  type LazyExoticComponent,
  type MouseEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  ClipboardPaste,
  Code2,
  FileBadge2,
  Film,
  Image as ImageIcon,
  Palette,
  QrCode,
  ShieldCheck,
  SlidersHorizontal,
  Sunrise,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useRouter } from '../../lib/router';

type ToolId =
  | 'image'
  | 'grade'
  | 'lut'
  | 'clipboard'
  | 'dev'
  | 'qr'
  | 'twilight'
  | 'watermark'
  | 'focus'
  | 'color';

type ToolSpec = {
  id: ToolId;
  label: string;
  shortLabel: string;
  category: string;
  summary: string;
  runtimeBadge: string;
  icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType>;
};

const ImageDarkroomTool = lazy(() => import('./tools/ImageDarkroomTool'));
const PhotoGradeTool = lazy(() => import('./tools/PhotoGradeTool'));
const VideoLutTool = lazy(() => import('./tools/VideoLutTool'));
const ClipboardDropTool = lazy(() => import('./tools/ClipboardDropTool'));
const DevWorkbenchTool = lazy(() => import('./tools/DevWorkbenchTool'));
const QrStudioTool = lazy(() => import('./tools/QrStudioTool'));
const TwilightCompassTool = lazy(() => import('./tools/TwilightCompassTool'));
const WatermarkPdfTool = lazy(() => import('./tools/WatermarkPdfTool'));
const FocusAmbienceTool = lazy(() => import('./tools/FocusAmbienceTool'));
const ColorContrastTool = lazy(() => import('./tools/ColorContrastTool'));

const TOOLS: readonly ToolSpec[] = [
  {
    id: 'image',
    label: '影像暗房与邮戳',
    shortLabel: '影像暗房',
    category: '视觉暗房',
    summary: '批量无损压图、剥离 EXIF 定位隐私，以及骨白邮戳装裱冲印台。',
    runtimeBadge: '纯本地处理 · 影像永不离开设备',
    icon: ImageIcon,
    Component: ImageDarkroomTool,
  },
  {
    id: 'grade',
    label: '暗房一键调色',
    shortLabel: '一键调色',
    category: '视觉暗房',
    summary: '20 套真实胶片与场景调色配方、新手按痛点选方案、WebGL 实时 HSL 精调与 .cube 兼容。',
    runtimeBadge: 'WebGL 本地 GPU 调色 · 零上传',
    icon: SlidersHorizontal,
    Component: PhotoGradeTool,
  },
  {
    id: 'lut',
    label: 'Log 视频 LUT 还原',
    shortLabel: 'Log LUT',
    category: '视觉暗房',
    summary: '大疆、影石、索尼、尼康、徕卡等公开白皮书 Log 还原与 .cube 导入，实时对比并导出视频与静帧。',
    runtimeBadge: 'WebGL 3D LUT 引擎 · 本地导出',
    icon: Film,
    Component: VideoLutTool,
  },
  {
    id: 'clipboard',
    label: '跨端闪传剪贴板',
    shortLabel: '跨端闪传',
    category: '跨端效率',
    summary: '六位口令与扫码瞬时传递文本片段，支持阅后即焚与定时自动清理。',
    runtimeBadge: '限时直存 D1 · 零 R2 占用',
    icon: ClipboardPaste,
    Component: ClipboardDropTool,
  },
  {
    id: 'dev',
    label: '开发者工作台',
    shortLabel: '开发工作台',
    category: '开发与编码',
    summary: 'JSON 格式化对比、JWT 本地解析、时间戳编码、正则测试与文件哈希校验。',
    runtimeBadge: '纯本地计算 · 零数据外传',
    icon: Code2,
    Component: DevWorkbenchTool,
  },
  {
    id: 'qr',
    label: '零联网二维码',
    shortLabel: '二维码工坊',
    category: '跨端效率',
    summary: '纯前端矢量生成网址、Wi-Fi、文本与名片二维码，支持圆点样式与高清导出。',
    runtimeBadge: '纯本地生成 · 零外链请求',
    icon: QrCode,
    Component: QrStudioTool,
  },
  {
    id: 'twilight',
    label: '晨昏蓝调罗盘',
    shortLabel: '晨昏罗盘',
    category: '光影与专注',
    summary: '按经纬与日期本地推算日出日落、蓝调黄金时刻、月相与银心可见窗口。',
    runtimeBadge: '本地天文历算 · 零外部 API',
    icon: Sunrise,
    Component: TwilightCompassTool,
  },
  {
    id: 'watermark',
    label: '证件水印与拼图',
    shortLabel: '水印与 PDF',
    category: '视觉暗房',
    summary: '证件敏感件防盗斜纹水印，以及多图无缝长图拼接与离线 PDF 合成。',
    runtimeBadge: '纯本地合成 · 敏感件零上传',
    icon: FileBadge2,
    Component: WatermarkPdfTool,
  },
  {
    id: 'focus',
    label: '番茄钟与白噪音',
    shortLabel: '番茄白噪音',
    category: '光影与专注',
    summary: '程序化合成山脊风声、夜雨、篝火与深棕底噪，切换站内页面时浮窗持续陪伴。',
    runtimeBadge: 'Web Audio 本地合成 · 零音频拉流',
    icon: Timer,
    Component: FocusAmbienceTool,
  },
  {
    id: 'color',
    label: '光学配色对比度',
    shortLabel: '配色对比度',
    category: '视觉暗房',
    summary: '从山海影像提取主色与 OKLCH 色值，实时校验日夜 WCAG 2.1 可读性对比度。',
    runtimeBadge: '纯本地采样 · 实时测算',
    icon: Palette,
    Component: ColorContrastTool,
  },
];

const TOOL_BY_ID: Record<ToolId, ToolSpec> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<ToolId, ToolSpec>;

function isToolId(value: string): value is ToolId {
  return value in TOOL_BY_ID;
}

function resolveActiveTool(search: string): ToolId {
  const params = new URLSearchParams(search);
  const rawTool = (params.get('tool') || '').trim().toLowerCase();
  if (isToolId(rawTool)) return rawTool;
  if ((params.get('code') || params.get('c') || '').trim()) return 'clipboard';
  return 'image';
}

function ToolLoadingSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={`正在载入${label}`}
      className="rounded-[24px] border border-hairline bg-surface p-6 sm:p-8"
    >
      <div className="h-5 w-40 rounded-[8px] bg-paper" />
      <div className="mt-3 h-4 w-72 max-w-full rounded-[6px] bg-paper" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="h-44 rounded-[18px] bg-paper" />
        <div className="h-44 rounded-[18px] bg-paper" />
      </div>
    </div>
  );
}

export default function ToolkitPage() {
  const { search, navigate } = useRouter();
  const activeToolId = useMemo(() => resolveActiveTool(search), [search]);
  const activeSpec = TOOL_BY_ID[activeToolId];
  const ActiveComponent = activeSpec.Component;

  const handleSelectTool = (nextId: ToolId) => {
    if (nextId === activeToolId) return;
    const params = new URLSearchParams(search);
    params.set('tool', nextId);
    if (nextId !== 'clipboard') {
      params.delete('code');
      params.delete('c');
    }
    params.delete('handoff');
    navigate(`/toolkit?${params.toString()}`, { replace: true });
  };

  const handleSpaLink = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return (
    <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-x-clip">
      <CelestialFieldBackdrop variant="subtle-header" />

      <div className="relative z-10 mx-auto max-w-[1320px] px-4 py-7 sm:px-6 sm:py-10">
        {/* Mercury Masthead */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="tabular-nums-mono text-[12px] tracking-[0.08em] text-ink-muted">
              水星轨道 · Mercury · 0.39 AU
            </div>
            <h1 tabIndex={-1} className="display-h1 mt-2 text-[30px] text-ink sm:text-[40px]">
              实用工具台
            </h1>
            <p className="font-editorial-serif mt-2.5 mb-0 max-w-[680px] text-[15px] leading-relaxed text-ink-muted">
              围绕影像调色、Log 视频还原、跨端闪传、编码调试与天文外拍构建的十件日常工具，默认在浏览器本地完成计算。
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] text-ink">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-postmark" aria-hidden="true" />
              <span>纯本地优先 · 零第三方请求</span>
            </span>
          </div>
        </header>

        {/* Mobile Horizontal Scrollable Tool Rail */}
        <nav
          aria-label="工具切换列表"
          className="-mx-4 mt-6 flex items-center gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden"
        >
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            const active = tool.id === activeToolId;
            return (
              <button
                key={tool.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => handleSelectTool(tool.id)}
                className={[
                  'inline-flex min-h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] transition-colors',
                  active
                    ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                    : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                ].join(' ')}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{tool.shortLabel}</span>
              </button>
            );
          })}
        </nav>

        {/* Main Workbench Layout: Desktop Sticky Vertical Rail + Active Tool Canvas */}
        <div className="mt-5 grid grid-cols-1 gap-6 lg:mt-8 lg:grid-cols-[256px_minmax(0,1fr)] lg:items-start">
          {/* Desktop Vertical Rail */}
          <aside className="hidden lg:sticky lg:top-[76px] lg:block lg:max-h-[calc(100dvh-96px)] lg:overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <nav
              aria-label="工具台目录"
              className="rounded-[24px] border border-hairline bg-surface p-2.5"
            >
              <ul className="m-0 list-none space-y-1 p-0">
                {TOOLS.map((tool) => {
                  const Icon = tool.icon;
                  const active = tool.id === activeToolId;
                  return (
                    <li key={tool.id}>
                      <button
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => handleSelectTool(tool.id)}
                        className={[
                          'group flex w-full cursor-pointer items-center gap-2.5 rounded-[14px] border px-3 py-2.5 text-left transition-colors',
                          active
                            ? 'border-hairline-strong bg-paper text-ink shadow-2xs'
                            : 'border-transparent bg-transparent text-ink-muted hover:bg-surface-hover hover:text-ink',
                        ].join(' ')}
                      >
                        <span
                          aria-hidden="true"
                          className={`h-4 w-[2.5px] shrink-0 rounded-full transition-colors ${
                            active ? 'bg-accent' : 'bg-transparent'
                          }`}
                        />
                        <Icon
                          className={`h-4 w-4 shrink-0 ${
                            active ? 'text-accent' : 'text-ink-muted group-hover:text-ink'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">
                            {tool.label}
                          </span>
                          <span className="block truncate text-[11px] text-ink-muted">
                            {tool.category}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="mt-3 rounded-[18px] border border-hairline bg-paper/80 px-4 py-3 text-[12px] leading-relaxed text-ink-muted">
              切换任意工具时链接会自动同步参数，可直接收藏或分享当前工具视图。
            </div>
          </aside>

          {/* Active Tool Panel */}
          <section
            aria-label={activeSpec.label}
            className="min-w-0 space-y-4"
          >
            {/* Active Tool Context Strip */}
            <div className="flex flex-col gap-2.5 rounded-[22px] border border-hairline bg-paper px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="m-0 text-[18px] font-medium text-ink sm:text-[19px]">
                    {activeSpec.label}
                  </h2>
                  <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11.5px] text-ink-muted">
                    {activeSpec.category}
                  </span>
                </div>
                <p className="mt-1 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                  {activeSpec.summary}
                </p>
              </div>
              <span className="tabular-nums-mono shrink-0 text-[12px] text-postmark">
                {activeSpec.runtimeBadge}
              </span>
            </div>

            {/* Lazy Tool Mount with Isolated Error Boundary */}
            <div className="min-w-0">
              <ErrorBoundary resetKey={activeToolId}>
                <Suspense fallback={<ToolLoadingSkeleton label={activeSpec.label} />}>
                  <ActiveComponent />
                </Suspense>
              </ErrorBoundary>
            </div>
          </section>
        </div>

        {/* Calm Bottom Navigation */}
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-[13px] text-ink-muted">
          <a
            href="/"
            onClick={handleSpaLink('/')}
            className="inline-flex items-center gap-1.5 text-ink-muted no-underline transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>返回太阳系首页</span>
          </a>
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="/explore/mercury"
              onClick={handleSpaLink('/explore/mercury')}
              className="inline-flex items-center gap-1 text-ink-muted no-underline transition-colors hover:text-ink"
            >
              <span>水星实时星历</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <a
              href="/observatory"
              onClick={handleSpaLink('/observatory')}
              className="inline-flex items-center gap-1 text-accent no-underline hover:underline"
            >
              <span>前往土星观星台</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
