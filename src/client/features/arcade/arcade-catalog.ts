export type ArcadeGameId =
  | 'dino'
  | 'snake'
  | 'tetris'
  | '2048'
  | 'minesweeper'
  | 'breakout';

export type ArcadeGameCategory = '动作反应' | '策略益智';

export type ArcadeRunResult = {
  score: number;
  durationMs: number;
  meta?: Record<string, string | number | boolean>;
};

export type ArcadeGameProps = {
  onRunFinished: (result: ArcadeRunResult) => void;
  bestScore: number | null;
  muted: boolean;
};

export type ArcadeGameMeta = {
  id: ArcadeGameId;
  name: string;
  shortName: string;
  category: ArcadeGameCategory;
  summary: string;
  controlsHint: string;
  sortDirection: 'desc' | 'asc';
  scoreUnit: string;
};

export const ARCADE_GAMES: readonly ArcadeGameMeta[] = [
  {
    id: 'dino',
    name: '荒原小恐龙',
    shortName: '小恐龙',
    category: '动作反应',
    summary: '跨越火星玄武岩柱与低空轨道无人机，在昼夜交替的沙丘地平线上不断加速前行。',
    controlsHint: '空格 / 上键跳跃，下键疾降俯冲；触屏点击起跳，长按下方按键低姿闪避。',
    sortDirection: 'desc',
    scoreUnit: '分',
  },
  {
    id: 'snake',
    name: '星轨贪吃蛇',
    shortName: '贪吃蛇',
    category: '动作反应',
    summary: '在深空网格中沿星轨游走，支持经典边界与穿墙双模式，按住加速可触发高倍积分。',
    controlsHint: '方向键 / WASD 转向，按住 Shift 或空格加速；移动端支持滑动或方向垫操控。',
    sortDirection: 'desc',
    scoreUnit: '分',
  },
  {
    id: 'tetris',
    name: '俄罗斯方块 · 重力井',
    shortName: '俄罗斯方块',
    category: '策略益智',
    summary: '标准 SRS 旋转踢墙、7-Bag 发块、暂存与幽灵落点，支持连击与 T-Spin 精准计分。',
    controlsHint: '左右移动，上键 / X 顺旋，Z 逆旋，下键软降，空格瞬降，C / Shift 暂存，P 暂停。',
    sortDirection: 'desc',
    scoreUnit: '分',
  },
  {
    id: '2048',
    name: '2048 · 天体演化',
    shortName: '2048',
    category: '策略益智',
    summary: '从星尘与微粒起步，逐步合成超新星、中子星乃至黑洞，支持撤销一步与无尽演化。',
    controlsHint: '方向键 / WASD 或在棋盘区域滑动合并天体，达成 2048 后可继续冲刺更高纪录。',
    sortDirection: 'desc',
    scoreUnit: '分',
  },
  {
    id: 'minesweeper',
    name: '极简扫雷',
    shortName: '扫雷',
    category: '策略益智',
    summary: '保证首击安全展开，提供初、中、高级三档雷区与毫秒级计时，用时越短排名越高。',
    controlsHint: '左键翻开，右键标旗，双击或点击已满足雷数的数字快捷展开；触屏可切换翻开/插旗模式。',
    sortDirection: 'asc',
    scoreUnit: '秒',
  },
  {
    id: 'breakout',
    name: '轨道打砖块',
    shortName: '打砖块',
    category: '动作反应',
    summary: '五套几何轨道阵型循环递进，精准控制挡板倾角折射弹道并拾取多球、宽板与穿透胶囊。',
    controlsHint: '鼠标 / 触屏拖动或左右方向键 / A、D 移动挡板，空格或点击发射轨道弹球。',
    sortDirection: 'desc',
    scoreUnit: '分',
  },
] as const;

const GAME_META_BY_ID: Record<ArcadeGameId, ArcadeGameMeta> = ARCADE_GAMES.reduce(
  (acc, item) => {
    acc[item.id] = item;
    return acc;
  },
  {} as Record<ArcadeGameId, ArcadeGameMeta>,
);

export function isArcadeGameId(value: string | null | undefined): value is ArcadeGameId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAME_META_BY_ID, value);
}

export function getArcadeGameMeta(id: ArcadeGameId): ArcadeGameMeta {
  return GAME_META_BY_ID[id];
}

export function isBetterArcadeScore(
  gameId: ArcadeGameId,
  candidate: number,
  currentBest: number | null,
): boolean {
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return false;
  }
  if (currentBest === null || !Number.isFinite(currentBest) || currentBest <= 0) {
    return true;
  }
  const meta = getArcadeGameMeta(gameId);
  return meta.sortDirection === 'asc' ? candidate < currentBest : candidate > currentBest;
}

export function formatArcadeScore(gameId: ArcadeGameId, score: number): string {
  if (!Number.isFinite(score)) return '—';
  if (gameId === 'minesweeper') {
    const safeMs = Math.max(0, score);
    const totalSeconds = safeMs / 1000;
    const hundredths = Math.round(totalSeconds * 100);
    if (hundredths < 6000) {
      return `${(hundredths / 100).toFixed(2)}s`;
    }
    const tenths = Math.round(totalSeconds * 10);
    const minutes = Math.floor(tenths / 600);
    const remTenths = tenths % 600;
    const remSeconds = (remTenths / 10).toFixed(1).padStart(4, '0');
    return `${minutes}m ${remSeconds}s`;
  }
  return Math.round(score).toLocaleString('en-US');
}

export function formatArcadeDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  const totalSeconds = Math.max(0, durationMs) / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const wholeSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = String(wholeSeconds % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}
