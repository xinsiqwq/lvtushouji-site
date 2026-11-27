export type SkyTarget = {
  id: string;
  name: string;
  english: string;
  kind: '行星' | '恒星' | '星座';
  aliases?: string;
};

export type SkyState = {
  lat: number;
  lng: number;
  date: string;
  yaw: number;
  pitch: number;
  fov: number;
  constellations: boolean;
  labels: boolean;
  grid: boolean;
  atmosphere: boolean;
  ground: boolean;
  ready: boolean;
  starsLoaded?: boolean;
  paused?: boolean;
  selected?: {
    id: string;
    name: string;
    kind?: string;
    magnitude?: number;
    azimuth?: number;
    altitude?: number;
    ra?: number;
    dec?: number;
  } | null;
};

export type SkySettings = Pick<
  SkyState,
  'constellations' | 'labels' | 'grid' | 'atmosphere' | 'ground'
>;

const planets: SkyTarget[] = [
  ['Moon', '月亮', '月球'],
  ['Sun', '太阳', '日'],
  ['Mercury', '水星', ''],
  ['Venus', '金星', '启明星 长庚星'],
  ['Mars', '火星', ''],
  ['Jupiter', '木星', ''],
  ['Saturn', '土星', ''],
  ['Uranus', '天王星', ''],
  ['Neptune', '海王星', ''],
].map(([english, name, aliases]) => ({
  id: `NAME ${english}`,
  name,
  english,
  aliases,
  kind: '行星',
}));

const stars: SkyTarget[] = [
  [32349, '天狼星', 'Sirius'],
  [30438, '老人星', 'Canopus'],
  [69673, '大角星', 'Arcturus'],
  [91262, '织女一', 'Vega'],
  [24608, '五车二', 'Capella'],
  [24436, '参宿七', 'Rigel'],
  [37279, '南河三', 'Procyon'],
  [27989, '参宿四', 'Betelgeuse'],
  [97649, '河鼓二', 'Altair'],
  [21421, '毕宿五', 'Aldebaran'],
  [80763, '心宿二', 'Antares'],
  [65474, '角宿一', 'Spica'],
  [37826, '北河三', 'Pollux'],
  [113368, '北落师门', 'Fomalhaut'],
  [102098, '天津四', 'Deneb'],
  [49669, '轩辕十四', 'Regulus'],
  [11767, '北极星', 'Polaris'],
  [36850, '北河二', 'Castor'],
  [54061, '天枢', 'Dubhe'],
  [53910, '天璇', 'Merak'],
  [58001, '天玑', 'Phecda'],
  [59774, '天权', 'Megrez'],
  [62956, '玉衡', 'Alioth'],
  [65378, '开阳', 'Mizar'],
  [67301, '摇光', 'Alkaid'],
].map(([hip, name, english]) => ({
  id: `HIP ${hip}`,
  name: String(name),
  english: String(english),
  kind: '恒星',
}));

const constellations: SkyTarget[] = [
  ['And', '仙女座', 'Andromeda'],
  ['Ant', '唧筒座', 'Antlia'],
  ['Aps', '天燕座', 'Apus'],
  ['Aqr', '宝瓶座', 'Aquarius'],
  ['Aql', '天鹰座', 'Aquila'],
  ['Ara', '天坛座', 'Ara'],
  ['Ari', '白羊座', 'Aries'],
  ['Aur', '御夫座', 'Auriga'],
  ['Boo', '牧夫座', 'Bootes'],
  ['Cae', '雕具座', 'Caelum'],
  ['Cam', '鹿豹座', 'Camelopardalis'],
  ['Cnc', '巨蟹座', 'Cancer'],
  ['CVn', '猎犬座', 'Canes Venatici'],
  ['CMa', '大犬座', 'Canis Major'],
  ['CMi', '小犬座', 'Canis Minor'],
  ['Cap', '摩羯座', 'Capricornus'],
  ['Car', '船底座', 'Carina'],
  ['Cas', '仙后座', 'Cassiopeia'],
  ['Cen', '半人马座', 'Centaurus'],
  ['Cep', '仙王座', 'Cepheus'],
  ['Cet', '鲸鱼座', 'Cetus'],
  ['Cha', '堰蜓座', 'Chamaeleon'],
  ['Cir', '圆规座', 'Circinus'],
  ['Col', '天鸽座', 'Columba'],
  ['Com', '后发座', 'Coma Berenices'],
  ['CrA', '南冕座', 'Corona Australis'],
  ['CrB', '北冕座', 'Corona Borealis'],
  ['Crv', '乌鸦座', 'Corvus'],
  ['Crt', '巨爵座', 'Crater'],
  ['Cru', '南十字座', 'Crux'],
  ['Cyg', '天鹅座', 'Cygnus'],
  ['Del', '海豚座', 'Delphinus'],
  ['Dor', '剑鱼座', 'Dorado'],
  ['Dra', '天龙座', 'Draco'],
  ['Equ', '小马座', 'Equuleus'],
  ['Eri', '波江座', 'Eridanus'],
  ['For', '天炉座', 'Fornax'],
  ['Gem', '双子座', 'Gemini'],
  ['Gru', '天鹤座', 'Grus'],
  ['Her', '武仙座', 'Hercules'],
  ['Hor', '时钟座', 'Horologium'],
  ['Hya', '长蛇座', 'Hydra'],
  ['Hyi', '水蛇座', 'Hydrus'],
  ['Ind', '印第安座', 'Indus'],
  ['Lac', '蝎虎座', 'Lacerta'],
  ['Leo', '狮子座', 'Leo'],
  ['LMi', '小狮座', 'Leo Minor'],
  ['Lep', '天兔座', 'Lepus'],
  ['Lib', '天秤座', 'Libra'],
  ['Lup', '豺狼座', 'Lupus'],
  ['Lyn', '天猫座', 'Lynx'],
  ['Lyr', '天琴座', 'Lyra'],
  ['Men', '山案座', 'Mensa'],
  ['Mic', '显微镜座', 'Microscopium'],
  ['Mon', '麒麟座', 'Monoceros'],
  ['Mus', '苍蝇座', 'Musca'],
  ['Nor', '矩尺座', 'Norma'],
  ['Oct', '南极座', 'Octans'],
  ['Oph', '蛇夫座', 'Ophiuchus'],
  ['Ori', '猎户座', 'Orion'],
  ['Pav', '孔雀座', 'Pavo'],
  ['Peg', '飞马座', 'Pegasus'],
  ['Per', '英仙座', 'Perseus'],
  ['Phe', '凤凰座', 'Phoenix'],
  ['Pic', '绘架座', 'Pictor'],
  ['Psc', '双鱼座', 'Pisces'],
  ['PsA', '南鱼座', 'Piscis Austrinus'],
  ['Pup', '船尾座', 'Puppis'],
  ['Pyx', '罗盘座', 'Pyxis'],
  ['Ret', '网罟座', 'Reticulum'],
  ['Sge', '天箭座', 'Sagitta'],
  ['Sgr', '人马座', 'Sagittarius'],
  ['Sco', '天蝎座', 'Scorpius'],
  ['Scl', '玉夫座', 'Sculptor'],
  ['Sct', '盾牌座', 'Scutum'],
  ['Ser', '巨蛇座', 'Serpens'],
  ['Sex', '六分仪座', 'Sextans'],
  ['Tau', '金牛座', 'Taurus'],
  ['Tel', '望远镜座', 'Telescopium'],
  ['Tri', '三角座', 'Triangulum'],
  ['TrA', '南三角座', 'Triangulum Australe'],
  ['Tuc', '杜鹃座', 'Tucana'],
  ['UMa', '大熊座', 'Ursa Major'],
  ['UMi', '小熊座', 'Ursa Minor'],
  ['Vel', '船帆座', 'Vela'],
  ['Vir', '室女座', 'Virgo'],
  ['Vol', '飞鱼座', 'Volans'],
  ['Vul', '狐狸座', 'Vulpecula'],
].map(([iau, name, english]) => ({
  id: `CON western ${iau}`,
  name,
  english,
  kind: '星座',
  aliases:
    name === '宝瓶座'
      ? '水瓶座'
      : name === '人马座'
        ? '射手座'
        : name === '室女座'
          ? '处女座'
          : '',
}));

export const skyTargets = [...planets, ...stars, ...constellations];

export const suggestedTargets = [
  'NAME Moon',
  'NAME Saturn',
  'HIP 91262',
  'HIP 11767',
  'CON western Ori',
  'CON western Cas',
].map((id) => skyTargets.find((target) => target.id === id)!);

export function findSkyTargets(query: string): SkyTarget[] {
  const value = query.trim().toLocaleLowerCase();
  return value
    ? skyTargets
        .filter((target) =>
          `${target.name} ${target.english} ${target.id} ${target.aliases || ''}`
            .toLocaleLowerCase()
            .includes(value),
        )
        .slice(0, 8)
    : suggestedTargets;
}

export function skyPositionLabel(position: { lat: number; lng: number; name: string }): string {
  return `${position.name} · ${Math.abs(position.lat).toFixed(4)}° ${position.lat >= 0 ? 'N' : 'S'} / ${Math.abs(position.lng).toFixed(4)}° ${position.lng >= 0 ? 'E' : 'W'}`;
}

export function validSkyPosition(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}
