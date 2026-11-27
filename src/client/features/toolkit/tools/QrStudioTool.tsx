import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Contact,
  Copy,
  Download,
  Eye,
  EyeOff,
  ImageDown,
  Link2,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import { createMagneticHandlers } from '../../../lib/pointer-fx';
import {
  QR_MAX_BYTE_CAPACITY,
  qrToStyledSvg,
  renderQrToPngBlob,
  type QrDotStyle,
} from '../../../lib/qr-svg';

type ContentPreset = 'text' | 'wifi' | 'vcard';
type WifiAuthType = 'WPA' | 'WEP' | 'nopass';

type ColorPreset = {
  id: string;
  label: string;
  fg: string;
  bg: string;
};

const COLOR_PRESETS: readonly ColorPreset[] = [
  { id: 'ink', label: '经典墨黑', fg: '#1F1F1F', bg: '#FFFFFF' },
  { id: 'google-blue', label: '谷歌蓝', fg: '#1A73E8', bg: '#FFFFFF' },
  { id: 'postmark', label: '暖赭印泥', fg: '#9A5B42', bg: '#FAF8F4' },
  { id: 'aurora-dark', label: '深夜极光', fg: '#E3E3E3', bg: '#131314' },
];

const DOT_STYLES: readonly { id: QrDotStyle; label: string; desc: string }[] = [
  { id: 'square', label: '经典方格', desc: '锐利像素边缘' },
  { id: 'rounded', label: '柔和圆角', desc: '圆润光学码块' },
  { id: 'dots', label: '光学圆点', desc: '独立圆点阵列' },
];

function escapeWifiField(val: string): string {
  return val.replace(/([\\;,:"])/g, '\\$1');
}

function escapeVcardField(val: string): string {
  return val
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function normalizeHexOrNull(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return `#${cleaned[0]}${cleaned[0]}${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned}`.toUpperCase();
  }
  return null;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const norm = normalizeHexOrNull(hex);
  if (!norm) return null;
  return [
    Number.parseInt(norm.slice(1, 3), 16),
    Number.parseInt(norm.slice(3, 5), 16),
    Number.parseInt(norm.slice(5, 7), 16),
  ];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const linear = rgb.map((ch) => {
    const s = ch / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function computeContrast(fgHex: string, bgHex: string): {
  ratio: number;
  fgLum: number;
  bgLum: number;
} | null {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  if (!fg || !bg) return null;
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return {
    ratio: (lighter + 0.05) / (darker + 0.05),
    fgLum,
    bgLum,
  };
}

function extractSvgPaths(svgMarkup: string): Array<{ d: string; fillRule?: 'evenodd' }> {
  const paths: Array<{ d: string; fillRule?: 'evenodd' }> = [];
  const re = /<path\s+d="([^"]+)"[^>]*?(fill-rule="evenodd")?[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(svgMarkup)) !== null) {
    paths.push({
      d: match[1]!,
      fillRule: match[2] ? 'evenodd' : undefined,
    });
  }
  return paths;
}

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

export default function QrStudioTool() {
  const [preset, setPreset] = useState<ContentPreset>('text');

  // Text / URL state
  const [textValue, setTextValue] = useState(() => {
    if (typeof window !== 'undefined' && window.location.origin) {
      return `${window.location.origin}/toolkit?tool=qr`;
    }
    return 'https://example.org/toolkit';
  });

  // Wi-Fi state
  const [wifiSsid, setWifiSsid] = useState('Studio-Guest-5G');
  const [wifiAuth, setWifiAuth] = useState<WifiAuthType>('WPA');
  const [wifiPassword, setWifiPassword] = useState('');
  const [wifiHidden, setWifiHidden] = useState(false);
  const [showWifiPassword, setShowWifiPassword] = useState(false);

  // vCard state
  const [vcardName, setVcardName] = useState('');
  const [vcardPhone, setVcardPhone] = useState('');
  const [vcardEmail, setVcardEmail] = useState('');
  const [vcardUrl, setVcardUrl] = useState('');
  const [vcardNote, setVcardNote] = useState('');

  // Visual customization state
  const [dotStyle, setDotStyle] = useState<QrDotStyle>('rounded');
  const [fgColor, setFgColor] = useState('#1F1F1F');
  const [bgColor, setBgColor] = useState('#FFFFFF');
  const [fgInput, setFgInput] = useState('#1F1F1F');
  const [bgInput, setBgInput] = useState('#FFFFFF');
  const [quietZone, setQuietZone] = useState(2);

  // Export & copy feedback
  const [exportingPng, setExportingPng] = useState(false);
  const [exportError, setExportError] = useState('');
  const [copiedSvg, setCopiedSvg] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const magneticHandlers = createMagneticHandlers(4);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const payload = useMemo(() => {
    if (preset === 'text') {
      return textValue;
    }
    if (preset === 'wifi') {
      const ssid = escapeWifiField(wifiSsid.trim());
      const parts = [`WIFI:T:${wifiAuth};`, `S:${ssid};`];
      if (wifiAuth !== 'nopass' && wifiPassword) {
        parts.push(`P:${escapeWifiField(wifiPassword)};`);
      }
      if (wifiHidden) {
        parts.push('H:true;');
      }
      parts.push(';');
      return parts.join('');
    }
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    const name = vcardName.trim();
    if (name) {
      lines.push(`FN:${escapeVcardField(name)}`);
      lines.push(`N:${escapeVcardField(name)};;;;`);
    }
    if (vcardPhone.trim()) lines.push(`TEL;TYPE=CELL:${escapeVcardField(vcardPhone.trim())}`);
    if (vcardEmail.trim()) lines.push(`EMAIL:${escapeVcardField(vcardEmail.trim())}`);
    if (vcardUrl.trim()) lines.push(`URL:${escapeVcardField(vcardUrl.trim())}`);
    if (vcardNote.trim()) lines.push(`NOTE:${escapeVcardField(vcardNote.trim())}`);
    lines.push('END:VCARD');
    return lines.join('\n');
  }, [preset, textValue, wifiAuth, wifiHidden, wifiPassword, wifiSsid, vcardEmail, vcardName, vcardNote, vcardPhone, vcardUrl]);

  const payloadBytes = useMemo(() => new TextEncoder().encode(payload).length, [payload]);
  const isPayloadEmpty = payload.trim().length === 0;
  const isOverCapacity = payloadBytes > QR_MAX_BYTE_CAPACITY;

  const qrResult = useMemo(() => {
    if (isPayloadEmpty || isOverCapacity) return null;
    try {
      const styled = qrToStyledSvg(payload, {
        quietZone,
        dotStyle,
        fgColor,
        bgColor,
      });
      return {
        ...styled,
        paths: extractSvgPaths(styled.svgMarkup),
      };
    } catch {
      return null;
    }
  }, [bgColor, dotStyle, fgColor, isOverCapacity, isPayloadEmpty, payload, quietZone]);

  const contrast = useMemo(() => computeContrast(fgColor, bgColor), [fgColor, bgColor]);
  const lowContrast = contrast !== null && contrast.ratio < 4.0;
  const invertedColors = contrast !== null && contrast.fgLum > contrast.bgLum;

  const applyColorPreset = (p: ColorPreset) => {
    setFgColor(p.fg);
    setFgInput(p.fg);
    setBgColor(p.bg);
    setBgInput(p.bg);
  };

  const handleSwapColors = () => {
    setFgColor(bgColor);
    setFgInput(bgColor);
    setBgColor(fgColor);
    setBgInput(fgColor);
  };

  const handleFgTextChange = (val: string) => {
    setFgInput(val);
    const norm = normalizeHexOrNull(val);
    if (norm) setFgColor(norm);
  };

  const handleBgTextChange = (val: string) => {
    setBgInput(val);
    const norm = normalizeHexOrNull(val);
    if (norm) setBgColor(norm);
  };

  const handleDownloadSvg = useCallback(() => {
    if (!qrResult) return;
    setExportError('');
    const blob = new Blob([qrResult.svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qr-${preset}-${dotStyle}.svg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [dotStyle, preset, qrResult]);

  const handleDownloadPng = useCallback(async () => {
    if (!qrResult || exportingPng) return;
    setExportingPng(true);
    setExportError('');
    try {
      const blob = await renderQrToPngBlob(qrResult.svgMarkup, 1024);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `qr-${preset}-${dotStyle}-1024.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出 PNG 失败，请重试。');
    } finally {
      setExportingPng(false);
    }
  }, [dotStyle, exportingPng, preset, qrResult]);

  const handleCopySvg = useCallback(async () => {
    if (!qrResult) return;
    const ok = await copyTextSafe(qrResult.svgMarkup);
    if (!ok) return;
    setCopiedSvg(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedSvg(false), 1800);
  }, [qrResult]);

  return (
    <div className="space-y-5">
      {/* Top mode switcher & local privacy notice */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="二维码内容类型"
          className="inline-flex flex-wrap rounded-full border border-hairline bg-surface p-1"
        >
          {(
            [
              { id: 'text', label: '链接 / 纯文本', icon: <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> },
              { id: 'wifi', label: 'Wi-Fi 一键连网', icon: <Wifi className="h-3.5 w-3.5" aria-hidden="true" /> },
              { id: 'vcard', label: '电子名片 vCard', icon: <Contact className="h-3.5 w-3.5" aria-hidden="true" /> },
            ] as const
          ).map((item) => {
            const active = preset === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPreset(item.id)}
                className={[
                  'inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors',
                  active
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <div className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-muted">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          <span>纯本地离线矢量生成 · 绝不上传内容</span>
        </div>
      </div>

      {/* Main 2-column studio grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)] lg:items-start">
        {/* Left: Content & Style Controls */}
        <div className="min-w-0 space-y-5">
          {/* Content Input Card */}
          <section className="rounded-[24px] border border-hairline bg-surface p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-[14.5px] font-medium text-ink">
                {preset === 'text'
                  ? '链接或文本内容'
                  : preset === 'wifi'
                    ? 'Wi-Fi 无线网络参数'
                    : '电子名片信息 (vCard 3.0)'}
              </h3>
              <span
                className={[
                  'tabular-nums-mono text-[12px]',
                  isOverCapacity ? 'font-medium text-postmark' : 'text-ink-muted',
                ].join(' ')}
              >
                {payloadBytes} / {QR_MAX_BYTE_CAPACITY} B
              </span>
            </div>

            {preset === 'text' && (
              <textarea
                aria-label="二维码文本或链接"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder="输入网址 https://... 或任意纯文本内容"
                className="tabular-nums-mono block w-full resize-y rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent"
              />
            )}

            {preset === 'wifi' && (
              <div className="space-y-3.5">
                <div>
                  <label htmlFor="qr-wifi-ssid" className="mb-1.5 block text-[12.5px] text-ink-muted">
                    网络名称 (SSID)
                  </label>
                  <input
                    id="qr-wifi-ssid"
                    type="text"
                    value={wifiSsid}
                    onChange={(e) => setWifiSsid(e.target.value)}
                    placeholder="输入 Wi-Fi 名称"
                    className="block w-full rounded-[12px] border border-hairline bg-paper px-3.5 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                  />
                </div>

                <div>
                  <div className="mb-1.5 text-[12.5px] text-ink-muted">加密方式</div>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        { id: 'WPA', label: 'WPA / WPA2 / WPA3' },
                        { id: 'WEP', label: 'WEP' },
                        { id: 'nopass', label: '无密码开放网络' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        aria-pressed={wifiAuth === opt.id}
                        onClick={() => setWifiAuth(opt.id)}
                        className={[
                          'min-h-[34px] rounded-full border px-3.5 text-[12.5px] transition-colors',
                          wifiAuth === opt.id
                            ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                            : 'border-hairline bg-paper text-ink-muted hover:text-ink',
                        ].join(' ')}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {wifiAuth !== 'nopass' && (
                  <div>
                    <label htmlFor="qr-wifi-pass" className="mb-1.5 block text-[12.5px] text-ink-muted">
                      无线密码
                    </label>
                    <div className="flex items-center rounded-[12px] border border-hairline bg-paper pr-2 focus-within:border-accent">
                      <input
                        id="qr-wifi-pass"
                        type={showWifiPassword ? 'text' : 'password'}
                        value={wifiPassword}
                        onChange={(e) => setWifiPassword(e.target.value)}
                        placeholder="输入 Wi-Fi 密码（仅在本地生成二维码）"
                        className="tabular-nums-mono min-w-0 flex-1 bg-transparent px-3.5 py-2 text-[13.5px] text-ink outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowWifiPassword((v) => !v)}
                        aria-label={showWifiPassword ? '隐藏密码' : '显示密码'}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-surface-hover hover:text-ink"
                      >
                        {showWifiPassword ? (
                          <EyeOff className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={wifiHidden}
                    onChange={(e) => setWifiHidden(e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span>隐藏 SSID（不广播名称的无线网络）</span>
                </label>
              </div>
            )}

            {preset === 'vcard' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="qr-vc-name" className="mb-1 block text-[12.5px] text-ink-muted">
                    姓名
                  </label>
                  <input
                    id="qr-vc-name"
                    type="text"
                    value={vcardName}
                    onChange={(e) => setVcardName(e.target.value)}
                    placeholder="林野"
                    className="block w-full rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label htmlFor="qr-vc-phone" className="mb-1 block text-[12.5px] text-ink-muted">
                    电话
                  </label>
                  <input
                    id="qr-vc-phone"
                    type="tel"
                    value={vcardPhone}
                    onChange={(e) => setVcardPhone(e.target.value)}
                    placeholder="+86 138 0000 0000"
                    className="tabular-nums-mono block w-full rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label htmlFor="qr-vc-email" className="mb-1 block text-[12.5px] text-ink-muted">
                    电子邮箱
                  </label>
                  <input
                    id="qr-vc-email"
                    type="email"
                    value={vcardEmail}
                    onChange={(e) => setVcardEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="tabular-nums-mono block w-full rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label htmlFor="qr-vc-url" className="mb-1 block text-[12.5px] text-ink-muted">
                    个人主页 / 网址
                  </label>
                  <input
                    id="qr-vc-url"
                    type="url"
                    value={vcardUrl}
                    onChange={(e) => setVcardUrl(e.target.value)}
                    placeholder="https://example.com"
                    className="tabular-nums-mono block w-full rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="qr-vc-note" className="mb-1 block text-[12.5px] text-ink-muted">
                    备注
                  </label>
                  <input
                    id="qr-vc-note"
                    type="text"
                    value={vcardNote}
                    onChange={(e) => setVcardNote(e.target.value)}
                    placeholder="摄影师 · 旅途手记作者"
                    className="block w-full rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent"
                  />
                </div>
              </div>
            )}

            {preset !== 'text' && (
              <details className="mt-4 rounded-[12px] border border-hairline bg-paper/75 px-3.5 py-2.5 text-[12px]">
                <summary className="cursor-pointer select-none text-ink-muted">
                  查看编码载荷原文
                </summary>
                <pre className="tabular-nums-mono mt-2 mb-0 overflow-x-auto whitespace-pre-wrap break-all text-[11.5px] text-ink">
                  {payload}
                </pre>
              </details>
            )}

            {isOverCapacity && (
              <p
                role="alert"
                className="mt-3 mb-0 flex items-center gap-2 rounded-[12px] border border-postmark/30 bg-paper px-3.5 py-2.5 text-[12.5px] text-postmark"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  当前内容占 {payloadBytes} 字节，超出 Version 14 容量上限（{QR_MAX_BYTE_CAPACITY} 字节），请精简文本。
                </span>
              </p>
            )}
          </section>

          {/* Visual Customization Card */}
          <section className="space-y-5 rounded-[24px] border border-hairline bg-surface p-5">
            <h3 className="m-0 text-[14.5px] font-medium text-ink">光学样式与留白</h3>

            {/* Dot style */}
            <div>
              <div className="mb-2 text-[12.5px] text-ink-muted">码点形态</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {DOT_STYLES.map((st) => {
                  const active = dotStyle === st.id;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setDotStyle(st.id)}
                      className={[
                        'rounded-[14px] border px-3.5 py-2.5 text-left transition-colors',
                        active
                          ? 'border-accent bg-accent/10 text-ink'
                          : 'border-hairline bg-paper text-ink-muted hover:border-hairline-strong hover:text-ink',
                      ].join(' ')}
                    >
                      <div className="text-[13px] font-medium text-ink">{st.label}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-muted">{st.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Color presets */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[12.5px] text-ink-muted">色彩预设</span>
                <button
                  type="button"
                  onClick={handleSwapColors}
                  className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
                >
                  <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
                  <span>反转前景/背景</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {COLOR_PRESETS.map((cp) => {
                  const active =
                    fgColor.toUpperCase() === cp.fg.toUpperCase() &&
                    bgColor.toUpperCase() === cp.bg.toUpperCase();
                  return (
                    <button
                      key={cp.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => applyColorPreset(cp)}
                      className={[
                        'inline-flex min-h-[34px] items-center gap-2 rounded-full border px-3 text-[12.5px] transition-colors',
                        active
                          ? 'border-accent bg-paper font-medium text-ink'
                          : 'border-hairline bg-paper text-ink-muted hover:border-hairline-strong hover:text-ink',
                      ].join(' ')}
                    >
                      <span
                        aria-hidden="true"
                        className="inline-flex h-4 w-4 overflow-hidden rounded-full border border-hairline-strong"
                      >
                        <span className="h-full w-1/2" style={{ backgroundColor: cp.fg }} />
                        <span className="h-full w-1/2" style={{ backgroundColor: cp.bg }} />
                      </span>
                      <span>{cp.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom color inputs */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-[14px] border border-hairline bg-paper p-3">
                <label htmlFor="qr-fg-hex" className="mb-1.5 block text-[12px] text-ink-muted">
                  前景色（码点）
                </label>
                <div className="flex items-center gap-2.5">
                  <input
                    type="color"
                    aria-label="选择码点前景色"
                    value={fgColor}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase();
                      setFgColor(next);
                      setFgInput(next);
                    }}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded-[8px] border border-hairline bg-transparent p-0.5"
                  />
                  <input
                    id="qr-fg-hex"
                    type="text"
                    value={fgInput}
                    onChange={(e) => handleFgTextChange(e.target.value)}
                    maxLength={7}
                    className="tabular-nums-mono min-w-0 flex-1 rounded-[10px] border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink uppercase outline-none focus:border-accent"
                  />
                </div>
              </div>

              <div className="rounded-[14px] border border-hairline bg-paper p-3">
                <label htmlFor="qr-bg-hex" className="mb-1.5 block text-[12px] text-ink-muted">
                  背景色（底纸）
                </label>
                <div className="flex items-center gap-2.5">
                  <input
                    type="color"
                    aria-label="选择二维码背景色"
                    value={bgColor}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase();
                      setBgColor(next);
                      setBgInput(next);
                    }}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded-[8px] border border-hairline bg-transparent p-0.5"
                  />
                  <input
                    id="qr-bg-hex"
                    type="text"
                    value={bgInput}
                    onChange={(e) => handleBgTextChange(e.target.value)}
                    maxLength={7}
                    className="tabular-nums-mono min-w-0 flex-1 rounded-[10px] border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink uppercase outline-none focus:border-accent"
                  />
                </div>
              </div>
            </div>

            {/* Quiet zone slider */}
            <div>
              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                <label htmlFor="qr-quiet-zone" className="text-ink-muted">
                  静区留白（Quiet Zone）
                </label>
                <span className="tabular-nums-mono text-ink">{quietZone} 模块</span>
              </div>
              <input
                id="qr-quiet-zone"
                type="range"
                min={1}
                max={6}
                step={1}
                value={quietZone}
                onChange={(e) => setQuietZone(Number.parseInt(e.target.value, 10))}
                className="mt-2 block w-full accent-accent"
              />
            </div>

            {/* Live WCAG contrast meter & scan-safety warning */}
            {contrast && (
              <div
                role={lowContrast ? 'alert' : 'status'}
                className={[
                  'rounded-[16px] border px-4 py-3 text-[12.5px]',
                  lowContrast
                    ? 'border-postmark/40 bg-postmark/10 text-postmark'
                    : 'border-hairline bg-paper text-ink-muted',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    {lowContrast ? (
                      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                    )}
                    <span>
                      {lowContrast ? '扫码安全警告：对比度偏低' : '扫码对比度安全'}
                    </span>
                  </span>
                  <span className="tabular-nums-mono font-medium text-ink">
                    WCAG {contrast.ratio.toFixed(2)} : 1
                  </span>
                </div>

                {lowContrast && (
                  <p className="mt-1.5 mb-0 leading-relaxed">
                    当前前背景亮度对比度低于 4.0 : 1，部分手机相机在暗光或反光环境下可能难以识别，建议拉大明暗反差。
                  </p>
                )}

                {!lowContrast && invertedColors && (
                  <p className="mt-1.5 mb-0 leading-relaxed">
                    当前为浅码深底（反色模式），绝大多数现代手机相机可正常扫码，印制前仍建议实机验证。
                  </p>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Right: Sticky Live Preview & Export Slip */}
        <aside className="min-w-0 rounded-[24px] border border-hairline bg-paper p-5 shadow-sm lg:sticky lg:top-[calc(var(--nav-height)+24px)] sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-[14.5px] font-medium text-ink">实时矢量预览</h3>
            {qrResult && (
              <span className="tabular-nums-mono text-[12px] text-ink-muted">
                {qrResult.dimension} × {qrResult.dimension} 模块
              </span>
            )}
          </div>

          <div className="mt-4 flex min-h-[268px] items-center justify-center rounded-[20px] border border-hairline bg-surface/80 p-5">
            {qrResult ? (
              <div
                className="w-full max-w-[248px] overflow-hidden rounded-[16px] border border-hairline shadow-xs"
                style={{ backgroundColor: bgColor }}
              >
                <svg
                  viewBox={qrResult.viewBox}
                  role="img"
                  aria-label="零联网二维码实时预览"
                  shapeRendering={dotStyle === 'square' ? 'crispEdges' : 'geometricPrecision'}
                  className="block h-auto w-full"
                >
                  <rect width={qrResult.dimension} height={qrResult.dimension} fill={bgColor} />
                  {qrResult.paths.map((p, idx) => (
                    <path
                      key={idx}
                      d={p.d}
                      fill={fgColor}
                      fillRule={p.fillRule}
                    />
                  ))}
                </svg>
              </div>
            ) : (
              <p className="m-0 text-center text-[13px] text-ink-muted">
                {isOverCapacity
                  ? '载荷超出 Version 14 容量上限，精简内容后自动恢复预览。'
                  : '请输入有效内容以实时生成矢量二维码。'}
              </p>
            )}
          </div>

          {/* Export actions */}
          <div className="mt-5 flex flex-col gap-2.5">
            <button
              type="button"
              disabled={!qrResult}
              onClick={handleDownloadSvg}
              {...magneticHandlers}
              className="pill-cta-primary min-h-[42px] w-full text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>导出无损矢量 .svg</span>
            </button>

            <button
              type="button"
              disabled={!qrResult || exportingPng}
              onClick={() => void handleDownloadPng()}
              className="pill-cta-secondary min-h-[42px] w-full text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ImageDown className="h-4 w-4" aria-hidden="true" />
              <span>{exportingPng ? '正在渲染高清位图…' : '导出高清 PNG（1024×1024）'}</span>
            </button>

            <button
              type="button"
              disabled={!qrResult}
              onClick={() => void handleCopySvg()}
              className="inline-flex min-h-[38px] w-full items-center justify-center gap-1.5 rounded-full border border-hairline bg-transparent px-4 text-[13px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-45"
            >
              {copiedSvg ? (
                <>
                  <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>已复制 SVG 代码</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>复制 SVG 源代码</span>
                </>
              )}
            </button>
          </div>

          {exportError && (
            <p role="alert" className="mt-3 mb-0 text-center text-[12.5px] text-postmark">
              {exportError}
            </p>
          )}

          <p className="mt-4 mb-0 text-center text-[12px] text-ink-muted">
            遵循 ISO/IEC 18004（ECC Level L，支持至 Version 14 / 458 B）
          </p>
        </aside>
      </div>
    </div>
  );
}
