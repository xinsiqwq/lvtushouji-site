export const ARENA_ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function sanitizeArenaPlayerName(raw: unknown, fallback = '火星特勤'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16);
  return cleaned || fallback;
}

export function sanitizeRoomName(raw: unknown, fallback = '沙暴行动房间'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 24);
  return cleaned || fallback;
}

export function isValidRoomCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code);
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return isValidRoomCode(cleaned) ? cleaned : null;
}

export function generateRoomCode(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 6; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ARENA_ROOM_CODE_ALPHABET[bytes[i] % ARENA_ROOM_CODE_ALPHABET.length];
  }
  return code;
}
