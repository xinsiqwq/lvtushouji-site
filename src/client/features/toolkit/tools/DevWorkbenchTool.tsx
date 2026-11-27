import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  Braces,
  Check,
  Clock,
  Copy,
  FileCheck2,
  GitCompare,
  KeyRound,
  Pause,
  Play,
  Regex,
  ShieldCheck,
  Upload,
} from 'lucide-react';

type SubTabId = 'json' | 'jwt' | 'time' | 'regex' | 'hash';
type JsonViewMode = 'format' | 'diff';
type EncodingKind = 'base64' | 'url' | 'hex';
type UnixUnitMode = 'auto' | 'sec' | 'ms';

const SUB_TABS: readonly { id: SubTabId; label: string }[] = [
  { id: 'json', label: 'JSON 格式化与对比' },
  { id: 'jwt', label: 'JWT 本地解析' },
  { id: 'time', label: '时间戳与编码转换' },
  { id: 'regex', label: '正则实时测试' },
  { id: 'hash', label: '文件哈希校验' },
];

const DEFAULT_JSON_SAMPLE = `{
  "station": "Mercury Toolkit",
  "orbitAU": 0.39,
  "localOnly": true,
  "features": ["json", "jwt", "regex", "hash"],
  "limits": {
    "clipboardBytes": 32768,
    "qrMaxBytes": 458
  }
}`;

const DEFAULT_DIFF_LEFT = `{
  "service": "lvtushouji",
  "version": "2.0.0",
  "storage": {
    "d1": true,
    "r2Bucket": "private-vault",
    "ttlSeconds": 3600
  },
  "modules": ["atlas", "observatory", "vault"]
}`;

const DEFAULT_DIFF_RIGHT = `{
  "service": "lvtushouji",
  "version": "2.1.0",
  "storage": {
    "d1": true,
    "ttlSeconds": 86400,
    "burnAfterRead": true
  },
  "modules": ["atlas", "observatory", "vault", "toolkit"]
}`;

const REGEX_PRESETS: readonly { label: string; pattern: string; flags: string; sample: string }[] = [
  {
    label: 'ISO 日期',
    pattern: '(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})',
    flags: 'g',
    sample: '川西出发 2025-10-03，纳木错观星 2025-10-08，返程记录 2025-10-12。',
  },
  {
    label: '电子邮箱',
    pattern: '([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})',
    flags: 'gi',
    sample: '联系地址：hello@example.com，归档备份 archive.ops@mercury-lab.org。',
  },
  {
    label: 'IPv4 地址',
    pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b',
    flags: 'g',
    sample: '本地回环 127.0.0.1，内网网关 192.168.1.1，无效地址 999.10.0.1。',
  },
  {
    label: 'URL 链接',
    pattern: 'https?:\\/\\/[^\\s/$.?#].[^\\s]*',
    flags: 'gi',
    sample: '工具台入口 https://example.org/toolkit?tool=dev 以及备用 http://127.0.0.1:5173/vault',
  },
];

const REGEX_FLAGS: readonly { flag: string; title: string }[] = [
  { flag: 'g', title: '全局匹配' },
  { flag: 'i', title: '忽略大小写' },
  { flag: 'm', title: '多行模式' },
  { flag: 's', title: '点号匹配换行' },
  { flag: 'u', title: 'Unicode 模式' },
];

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------- UTF-8 Safe Base64 / Base64URL / Hex Helpers ----------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('包含非法的 Base64 字符');
  }
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function encodeBase64Utf8(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function encodeBase64UrlUtf8(text: string): string {
  return encodeBase64Utf8(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Utf8(input: string): string {
  const bytes = base64ToBytes(input);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeHexUtf8(text: string, spaced: boolean): string {
  const bytes = new TextEncoder().encode(text);
  const parts = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return parts.join(spaced ? ' ' : '');
}

function decodeHexUtf8(input: string): string {
  const cleaned = input.trim().replace(/^0x/i, '').replace(/[\s:,-]+/g, '');
  if (!cleaned) return '';
  if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error('Hex 字符串必须为偶数长度的十六进制字符');
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildSampleJwt(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: 'mercury-local-demo' };
  const payload = {
    sub: 'traveler-01',
    name: '旅途手记访客',
    scope: ['toolkit:local', 'observatory:read'],
    iat: nowSec - 600,
    nbf: nowSec - 600,
    exp: nowSec + 7200,
  };
  return `${encodeBase64UrlUtf8(JSON.stringify(header))}.${encodeBase64UrlUtf8(JSON.stringify(payload))}.local-demo-signature-not-verified`;
}

// ---------- JSON Helpers ----------

type JsonErrorInfo = {
  message: string;
  line: number | null;
  column: number | null;
  snippet: string | null;
};

function parseJsonWithDiagnostics(raw: string): { ok: true; value: unknown } | { ok: false; error: JsonErrorInfo } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JSON 语法解析失败';
    let line: number | null = null;
    let column: number | null = null;

    const lineColMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineColMatch) {
      line = Number.parseInt(lineColMatch[1]!, 10);
      column = Number.parseInt(lineColMatch[2]!, 10);
    } else {
      const posMatch = message.match(/position\s+(\d+)/i);
      if (posMatch) {
        const pos = Math.min(raw.length, Number.parseInt(posMatch[1]!, 10));
        const before = raw.slice(0, pos);
        const lines = before.split('\n');
        line = lines.length;
        column = (lines[lines.length - 1]?.length ?? 0) + 1;
      }
    }

    let snippet: string | null = null;
    if (line !== null) {
      const allLines = raw.split('\n');
      const targetLine = allLines[line - 1];
      if (targetLine !== undefined) {
        snippet = targetLine.slice(0, 120);
      }
    }

    return { ok: false, error: { message, line, column, snippet } };
  }
}

function sortJsonKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortJsonKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

function inspectJsonStats(value: unknown): { keys: number; maxDepth: number } {
  let keys = 0;
  let maxDepth = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      keys += entries.length;
      for (const [, child] of entries) walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return { keys, maxDepth };
}

type DiffEntry = {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
};

function formatDiffLeaf(val: unknown): string {
  const s = JSON.stringify(val);
  if (s.length <= 160) return s;
  return `${s.slice(0, 157)}…`;
}

function diffJsonValues(left: unknown, right: unknown, path = '$', out: DiffEntry[] = []): DiffEntry[] {
  if (Object.is(left, right)) return out;

  const leftIsArr = Array.isArray(left);
  const rightIsArr = Array.isArray(right);
  const leftIsObj = left !== null && typeof left === 'object' && !leftIsArr;
  const rightIsObj = right !== null && typeof right === 'object' && !rightIsArr;

  if (leftIsObj && rightIsObj) {
    const lRec = left as Record<string, unknown>;
    const rRec = right as Record<string, unknown>;
    const allKeys = Array.from(new Set([...Object.keys(lRec), ...Object.keys(rRec)])).sort();
    for (const key of allKeys) {
      const nextPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      const inLeft = Object.prototype.hasOwnProperty.call(lRec, key);
      const inRight = Object.prototype.hasOwnProperty.call(rRec, key);
      if (!inLeft && inRight) {
        out.push({ path: nextPath, kind: 'added', after: formatDiffLeaf(rRec[key]) });
      } else if (inLeft && !inRight) {
        out.push({ path: nextPath, kind: 'removed', before: formatDiffLeaf(lRec[key]) });
      } else {
        diffJsonValues(lRec[key], rRec[key], nextPath, out);
      }
    }
    return out;
  }

  if (leftIsArr && rightIsArr) {
    const maxLen = Math.max(left.length, right.length);
    for (let i = 0; i < maxLen; i += 1) {
      const nextPath = `${path}[${i}]`;
      if (i >= left.length) {
        out.push({ path: nextPath, kind: 'added', after: formatDiffLeaf(right[i]) });
      } else if (i >= right.length) {
        out.push({ path: nextPath, kind: 'removed', before: formatDiffLeaf(left[i]) });
      } else {
        diffJsonValues(left[i], right[i], nextPath, out);
      }
    }
    return out;
  }

  out.push({
    path,
    kind: 'changed',
    before: formatDiffLeaf(left),
    after: formatDiffLeaf(right),
  });
  return out;
}

// ---------- Time Formatting Helpers ----------

function formatShanghaiTime(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} CST`;
  } catch {
    return date.toLocaleString('zh-CN');
  }
}

function formatDateTimeLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatRelativeDuration(diffMs: number): string {
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  const days = Math.floor(absSec / 86_400);
  const hours = Math.floor((absSec % 86_400) / 3600);
  const mins = Math.floor((absSec % 3600) / 60);
  const secs = absSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0 && days === 0) parts.push(`${mins} 分`);
  if (days === 0 && hours === 0) parts.push(`${secs} 秒`);
  return parts.join(' ') || '0 秒';
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ---------- Main Component ----------

export default function DevWorkbenchTool() {
  const [activeTab, setActiveTab] = useState<SubTabId>('json');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Live clock (ticks when JWT or Time tab is active)
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [clockPaused, setClockPaused] = useState(false);

  // Tab 1: JSON
  const [jsonMode, setJsonMode] = useState<JsonViewMode>('format');
  const [jsonInput, setJsonInput] = useState(DEFAULT_JSON_SAMPLE);
  const [jsonIndent, setJsonIndent] = useState<2 | 4>(2);
  const [diffLeft, setDiffLeft] = useState(DEFAULT_DIFF_LEFT);
  const [diffRight, setDiffRight] = useState(DEFAULT_DIFF_RIGHT);

  // Tab 2: JWT
  const [jwtInput, setJwtInput] = useState(() => buildSampleJwt());

  // Tab 3: Time & Encoding
  const [unixInput, setUnixInput] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [unixUnit, setUnixUnit] = useState<UnixUnitMode>('auto');
  const [dateInput, setDateInput] = useState(() => formatDateTimeLocalInput(new Date()));
  const [encodingKind, setEncodingKind] = useState<EncodingKind>('base64');
  const [encodePlain, setEncodePlain] = useState('旅途手记 · Mercury Toolkit');
  const [encodeCoded, setEncodeCoded] = useState(() =>
    encodeBase64Utf8('旅途手记 · Mercury Toolkit'),
  );
  const [encodeError, setEncodeError] = useState('');
  const [hexSpaced, setHexSpaced] = useState(true);

  // Tab 4: Regex
  const [regexPattern, setRegexPattern] = useState(REGEX_PRESETS[0]!.pattern);
  const [regexFlags, setRegexFlags] = useState(REGEX_PRESETS[0]!.flags);
  const [regexText, setRegexText] = useState(REGEX_PRESETS[0]!.sample);

  // Tab 5: File Hash
  const [hashFileInfo, setHashFileInfo] = useState<{
    name: string;
    size: number;
    type: string;
    lastModified: number;
    elapsedMs: number;
    sha256: string;
    sha1: string;
    sha512: string;
  } | null>(null);
  const [hashing, setHashing] = useState(false);
  const [hashError, setHashError] = useState('');
  const [hashUppercase, setHashUppercase] = useState(false);
  const [expectedHash, setExpectedHash] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (clockPaused) return;
    if (activeTab !== 'time' && activeTab !== 'jwt') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeTab, clockPaused]);

  const handleCopy = useCallback(async (key: string, value: string) => {
    const ok = await copyTextSafe(value);
    if (!ok) return;
    setCopiedKey(key);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1800);
  }, []);

  // ---------- JSON Derived State ----------

  const jsonParsed = useMemo(() => {
    if (!jsonInput.trim()) return null;
    return parseJsonWithDiagnostics(jsonInput);
  }, [jsonInput]);

  const jsonStats = useMemo(() => {
    if (!jsonParsed || !jsonParsed.ok) return null;
    const stats = inspectJsonStats(jsonParsed.value);
    const bytes = new TextEncoder().encode(jsonInput).length;
    return { ...stats, bytes };
  }, [jsonInput, jsonParsed]);

  const jsonDiffResult = useMemo(() => {
    const leftRes = parseJsonWithDiagnostics(diffLeft);
    const rightRes = parseJsonWithDiagnostics(diffRight);
    if (!leftRes.ok || !rightRes.ok) {
      return {
        leftError: leftRes.ok ? null : leftRes.error,
        rightError: rightRes.ok ? null : rightRes.error,
        entries: [] as DiffEntry[],
      };
    }
    const entries = diffJsonValues(leftRes.value, rightRes.value);
    return { leftError: null, rightError: null, entries };
  }, [diffLeft, diffRight]);

  const handleJsonTransform = (kind: 'pretty' | 'minify' | 'sort') => {
    const parsed = parseJsonWithDiagnostics(jsonInput);
    if (!parsed.ok) return;
    if (kind === 'pretty') {
      setJsonInput(JSON.stringify(parsed.value, null, jsonIndent));
    } else if (kind === 'minify') {
      setJsonInput(JSON.stringify(parsed.value));
    } else {
      setJsonInput(JSON.stringify(sortJsonKeysDeep(parsed.value), null, jsonIndent));
    }
  };

  // ---------- JWT Derived State ----------

  const jwtParsed = useMemo(() => {
    const trimmed = jwtInput.trim();
    if (!trimmed) return null;
    const segments = trimmed.split('.');
    if (segments.length !== 3) {
      return {
        ok: false as const,
        error: `标准 JWT 应包含 3 段由点号分隔的字段（Header.Payload.Signature），当前检测到 ${segments.length} 段。`,
      };
    }
    try {
      const headerRaw = decodeBase64Utf8(segments[0]!);
      const payloadRaw = decodeBase64Utf8(segments[1]!);
      const headerObj = JSON.parse(headerRaw) as Record<string, unknown>;
      const payloadObj = JSON.parse(payloadRaw) as Record<string, unknown>;
      const sigPart = segments[2]!;
      let sigBytes = 0;
      try {
        sigBytes = base64ToBytes(sigPart).length;
      } catch {
        sigBytes = 0;
      }
      return {
        ok: true as const,
        header: headerObj,
        payload: payloadObj,
        headerJson: JSON.stringify(headerObj, null, 2),
        payloadJson: JSON.stringify(payloadObj, null, 2),
        signature: sigPart,
        signatureBytes: sigBytes,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: `JWT 解码失败：${err instanceof Error ? err.message : 'Base64URL 或 JSON 格式无效'}`,
      };
    }
  }, [jwtInput]);

  const jwtTiming = useMemo(() => {
    if (!jwtParsed || !jwtParsed.ok) return null;
    const p = jwtParsed.payload;
    const readNum = (key: string) =>
      typeof p[key] === 'number' && Number.isFinite(p[key]) ? (p[key] as number) : null;
    const iat = readNum('iat');
    const nbf = readNum('nbf');
    const exp = readNum('exp');

    let status: 'valid' | 'expired' | 'not-yet' | 'no-exp' = 'no-exp';
    let statusText = '无 exp 过期声明';
    if (nbf !== null && nowMs < nbf * 1000) {
      status = 'not-yet';
      statusText = `尚未生效 · ${formatRelativeDuration(nbf * 1000 - nowMs)}后生效`;
    } else if (exp !== null) {
      const diff = exp * 1000 - nowMs;
      if (diff <= 0) {
        status = 'expired';
        statusText = `已过期 · ${formatRelativeDuration(diff)}前失效`;
      } else {
        status = 'valid';
        statusText = `有效中 · 剩余 ${formatRelativeDuration(diff)}`;
      }
    }
    return { iat, nbf, exp, status, statusText };
  }, [jwtParsed, nowMs]);

  // ---------- Timestamp & Encoding Derived State ----------

  const unixParsed = useMemo(() => {
    const trimmed = unixInput.trim();
    if (!trimmed) return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return { ok: false as const, error: '请输入有效的数字时间戳（支持 10 位秒或 13 位毫秒）' };
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return { ok: false as const, error: '时间戳超出安全数值范围' };
    }
    const absDigits = trimmed.replace(/^-/, '').split('.')[0]!.length;
    const isMs = unixUnit === 'ms' || (unixUnit === 'auto' && absDigits >= 12);
    const ms = isMs ? num : num * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
      return { ok: false as const, error: '无法转换为有效日期' };
    }
    const diff = ms - nowMs;
    const rel =
      Math.abs(diff) < 1000
        ? '就是现在'
        : diff > 0
          ? `${formatRelativeDuration(diff)}后`
          : `${formatRelativeDuration(diff)}前`;
    return {
      ok: true as const,
      unitDetected: isMs ? '毫秒 (ms)' : '秒 (s)',
      iso: d.toISOString(),
      shanghai: formatShanghaiTime(d),
      local: d.toLocaleString('zh-CN', { hour12: false }),
      relative: rel,
    };
  }, [unixInput, unixUnit, nowMs]);

  const dateParsed = useMemo(() => {
    const trimmed = dateInput.trim();
    if (!trimmed) return null;
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      return { ok: false as const, error: '无法识别该日期格式，可使用 ISO-8601 或选择日期时间。' };
    }
    const ms = d.getTime();
    return {
      ok: true as const,
      sec: String(Math.floor(ms / 1000)),
      ms: String(ms),
      iso: d.toISOString(),
      shanghai: formatShanghaiTime(d),
    };
  }, [dateInput]);

  const runEncode = (plain: string, kind: EncodingKind, spaced: boolean) => {
    setEncodeError('');
    try {
      if (kind === 'base64') setEncodeCoded(encodeBase64Utf8(plain));
      else if (kind === 'url') setEncodeCoded(encodeURIComponent(plain));
      else setEncodeCoded(encodeHexUtf8(plain, spaced));
    } catch (err) {
      setEncodeError(err instanceof Error ? err.message : '编码失败');
    }
  };

  const runDecode = (coded: string, kind: EncodingKind) => {
    setEncodeError('');
    try {
      if (kind === 'base64') setEncodePlain(decodeBase64Utf8(coded));
      else if (kind === 'url') setEncodePlain(decodeURIComponent(coded));
      else setEncodePlain(decodeHexUtf8(coded));
    } catch (err) {
      setEncodeError(err instanceof Error ? err.message : '解码失败，请检查输入格式');
    }
  };

  const handleSwitchEncodingKind = (next: EncodingKind) => {
    setEncodingKind(next);
    runEncode(encodePlain, next, hexSpaced);
  };

  // ---------- Regex Derived State ----------

  const regexEvaluation = useMemo(() => {
    if (!regexPattern) {
      return { ok: true as const, matches: [], segments: [{ text: regexText, matched: false, idx: -1 }], truncated: false };
    }
    let compiled: RegExp;
    try {
      compiled = new RegExp(regexPattern, regexFlags);
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : '正则表达式语法错误',
      };
    }

    type MatchRecord = {
      index: number;
      end: number;
      full: string;
      captures: (string | undefined)[];
      named: Record<string, string | undefined> | null;
    };

    const matches: MatchRecord[] = [];
    const MAX_MATCHES = 300;
    let truncated = false;

    if (compiled.global) {
      let m: RegExpExecArray | null;
      while ((m = compiled.exec(regexText)) !== null) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({
          index: m.index,
          end: m.index + m[0].length,
          full: m[0],
          captures: m.slice(1),
          named: m.groups ? { ...m.groups } : null,
        });
        if (m[0].length === 0) {
          compiled.lastIndex += 1;
          if (compiled.lastIndex > regexText.length) break;
        }
      }
    } else {
      const m = compiled.exec(regexText);
      if (m) {
        matches.push({
          index: m.index,
          end: m.index + m[0].length,
          full: m[0],
          captures: m.slice(1),
          named: m.groups ? { ...m.groups } : null,
        });
      }
    }

    const segments: { text: string; matched: boolean; idx: number }[] = [];
    let cursor = 0;
    matches.forEach((match, idx) => {
      if (match.index > cursor) {
        segments.push({ text: regexText.slice(cursor, match.index), matched: false, idx: -1 });
      }
      if (match.end > match.index) {
        segments.push({ text: regexText.slice(match.index, match.end), matched: true, idx });
      }
      cursor = Math.max(cursor, match.end);
    });
    if (cursor < regexText.length) {
      segments.push({ text: regexText.slice(cursor), matched: false, idx: -1 });
    }

    return { ok: true as const, matches, segments, truncated };
  }, [regexFlags, regexPattern, regexText]);

  const toggleRegexFlag = (flag: string) => {
    setRegexFlags((prev) => (prev.includes(flag) ? prev.replace(flag, '') : `${prev}${flag}`));
  };

  // ---------- File Hash Handlers ----------

  const computeFileHashes = useCallback(async (file: File) => {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setHashError('当前浏览器上下文不支持 Web Crypto API（crypto.subtle）。');
      return;
    }
    setHashing(true);
    setHashError('');
    const t0 = performance.now();
    try {
      const buf = await file.arrayBuffer();
      const [s256, s1, s512] = await Promise.all([
        crypto.subtle.digest('SHA-256', buf),
        crypto.subtle.digest('SHA-1', buf),
        crypto.subtle.digest('SHA-512', buf),
      ]);
      setHashFileInfo({
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        lastModified: file.lastModified,
        elapsedMs: Math.max(1, Math.round(performance.now() - t0)),
        sha256: bufferToHex(s256),
        sha1: bufferToHex(s1),
        sha512: bufferToHex(s512),
      });
    } catch (err) {
      setHashFileInfo(null);
      setHashError(err instanceof Error ? err.message : '计算文件摘要失败，请重试。');
    } finally {
      setHashing(false);
    }
  }, []);

  const handleFilePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void computeFileHashes(file);
    event.target.value = '';
  };

  const handleFileDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void computeFileHashes(file);
  };

  const expectedHashVerdict = useMemo(() => {
    const normalized = expectedHash.trim().replace(/\s+/g, '').toLowerCase();
    if (!normalized || !hashFileInfo) return null;
    if (normalized === hashFileInfo.sha256) return { match: true as const, algo: 'SHA-256' };
    if (normalized === hashFileInfo.sha1) return { match: true as const, algo: 'SHA-1' };
    if (normalized === hashFileInfo.sha512) return { match: true as const, algo: 'SHA-512' };
    return { match: false as const, algo: null };
  }, [expectedHash, hashFileInfo]);

  const renderCopyButton = (key: string, value: string, label = '复制') => (
    <button
      type="button"
      onClick={() => void handleCopy(key, value)}
      className="inline-flex min-h-[30px] items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover"
    >
      {copiedKey === key ? (
        <>
          <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          <span>已复制</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </button>
  );

  const tabIcons: Record<SubTabId, ReactNode> = {
    json: <Braces className="h-3.5 w-3.5" aria-hidden="true" />,
    jwt: <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />,
    time: <Clock className="h-3.5 w-3.5" aria-hidden="true" />,
    regex: <Regex className="h-3.5 w-3.5" aria-hidden="true" />,
    hash: <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />,
  };

  const nowDate = new Date(nowMs);
  const nowSecStr = String(Math.floor(nowMs / 1000));
  const nowMsStr = String(nowMs);
  const nowIsoStr = nowDate.toISOString();
  const nowShanghaiStr = formatShanghaiTime(nowDate);

  return (
    <div className="space-y-5">
      {/* Sub-tab pill bar */}
      <div
        role="tablist"
        aria-label="开发者工具模块"
        className="flex flex-wrap items-center gap-2"
      >
        {SUB_TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3.5 text-[13px] transition-colors',
                active
                  ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                  : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:bg-surface-hover hover:text-ink',
              ].join(' ')}
            >
              {tabIcons[tab.id]}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* ==================== TAB 1: JSON ==================== */}
      {activeTab === 'json' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-full border border-hairline bg-surface p-1">
              <button
                type="button"
                aria-pressed={jsonMode === 'format'}
                onClick={() => setJsonMode('format')}
                className={[
                  'inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-3.5 text-[12.5px] transition-colors',
                  jsonMode === 'format'
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                <Braces className="h-3.5 w-3.5" aria-hidden="true" />
                <span>格式化与校验</span>
              </button>
              <button
                type="button"
                aria-pressed={jsonMode === 'diff'}
                onClick={() => setJsonMode('diff')}
                className={[
                  'inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-3.5 text-[12.5px] transition-colors',
                  jsonMode === 'diff'
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                <span>结构对比</span>
              </button>
            </div>

            {jsonMode === 'format' && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-full border border-hairline bg-surface p-0.5 text-[12px]">
                  {([2, 4] as const).map((sp) => (
                    <button
                      key={sp}
                      type="button"
                      onClick={() => setJsonIndent(sp)}
                      className={[
                        'tabular-nums-mono rounded-full px-2.5 py-1 transition-colors',
                        jsonIndent === sp ? 'bg-paper font-medium text-ink' : 'text-ink-muted',
                      ].join(' ')}
                    >
                      {sp} 空格
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!jsonParsed?.ok}
                  onClick={() => handleJsonTransform('pretty')}
                  className="pill-cta-secondary min-h-[34px] px-3.5 text-[12.5px] disabled:opacity-45"
                >
                  美化格式化
                </button>
                <button
                  type="button"
                  disabled={!jsonParsed?.ok}
                  onClick={() => handleJsonTransform('minify')}
                  className="pill-cta-secondary min-h-[34px] px-3.5 text-[12.5px] disabled:opacity-45"
                >
                  压缩一行
                </button>
                <button
                  type="button"
                  disabled={!jsonParsed?.ok}
                  onClick={() => handleJsonTransform('sort')}
                  className="pill-cta-secondary min-h-[34px] px-3.5 text-[12.5px] disabled:opacity-45"
                >
                  按键名排序
                </button>
                {renderCopyButton('json-all', jsonInput, '复制 JSON')}
              </div>
            )}
          </div>

          {jsonMode === 'format' ? (
            <div className="rounded-[24px] border border-hairline bg-surface p-4 sm:p-5">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-3 text-ink-muted">
                  {jsonParsed === null ? (
                    <span>等待输入 JSON 文本</span>
                  ) : jsonParsed.ok ? (
                    <span className="inline-flex items-center gap-1 font-medium text-accent">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>语法有效</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium text-postmark">
                      <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>语法错误</span>
                    </span>
                  )}
                  {jsonStats && (
                    <span className="tabular-nums-mono">
                      {jsonStats.keys} 键 · 深度 {jsonStats.maxDepth} · {jsonStats.bytes.toLocaleString('en-US')} B
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setJsonInput(DEFAULT_JSON_SAMPLE)}
                    className="text-[12px] text-accent hover:underline"
                  >
                    载入示例
                  </button>
                  <button
                    type="button"
                    onClick={() => setJsonInput('')}
                    className="text-[12px] text-ink-muted hover:text-ink"
                  >
                    清空
                  </button>
                </div>
              </div>

              <textarea
                aria-label="JSON 编辑器"
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                rows={13}
                spellCheck={false}
                placeholder='{"key": "value"}'
                className="tabular-nums-mono block w-full resize-y rounded-[16px] border border-hairline bg-paper px-4 py-3 text-[13px] leading-relaxed text-ink outline-none transition-colors focus:border-accent"
              />

              {jsonParsed && !jsonParsed.ok && (
                <div
                  role="alert"
                  className="mt-3 rounded-[14px] border border-postmark/30 bg-paper p-3.5 text-[12.5px] text-postmark"
                >
                  <div className="font-medium">
                    {jsonParsed.error.line !== null
                      ? `第 ${jsonParsed.error.line} 行${jsonParsed.error.column !== null ? `，第 ${jsonParsed.error.column} 列` : ''}：`
                      : ''}
                    {jsonParsed.error.message}
                  </div>
                  {jsonParsed.error.snippet !== null && (
                    <pre className="tabular-nums-mono mt-2 mb-0 overflow-x-auto rounded-[10px] bg-surface px-3 py-2 text-[12px] text-ink">
                      {jsonParsed.error.snippet}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="min-w-0 rounded-[20px] border border-hairline bg-surface p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">基准 JSON（左侧）</span>
                    <button
                      type="button"
                      onClick={() => {
                        const r = parseJsonWithDiagnostics(diffLeft);
                        if (r.ok) setDiffLeft(JSON.stringify(r.value, null, 2));
                      }}
                      className="text-[12px] text-accent hover:underline"
                    >
                      格式化
                    </button>
                  </div>
                  <textarea
                    aria-label="基准 JSON"
                    value={diffLeft}
                    onChange={(e) => setDiffLeft(e.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink outline-none focus:border-accent"
                  />
                  {jsonDiffResult.leftError && (
                    <p role="alert" className="mt-2 mb-0 text-[12px] text-postmark">
                      左侧错误：{jsonDiffResult.leftError.message}
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-[20px] border border-hairline bg-surface p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">目标 JSON（右侧）</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          const r = parseJsonWithDiagnostics(diffRight);
                          if (r.ok) setDiffRight(JSON.stringify(r.value, null, 2));
                        }}
                        className="text-[12px] text-accent hover:underline"
                      >
                        格式化
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDiffLeft(DEFAULT_DIFF_LEFT);
                          setDiffRight(DEFAULT_DIFF_RIGHT);
                        }}
                        className="text-[12px] text-ink-muted hover:text-ink"
                      >
                        重置示例
                      </button>
                    </div>
                  </div>
                  <textarea
                    aria-label="目标 JSON"
                    value={diffRight}
                    onChange={(e) => setDiffRight(e.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink outline-none focus:border-accent"
                  />
                  {jsonDiffResult.rightError && (
                    <p role="alert" className="mt-2 mb-0 text-[12px] text-postmark">
                      右侧错误：{jsonDiffResult.rightError.message}
                    </p>
                  )}
                </div>
              </div>

              {/* Structural Diff Summary */}
              {!jsonDiffResult.leftError && !jsonDiffResult.rightError && (
                <section className="rounded-[20px] border border-hairline bg-paper p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3">
                    <h3 className="m-0 text-[14px] font-medium text-ink">结构差异清单</h3>
                    <div className="tabular-nums-mono flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-accent">
                        +{jsonDiffResult.entries.filter((e) => e.kind === 'added').length} 新增
                      </span>
                      <span className="rounded-full border border-postmark/30 bg-postmark/10 px-2.5 py-0.5 text-postmark">
                        -{jsonDiffResult.entries.filter((e) => e.kind === 'removed').length} 删除
                      </span>
                      <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-ink-muted">
                        ~{jsonDiffResult.entries.filter((e) => e.kind === 'changed').length} 变更
                      </span>
                    </div>
                  </div>

                  {jsonDiffResult.entries.length === 0 ? (
                    <p className="mt-3 mb-0 text-[13.5px] text-ink-muted">
                      两侧 JSON 语义结构与字段值完全一致。
                    </p>
                  ) : (
                    <ul className="mt-3 mb-0 max-h-[360px] list-none space-y-2 overflow-y-auto p-0 pr-1">
                      {jsonDiffResult.entries.map((entry, idx) => (
                        <li
                          key={`${entry.path}-${idx}`}
                          className="rounded-[12px] border border-hairline bg-surface px-3.5 py-2.5 text-[12.5px]"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={[
                                'tabular-nums-mono rounded-full px-2 py-0.5 text-[11px] font-medium',
                                entry.kind === 'added'
                                  ? 'bg-accent/15 text-accent'
                                  : entry.kind === 'removed'
                                    ? 'bg-postmark/15 text-postmark'
                                    : 'bg-paper text-ink',
                              ].join(' ')}
                            >
                              {entry.kind === 'added' ? '新增' : entry.kind === 'removed' ? '删除' : '变更'}
                            </span>
                            <code className="tabular-nums-mono break-all font-medium text-ink">
                              {entry.path}
                            </code>
                          </div>
                          <div className="tabular-nums-mono mt-1.5 space-y-1 text-[12px]">
                            {entry.before !== undefined && (
                              <div className="break-all text-postmark">- {entry.before}</div>
                            )}
                            {entry.after !== undefined && (
                              <div className="break-all text-accent">+ {entry.after}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 2: JWT ==================== */}
      {activeTab === 'jwt' && (
        <div className="space-y-4">
          <div className="rounded-[24px] border border-hairline bg-surface p-4 sm:p-5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="dev-jwt-input" className="text-[13.5px] font-medium text-ink">
                粘贴 JWT 令牌
              </label>
              <div className="flex items-center gap-3 text-[12px]">
                <button
                  type="button"
                  onClick={() => setJwtInput(buildSampleJwt())}
                  className="text-accent hover:underline"
                >
                  载入示例令牌
                </button>
                <button
                  type="button"
                  onClick={() => setJwtInput('')}
                  className="text-ink-muted hover:text-ink"
                >
                  清空
                </button>
              </div>
            </div>

            <textarea
              id="dev-jwt-input"
              value={jwtInput}
              onChange={(e) => setJwtInput(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"
              className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[12.5px] leading-relaxed break-all text-ink outline-none focus:border-accent"
            />
            <p className="mt-2.5 mb-0 text-[12px] text-ink-muted">
              完全在本地浏览器完成 Base64URL 解码，不会发起任何网络请求，也不验证服务端签名密钥。
            </p>
          </div>

          {jwtParsed && !jwtParsed.ok && (
            <p
              role="alert"
              className="m-0 rounded-[16px] border border-postmark/30 bg-paper px-4 py-3 text-[13px] text-postmark"
            >
              {jwtParsed.error}
            </p>
          )}

          {jwtParsed && jwtParsed.ok && jwtTiming && (
            <div className="space-y-4">
              {/* Status & Timestamps Strip */}
              <div className="rounded-[20px] border border-hairline bg-paper p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={[
                        'tabular-nums-mono inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium',
                        jwtTiming.status === 'valid'
                          ? 'border-accent/35 bg-accent/10 text-accent'
                          : jwtTiming.status === 'expired'
                            ? 'border-postmark/35 bg-postmark/10 text-postmark'
                            : 'border-hairline bg-surface text-ink-muted',
                      ].join(' ')}
                    >
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{jwtTiming.statusText}</span>
                    </span>
                    {typeof jwtParsed.header.alg === 'string' && (
                      <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink">
                        alg: {jwtParsed.header.alg}
                      </span>
                    )}
                    {typeof jwtParsed.header.typ === 'string' && (
                      <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
                        typ: {jwtParsed.header.typ}
                      </span>
                    )}
                  </div>
                </div>

                {(jwtTiming.iat !== null || jwtTiming.nbf !== null || jwtTiming.exp !== null) && (
                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {[
                      { key: 'iat', label: '签发时间 (iat)', val: jwtTiming.iat },
                      { key: 'nbf', label: '生效时间 (nbf)', val: jwtTiming.nbf },
                      { key: 'exp', label: '过期时间 (exp)', val: jwtTiming.exp },
                    ].map((row) => (
                      <div
                        key={row.key}
                        className="rounded-[14px] border border-hairline bg-surface px-3.5 py-2.5"
                      >
                        <div className="text-[11.5px] text-ink-muted">{row.label}</div>
                        {row.val !== null ? (
                          <>
                            <div className="tabular-nums-mono mt-1 text-[12.5px] font-medium text-ink">
                              {formatShanghaiTime(new Date(row.val * 1000))}
                            </div>
                            <div className="tabular-nums-mono mt-0.5 text-[11.5px] text-ink-muted">
                              Unix {row.val}
                            </div>
                          </>
                        ) : (
                          <div className="mt-1 text-[12.5px] text-ink-muted">未声明</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Header & Payload JSON panes */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="min-w-0 rounded-[20px] border border-hairline bg-surface p-4">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-ink">Header（标头）</span>
                    {renderCopyButton('jwt-header', jwtParsed.headerJson)}
                  </div>
                  <pre className="tabular-nums-mono m-0 max-h-[300px] overflow-auto rounded-[14px] border border-hairline bg-paper p-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                    {jwtParsed.headerJson}
                  </pre>
                </div>

                <div className="min-w-0 rounded-[20px] border border-hairline bg-surface p-4">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-ink">Payload（载荷）</span>
                    {renderCopyButton('jwt-payload', jwtParsed.payloadJson)}
                  </div>
                  <pre className="tabular-nums-mono m-0 max-h-[300px] overflow-auto rounded-[14px] border border-hairline bg-paper p-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                    {jwtParsed.payloadJson}
                  </pre>
                </div>
              </div>

              <div className="rounded-[18px] border border-hairline bg-surface px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-ink-muted">
                    Signature（原始签名段{jwtParsed.signatureBytes > 0 ? ` · ${jwtParsed.signatureBytes} B` : ''}）
                  </span>
                  {renderCopyButton('jwt-sig', jwtParsed.signature, '复制签名')}
                </div>
                <div className="tabular-nums-mono mt-1.5 break-all text-[12px] text-ink-muted">
                  {jwtParsed.signature}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 3: TIME & ENCODING ==================== */}
      {activeTab === 'time' && (
        <div className="space-y-5">
          {/* Live Clock Strip */}
          <section className="rounded-[24px] border border-hairline bg-paper p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-[14px] font-medium text-ink">实时系统时钟</h3>
              <button
                type="button"
                onClick={() => setClockPaused((p) => !p)}
                className="inline-flex min-h-[30px] items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink transition-colors hover:bg-surface-hover"
              >
                {clockPaused ? (
                  <>
                    <Play className="h-3 w-3" aria-hidden="true" />
                    <span>继续走时</span>
                  </>
                ) : (
                  <>
                    <Pause className="h-3 w-3" aria-hidden="true" />
                    <span>暂停读数</span>
                  </>
                )}
              </button>
            </div>

            <div className="mt-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { key: 'clock-sec', label: 'Unix 秒 (10 位)', value: nowSecStr },
                { key: 'clock-ms', label: 'Unix 毫秒 (13 位)', value: nowMsStr },
                { key: 'clock-iso', label: 'ISO-8601 (UTC)', value: nowIsoStr },
                { key: 'clock-sh', label: '北京时间 (Asia/Shanghai)', value: nowShanghaiStr },
              ].map((item) => (
                <div
                  key={item.key}
                  className="flex flex-col justify-between gap-2 rounded-[16px] border border-hairline bg-surface px-3.5 py-3"
                >
                  <div>
                    <div className="text-[11.5px] text-ink-muted">{item.label}</div>
                    <div className="tabular-nums-mono mt-1 break-all text-[13.5px] font-medium text-ink">
                      {item.value}
                    </div>
                  </div>
                  <div className="flex justify-end">{renderCopyButton(item.key, item.value)}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Bidirectional Unix <-> Date */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-[20px] border border-hairline bg-surface p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="dev-unix-input" className="text-[13.5px] font-medium text-ink">
                  Unix 时间戳转日期
                </label>
                <div className="flex items-center gap-1.5">
                  {(['auto', 'sec', 'ms'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setUnixUnit(u)}
                      className={[
                        'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
                        unixUnit === u
                          ? 'border-accent/40 bg-accent/10 text-accent'
                          : 'border-hairline bg-paper text-ink-muted',
                      ].join(' ')}
                    >
                      {u === 'auto' ? '自动' : u === 'sec' ? '秒' : '毫秒'}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setUnixInput(String(Math.floor(Date.now() / 1000)))}
                    className="ml-1 text-[12px] text-accent hover:underline"
                  >
                    当前
                  </button>
                </div>
              </div>

              <input
                id="dev-unix-input"
                type="text"
                value={unixInput}
                onChange={(e) => setUnixInput(e.target.value)}
                placeholder="例如 1760000000 或 1760000000000"
                className="tabular-nums-mono mt-3 block w-full rounded-[12px] border border-hairline bg-paper px-3.5 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
              />

              {unixParsed && !unixParsed.ok && (
                <p role="alert" className="mt-2.5 mb-0 text-[12.5px] text-postmark">
                  {unixParsed.error}
                </p>
              )}
              {unixParsed && unixParsed.ok && (
                <dl className="tabular-nums-mono mt-3 mb-0 space-y-2 rounded-[14px] border border-hairline bg-paper p-3 text-[12.5px]">
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-ink-muted">识别单位</dt>
                    <dd className="m-0 text-ink">{unixParsed.unitDetected} · {unixParsed.relative}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-ink-muted">Asia/Shanghai</dt>
                    <dd className="m-0 text-ink">{unixParsed.shanghai}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-ink-muted">ISO-8601</dt>
                    <dd className="m-0 break-all text-ink">{unixParsed.iso}</dd>
                  </div>
                </dl>
              )}
            </div>

            <div className="rounded-[20px] border border-hairline bg-surface p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="dev-date-input" className="text-[13.5px] font-medium text-ink">
                  日期时间转 Unix 时间戳
                </label>
                <button
                  type="button"
                  onClick={() => setDateInput(formatDateTimeLocalInput(new Date()))}
                  className="text-[12px] text-accent hover:underline"
                >
                  设为此刻
                </button>
              </div>

              <input
                id="dev-date-input"
                type="datetime-local"
                step={1}
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                className="tabular-nums-mono mt-3 block w-full rounded-[12px] border border-hairline bg-paper px-3.5 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
              />

              {dateParsed && !dateParsed.ok && (
                <p role="alert" className="mt-2.5 mb-0 text-[12.5px] text-postmark">
                  {dateParsed.error}
                </p>
              )}
              {dateParsed && dateParsed.ok && (
                <dl className="tabular-nums-mono mt-3 mb-0 space-y-2 rounded-[14px] border border-hairline bg-paper p-3 text-[12.5px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-ink-muted">Unix 秒</dt>
                    <dd className="m-0 flex items-center gap-2 text-ink">
                      <span>{dateParsed.sec}</span>
                      {renderCopyButton('date-sec', dateParsed.sec)}
                    </dd>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-ink-muted">Unix 毫秒</dt>
                    <dd className="m-0 flex items-center gap-2 text-ink">
                      <span>{dateParsed.ms}</span>
                      {renderCopyButton('date-ms', dateParsed.ms)}
                    </dd>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <dt className="text-ink-muted">ISO-8601</dt>
                    <dd className="m-0 break-all text-ink">{dateParsed.iso}</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>

          {/* UTF-8 Safe Encoding Converter */}
          <section className="rounded-[24px] border border-hairline bg-surface p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex flex-wrap rounded-full border border-hairline bg-paper p-1">
                {(
                  [
                    { id: 'base64', label: 'Base64 (UTF-8)' },
                    { id: 'url', label: 'URL 编解码' },
                    { id: 'hex', label: 'Hex 十六进制' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={encodingKind === item.id}
                    onClick={() => handleSwitchEncodingKind(item.id)}
                    className={[
                      'min-h-[32px] rounded-full px-3.5 text-[12.5px] transition-colors',
                      encodingKind === item.id
                        ? 'bg-cta-bg font-medium text-cta-text'
                        : 'text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {encodingKind === 'hex' && (
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted">
                  <input
                    type="checkbox"
                    checked={hexSpaced}
                    onChange={(e) => {
                      const nextSpaced = e.target.checked;
                      setHexSpaced(nextSpaced);
                      runEncode(encodePlain, 'hex', nextSpaced);
                    }}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <span>字节间以空格分隔</span>
                </label>
              )}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label htmlFor="dev-encode-plain" className="text-[13px] font-medium text-ink">
                    原文（UTF-8）
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => runEncode(encodePlain, encodingKind, hexSpaced)}
                      className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-3 text-[12px] font-medium text-accent"
                    >
                      <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                      <span>编码 →</span>
                    </button>
                    {renderCopyButton('enc-plain', encodePlain)}
                  </div>
                </div>
                <textarea
                  id="dev-encode-plain"
                  value={encodePlain}
                  onChange={(e) => {
                    const next = e.target.value;
                    setEncodePlain(next);
                    runEncode(next, encodingKind, hexSpaced);
                  }}
                  rows={5}
                  spellCheck={false}
                  className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent"
                />
              </div>

              <div className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label htmlFor="dev-encode-coded" className="text-[13px] font-medium text-ink">
                    编码结果
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => runDecode(encodeCoded, encodingKind)}
                      className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-hairline bg-paper px-3 text-[12px] text-ink hover:border-hairline-strong"
                    >
                      <span>← 解码</span>
                    </button>
                    {renderCopyButton('enc-coded', encodeCoded)}
                  </div>
                </div>
                <textarea
                  id="dev-encode-coded"
                  value={encodeCoded}
                  onChange={(e) => {
                    const next = e.target.value;
                    setEncodeCoded(next);
                    runDecode(next, encodingKind);
                  }}
                  rows={5}
                  spellCheck={false}
                  className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed break-all text-ink outline-none focus:border-accent"
                />
              </div>
            </div>

            {encodeError && (
              <p role="alert" className="mt-3 mb-0 text-[12.5px] text-postmark">
                {encodeError}
              </p>
            )}
          </section>
        </div>
      )}

      {/* ==================== TAB 4: REGEX ==================== */}
      {activeTab === 'regex' && (
        <div className="space-y-4">
          <div className="rounded-[24px] border border-hairline bg-surface p-4 sm:p-5">
            {/* Pattern + Flags Row */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center rounded-[14px] border border-hairline bg-paper px-3 transition-colors focus-within:border-accent">
                <span className="tabular-nums-mono select-none text-[15px] text-ink-muted">/</span>
                <input
                  type="text"
                  aria-label="正则表达式模式"
                  value={regexPattern}
                  onChange={(e) => setRegexPattern(e.target.value)}
                  spellCheck={false}
                  placeholder="输入正则表达式，例如 (\d{4})-(\d{2})-(\d{2})"
                  className="tabular-nums-mono min-w-0 flex-1 bg-transparent px-2 py-2.5 text-[13.5px] text-ink outline-none"
                />
                <span className="tabular-nums-mono select-none text-[15px] text-ink-muted">
                  /{regexFlags}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="正则修饰符">
                {REGEX_FLAGS.map((item) => {
                  const active = regexFlags.includes(item.flag);
                  return (
                    <button
                      key={item.flag}
                      type="button"
                      title={item.title}
                      aria-pressed={active}
                      onClick={() => toggleRegexFlag(item.flag)}
                      className={[
                        'tabular-nums-mono h-9 w-9 rounded-full border text-[13px] font-medium transition-colors',
                        active
                          ? 'border-transparent bg-cta-bg text-cta-text'
                          : 'border-hairline bg-paper text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      {item.flag}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Quick Presets */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-ink-muted">常用预设：</span>
              {REGEX_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setRegexPattern(preset.pattern);
                    setRegexFlags(preset.flags);
                    setRegexText(preset.sample);
                  }}
                  className="rounded-full border border-hairline bg-paper px-3 py-1 text-[12px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {!regexEvaluation.ok && (
              <p
                role="alert"
                className="mt-3 mb-0 flex items-center gap-2 rounded-[14px] border border-postmark/30 bg-paper px-3.5 py-2.5 text-[12.5px] text-postmark"
              >
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>无效正则表达式：{regexEvaluation.error}</span>
              </p>
            )}

            {/* Test Input + Highlighted Output */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="dev-regex-text" className="mb-2 block text-[13px] font-medium text-ink">
                  测试文本
                </label>
                <textarea
                  id="dev-regex-text"
                  value={regexText}
                  onChange={(e) => setRegexText(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent"
                />
              </div>

              <div className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-ink">实时命中高亮</span>
                  {regexEvaluation.ok && (
                    <span className="tabular-nums-mono text-[12px] text-accent">
                      共 {regexEvaluation.matches.length} 处匹配
                      {regexEvaluation.truncated ? '（已达 300 处上限）' : ''}
                    </span>
                  )}
                </div>
                <div
                  aria-label="正则高亮预览"
                  className="tabular-nums-mono min-h-[154px] max-h-[260px] overflow-auto rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink"
                >
                  {regexEvaluation.ok ? (
                    regexEvaluation.segments.length > 0 ? (
                      regexEvaluation.segments.map((seg, i) =>
                        seg.matched ? (
                          <mark
                            key={i}
                            className="rounded-[4px] bg-accent/20 px-0.5 text-ink ring-1 ring-accent/45"
                          >
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                      )
                    ) : (
                      <span className="text-ink-muted">输入测试文本以实时查看命中范围……</span>
                    )
                  ) : (
                    <span className="text-ink-muted">修正正则表达式语法后显示命中结果。</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Structured Match & Capture Group Table */}
          {regexEvaluation.ok && (
            <section className="rounded-[20px] border border-hairline bg-paper p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 border-b border-hairline pb-3">
                <h3 className="m-0 text-[14px] font-medium text-ink">匹配明细与捕获组</h3>
                <span className="tabular-nums-mono text-[12px] text-ink-muted">
                  {regexEvaluation.matches.length} 条记录
                </span>
              </div>

              {regexEvaluation.matches.length === 0 ? (
                <p className="mt-3 mb-0 text-[13px] text-ink-muted">当前测试文本中没有匹配项。</p>
              ) : (
                <ul className="mt-3 mb-0 max-h-[340px] list-none space-y-2 overflow-y-auto p-0 pr-1">
                  {regexEvaluation.matches.map((m, idx) => (
                    <li
                      key={`${m.index}-${idx}`}
                      className="rounded-[14px] border border-hairline bg-surface px-3.5 py-2.5 text-[12.5px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="tabular-nums-mono rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-accent">
                            #{idx + 1}
                          </span>
                          <code className="tabular-nums-mono break-all font-medium text-ink">
                            {m.full === '' ? '(空串匹配)' : m.full}
                          </code>
                        </div>
                        <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                          位置 [{m.index}, {m.end})
                        </span>
                      </div>

                      {m.captures.length > 0 && (
                        <div className="tabular-nums-mono mt-2 flex flex-wrap gap-2 text-[11.5px]">
                          {m.captures.map((cap, cIdx) => (
                            <span
                              key={cIdx}
                              className="rounded-[8px] border border-hairline bg-paper px-2 py-0.5 text-ink"
                            >
                              <span className="text-ink-muted">${cIdx + 1}:</span>{' '}
                              {cap ?? 'undefined'}
                            </span>
                          ))}
                        </div>
                      )}

                      {m.named && Object.keys(m.named).length > 0 && (
                        <div className="tabular-nums-mono mt-1.5 flex flex-wrap gap-2 text-[11.5px]">
                          {Object.entries(m.named).map(([name, val]) => (
                            <span
                              key={name}
                              className="rounded-[8px] border border-accent/25 bg-accent/10 px-2 py-0.5 text-ink"
                            >
                              <span className="text-accent">{name}:</span> {val ?? 'undefined'}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      {/* ==================== TAB 5: FILE HASH ==================== */}
      {activeTab === 'hash' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-[16px] border border-hairline bg-paper px-4 py-3 text-[13px] text-ink-muted">
            <ShieldCheck className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <span>文件仅在本地内存校验，绝不上传 · 基于浏览器原生 Web Crypto API 计算 SHA-256 / SHA-1 / SHA-512</span>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleFileDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={[
              'flex cursor-pointer flex-col items-center justify-center rounded-[24px] border border-dashed px-5 py-9 text-center transition-colors',
              dragActive
                ? 'border-accent bg-accent/5'
                : 'border-hairline-strong bg-surface hover:border-accent/60 hover:bg-surface-hover/50',
            ].join(' ')}
          >
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFilePicked}
              className="hidden"
              aria-label="选择要校验哈希的本地文件"
            />
            <Upload className="h-6 w-6 text-accent" aria-hidden="true" />
            <div className="mt-3 text-[14.5px] font-medium text-ink">
              {hashing ? '正在本地计算摘要…' : '拖放任意本地文件到此处，或点击选择文件'}
            </div>
            <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
              支持安装包、镜像、压缩包、文档或任意二进制文件
            </p>
          </div>

          {hashError && (
            <p
              role="alert"
              className="m-0 rounded-[14px] border border-postmark/30 bg-paper px-4 py-3 text-[13px] text-postmark"
            >
              {hashError}
            </p>
          )}

          {hashFileInfo && (
            <section className="rounded-[24px] border border-hairline bg-paper p-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline pb-4">
                <div className="min-w-0">
                  <h3 className="m-0 break-all text-[15.5px] font-medium text-ink">
                    {hashFileInfo.name}
                  </h3>
                  <div className="tabular-nums-mono mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted">
                    <span>
                      {formatFileSize(hashFileInfo.size)} ({hashFileInfo.size.toLocaleString('en-US')} B)
                    </span>
                    <span>{hashFileInfo.type}</span>
                    <span>本地耗时 {hashFileInfo.elapsedMs} ms</span>
                  </div>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted">
                  <input
                    type="checkbox"
                    checked={hashUppercase}
                    onChange={(e) => setHashUppercase(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <span>大写 HEX</span>
                </label>
              </div>

              <div className="mt-4 space-y-3">
                {(
                  [
                    { label: 'SHA-256', value: hashFileInfo.sha256 },
                    { label: 'SHA-1', value: hashFileInfo.sha1 },
                    { label: 'SHA-512', value: hashFileInfo.sha512 },
                  ] as const
                ).map((item) => {
                  const formatted = hashUppercase ? item.value.toUpperCase() : item.value;
                  return (
                    <div
                      key={item.label}
                      className="rounded-[14px] border border-hairline bg-surface p-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="tabular-nums-mono text-[12px] font-medium text-ink-muted">
                          {item.label}
                        </span>
                        {renderCopyButton(`hash-${item.label}`, formatted)}
                      </div>
                      <div className="tabular-nums-mono mt-1.5 select-all break-all text-[12.5px] leading-relaxed text-ink">
                        {formatted}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Expected Digest Comparison */}
          <div className="rounded-[20px] border border-hairline bg-surface p-4 sm:p-5">
            <label htmlFor="dev-expected-hash" className="block text-[13.5px] font-medium text-ink">
              期望摘要比对
            </label>
            <input
              id="dev-expected-hash"
              type="text"
              value={expectedHash}
              onChange={(e) => setExpectedHash(e.target.value)}
              spellCheck={false}
              placeholder="粘贴发布页提供的 SHA-256 / SHA-1 / SHA-512 摘要（自动忽略空格与大小写）"
              className="tabular-nums-mono mt-2.5 block w-full rounded-[12px] border border-hairline bg-paper px-3.5 py-2.5 text-[12.5px] text-ink outline-none focus:border-accent"
            />

            {expectedHash.trim() && !hashFileInfo && (
              <p className="mt-2.5 mb-0 text-[12.5px] text-ink-muted">
                请先拖放或选择本地文件，将自动与该期望摘要完成比对。
              </p>
            )}

            {expectedHashVerdict && (
              <div
                role="status"
                className={[
                  'mt-3 flex items-center gap-2 rounded-[14px] border px-4 py-2.5 text-[13px] font-medium',
                  expectedHashVerdict.match
                    ? 'border-accent/35 bg-accent/10 text-accent'
                    : 'border-postmark/35 bg-postmark/10 text-postmark',
                ].join(' ')}
              >
                {expectedHashVerdict.match ? (
                  <>
                    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>校验通过 · 与本地计算的 {expectedHashVerdict.algo} 摘要完全一致</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>校验不匹配 · 与 SHA-256 / SHA-1 / SHA-512 均不一致，请检查文件是否完整</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
