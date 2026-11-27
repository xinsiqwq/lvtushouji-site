import { env, SELF } from 'cloudflare:test';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import { withCostLimits } from '../../src/server/middleware/cost-limits';
import type { AppBindings } from '../../src/server/types';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loginAsAdmin() {
  const res = await SELF.fetch('http://127.0.0.1:5173/api/security/auth', {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'admin-backup-password-123' }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers
    .getSetCookie()
    .filter((c: string) => !c.includes('Max-Age=0'))
    .map((c: string) => c.split(';')[0])
    .join('; ');
  const json = (await res.json()) as { csrfToken: string };
  return { cookies, csrfToken: json.csrfToken };
}

describe('GET /api/admin/backup', () => {
  beforeEach(async () => {
    await resetTestDatabase(env.DB);
  });

  it('exports cloudflare-1 ZIP covering Atlas + Vault D1/R2 data with SHA-256 manifest and excludes secrets/sessions', async () => {
    const auth = await loginAsAdmin();
    const limited = withCostLimits(env as unknown as AppBindings);

    const thumbBytes = new TextEncoder().encode('thumb-webp-data');
    const previewBytes = new TextEncoder().encode('preview-webp-data');
    const origBytes = new TextEncoder().encode('original-jpg-data');
    const vaultPart0 = new Uint8Array([1, 2, 3, 4, 5]);
    const vaultPart1 = new Uint8Array([6, 7, 8]);

    await limited.MEDIA.put('atlas/m1/thumb-600.webp', thumbBytes);
    await limited.MEDIA.put('atlas/m1/preview-1600.webp', previewBytes);
    await limited.MEDIA.put('atlas/m1/original.jpg', origBytes);
    await limited.MEDIA.put('vault/vf1/part-0', vaultPart0);
    await limited.MEDIA.put('vault/vf1/part-1', vaultPart1);

    await env.DB.batch([
      env.DB.prepare('INSERT INTO journeys (id,data) VALUES (?,?)').bind(
        'j1',
        JSON.stringify({
          id: 'j1',
          title: '川西秋色',
          subtitle: '稻城亚丁',
          startDate: '2026-10-01',
          endDate: '2026-10-05',
          visibility: 'public',
          coverId: 'm1',
          stops: [],
          createdAt: '2026-10-05T12:00:00Z',
        }),
      ),
      env.DB.prepare(
        'INSERT INTO media (id,data,original,thumbnail,preview,hash) VALUES (?,?,?,?,?,?)',
      ).bind(
        'm1',
        JSON.stringify({ id: 'm1', name: 'm1.jpg', size: origBytes.byteLength }),
        'atlas/m1/original.jpg',
        'atlas/m1/thumb-600.webp',
        'atlas/m1/preview-1600.webp',
        'hash-m1',
      ),
      env.DB.prepare(
        'INSERT INTO vault_files (id,name,mime,size,sha256,r2_key,chunk_count,visibility,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(
        'vf1',
        'archive.zip',
        'application/zip',
        8,
        'sha-vf1',
        'vault/vf1/part-0',
        2,
        'shared',
        '2026-11-20T00:00:00Z',
      ),
      env.DB.prepare(
        'INSERT INTO vault_shares (id,file_id,passcode_hash,passcode_salt,passcode_lookup,note,max_downloads,downloads,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        'vs1',
        'vf1',
        'phash',
        'psalt',
        'plookup',
        '小心保管',
        3,
        0,
        '2026-12-01T00:00:00Z',
        '2026-11-20T00:00:00Z',
      ),
    ]);

    const res = await SELF.fetch('http://127.0.0.1:5173/api/admin/backup', {
      headers: { cookie: auth.cookies },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');

    const zipBytes = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(zipBytes);

    expect(files['library.sql']).toBeDefined();
    expect(files['README.txt']).toBeDefined();
    expect(files['manifest.json']).toBeDefined();

    const sqlText = new TextDecoder().decode(files['library.sql']);
    expect(sqlText).toContain('INSERT INTO journeys');
    expect(sqlText).toContain('INSERT INTO media');
    expect(sqlText).toContain('INSERT INTO vault_files');
    expect(sqlText).toContain('INSERT INTO vault_shares');
    expect(sqlText).not.toContain('security_sessions');
    expect(sqlText).not.toContain('usage_limits');
    expect(sqlText).not.toContain((env as unknown as AppBindings).SESSION_SECRET);

    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      version: string;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    expect(manifest.version).toBe('cloudflare-1');

    const expectedObjects: Record<string, Uint8Array> = {
      'media/atlas/m1/thumb-600.webp': thumbBytes,
      'media/atlas/m1/preview-1600.webp': previewBytes,
      'media/atlas/m1/original.jpg': origBytes,
      'media/vault/vf1/part-0': vaultPart0,
      'media/vault/vf1/part-1': vaultPart1,
    };

    for (const [archivePath, expected] of Object.entries(expectedObjects)) {
      expect(files[archivePath]).toEqual(expected);
      const entry = manifest.files.find((f) => f.path === archivePath);
      expect(entry).toEqual({
        path: archivePath,
        size: expected.byteLength,
        sha256: await sha256(expected),
      });
    }
  });
});
