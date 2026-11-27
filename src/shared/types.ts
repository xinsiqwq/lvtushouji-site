export type ExifSummary = {
  make?: string;
  model?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
  shutter?: string;
  iso?: number;
};

export type Media = {
  hash?: string;
  id: string;
  name: string;
  url: string;
  thumbnail: string;
  preview: string;
  posterUrl?: string;
  width: number;
  height: number;
  kind: 'image' | 'video' | 'file';
  mime: string;
  size: number;
  takenAt: string | null;
  lat: number | null;
  lng: number | null;
  confirmed: boolean;
  caption: string;
  exif?: ExifSummary;
};

export type Stop = {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  date: string;
  note: string;
  mediaIds: string[];
};

export type Journey = {
  id: string;
  title: string;
  subtitle: string;
  startDate: string;
  endDate: string;
  visibility: 'private' | 'public';
  coverId: string | null;
  stops: Stop[];
  createdAt: string;
  sortOrder?: number;
  shareToken?: string | null;
};

export type HomeShowcaseFrame = {
  id: string;
  src: string;
  alt: string;
  place: string;
  coords: string;
  caption: string;
  mediaId?: string | null;
  width?: number;
  height?: number;
};

export type SiteSettings = {
  title: string;
  tagline: string;
  homeShowcase?: HomeShowcaseFrame[];
};

export type ProjectLink = {
  label: string;
  href: string;
  kind: 'download' | 'external' | 'vault' | 'demo';
  vaultCode?: string;
  note?: string;
};

export type ProjectMetric = {
  label: string;
  value: string;
};

export type ProjectItem = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  category: string;
  version: string;
  status: 'published' | 'draft';
  stack: string[];
  highlights: string[];
  metrics: ProjectMetric[];
  links: ProjectLink[];
  requirements?: string;
  coverUrl?: string | null;
  sortOrder: number;
  updatedAt: string;
};

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  title: '旅途手记',
  tagline: '把走过的山海，和看过的夜空收进一册。',
};

export type Library = {
  journeys: Journey[];
  media: Media[];
  settings?: SiteSettings;
  access?: {
    protected: boolean;
    role: 'owner' | 'visitor';
  };
};

// Security types
export type AddressSource = 'loopback' | 'signed-proxy';

export type DeviceInfo = {
  browser: string;
  os: string;
  type: 'desktop' | 'mobile' | 'tablet' | 'script' | 'unknown';
  userAgent: string;
  language: string;
};

export type ClientInfo = {
  timezone: string;
  language: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  chapter: string;
};

export type SecurityEvent = {
  id: string;
  at: string;
  visitorId: string;
  sessionId: string | null;
  address: string;
  addressSource: AddressSource;
  forwardedClaim: string;
  method: string;
  path: string;
  status: number;
  kind: 'access' | 'auth' | 'blocked' | 'policy' | 'visit';
  reasons: string[];
  referrer: string;
  device: DeviceInfo;
};

export type VisitorSummary = {
  id: string;
  firstSeen: string;
  lastSeen: string;
  address: string;
  addressSource: AddressSource;
  device: DeviceInfo;
  requests: number;
  denied: number;
  reasons: string[];
  blocked: boolean;
  authenticated: boolean;
  clientInfo: ClientInfo | null;
};

export type VisitorDetail = {
  visitor: VisitorSummary;
  events: SecurityEvent[];
  addresses: string[];
  browserChanges: number;
};

export type AdminSession = {
  id: string;
  createdAt: string;
  lastSeen: string;
  expiresAt: string;
  address: string;
  device: DeviceInfo;
  current: boolean;
};

export type SecurityBlock = {
  id: string;
  type: 'visitor' | 'ip';
  value: string;
  reason: string;
  createdAt: string;
};

export type SecurityPolicy = {
  recordingEnabled: boolean;
  retentionDays: 7 | 30 | 90;
  requestsPerMinute: number;
  allowVisitorMessages: boolean;
};

export type AuthStatus = {
  configured: boolean;
  authenticated: boolean;
  csrfToken: string | null;
  sessionId: string | null;
};

export type SecuritySnapshot = {
  auth: AuthStatus;
  policy: SecurityPolicy;
  visitors: VisitorSummary[];
  events: SecurityEvent[];
  sessions: AdminSession[];
  blocks: SecurityBlock[];
  totals: { requests: number; visitors: number; denied: number; failedLogins: number };
  sourceMode: 'loopback' | 'signed-proxy';
  proxyConfigured: boolean;
};

export type NetworkLookup = {
  address: string;
  checkedAt: string;
  addressClass: string;
  publicAddress: boolean;
  network: {
    name: string;
    handle: string;
    country: string;
    start: string;
    end: string;
    organization: string;
    registry: string;
  } | null;
  route: { prefix: string; asns: { number: number; name: string }[]; announced: boolean | null } | null;
  reverseDns: string[];
  sources: { name: string; url: string; status: 'ok' | 'unavailable' | 'not-applicable'; detail: string }[];
  limitations: string[];
};

// Vault types
export type VaultVisibility = 'private' | 'shared';

export type VaultFileRecord = {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  r2Key: string;
  chunkCount: number;
  visibility: VaultVisibility;
  createdAt: string;
};

export type VaultUploadSession = {
  id: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  totalChunks: number;
  receivedChunks: number[];
  state: 'uploading' | 'completed' | 'aborted';
  createdAt: string;
  updatedAt: string;
};

export type VaultShareSummary = {
  id: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  fileMime: string;
  note: string;
  maxDownloads: number;
  downloads: number;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
};

export type VaultRedeemResult = {
  ticketId: string;
  downloadUrl: string;
  fileName: string;
  fileSize: number;
  fileMime: string;
  note: string;
  remainingDownloads: number;
  expiresAt: string;
};

// Admin & Usage types
export type TrashKind = 'journey' | 'media' | 'vault_file';

export type TrashItem = {
  key: string;
  kind: TrashKind;
  id: string;
  label: string;
  removedAt: string;
  record: Journey | Media | VaultFileRecord;
};

export type AdminSnapshot = {
  library: Library;
  settings: SiteSettings;
  trash: TrashItem[];
  vaultFiles: VaultFileRecord[];
  projects: ProjectItem[];
  storage: {
    dataDirectory: string;
    databaseBytes: number;
    originalBytes: number;
    vaultBytes: number;
  };
  limits: {
    maxFileBytes: number;
    maxBatchBytes: number;
    maxChunkBytes: number;
  };
};

export type UsageLimitsSummary = {
  limits: {
    uploadBytes: number;
    classA: number;
    classB: number;
    apiRequests: number;
  };
  month: string;
  counters: Array<{ key: string; value: number }>;
};

// Cross-Device Clipboard Drops (Phase 2 Mercury Toolkit)
export type ClipboardCreateRequest = {
  content: string;
  burnAfterRead?: boolean;
  maxViews?: number;
  expiresInSeconds?: number;
};

export type ClipboardCreateResponse = {
  code: string;
  destroyToken: string;
  expiresAt: string;
  burnAfterRead: boolean;
  maxViews: number;
  sizeBytes: number;
};

export type ClipboardClaimResponse = {
  code: string;
  content: string;
  burnAfterRead: boolean;
  remainingViews: number;
  expiresAt: string;
  createdAt: string;
  burned: boolean;
};

// Mars Arcade Leaderboard (Phase 3)
export type ArcadeGameId = 'dino' | 'snake' | 'tetris' | '2048' | 'minesweeper' | 'breakout';

export type ArcadeScoreEntry = {
  id: string;
  gameId: ArcadeGameId;
  playerName: string;
  score: number;
  durationMs: number;
  meta: Record<string, string | number | boolean>;
  createdAt: string;
  visitorPrefix?: string;
};

export type ArcadeLeaderboardResponse = {
  gameId: ArcadeGameId;
  sortDirection: 'desc' | 'asc';
  entries: ArcadeScoreEntry[];
};

export type ArcadeSubmitResponse = {
  entry: ArcadeScoreEntry;
  rank: number;
  madeTop10: boolean;
  leaderboard: ArcadeScoreEntry[];
};

export type ArcadeAdminScoresResponse = {
  entries: ArcadeScoreEntry[];
  counts: Record<ArcadeGameId, number>;
};

// Mars 3D Tactical Shooter · SANDSTORM (Phase 4 & v3.0)
export type ArenaMapId = 'dust' | 'frost' | 'harbor' | 'mars';
export type ArenaGameMode = 'elimination' | 'deathmatch' | 'armsrace' | 'retake';
export type ArenaBotDifficulty = 'rookie' | 'veteran' | 'commander';
export type ArenaTeam = 'red' | 'blue';
export type ArenaWeaponId = 'rifle' | 'sniper' | 'pistol' | 'knife';
export type ArenaPrimaryWeaponId = 'rifle' | 'sniper';
export type ArenaPhase = 'lobby' | 'freeze' | 'live' | 'round_over' | 'match_over';

export type ArenaLobbySummary = {
  code: string;
  name: string;
  hostName: string;
  mode: ArenaGameMode;
  mapId: ArenaMapId;
  isPublic: boolean;
  phase: ArenaPhase;
  humanCount: number;
  maxHumans: number;
  botCount: number;
  botDifficulty: ArenaBotDifficulty;
  roundsToWin: number;
  targetKills: number;
  scoreRed: number;
  scoreBlue: number;
  createdAt: string;
  updatedAt: string;
};

export type ArenaCreateRoomRequest = {
  name?: string;
  hostName?: string;
  mode?: ArenaGameMode;
  mapId?: ArenaMapId;
  isPublic?: boolean;
  maxHumans?: number;
  botCount?: number;
  botDifficulty?: ArenaBotDifficulty;
  roundsToWin?: number;
  targetKills?: number;
};

export type ArenaCreateRoomResponse = {
  code: string;
  room: ArenaLobbySummary;
  wsPath: string;
};

export type ArenaRoomsListResponse = {
  rooms: ArenaLobbySummary[];
  totalPublic: number;
};

export type ArenaMatchPlayerStat = {
  id: string;
  name: string;
  team: ArenaTeam;
  isBot: boolean;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  score: number;
};

export type ArenaMatchRecord = {
  id: string;
  roomCode: string;
  source: 'online' | 'solo';
  mode: ArenaGameMode;
  mapId: ArenaMapId;
  winnerTeam: ArenaTeam | 'draw';
  scoreRed: number;
  scoreBlue: number;
  mvpName: string;
  mvpKills: number;
  mvpDeaths: number;
  mvpHeadshots: number;
  durationMs: number;
  playerCount: number;
  botCount: number;
  players: ArenaMatchPlayerStat[];
  createdAt: string;
  visitorPrefix?: string;
};

export type ArenaSubmitMatchRequest = {
  roomCode?: string;
  source?: 'online' | 'solo';
  archiveToken?: string;
  mode: ArenaGameMode;
  mapId?: ArenaMapId;
  winnerTeam: ArenaTeam | 'draw';
  scoreRed: number;
  scoreBlue: number;
  mvpName: string;
  mvpKills: number;
  mvpDeaths: number;
  mvpHeadshots: number;
  durationMs: number;
  playerCount: number;
  botCount: number;
  players: ArenaMatchPlayerStat[];
};

export type ArenaMatchesResponse = {
  matches: ArenaMatchRecord[];
};

export type ArenaAdminSnapshotResponse = {
  lobbies: ArenaLobbySummary[];
  matches: ArenaMatchRecord[];
  counts: {
    activeLobbies: number;
    publicLobbies: number;
    activeHumans: number;
    archivedMatches: number;
  };
};
