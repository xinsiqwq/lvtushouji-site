export type CatalogStar = [name: string, ra: number, dec: number, magnitude: number];

export async function loadCatalog(): Promise<CatalogStar[]> {
  const module = await import('../data/hyg-bright.json');
  return module.default as CatalogStar[];
}

export const CHINESE_STARS: Record<string, string> = {
  Sirius: '天狼星',
  Canopus: '老人星',
  Arcturus: '大角星',
  Vega: '织女一',
  Capella: '五车二',
  Rigel: '参宿七',
  Procyon: '南河三',
  Betelgeuse: '参宿四',
  Altair: '河鼓二',
  Aldebaran: '毕宿五',
  Antares: '心宿二',
  Spica: '角宿一',
  Pollux: '北河三',
  Fomalhaut: '北落师门',
  Deneb: '天津四',
  Regulus: '轩辕十四',
  Polaris: '北极星',
  Castor: '北河二',
  Dubhe: '天枢',
  Merak: '天璇',
  Phecda: '天玑',
  Megrez: '天权',
  Alioth: '玉衡',
  Mizar: '开阳',
  Alkaid: '摇光',
};

export function isNamedStar(name: string): boolean {
  const trimmed = name.trim();
  return Boolean(trimmed) && !/^HIP(\s+\d+)?$/i.test(trimmed);
}
