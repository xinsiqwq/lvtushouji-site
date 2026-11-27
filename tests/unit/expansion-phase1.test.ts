import { env, SELF } from 'cloudflare:test';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import { withCostLimits } from '../../src/server/middleware/cost-limits';
import type { AppBindings } from '../../src/server/types';
import type { AdminSnapshot, ProjectItem, SiteSettings } from '../../src/shared/types';

const ORIGIN = 'http://127.0.0.1:5173';

async function setupAdmin() {
  const res = await SELF.fetch(`${ORIGIN}/api/security/auth`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'phase1-admin-password-2026' }),
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

function adminHeaders(auth: { cookies: string; csrfToken: string }, withJson = true) {
  return {
    origin: ORIGIN,
    cookie: auth.cookies,
    'x-travel-csrf': auth.csrfToken,
    ...(withJson ? { 'content-type': 'application/json' } : {}),
  };
}

async function clearExpansionTables() {
  await resetTestDatabase(env.DB);
  await env.DB.prepare('DELETE FROM projects').run();
}

describe('Phase 1 expansion backend contracts', () => {
  beforeEach(async () => {
    await clearExpansionTables();
  });

  afterEach(async () => {
    await env.DB.prepare('DELETE FROM projects').run();
  });

  describe('Projects API & auto-seeding', () => {
    it('auto-seeds TrafficObserver and VideoVault V2 once, enforces published filter, and supports admin CRUD', async () => {
      // Unauthed admin route -> 401
      const unauthedAdmin = await SELF.fetch(`${ORIGIN}/api/admin/projects`);
      expect(unauthedAdmin.status).toBe(401);

      // First public GET auto-seeds 2 published records
      const publicRes = await SELF.fetch(`${ORIGIN}/api/projects`);
      expect(publicRes.status).toBe(200);
      const { projects: seeded } = (await publicRes.json()) as { projects: ProjectItem[] };
      expect(seeded).toHaveLength(2);
      expect(seeded.map((p) => p.slug)).toEqual(['traffic-observer', 'videovault-v2']);
      expect(seeded[0]!.version).toBe('1.0.0');
      expect(seeded[1]!.version).toBe('0.7.1');

      const seedFlag = await env.DB.prepare("SELECT data FROM admin_settings WHERE key='projects_seeded'").first<{
        data: string;
      }>();
      expect(seedFlag?.data).toBe('1');

      const auth = await setupAdmin();

      // Create a draft project and a top-sorted published project
      const draftRes = await SELF.fetch(`${ORIGIN}/api/admin/projects`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          slug: 'internal-draft',
          title: '未发布草稿工具',
          subtitle: '草稿副标题',
          summary: '草稿描述',
          category: '实验工具',
          version: '0.1.0',
          status: 'draft',
          stack: ['TypeScript'],
          highlights: ['仅管理员可见'],
          metrics: [{ label: '阶段', value: '开发测试' }],
          links: [{ label: '密匣', href: '/vault', kind: 'vault', vaultCode: 'Ab12Xy' }],
          sortOrder: 0,
        }),
      });
      expect(draftRes.status).toBe(200);
      const { project: draftProject } = (await draftRes.json()) as { project: ProjectItem };
      expect(draftProject.status).toBe('draft');

      // Reject unsafe javascript: href and external coverUrl
      const badHref = await SELF.fetch(`${ORIGIN}/api/admin/projects`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '恶意链接测试',
          status: 'draft',
          links: [{ label: 'XSS', href: 'javascript:alert(1)', kind: 'external' }],
        }),
      });
      expect(badHref.status).toBe(400);

      const badCover = await SELF.fetch(`${ORIGIN}/api/admin/projects`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '外部封面测试',
          status: 'draft',
          coverUrl: 'https://evil.example/a.png',
        }),
      });
      expect(badCover.status).toBe(400);

      // Admin sees all 3 (draft + 2 published), public sees only 2 published
      const adminListRes = await SELF.fetch(`${ORIGIN}/api/admin/projects`, {
        headers: { cookie: auth.cookies },
      });
      expect(adminListRes.status).toBe(200);
      const { projects: adminProjects } = (await adminListRes.json()) as { projects: ProjectItem[] };
      expect(adminProjects).toHaveLength(3);
      expect(adminProjects[0]!.slug).toBe('internal-draft');

      const publicAfterDraft = await SELF.fetch(`${ORIGIN}/api/projects`);
      const { projects: pubProjects } = (await publicAfterDraft.json()) as { projects: ProjectItem[] };
      expect(pubProjects.map((p) => p.slug)).toEqual(['traffic-observer', 'videovault-v2']);

      // Update draft to published with sortOrder = -1 -> moves first in public list
      const promoteRes = await SELF.fetch(`${ORIGIN}/api/admin/projects`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          ...draftProject,
          status: 'published',
          sortOrder: -1,
        }),
      });
      expect(promoteRes.status).toBe(200);

      const publicPromoted = await SELF.fetch(`${ORIGIN}/api/projects`);
      const { projects: promotedList } = (await publicPromoted.json()) as { projects: ProjectItem[] };
      expect(promotedList.map((p) => p.slug)).toEqual([
        'internal-draft',
        'traffic-observer',
        'videovault-v2',
      ]);

      // Delete all 3 projects -> must NOT re-seed because projects_seeded='1'
      for (const item of promotedList) {
        const delRes = await SELF.fetch(`${ORIGIN}/api/admin/projects/${item.id}`, {
          method: 'DELETE',
          headers: adminHeaders(auth, false),
        });
        expect(delRes.status).toBe(200);
        expect(await delRes.json()).toEqual({ ok: true, id: item.id });
      }

      // Deleting non-existent project returns 404
      const missingDel = await SELF.fetch(`${ORIGIN}/api/admin/projects/proj_missing`, {
        method: 'DELETE',
        headers: adminHeaders(auth, false),
      });
      expect(missingDel.status).toBe(404);

      const emptyPublic = await SELF.fetch(`${ORIGIN}/api/projects`);
      expect(((await emptyPublic.json()) as { projects: ProjectItem[] }).projects).toEqual([]);
    });

    it('includes auto-seeded projects in GET /api/admin snapshot and GET /api/admin/backup SQL dump', async () => {
      const auth = await setupAdmin();

      const snapRes = await SELF.fetch(`${ORIGIN}/api/admin`, {
        headers: { cookie: auth.cookies },
      });
      expect(snapRes.status).toBe(200);
      const snapshot = (await snapRes.json()) as AdminSnapshot;
      expect(snapshot.projects).toHaveLength(2);
      expect(snapshot.projects.map((p) => p.slug)).toEqual(['traffic-observer', 'videovault-v2']);

      const backupRes = await SELF.fetch(`${ORIGIN}/api/admin/backup`, {
        headers: { cookie: auth.cookies },
      });
      expect(backupRes.status).toBe(200);
      const files = unzipSync(new Uint8Array(await backupRes.arrayBuffer()));
      const sqlText = new TextDecoder().decode(files['library.sql']);
      expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS projects');
      expect(sqlText).toContain('INSERT INTO projects');
    });
  });

  describe('Admin settings homeShowcase & trash purge', () => {
    it('validates homeShowcase relative paths, max 8 items, and preserves/clears cleanly', async () => {
      const auth = await setupAdmin();

      // Reject external URL
      const extUrlRes = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '旅途手记',
          tagline: '山海之间',
          homeShowcase: [
            {
              id: 'f1',
              src: 'https://cdn.evil.example/photo.jpg',
              alt: 'bad',
              place: '外链',
              coords: '0,0',
              caption: '不应通过',
            },
          ],
        }),
      });
      expect(extUrlRes.status).toBe(400);

      // Reject protocol-relative //evil.com
      const protoRelRes = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '旅途手记',
          tagline: '山海之间',
          homeShowcase: [
            {
              id: 'f1',
              src: '//evil.example/photo.jpg',
              alt: 'bad',
              place: '外链',
              coords: '0,0',
              caption: '不应通过',
            },
          ],
        }),
      });
      expect(protoRelRes.status).toBe(400);

      // Reject > 8 items
      const tooManyRes = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '旅途手记',
          tagline: '山海之间',
          homeShowcase: Array.from({ length: 9 }, (_, i) => ({
            id: `f_${i}`,
            src: `/demo/frame-${i}.webp`,
            alt: `f${i}`,
            place: '海边',
            coords: '30.0°N',
            caption: '测试',
          })),
        }),
      });
      expect(tooManyRes.status).toBe(400);

      // Accept valid internal paths
      const okRes = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '旅途手记',
          tagline: '把山海与夜空收进一册。',
          homeShowcase: [
            {
              id: 'frame_1',
              src: '/api/files/m_home_1?variant=preview',
              alt: '雪山日出',
              place: '稻城亚丁',
              coords: '28.45°N · 100.34°E',
              caption: '清晨第一缕光线落在央迈勇峰顶',
              mediaId: 'm_home_1',
              width: 1600,
              height: 1067,
            },
          ],
        }),
      });
      expect(okRes.status).toBe(200);
      const saved = (await okRes.json()) as SiteSettings;
      expect(saved.homeShowcase).toHaveLength(1);
      expect(saved.homeShowcase![0]!.mediaId).toBe('m_home_1');

      // Patching title/tagline without homeShowcase preserves existing homeShowcase
      const titleOnly = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({ title: '山海手记', tagline: '新的引言' }),
      });
      expect(titleOnly.status).toBe(200);
      const afterTitleOnly = (await titleOnly.json()) as SiteSettings;
      expect(afterTitleOnly.title).toBe('山海手记');
      expect(afterTitleOnly.homeShowcase).toHaveLength(1);

      // GET /api/admin/settings returns the saved settings
      const getSettings = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        headers: { cookie: auth.cookies },
      });
      expect(getSettings.status).toBe(200);
      expect(((await getSettings.json()) as SiteSettings).homeShowcase).toHaveLength(1);
    });

    it('purges single trash item and all trash items while deleting R2 objects for media and multi-chunk vault files', async () => {
      const auth = await setupAdmin();
      const limited = withCostLimits(env as unknown as AppBindings);

      // Seed media + R2 objects
      await limited.MEDIA.put('atlas/m_del/original.jpg', new Uint8Array([1, 2, 3]));
      await limited.MEDIA.put('atlas/m_del/thumb-600.webp', new Uint8Array([4, 5]));
      await limited.MEDIA.put('atlas/m_del/preview-1600.webp', new Uint8Array([6, 7]));

      // Seed 2-chunk vault file + R2 objects
      await limited.MEDIA.put('vault/vf_multi/part-0', new Uint8Array([10, 11]));
      await limited.MEDIA.put('vault/vf_multi/part-1', new Uint8Array([12, 13]));

      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO media (id,data,original,thumbnail,preview,hash) VALUES (?,?,?,?,?,?)',
        ).bind(
          'm_del',
          JSON.stringify({ id: 'm_del', name: 'del.jpg', size: 3 }),
          'atlas/m_del/original.jpg',
          'atlas/m_del/thumb-600.webp',
          'atlas/m_del/preview-1600.webp',
          'hash-del',
        ),
        env.DB.prepare(
          'INSERT INTO vault_files (id,name,mime,size,sha256,r2_key,chunk_count,visibility,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ).bind(
          'vf_multi',
          'bundle.bin',
          'application/octet-stream',
          4,
          '0'.repeat(64),
          'vault/vf_multi/part-0',
          2,
          'private',
          '2026-11-20T00:00:00Z',
        ),
        env.DB.prepare('INSERT INTO journeys (id,data) VALUES (?,?)').bind(
          'j_del',
          JSON.stringify({
            id: 'j_del',
            title: '待清理旅程',
            subtitle: '',
            startDate: '2026-10-01',
            endDate: '2026-10-02',
            visibility: 'private',
            coverId: null,
            stops: [],
            createdAt: '2026-10-02T00:00:00Z',
          }),
        ),
      ]);

      // Move all 3 into trash
      const trashMediaRes = await SELF.fetch(`${ORIGIN}/api/admin/trash`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ kind: 'media', id: 'm_del' }),
      });
      expect(trashMediaRes.status).toBe(200);
      const trashMedia = (await trashMediaRes.json()) as { key: string };

      const trashVaultRes = await SELF.fetch(`${ORIGIN}/api/admin/trash`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ kind: 'vault_file', id: 'vf_multi' }),
      });
      expect(trashVaultRes.status).toBe(200);

      const trashJourneyRes = await SELF.fetch(`${ORIGIN}/api/admin/trash`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ kind: 'journey', id: 'j_del' }),
      });
      expect(trashJourneyRes.status).toBe(200);

      // Purge single media trash item
      const purgeOneRes = await SELF.fetch(`${ORIGIN}/api/admin/trash/purge`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ key: trashMedia.key }),
      });
      expect(purgeOneRes.status).toBe(200);
      const purgeOne = (await purgeOneRes.json()) as {
        ok: boolean;
        purged: number;
        deletedR2Keys: string[];
      };
      expect(purgeOne.ok).toBe(true);
      expect(purgeOne.purged).toBe(1);
      expect(purgeOne.deletedR2Keys.sort()).toEqual([
        'atlas/m_del/original.jpg',
        'atlas/m_del/preview-1600.webp',
        'atlas/m_del/thumb-600.webp',
      ]);

      // Verify media R2 objects are physically deleted
      expect(await env.MEDIA.head('atlas/m_del/original.jpg')).toBeNull();
      expect(await env.MEDIA.head('atlas/m_del/thumb-600.webp')).toBeNull();
      expect(await env.MEDIA.head('atlas/m_del/preview-1600.webp')).toBeNull();

      // Purge remaining trash items (vault_file + journey) via { all: true }
      const purgeAllRes = await SELF.fetch(`${ORIGIN}/api/admin/trash/purge`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ all: true }),
      });
      expect(purgeAllRes.status).toBe(200);
      const purgeAll = (await purgeAllRes.json()) as {
        ok: boolean;
        purged: number;
        deletedR2Keys: string[];
      };
      expect(purgeAll.ok).toBe(true);
      expect(purgeAll.purged).toBe(2);
      expect(purgeAll.deletedR2Keys.sort()).toEqual([
        'vault/vf_multi/part-0',
        'vault/vf_multi/part-1',
      ]);

      expect(await env.MEDIA.head('vault/vf_multi/part-0')).toBeNull();
      expect(await env.MEDIA.head('vault/vf_multi/part-1')).toBeNull();

      const remaining = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM admin_trash').first<{
        cnt: number;
      }>();
      expect(Number(remaining?.cnt)).toBe(0);

      // Idempotent empty purge
      const purgeEmptyRes = await SELF.fetch(`${ORIGIN}/api/admin/trash/purge`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ all: true }),
      });
      expect(purgeEmptyRes.status).toBe(200);
      expect(await purgeEmptyRes.json()).toEqual({ ok: true, purged: 0, deletedR2Keys: [] });
    });
  });

  describe('Atlas private companion share token & homeShowcase authorization', () => {
    it('supports shareToken validation, scoped unauthed access, zero token leak, and strict F2.7 isolation', async () => {
      const auth = await setupAdmin();
      const limited = withCostLimits(env as unknown as AppBindings);
      const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

      for (const mediaId of ['m_shared_cover', 'm_shared_stop', 'm_secret_other', 'm_home_only']) {
        await limited.MEDIA.put(`atlas/${mediaId}/preview-1600.webp`, imgBytes);
        await env.DB.prepare(
          'INSERT INTO media (id,data,original,thumbnail,preview,hash) VALUES (?,?,?,?,?,?)',
        )
          .bind(
            mediaId,
            JSON.stringify({
              id: mediaId,
              name: `${mediaId}.png`,
              url: `/api/files/${mediaId}?variant=preview`,
              thumbnail: `/api/files/${mediaId}?variant=thumbnail`,
              preview: `/api/files/${mediaId}?variant=preview`,
              width: 800,
              height: 600,
              kind: 'image',
              mime: 'image/png',
              size: imgBytes.byteLength,
              takenAt: null,
              lat: null,
              lng: null,
              confirmed: false,
              caption: '',
            }),
            `atlas/${mediaId}/preview-1600.webp`,
            `atlas/${mediaId}/preview-1600.webp`,
            `atlas/${mediaId}/preview-1600.webp`,
            `hash-${mediaId}`,
          )
          .run();
      }

      // Reject invalid short shareToken
      const badTokenRes = await SELF.fetch(`${ORIGIN}/api/journeys`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          id: 'j_bad',
          title: '短令牌测试',
          startDate: '2026-10-01',
          endDate: '2026-10-02',
          visibility: 'private',
          stops: [],
          shareToken: 'short',
        }),
      });
      expect(badTokenRes.status).toBe(400);

      // Create private journey WITH valid shareToken
      const validToken = 'CompanionToken_2026_OK';
      const createShared = await SELF.fetch(`${ORIGIN}/api/journeys`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          id: 'j_companion',
          title: '川西同行私密旅图',
          subtitle: '仅同行友人可见',
          startDate: '2026-10-01',
          endDate: '2026-10-03',
          visibility: 'private',
          coverId: 'm_shared_cover',
          shareToken: validToken,
          stops: [
            {
              id: 'stop_1',
              name: '新都桥',
              region: '甘孜',
              lat: 30.05,
              lng: 101.49,
              date: '2026-10-02',
              note: '秋光极好',
              mediaIds: ['m_shared_stop'],
            },
          ],
        }),
      });
      expect(createShared.status).toBe(200);

      // Create another private journey WITHOUT matching shareToken
      const createOther = await SELF.fetch(`${ORIGIN}/api/journeys`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          id: 'j_other_private',
          title: '另一段完全私密旅程',
          startDate: '2026-11-01',
          endDate: '2026-11-02',
          visibility: 'private',
          coverId: 'm_secret_other',
          shareToken: 'AnotherPrivateToken_999',
          stops: [],
        }),
      });
      expect(createOther.status).toBe(200);

      // 1) Unauthenticated without share -> 0 journeys, 0 media, 404 on files
      const libNoShare = await SELF.fetch(`${ORIGIN}/api/library`);
      const libNoShareJson = (await libNoShare.json()) as {
        journeys: Array<{ id: string }>;
        media: Array<{ id: string }>;
      };
      expect(libNoShareJson.journeys).toHaveLength(0);
      expect(libNoShareJson.media).toHaveLength(0);
      expect((await SELF.fetch(`${ORIGIN}/api/files/m_shared_cover?variant=preview`)).status).toBe(404);
      expect((await SELF.fetch(`${ORIGIN}/api/files/m_shared_stop?variant=preview`)).status).toBe(404);

      // 2) Unauthenticated with wrong share -> 0 journeys, 404 on files
      const libWrongShare = await SELF.fetch(`${ORIGIN}/api/library?share=WrongToken_123456`);
      const libWrongJson = (await libWrongShare.json()) as { journeys: Array<{ id: string }> };
      expect(libWrongJson.journeys).toHaveLength(0);
      expect(
        (await SELF.fetch(`${ORIGIN}/api/files/m_shared_cover?variant=preview&share=WrongToken_123456`))
          .status,
      ).toBe(404);

      // 3) Unauthenticated with valid share -> includes j_companion & its 2 media, hides j_other_private, NEVER leaks shareToken
      const libValidShare = await SELF.fetch(
        `${ORIGIN}/api/library?share=${encodeURIComponent(validToken)}`,
      );
      expect(libValidShare.status).toBe(200);
      const rawText = await libValidShare.text();
      expect(rawText).not.toContain(validToken);
      expect(rawText).not.toContain('shareToken');
      const libValidJson = JSON.parse(rawText) as {
        journeys: Array<{ id: string; shareToken?: string }>;
        media: Array<{ id: string }>;
      };
      expect(libValidJson.journeys.map((j) => j.id)).toEqual(['j_companion']);
      expect(libValidJson.media.map((m) => m.id).sort()).toEqual([
        'm_shared_cover',
        'm_shared_stop',
      ]);

      // Files referenced by j_companion succeed with ?share=, while m_secret_other stays 404
      expect(
        (
          await SELF.fetch(
            `${ORIGIN}/api/files/m_shared_cover?variant=preview&share=${encodeURIComponent(validToken)}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await SELF.fetch(
            `${ORIGIN}/api/files/m_shared_stop?variant=preview&share=${encodeURIComponent(validToken)}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await SELF.fetch(
            `${ORIGIN}/api/files/m_secret_other?variant=preview&share=${encodeURIComponent(validToken)}`,
          )
        ).status,
      ).toBe(404);

      // 4) Authenticated owner sees shareToken in /api/library
      const authedLib = await SELF.fetch(`${ORIGIN}/api/library`, {
        headers: { cookie: auth.cookies },
      });
      const authedJson = (await authedLib.json()) as {
        journeys: Array<{ id: string; shareToken?: string | null }>;
      };
      const companion = authedJson.journeys.find((j) => j.id === 'j_companion');
      expect(companion?.shareToken).toBe(validToken);

      // 5) Media curated in settings.homeShowcase is authorized publicly, and returns 404 once removed
      expect((await SELF.fetch(`${ORIGIN}/api/files/m_home_only?variant=preview`)).status).toBe(404);
      const pinHome = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          title: '旅途手记',
          tagline: '山海',
          homeShowcase: [
            {
              id: 'hs1',
              src: '/api/files/m_home_only?variant=preview',
              alt: '首页精选',
              place: '青海湖',
              coords: '36.8°N',
              caption: '晴朗的湖面',
              mediaId: 'm_home_only',
            },
          ],
        }),
      });
      expect(pinHome.status).toBe(200);
      expect((await SELF.fetch(`${ORIGIN}/api/files/m_home_only?variant=preview`)).status).toBe(200);

      // Clear homeShowcase -> returns 404 again
      const clearHome = await SELF.fetch(`${ORIGIN}/api/admin/settings`, {
        method: 'PATCH',
        headers: adminHeaders(auth),
        body: JSON.stringify({ title: '旅途手记', tagline: '山海', homeShowcase: [] }),
      });
      expect(clearHome.status).toBe(200);
      expect((await SELF.fetch(`${ORIGIN}/api/files/m_home_only?variant=preview`)).status).toBe(404);
    });
  });

  describe('Vault safe inline preview (?inline=1)', () => {
    async function seedVaultTicket(
      auth: { cookies: string; csrfToken: string },
      name: string,
      mime: string,
      content: string,
      code: string,
    ) {
      const payload = new TextEncoder().encode(content);
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', payload)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');

      const initRes = await SELF.fetch(`${ORIGIN}/api/vault/uploads/init`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({
          name,
          mime,
          size: payload.byteLength,
          sha256: sha,
          totalChunks: 1,
        }),
      });
      expect(initRes.status).toBe(200);
      const { uploadId } = (await initRes.json()) as { uploadId: string };

      const chunkRes = await SELF.fetch(`${ORIGIN}/api/vault/uploads/${uploadId}/chunk`, {
        method: 'PUT',
        headers: {
          ...adminHeaders(auth, false),
          'content-type': 'application/octet-stream',
          'x-chunk-index': '0',
        },
        body: payload,
      });
      expect(chunkRes.status).toBe(200);

      const completeRes = await SELF.fetch(`${ORIGIN}/api/vault/uploads/${uploadId}/complete`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({}),
      });
      expect(completeRes.status).toBe(200);
      const { fileId } = (await completeRes.json()) as { fileId: string };

      const shareRes = await SELF.fetch(`${ORIGIN}/api/vault/shares`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ fileId, maxDownloads: 5, expiresIn: 3600, passcode: code }),
      });
      expect(shareRes.status).toBe(201);

      const redeemRes = await SELF.fetch(`${ORIGIN}/api/vault/redeem`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      expect(redeemRes.status).toBe(200);
      const { downloadUrl } = (await redeemRes.json()) as { downloadUrl: string };
      return downloadUrl;
    }

    it('serves inline with sandbox CSP for safe allowlisted MIMEs and forces attachment for SVG/HTML and default requests', async () => {
      const auth = await setupAdmin();

      const txtUrl = await seedVaultTicket(auth, 'readme.txt', 'text/plain', 'hello safe preview', 'SAFE01');
      const pngUrl = await seedVaultTicket(auth, 'photo.png', 'image/png', '\x89PNG\r\n\x1a\n', 'SAFE02');
      const svgUrl = await seedVaultTicket(
        auth,
        'vector.svg',
        'image/svg+xml',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'EVIL01',
      );
      const htmlUrl = await seedVaultTicket(
        auth,
        'page.html',
        'text/html',
        '<html><body><script>alert(1)</script></body></html>',
        'EVIL02',
      );

      // Default (without ?inline=1) remains attachment
      const defaultTxt = await SELF.fetch(`${ORIGIN}${txtUrl}`);
      expect(defaultTxt.status).toBe(200);
      expect(defaultTxt.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(defaultTxt.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await defaultTxt.text()).toBe('hello safe preview');

      // Safe text with ?inline=1 -> inline + sandbox CSP + nosniff
      const inlineTxt = await SELF.fetch(`${ORIGIN}${txtUrl}?inline=1`);
      expect(inlineTxt.status).toBe(200);
      expect(inlineTxt.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(inlineTxt.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(inlineTxt.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await inlineTxt.text()).toBe('hello safe preview');

      // Safe PNG with ?inline=1 -> inline + sandbox CSP + nosniff
      const inlinePng = await SELF.fetch(`${ORIGIN}${pngUrl}?inline=1`);
      expect(inlinePng.status).toBe(200);
      expect(inlinePng.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(inlinePng.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(inlinePng.headers.get('x-content-type-options')).toBe('nosniff');

      // SVG with ?inline=1 -> MUST stay attachment (XSS defense!)
      const inlineSvg = await SELF.fetch(`${ORIGIN}${svgUrl}?inline=1`);
      expect(inlineSvg.status).toBe(200);
      expect(inlineSvg.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(inlineSvg.headers.get('x-content-type-options')).toBe('nosniff');

      // HTML with ?inline=1 -> MUST stay attachment (XSS defense!)
      const inlineHtml = await SELF.fetch(`${ORIGIN}${htmlUrl}?inline=1`);
      expect(inlineHtml.status).toBe(200);
      expect(inlineHtml.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(inlineHtml.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });
});
