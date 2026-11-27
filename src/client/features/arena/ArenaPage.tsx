import { useEffect, useRef, useState } from 'react';
import { useRouter } from '../../lib/router';

type SandstormMessage =
  | { type: 'sandstorm:navigate'; to?: unknown }
  | { type: 'sandstorm:room'; code?: unknown };

const ALLOWED_MODES = new Set(['comp', 'tdm', 'range']);
const ALLOWED_MAPS = new Set(['dust', 'frost', 'harbor']);

function normalizeRoomCode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function buildSandstormSrc(search: string): string {
  const incoming = new URLSearchParams(search);
  const forwarded = new URLSearchParams();

  const rawMode = (incoming.get('mode') || '').trim().toLowerCase();
  const rawMap = (incoming.get('map') || '').trim().toLowerCase();
  const room = normalizeRoomCode(incoming.get('room'));
  const rawAutostart = (incoming.get('autostart') || '').trim().toLowerCase();
  const rawTest = (incoming.get('test') || '').trim().toLowerCase();

  if (ALLOWED_MODES.has(rawMode)) {
    forwarded.set('mode', rawMode);
  } else if (rawMode === 'solo') {
    forwarded.set('mode', 'comp');
    if (room.length !== 6) {
      forwarded.set('autostart', '1');
    }
  }

  if (ALLOWED_MAPS.has(rawMap)) {
    forwarded.set('map', rawMap);
  }

  if (rawAutostart === '1' || rawAutostart === 'true') {
    forwarded.set('autostart', '1');
  }

  if (room.length === 6) {
    forwarded.set('room', room);
  }

  if (rawTest === '1' || rawTest === 'true') {
    forwarded.set('test', '1');
  }

  const query = forwarded.toString();
  return query ? `/sandstorm/index.html?${query}` : '/sandstorm/index.html';
}

function extractRoomCodeFromSearch(search: string): string {
  const code = normalizeRoomCode(new URLSearchParams(search).get('room'));
  return code.length === 6 ? code : '';
}

export default function ArenaPage() {
  const { search, navigate } = useRouter();

  // Freeze initial iframe URL so sandstorm:room history.replaceState updates never reload WebGL
  const [iframeSrc] = useState<string>(() => buildSandstormSrc(search));
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastSyncedRoomRef = useRef<string>(extractRoomCodeFromSearch(search));

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || typeof event.data !== 'object') return;

      const payload = event.data as SandstormMessage;

      if (payload.type === 'sandstorm:navigate') {
        const target = typeof payload.to === 'string' ? payload.to.trim() : '';
        if (target.startsWith('/') && !target.startsWith('//')) {
          navigate(target);
        }
        return;
      }

      if (payload.type === 'sandstorm:room') {
        const code = normalizeRoomCode(typeof payload.code === 'string' ? payload.code : '');
        const normalized = code.length === 6 ? code : '';
        lastSyncedRoomRef.current = normalized;
        const nextUrl =
          normalized.length === 6 ? `/arcade/arena?room=${encodeURIComponent(normalized)}` : '/arcade/arena';
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (nextUrl !== currentUrl) {
          window.history.replaceState(null, '', nextUrl);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate]);

  useEffect(() => {
    const nextCode = extractRoomCodeFromSearch(search);
    if (nextCode === lastSyncedRoomRef.current) return;
    lastSyncedRoomRef.current = nextCode;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'sandstorm:sync-room', code: nextCode || null },
      window.location.origin,
    );
  }, [search]);

  return (
    <div
      data-only-dark="true"
      className="relative h-[calc(100dvh_-_var(--nav-height))] w-full overflow-hidden bg-[#0b0c0e]"
    >
      <h1 tabIndex={-1} className="sr-only">
        沙暴行动 · SANDSTORM 3D 战术射击
      </h1>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title="沙暴行动 · SANDSTORM 3D 战术射击"
        allow="fullscreen; autoplay"
        className="block h-full w-full border-0"
      />
    </div>
  );
}
