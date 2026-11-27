import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { createBinaryChunkPayload, createSyntheticExifJpeg } from '../fixtures/exif-jpeg';
import { ApiClient, createApiClient } from '../helpers/api-client';
import { attachErrorListeners, scanAntiAiTaste } from '../helpers/browser-checks';
import { auditLocalOnlyBoundary } from '../helpers/local-guard';

test.describe.configure({ mode: 'serial' });

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'AtlasVaultStarlight2026!';
const PUBLIC_TEST_IP = '93.184.216.34';
const usedPasscodes = new Set<string>();

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function uniquePasscode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      const idx = (bytes[i] ?? 0) % alphabet.length;
      code += alphabet.charAt(idx);
    }
    if (!usedPasscodes.has(code)) {
      usedPasscodes.add(code);
      return code;
    }
  }
  throw new Error('Failed to generate unique 6-char passcode');
}

function uniqueSyntheticIp(): string {
  const hex = crypto.randomUUID().replace(/-/g, '');
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:${hex.slice(16, 20)}:${hex.slice(20, 24)}`;
}

function extractTicketId(redeemData: { ticketId?: string; downloadUrl?: string }): string {
  if (typeof redeemData.ticketId === 'string' && redeemData.ticketId.length > 0) {
    return redeemData.ticketId;
  }
  if (typeof redeemData.downloadUrl === 'string' && redeemData.downloadUrl.length > 0) {
    const pathname = redeemData.downloadUrl.split('?')[0] ?? '';
    const last = pathname.split('/').filter(Boolean).pop();
    if (last) return last;
  }
  throw new Error(`Unable to extract ticketId from redeem response: ${JSON.stringify(redeemData)}`);
}

function extractFileId(completeData: Record<string, unknown>, fallbackFileId?: string): string {
  const fileObj = completeData.file as Record<string, unknown> | undefined;
  const directId =
    (typeof fileObj?.id === 'string' && fileObj.id) ||
    (typeof completeData.fileId === 'string' && completeData.fileId) ||
    (typeof completeData.id === 'string' && completeData.id) ||
    fallbackFileId;
  if (!directId) {
    throw new Error(`Unable to resolve fileId from complete response: ${JSON.stringify(completeData)}`);
  }
  return directId;
}

function extractShareId(shareData: Record<string, unknown>): { shareId: string; passcode?: string } {
  const shareObj = (shareData.share as Record<string, unknown> | undefined) ?? shareData;
  const shareId = typeof shareObj.id === 'string' ? shareObj.id : '';
  if (!shareId) {
    throw new Error(`Unable to resolve shareId from share response: ${JSON.stringify(shareData)}`);
  }
  const passcode =
    typeof shareData.passcode === 'string'
      ? shareData.passcode
      : typeof shareObj.passcode === 'string'
        ? shareObj.passcode
        : undefined;
  return { shareId, passcode };
}

function getCounterValue(
  counters: Array<{ key: string; value: number }>,
  key: string,
): number {
  const found = counters.find((c) => c.key === key);
  return found ? found.value : 0;
}

async function uploadAndShareVaultFile(
  admin: ApiClient,
  opts: {
    sizeBytes?: number;
    chunkCount?: number;
    seed?: number;
    name?: string;
    mime?: string;
    maxDownloads?: number;
    expiresIn?: number;
    expiresAt?: string;
    passcode?: string;
    note?: string;
  } = {},
): Promise<{
  fileId: string;
  fileName: string;
  payload: Buffer;
  sha256: string;
  shareId: string;
  passcode: string;
}> {
  const sizeBytes = opts.sizeBytes ?? 2048;
  const chunkCount = opts.chunkCount ?? 1;
  const { buffer, sha256 } = createBinaryChunkPayload(sizeBytes, opts.seed ?? 29);
  const fileName = opts.name ?? `${uniqueId('t2-vault')}.bin`;

  const initRes = await admin.initVaultUpload({
    name: fileName,
    mime: opts.mime ?? 'application/octet-stream',
    size: sizeBytes,
    sha256,
    totalChunks: chunkCount,
  });
  expect([200, 201]).toContain(initRes.status);
  const uploadId = initRes.data.uploadId;

  const baseChunkSize = Math.floor(sizeBytes / chunkCount);
  let offset = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const end = i === chunkCount - 1 ? sizeBytes : offset + baseChunkSize;
    const chunk = buffer.subarray(offset, end);
    offset = end;
    const chunkRes = await admin.uploadVaultChunk(uploadId, i, chunk);
    expect(chunkRes.status).toBe(200);
  }

  const completeRes = await admin.completeVaultUpload(uploadId);
  expect([200, 201]).toContain(completeRes.status);
  const fileId = extractFileId(completeRes.data, initRes.data.fileId);

  const chosenPasscode = opts.passcode ?? uniquePasscode();
  const shareRes = await admin.createVaultShare({
    fileId,
    maxDownloads: opts.maxDownloads ?? 5,
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : { expiresIn: opts.expiresIn ?? 3600 }),
    passcode: chosenPasscode,
    note: opts.note ?? '',
  });
  expect([200, 201]).toContain(shareRes.status);
  const { shareId, passcode } = extractShareId(shareRes.data);

  return {
    fileId,
    fileName,
    payload: buffer,
    sha256,
    shareId,
    passcode: passcode ?? chosenPasscode,
  };
}

async function loginAdminInBrowser(page: Page, api: ApiClient): Promise<void> {
  await api.ensureAdminSession(ADMIN_PASSWORD);
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const passwordInput = page.locator('input[type="password"]').first();
  if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await passwordInput.fill(ADMIN_PASSWORD);
    const submitBtn = page.getByRole('button', { name: /登录|进入|确认|提交/i }).first();
    await submitBtn.click();
    await expect(passwordInput).toBeHidden({ timeout: 10_000 });
  }
}

async function openAdminSection(page: Page, pattern: RegExp): Promise<void> {
  const trigger = page
    .getByRole('tab', { name: pattern })
    .or(page.getByRole('button', { name: pattern }))
    .first();
  if (await trigger.isVisible({ timeout: 2500 }).catch(() => false)) {
    await trigger.click();
  }
}

async function resolveVisitorId(admin: ApiClient, client: ApiClient): Promise<string> {
  const uniqueUa = `E2E-Visitor-${crypto.randomUUID()}`;
  const res = await client.request('/api/atlas/config', {
    method: 'GET',
    headers: { 'user-agent': uniqueUa },
  });
  expect(res.status).toBe(200);

  const snap = await admin.getSecurity();
  expect(snap.status).toBe(200);
  const visitors = (snap.data.visitors as Array<Record<string, unknown>> | undefined) ?? [];
  const matched = visitors.find(
    (v) => (v.device as Record<string, unknown> | undefined)?.userAgent === uniqueUa,
  );
  const visitorId = typeof matched?.id === 'string' ? matched.id : '';
  expect(visitorId).toMatch(/^[a-f0-9]{64}$/);
  return visitorId;
}

async function locateVaultFileInput(page: Page) {
  const allFileInputs = page.locator('input[type="file"]');
  await allFileInputs.first().waitFor({ state: 'attached', timeout: 10_000 });
  if ((await allFileInputs.count()) === 1) {
    return allFileInputs.first();
  }
  const scoped = page
    .locator('main section, main [role="tabpanel"], main form, main div')
    .filter({ hasText: /密匣|Vault|分片上传|拖拽.*上传/i })
    .filter({ has: page.locator('input[type="file"]') })
    .last()
    .locator('input[type="file"]')
    .first();
  if ((await scoped.count()) > 0) {
    return scoped;
  }
  return allFileInputs.first();
}

function appendJpegComment(jpeg: Buffer, comment: string): Buffer {
  const textBytes = Buffer.from(comment, 'utf8');
  const len = 2 + textBytes.length;
  const com = Buffer.allocUnsafe(4 + textBytes.length);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(len, 2);
  textBytes.copy(com, 4);
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)]);
}

async function uploadUniqueAtlasMedia(
  admin: ApiClient,
  opts: { lat?: number; lng?: number; caption?: string } = {},
): Promise<string> {
  const tag = uniqueId('refmedia');
  const rawJpeg = createSyntheticExifJpeg({
    width: 160,
    height: 120,
    lat: opts.lat ?? 25.6065,
    lng: opts.lng ?? 100.2676,
    iso: 100 + crypto.randomInt(0, 800),
  });
  const uniqueJpeg = appendJpegComment(rawJpeg, tag);
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(uniqueJpeg)], { type: 'image/jpeg' }), `${tag}.jpg`);
  form.append('takenAt', '2026-10-01T12:00:00Z');
  form.append('lat', String(opts.lat ?? 25.6065));
  form.append('lng', String(opts.lng ?? 100.2676));
  form.append('caption', opts.caption ?? tag);

  const mediaRes = await admin.uploadMedia(form);
  expect([200, 201]).toContain(mediaRes.status);
  const rawMedia = mediaRes.data.media;
  const mediaObj = (Array.isArray(rawMedia) ? rawMedia[0] : rawMedia) as
    | Record<string, unknown>
    | undefined;
  const mediaId = String((mediaObj ?? mediaRes.data).id || '');
  expect(mediaId.length).toBeGreaterThan(0);
  return mediaId;
}

function makeTempLocalRepo(
  overrides: {
    wranglerJsonc?: string;
    packageJson?: string;
    devVars?: string;
    extraFiles?: Record<string, string>;
  } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-guard-t2-'));
  const defaultWrangler = JSON.stringify(
    {
      name: 'lvtushouji-site-local',
      compatibility_date: '2026-11-20',
      workers_dev: false,
      preview_urls: false,
      d1_databases: [{ binding: 'DB', database_name: 'local-db', remote: false }],
      r2_buckets: [{ binding: 'MEDIA', bucket_name: 'local-media', remote: false }],
    },
    null,
    2,
  );
  const defaultPkg = JSON.stringify(
    {
      name: 'temp-local-site',
      private: true,
      scripts: {
        dev: 'vite --host 127.0.0.1 --port 5173',
        build: 'vite build',
      },
    },
    null,
    2,
  );

  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), overrides.wranglerJsonc ?? defaultWrangler);
  fs.writeFileSync(path.join(dir, 'package.json'), overrides.packageJson ?? defaultPkg);
  if (overrides.devVars !== undefined) {
    fs.writeFileSync(path.join(dir, '.dev.vars'), overrides.devVars);
  }
  for (const [relPath, content] of Object.entries(overrides.extraFiles ?? {})) {
    fs.writeFileSync(path.join(dir, relPath), content);
  }
  return dir;
}

// ============================================================================
// F4.1 — Boundary, Negative & Edge Cases (6 tests)
// ============================================================================
test.describe('Tier 2 — F4.1 Vault Redemption & Streaming Boundaries', () => {
  test('T2-F4.1-01 wrong 6-char passcode returns 401 without existence leak and /vault UI shows calm alert', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const ip = uniqueSyntheticIp();
    const anon = createApiClient();
    const wrongCode = uniquePasscode();

    const apiRes = await anon.redeemVault(wrongCode, undefined, {
      headers: { 'cf-connecting-ip': ip },
    });
    expect(apiRes.status).toBe(401);
    expect(apiRes.data.error).toBeTruthy();

    await page.goto('/vault', { waitUntil: 'networkidle' });
    const input = page
      .getByRole('textbox', { name: /口令|提取/i })
      .or(page.locator('main form input').first());
    await input.fill(uniquePasscode());
    await input.press('Enter');

    const feedback = page
      .locator('main [role="alert"], main [role="status"]')
      .filter({ hasText: /\S+/ })
      .first();
    await expect(feedback).toBeVisible({ timeout: 10_000 });
    await scanAntiAiTaste(page);
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors.filter((m) => !/status of 401/i.test(m))).toEqual([]);
  });

  test('T2-F4.1-02 passcode whitespace and case normalization redeems consistently', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const mixedCode = `Ab${crypto.randomInt(10, 99)}Xy`;
    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('norm')}.bin`,
      passcode: mixedCode,
      maxDownloads: 3,
    });

    try {
      const anon = createApiClient();
      const paddedLower = `  ${mixedCode.toLowerCase()}  `;
      const res = await anon.redeemVault(paddedLower, undefined, {
        headers: { 'cf-connecting-ip': uniqueSyntheticIp() },
      });
      expect(res.status).toBe(200);
      expect(res.data.fileName).toBe(created.fileName);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T2-F4.1-03 invalid passcode lengths (5, 7, non-alphanumeric) rejected with 400', async () => {
    const anon = createApiClient();
    for (const badCode of ['12345', '1234567', 'ab!@12', '']) {
      const res = await anon.redeemVault(badCode, undefined, {
        headers: { 'cf-connecting-ip': uniqueSyntheticIp() },
      });
      expect(res.status, `Expected 400 for passcode "${badCode}"`).toBe(400);
    }
  });

  test('T2-F4.1-04 zero ?code= query-string redemption support rejects empty JSON body with 400', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('noqs')}.bin`,
    });

    try {
      const anon = createApiClient();
      const res = await anon.request<{ error?: string }>(
        `/api/vault/redeem?code=${encodeURIComponent(created.passcode)}`,
        {
          method: 'POST',
          headers: { 'cf-connecting-ip': uniqueSyntheticIp() },
          body: {},
        },
      );
      expect(res.status).toBe(400);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T2-F4.1-05 idempotent requestId replay returns 200 and decrements remainingDownloads only once', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('idem')}.bin`,
      maxDownloads: 3,
    });

    try {
      const anon = createApiClient();
      const reqId = crypto.randomUUID();
      const first = await anon.redeemVault(created.passcode, reqId);
      expect(first.status).toBe(200);
      expect(first.data.remainingDownloads).toBe(2);

      const second = await anon.redeemVault(created.passcode, reqId);
      expect(second.status).toBe(200);
      expect(second.data.remainingDownloads).toBe(2);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T2-F4.1-06 unsatisfiable Range returns 416 and missing ticket returns 403/404', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('bad-range')}.bin`,
      sizeBytes: 512,
    });

    try {
      const anon = createApiClient();
      const redeem = await anon.redeemVault(created.passcode);
      expect(redeem.status).toBe(200);
      const ticketId = extractTicketId(redeem.data as { ticketId?: string; downloadUrl?: string });

      const oobRange = await anon.downloadVaultTicket(ticketId, { range: 'bytes=999999-' });
      expect(oobRange.status).toBe(416);
      expect(oobRange.headers.get('content-range')).toBe('bytes */512');

      const invertedRange = await anon.downloadVaultTicket(ticketId, { range: 'bytes=50-10' });
      expect(invertedRange.status).toBe(416);

      const missingTicket = await anon.downloadVaultTicket(`nonexistent-${crypto.randomUUID()}`);
      expect([403, 404]).toContain(missingTicket.status);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });
});

// ============================================================================
// F4.2 — Vault Chunked Upload Error, Retry, Cancel & Auth Boundaries (6 tests)
// ============================================================================
test.describe('Tier 2 — F4.2 Vault Chunked Upload Boundaries', () => {
  test('T2-F4.2-01 chunk #2 failure blocks complete until missing chunk is retried without re-uploading chunk 0 or 2', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(3072, 13);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('resume')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 3,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    try {
      // Upload chunks 0 and 2, skip chunk 1 to simulate failure
      expect((await admin.uploadVaultChunk(uploadId, 0, buffer.subarray(0, 1024))).status).toBe(200);
      expect((await admin.uploadVaultChunk(uploadId, 2, buffer.subarray(2048, 3072))).status).toBe(200);

      const prematureComplete = await admin.completeVaultUpload(uploadId);
      expect([400, 409]).toContain(prematureComplete.status);

      // Now retry ONLY missing chunk 1
      expect((await admin.uploadVaultChunk(uploadId, 1, buffer.subarray(1024, 2048))).status).toBe(200);
      const finalComplete = await admin.completeVaultUpload(uploadId);
      expect([200, 201]).toContain(finalComplete.status);
    } catch (err) {
      await admin.abortVaultUpload(uploadId).catch(() => undefined);
      throw err;
    }
  });

  test('T2-F4.2-02 DELETE /api/vault/uploads/:id aborts upload and rejects subsequent chunk or complete', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(2048, 19);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('abort')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 2,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    expect((await admin.uploadVaultChunk(uploadId, 0, buffer.subarray(0, 1024))).status).toBe(200);
    const abortRes = await admin.abortVaultUpload(uploadId);
    expect([200, 204]).toContain(abortRes.status);

    const lateChunk = await admin.uploadVaultChunk(uploadId, 1, buffer.subarray(1024));
    expect([400, 404, 409]).toContain(lateChunk.status);

    const lateComplete = await admin.completeVaultUpload(uploadId);
    expect([400, 404, 409]).toContain(lateComplete.status);
  });

  test('T2-F4.2-03 >16 MiB (16 * 1024 * 1024 + 1) chunk upload is rejected with 413', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const overSize = 16 * 1024 * 1024 + 1;
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('over16m')}.bin`,
      mime: 'application/octet-stream',
      size: overSize,
      sha256: 'a'.repeat(64),
      totalChunks: 3,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    try {
      const oversizedChunk = Buffer.alloc(overSize, 0x41);
      const chunkRes = await admin.uploadVaultChunk(uploadId, 0, oversizedChunk);
      expect(chunkRes.status).toBe(413);
    } finally {
      await admin.abortVaultUpload(uploadId);
    }
  });

  test('T2-F4.2-04 invalid X-Chunk-Index (-1, >= totalChunks, non-integer) rejected with 400', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(2048, 21);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('badidx')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 2,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    try {
      for (const badIdx of ['-1', '2', 'abc']) {
        const res = await admin.uploadVaultChunk(uploadId, 0, buffer.subarray(0, 1024), {
          headers: {
            'content-type': 'application/octet-stream',
            'x-chunk-index': badIdx,
          },
        });
        expect(res.status, `Expected 400 for x-chunk-index=${badIdx}`).toBe(400);
      }
    } finally {
      await admin.abortVaultUpload(uploadId);
    }
  });

  test('T2-F4.2-05 unauthenticated upload rejected 401 and missing/bad Origin or CSRF rejected 403', async () => {
    const anon = createApiClient();
    const unauthed = await anon.initVaultUpload({
      name: 'unauth.bin',
      mime: 'application/octet-stream',
      size: 512,
      sha256: 'b'.repeat(64),
      totalChunks: 1,
    });
    expect(unauthed.status).toBe(401);

    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const noOrigin = await admin.initVaultUpload(
      {
        name: 'noorigin.bin',
        mime: 'application/octet-stream',
        size: 512,
        sha256: 'b'.repeat(64),
        totalChunks: 1,
      },
      { origin: null },
    );
    expect(noOrigin.status).toBe(403);

    const badOrigin = await admin.initVaultUpload(
      {
        name: 'badorigin.bin',
        mime: 'application/octet-stream',
        size: 512,
        sha256: 'b'.repeat(64),
        totalChunks: 1,
      },
      { origin: 'https://evil.example' },
    );
    expect(badOrigin.status).toBe(403);

    const noCsrf = await admin.initVaultUpload(
      {
        name: 'nocsrf.bin',
        mime: 'application/octet-stream',
        size: 512,
        sha256: 'b'.repeat(64),
        totalChunks: 1,
      },
      { csrfToken: null },
    );
    expect(noCsrf.status).toBe(403);

    const badCsrf = await admin.initVaultUpload(
      {
        name: 'badcsrf.bin',
        mime: 'application/octet-stream',
        size: 512,
        sha256: 'b'.repeat(64),
        totalChunks: 1,
      },
      { csrfToken: 'forged-csrf-token' },
    );
    expect(badCsrf.status).toBe(403);
  });

  test('T2-F4.2-06 Admin UI cancel button aborts active upload cleanly', async ({ page }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await loginAdminInBrowser(page, admin);
    await openAdminSection(page, /密匣|Vault/i);

    let holdAction: ((action: 'continue' | 'abort') => void) | null = null;
    await page.route('**/api/vault/uploads/*/chunk', async (route) => {
      const action = await new Promise<'continue' | 'abort'>((resolve) => {
        holdAction = resolve;
        setTimeout(() => resolve('abort'), 4000);
      });
      if (action === 'abort') {
        await route.abort('aborted').catch(() => undefined);
      } else {
        await route.continue().catch(() => undefined);
      }
    });

    const { buffer } = createBinaryChunkPayload(4096, 47);
    const cancelledName = `${uniqueId('ui-cancel')}.bin`;

    try {
      const fileInput = await locateVaultFileInput(page);
      await expect(fileInput).toBeAttached();

      await fileInput.setInputFiles({
        name: cancelledName,
        mimeType: 'application/octet-stream',
        buffer,
      });

      const cancelBtn = page.getByRole('button', { name: /取消|中止/i }).first();
      await expect(cancelBtn).toBeVisible({ timeout: 10_000 });

      const abortReqPromise = page.waitForRequest(
        (req) => req.url().includes('/api/vault/uploads/') && req.method() === 'DELETE',
      );
      await cancelBtn.click();
      await abortReqPromise;
      if (holdAction) (holdAction as (action: 'continue' | 'abort') => void)('abort');

      await expect(page.getByText(cancelledName)).toHaveCount(0);
      errors.assertZeroErrors();
    } finally {
      if (holdAction) (holdAction as (action: 'continue' | 'abort') => void)('abort');
      await page.unroute('**/api/vault/uploads/*/chunk');
    }
  });
});

// ============================================================================
// F4.3 — Vault Quota Exhaustion, Expiry, Tombstones & BVA (5 tests)
// ============================================================================
test.describe('Tier 2 — F4.3 Vault Share Quota, Expiry & Tombstone Boundaries', () => {
  test('T2-F4.3-01 last download succeeds with remainingDownloads 0 and next attempt returns 403 ticket_exhausted', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('exhaust')}.bin`,
      maxDownloads: 2,
    });

    try {
      const anon = createApiClient();
      const r1 = await anon.redeemVault(created.passcode);
      expect(r1.status).toBe(200);
      expect(r1.data.remainingDownloads).toBe(1);

      const r2 = await anon.redeemVault(created.passcode);
      expect(r2.status).toBe(200);
      expect(r2.data.remainingDownloads).toBe(0);
      const lastTicket = extractTicketId(r2.data as { ticketId?: string; downloadUrl?: string });
      expect((await anon.downloadVaultTicket(lastTicket)).status).toBe(200);

      const r3 = await anon.redeemVault(created.passcode);
      expect(r3.status).toBe(403);
      expect(JSON.stringify(r3.data)).toMatch(/exhausted|次数|上限/i);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T2-F4.3-02 expired TTL share rejects redeem and past/non-positive TTL boundaries return 400', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1024, 37);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('ttl')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    // Negative / zero expiresIn must be rejected
    const badTtl = await admin.createVaultShare({
      fileId,
      maxDownloads: 3,
      expiresIn: 0,
      passcode: uniquePasscode(),
    });
    expect(badTtl.status).toBe(400);

    // Past expiresAt must be rejected (400) or immediately expired on redeem
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const pastRes = await admin.createVaultShare({
      fileId,
      maxDownloads: 3,
      expiresAt: pastIso,
      passcode: uniquePasscode(),
    });
    expect([400, 422]).toContain(pastRes.status);

    // Short positive expiresAt: if accepted, wait past expiry and verify 404/410 share_expired
    const shortCode = uniquePasscode();
    const shortRes = await admin.createVaultShare({
      fileId,
      maxDownloads: 3,
      expiresAt: new Date(Date.now() + 2000).toISOString(),
      passcode: shortCode,
    });
    if (shortRes.status === 200 || shortRes.status === 201) {
      const { shareId } = extractShareId(shortRes.data);
      try {
        await new Promise((r) => setTimeout(r, 2700));
        const anon = createApiClient();
        const expiredRedeem = await anon.redeemVault(shortCode);
        expect([404, 410]).toContain(expiredRedeem.status);
        expect(JSON.stringify(expiredRedeem.data)).toMatch(/expired|过期/i);
      } finally {
        await admin.revokeVaultShare(shareId);
      }
    } else {
      // Server enforces minimum TTL (e.g. >= 5 minutes) with 400
      expect(shortRes.status).toBe(400);
    }
  });

  test('T2-F4.3-03 revocation tombstone blocks both new redeem and already-issued ticketId download', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('tomb')}.bin`,
      maxDownloads: 10,
      expiresIn: 7200,
    });

    const anon = createApiClient();
    const redeemBefore = await anon.redeemVault(created.passcode);
    expect(redeemBefore.status).toBe(200);
    const issuedTicketId = extractTicketId(
      redeemBefore.data as { ticketId?: string; downloadUrl?: string },
    );

    const revokeRes = await admin.revokeVaultShare(created.shareId);
    expect(revokeRes.status).toBe(200);

    // Both future redeem AND already-issued ticket must be blocked despite remaining quota & TTL
    const redeemAfter = await anon.redeemVault(created.passcode);
    expect([403, 410]).toContain(redeemAfter.status);
    expect(JSON.stringify(redeemAfter.data)).toMatch(/revoked|撤销/i);

    const dlAfter = await anon.downloadVaultTicket(issuedTicketId);
    expect([403, 410]).toContain(dlAfter.status);
  });

  test('T2-F4.3-04 maxDownloads BVA rejects 0 and 1000 with 400 and accepts 1 and 999', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1024, 41);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('maxdl')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    for (const badMax of [0, -1, 1000]) {
      const bad = await admin.createVaultShare({
        fileId,
        maxDownloads: badMax,
        expiresIn: 3600,
        passcode: uniquePasscode(),
      });
      expect(bad.status, `Expected 400 for maxDownloads=${badMax}`).toBe(400);
    }

    const createdShares: string[] = [];
    try {
      for (const goodMax of [1, 999]) {
        const ok = await admin.createVaultShare({
          fileId,
          maxDownloads: goodMax,
          expiresIn: 3600,
          passcode: uniquePasscode(),
        });
        expect([200, 201]).toContain(ok.status);
        createdShares.push(extractShareId(ok.data).shareId);
      }
    } finally {
      for (const sid of createdShares) {
        await admin.revokeVaultShare(sid);
      }
    }
  });

  test('T2-F4.3-05 invalid share passcode length/symbols return 400 and missing fileId returns 404', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1024, 43);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('badshare')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    for (const badCode of ['12345', '1234567', 'ab$12!']) {
      const res = await admin.createVaultShare({
        fileId,
        maxDownloads: 2,
        expiresIn: 3600,
        passcode: badCode,
      });
      expect(res.status, `Expected 400 for share passcode "${badCode}"`).toBe(400);
    }

    const missingFile = await admin.createVaultShare({
      fileId: `missing-${crypto.randomUUID()}`,
      maxDownloads: 2,
      expiresIn: 3600,
      passcode: uniquePasscode(),
    });
    expect(missingFile.status).toBe(404);
  });
});

// ============================================================================
// F5.1 — Request Parsing, Method/404/405 & Range Boundaries (5 tests)
// ============================================================================
test.describe('Tier 2 — F5.1 Stack Parsing & Route Boundaries', () => {
  test('T2-F5.1-01 malformed JSON body returns 400 on auth and admin endpoints', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const badAuthJson = await admin.request('/api/security/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken-json',
    });
    expect(badAuthJson.status).toBe(400);

    const badAdminJson = await admin.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not-valid-json',
    });
    expect(badAdminJson.status).toBe(400);
  });

  test('T2-F5.1-02 non-object JSON returns 400 and non-JSON Content-Type returns 415', async () => {
    const client = createApiClient();

    for (const nonObject of ['[]', 'null', '"hello"']) {
      const res = await client.request('/api/security/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: nonObject,
      });
      expect(res.status, `Expected 400 for JSON ${nonObject}`).toBe(400);
    }

    const wrongCt = await client.request('/api/security/auth', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"action":"login","password":"abc"}',
    });
    expect(wrongCt.status).toBe(415);
  });

  test('T2-F5.1-03 oversized JSON payload (>16 KiB) rejected with 413', async () => {
    const client = createApiClient();
    const oversizedPayload = JSON.stringify({
      action: 'login',
      password: 'x'.repeat(20_000),
    });

    const res = await client.request('/api/security/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversizedPayload,
    });
    expect(res.status).toBe(413);
  });

  test('T2-F5.1-04 /api/security/* unknown paths/methods return 405 while unknown /api/* returns 404 JSON', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const secUnknown = await admin.request('/api/security/unknown-subpath', { method: 'GET' });
    expect(secUnknown.status).toBe(405);

    const secSessionsGet = await admin.request('/api/security/sessions', { method: 'GET' });
    expect(secSessionsGet.status).toBe(405);

    const apiUnknown = await admin.request('/api/unknown-platform-route', {
      method: 'POST',
      body: {},
    });
    expect(apiUnknown.status).toBe(404);
    expect(apiUnknown.headers.get('content-type') || '').toContain('application/json');
  });

  test('T2-F5.1-05 invalid Range returns 416 and /admin / /vault do not eagerly fetch heavy chunks', async ({
    page,
  }) => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('f51-416')}.bin`,
      sizeBytes: 128,
    });

    try {
      const anon = createApiClient();
      const redeem = await anon.redeemVault(created.passcode);
      expect(redeem.status).toBe(200);
      const ticketId = extractTicketId(redeem.data as { ticketId?: string; downloadUrl?: string });

      const oob = await anon.downloadVaultTicket(ticketId, { range: 'bytes=5000-' });
      expect(oob.status).toBe(416);

      const heavyUrls: string[] = [];
      page.on('request', (req) => {
        if (/ogl|maplibre|astronomy|stellarium/i.test(req.url())) {
          heavyUrls.push(req.url());
        }
      });
      await page.goto('/admin', { waitUntil: 'networkidle' });
      expect(heavyUrls).toEqual([]);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });
});

// ============================================================================
// F5.2 — Auth, Setup, Origin, CSRF, Brute-Force 429 & Blocklist (7 tests)
// ============================================================================
test.describe('Tier 2 — F5.2 Security & Auth Adversarial Boundaries', () => {
  test('T2-F5.2-01 unauthenticated /api/admin/* and /api/security rejected with 401', async () => {
    const anon = createApiClient();

    expect((await anon.getAdminUsage()).status).toBe(401);
    expect((await anon.getAdminBackup()).status).toBe(401);
    expect((await anon.trashItem('vault_file', 'vf-missing')).status).toBe(401);
    expect((await anon.getSecurity()).status).toBe(401);
  });

  test('T2-F5.2-02 invalid, missing, or short /__setup token rejected with 403 and no cookie', async () => {
    const client = createApiClient();
    for (const pathUrl of ['/__setup', '/__setup?token=short', '/__setup?token=' + 'z'.repeat(40)]) {
      const res = await client.request<string>(pathUrl, {
        method: 'GET',
        redirect: 'manual',
        responseType: 'text',
      });
      expect(res.status, `Expected 403 for ${pathUrl}`).toBe(403);
      const setCookie = res.headers.getSetCookie().join(';');
      expect(setCookie).not.toContain('travel_setup=');
    }
  });

  test('T2-F5.2-03 missing or cross-origin Origin on mutation rejected with 403', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const noOrigin = await admin.request('/api/admin/settings', {
      method: 'PATCH',
      origin: null,
      body: { retentionDays: 30 },
    });
    expect(noOrigin.status).toBe(403);

    const crossOrigin = await admin.postAuth(
      { action: 'login', password: ADMIN_PASSWORD },
      { origin: 'https://attacker.invalid' },
    );
    expect(crossOrigin.status).toBe(403);
  });

  test('T2-F5.2-04 missing or forged X-Travel-CSRF on authenticated mutations rejected with 403', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const noCsrfPatch = await admin.patchSecurity({ retentionDays: 30 }, { csrfToken: null });
    expect(noCsrfPatch.status).toBe(403);

    const forgedTrash = await admin.request('/api/admin/trash', {
      method: 'POST',
      csrfToken: '0000forged',
      body: { kind: 'vault_file', id: 'nonexistent' },
    });
    expect(forgedTrash.status).toBe(403);

    const noCsrfBlock = await admin.request('/api/security/block', {
      method: 'POST',
      csrfToken: null,
      body: { action: 'block', type: 'ip', value: PUBLIC_TEST_IP },
    });
    expect(noCsrfBlock.status).toBe(403);
  });

  test('T2-F5.2-05 brute-force login returns 429 after 5 wrong attempts on isolated synthetic IP', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const attackerIp = uniqueSyntheticIp();
    for (let i = 0; i < 5; i += 1) {
      const attacker = createApiClient();
      const res = await attacker.postAuth(
        { action: 'login', password: `wrong-password-${i}` },
        { headers: { 'cf-connecting-ip': attackerIp } },
      );
      expect(res.status, `Attempt ${i + 1} should return 401`).toBe(401);
    }

    // 6th attempt from same synthetic IP must return 429 even with the correct password
    const blockedAttacker = createApiClient();
    const lockedRes = await blockedAttacker.postAuth(
      { action: 'login', password: ADMIN_PASSWORD },
      { headers: { 'cf-connecting-ip': attackerIp } },
    );
    expect(lockedRes.status).toBe(429);

    // 127.0.0.1 remains unthrottled
    const legitimate = createApiClient();
    const okRes = await legitimate.postAuth({ action: 'login', password: ADMIN_PASSWORD });
    expect(okRes.status).toBe(200);
  });

  test('T2-F5.2-06 self-block and private/reserved IP block rejected with 400', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const ownVisitorId = await resolveVisitorId(admin, admin);
    const selfBlock = await admin.blockTarget({ type: 'visitor', value: ownVisitorId });
    expect(selfBlock.status).toBe(400);

    for (const reservedIp of ['127.0.0.1', '192.168.1.1', '203.0.113.5']) {
      const res = await admin.blockTarget({ type: 'ip', value: reservedIp });
      expect(res.status, `Expected 400 for reserved IP ${reservedIp}`).toBe(400);
    }
  });

  test('T2-F5.2-07 blocked visitor ID and blocked public IP are denied 403 and restored in finally', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const visitor = createApiClient();
    const visitorId = await resolveVisitorId(admin, visitor);

    try {
      expect((await admin.blockTarget({ type: 'visitor', value: visitorId })).status).toBe(200);
      const deniedVisitor = await visitor.getLibrary();
      expect(deniedVisitor.status).toBe(403);
    } finally {
      await admin.unblockTarget({ type: 'visitor', value: visitorId });
    }

    const restoredVisitor = await visitor.getLibrary();
    expect(restoredVisitor.status).toBe(200);

    // Also verify public IP blocking + restore
    const ipVisitor = createApiClient();
    try {
      expect((await admin.blockTarget({ type: 'ip', value: PUBLIC_TEST_IP })).status).toBe(200);
      const deniedIp = await ipVisitor.request('/api/library', {
        method: 'GET',
        headers: { 'cf-connecting-ip': PUBLIC_TEST_IP },
      });
      expect(deniedIp.status).toBe(403);
    } finally {
      await admin.unblockTarget({ type: 'ip', value: PUBLIC_TEST_IP });
    }
  });
});

// ============================================================================
// F5.3 — Non-Poisoning Live E2E Cost Circuit Breaker Boundaries (5 tests)
// ============================================================================
test.describe('Tier 2 — F5.3 Non-Poisoning Cost Circuit Breaker Boundaries', () => {
  test('T2-F5.3-01 non-poisoning 507: upload init exceeding 2 GiB rejects 507 before R2 write with 0 bytes delta', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeUsage = await admin.getAdminUsage();
    expect(beforeUsage.status).toBe(200);
    const bytesBefore = getCounterValue(beforeUsage.data.counters, 'r2-upload-bytes:lifetime');

    const overTwoGiB = 2 * 1024 ** 3 + 1;
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('over2g')}.bin`,
      mime: 'application/octet-stream',
      size: overTwoGiB,
      sha256: 'c'.repeat(64),
      totalChunks: 257,
    });
    expect(initRes.status).toBe(507);

    const afterUsage = await admin.getAdminUsage();
    const bytesAfter = getCounterValue(afterUsage.data.counters, 'r2-upload-bytes:lifetime');
    expect(bytesAfter - bytesBefore).toBe(0);
  });

  test('T2-F5.3-02 negative/invalid size (-1, 1.5, null) in upload init rejected 400 without altering upload bytes', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeUsage = await admin.getAdminUsage();
    const bytesBefore = getCounterValue(beforeUsage.data.counters, 'r2-upload-bytes:lifetime');

    for (const badSize of [-1, 1.5, null]) {
      const res = await admin.request('/api/vault/uploads/init', {
        method: 'POST',
        body: {
          name: 'bad-size.bin',
          mime: 'application/octet-stream',
          size: badSize,
          sha256: 'd'.repeat(64),
          totalChunks: 1,
        },
      });
      expect(res.status, `Expected 400 for size=${String(badSize)}`).toBe(400);
    }

    const afterUsage = await admin.getAdminUsage();
    const bytesAfter = getCounterValue(afterUsage.data.counters, 'r2-upload-bytes:lifetime');
    expect(bytesAfter - bytesBefore).toBe(0);
  });

  test('T2-F5.3-03 exact >16 MiB single-PUT chunk rejected 413 by withCostLimits leaving 0 upload bytes delta', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const overPutBytes = 16 * 1024 * 1024 + 1;
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('put16m')}.bin`,
      mime: 'application/octet-stream',
      size: overPutBytes,
      sha256: 'e'.repeat(64),
      totalChunks: 3,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    const beforeUsage = await admin.getAdminUsage();
    const bytesBefore = getCounterValue(beforeUsage.data.counters, 'r2-upload-bytes:lifetime');

    try {
      const bigBuf = Buffer.alloc(overPutBytes, 0x5a);
      const chunkRes = await admin.uploadVaultChunk(uploadId, 0, bigBuf);
      expect(chunkRes.status).toBe(413);

      const afterUsage = await admin.getAdminUsage();
      const bytesAfter = getCounterValue(afterUsage.data.counters, 'r2-upload-bytes:lifetime');
      expect(bytesAfter - bytesBefore).toBe(0);
    } finally {
      await admin.abortVaultUpload(uploadId);
    }
  });

  test('T2-F5.3-04 aborted upload does NOT refund r2-upload-bytes:lifetime (monotonic non-decreasing)', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeUsage = await admin.getAdminUsage();
    const bytesBefore = getCounterValue(beforeUsage.data.counters, 'r2-upload-bytes:lifetime');

    const chunkBytes = 2048;
    const { buffer, sha256 } = createBinaryChunkPayload(chunkBytes * 2, 63);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('norefund')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 2,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    expect((await admin.uploadVaultChunk(uploadId, 0, buffer.subarray(0, chunkBytes))).status).toBe(
      200,
    );
    const afterChunkUsage = await admin.getAdminUsage();
    const bytesAfterChunk = getCounterValue(
      afterChunkUsage.data.counters,
      'r2-upload-bytes:lifetime',
    );
    expect(bytesAfterChunk - bytesBefore).toBeGreaterThanOrEqual(chunkBytes);

    expect([200, 204]).toContain((await admin.abortVaultUpload(uploadId)).status);

    const afterAbortUsage = await admin.getAdminUsage();
    const bytesAfterAbort = getCounterValue(
      afterAbortUsage.data.counters,
      'r2-upload-bytes:lifetime',
    );
    expect(bytesAfterAbort).toBeGreaterThanOrEqual(bytesAfterChunk);
  });

  test('T2-F5.3-05 concurrent API burst preserves atomic api-requests monotonicity and non-decreasing R2 counters', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeRes = await admin.getAdminUsage();
    const month = (beforeRes.data as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
    const apiKey = `api-requests:${month}`;
    const classAKey = `r2-class-a:${month}`;
    const classBKey = `r2-class-b:${month}`;

    const apiBefore = getCounterValue(beforeRes.data.counters, apiKey);
    const classABefore = getCounterValue(beforeRes.data.counters, classAKey);
    const classBBefore = getCounterValue(beforeRes.data.counters, classBKey);

    const burst = await Promise.all(
      Array.from({ length: 12 }, () => admin.getAtlasConfig()),
    );
    for (const r of burst) {
      expect(r.status).toBe(200);
    }

    const afterRes = await admin.getAdminUsage();
    expect(getCounterValue(afterRes.data.counters, apiKey) - apiBefore).toBeGreaterThanOrEqual(13);
    expect(getCounterValue(afterRes.data.counters, classAKey)).toBeGreaterThanOrEqual(classABefore);
    expect(getCounterValue(afterRes.data.counters, classBKey)).toBeGreaterThanOrEqual(classBBefore);
  });
});

// ============================================================================
// F5.4 — Backup Auth, Trash/Restore Integrity & Secret Exclusion (5 tests)
// ============================================================================
test.describe('Tier 2 — F5.4 Backup & Trash/Restore Integrity', () => {
  test('T2-F5.4-01 unauthenticated GET /api/admin/backup and /api/admin/usage return 401 with zero ZIP bytes', async () => {
    const anon = createApiClient();

    const usageRes = await anon.getAdminUsage();
    expect(usageRes.status).toBe(401);

    const backupRes = await anon.getAdminBackup();
    expect(backupRes.status).toBe(401);
    expect(backupRes.headers.get('content-type') || '').not.toContain('application/zip');
    // ZIP magic bytes PK\x03\x04 must not appear
    expect(backupRes.buffer.subarray(0, 2).toString('ascii')).not.toBe('PK');
  });

  test('T2-F5.4-02 POST /api/admin/trash rejects vault_file with active share (409)', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('active-share')}.bin`,
      maxDownloads: 5,
      expiresIn: 3600,
    });

    try {
      const trashRes = await admin.trashItem('vault_file', created.fileId);
      expect(trashRes.status).toBe(409);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T2-F5.4-03 POST /api/admin/trash rejects media referenced by a journey (409)', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const mediaId = await uploadUniqueAtlasMedia(admin);
    const journeyId = uniqueId('j-ref');
    const jRes = await admin.saveJourney({
      id: journeyId,
      title: '引用检查旅程',
      subtitle: '',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      visibility: 'private',
      coverId: mediaId,
      stops: [
        {
          id: uniqueId('stop'),
          name: '大理站',
          region: '云南',
          lat: 25.6065,
          lng: 100.2676,
          date: '2026-10-01',
          note: '',
          mediaIds: [mediaId],
        },
      ],
    });
    expect([200, 201]).toContain(jRes.status);

    try {
      const trashMedia = await admin.trashItem('media', mediaId);
      expect(trashMedia.status).toBe(409);
    } finally {
      await admin.trashItem('journey', journeyId).catch(() => undefined);
      await admin.trashItem('media', mediaId).catch(() => undefined);
    }
  });

  test('T2-F5.4-04 trash invalid kind/id (400), missing record (404), double-trash (409), and restore missing key (404) / journey missing media (409)', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const badKind = await admin.request('/api/admin/trash', {
      method: 'POST',
      body: { kind: 'unknown_kind', id: 'abc' },
    });
    expect(badKind.status).toBe(400);

    const badId = await admin.request('/api/admin/trash', {
      method: 'POST',
      body: { kind: 'vault_file', id: '../escape' },
    });
    expect(badId.status).toBe(400);

    const missingRecord = await admin.trashItem('vault_file', `missing-${crypto.randomUUID()}`);
    expect(missingRecord.status).toBe(404);

    const missingRestore = await admin.restoreItem(crypto.randomUUID());
    expect(missingRestore.status).toBe(404);

    // Double-trash check on a real vault_file
    const { buffer, sha256 } = createBinaryChunkPayload(1024, 93);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('dbltrash')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    const firstTrash = await admin.trashItem('vault_file', fileId);
    expect(firstTrash.status).toBe(200);
    const trashKey = String(firstTrash.data.key || '');
    try {
      const secondTrash = await admin.trashItem('vault_file', fileId);
      expect(secondTrash.status).toBe(409);
    } finally {
      await admin.restoreItem(trashKey);
    }

    // Journey missing media (409) when restoring a journey whose referenced media is still in trash
    const refMediaId = await uploadUniqueAtlasMedia(admin);
    const refJourneyId = uniqueId('j-restore409');
    const jRes = await admin.saveJourney({
      id: refJourneyId,
      title: '恢复约束旅程',
      subtitle: '',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      visibility: 'private',
      coverId: refMediaId,
      stops: [
        {
          id: uniqueId('stop'),
          name: '大理站',
          region: '云南',
          lat: 25.6065,
          lng: 100.2676,
          date: '2026-10-01',
          note: '',
          mediaIds: [refMediaId],
        },
      ],
    });
    expect([200, 201]).toContain(jRes.status);

    let journeyTrashKey = '';
    let mediaTrashKey = '';
    try {
      const tj = await admin.trashItem('journey', refJourneyId);
      expect(tj.status).toBe(200);
      journeyTrashKey = String(tj.data.key || '');
      expect(journeyTrashKey.length).toBeGreaterThan(0);

      const tm = await admin.trashItem('media', refMediaId);
      expect(tm.status).toBe(200);
      mediaTrashKey = String(tm.data.key || '');
      expect(mediaTrashKey.length).toBeGreaterThan(0);

      const blockedRestore = await admin.restoreItem(journeyTrashKey);
      expect(blockedRestore.status).toBe(409);

      const restoreMedia = await admin.restoreItem(mediaTrashKey);
      expect(restoreMedia.status).toBe(200);
      mediaTrashKey = '';

      const restoreJourney = await admin.restoreItem(journeyTrashKey);
      expect(restoreJourney.status).toBe(200);
      journeyTrashKey = '';
    } finally {
      if (!journeyTrashKey) {
        await admin.trashItem('journey', refJourneyId).catch(() => undefined);
      }
      if (!mediaTrashKey) {
        await admin.trashItem('media', refMediaId).catch(() => undefined);
      }
    }
  });

  test('T2-F5.4-05 backup archive excludes sessions, usage, uploads, tickets, and env secrets after activity', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('exclusions')}.bin`,
      sizeBytes: 1024,
    });

    try {
      const anon = createApiClient();
      await anon.redeemVault(created.passcode);

      const backupRes = await admin.getAdminBackup();
      expect(backupRes.status).toBe(200);
      const files = unzipSync(new Uint8Array(backupRes.data));
      const sqlBytes = files['library.sql'];
      if (!sqlBytes) throw new Error('library.sql missing');
      const sqlText = new TextDecoder().decode(sqlBytes);

      for (const forbidden of [
        'security_sessions',
        'usage_limits',
        'vault_uploads',
        'vault_tickets',
        'SESSION_SECRET',
        'SETUP_TOKEN',
      ]) {
        expect(sqlText).not.toContain(forbidden);
      }
      expect(sqlText).not.toContain(ADMIN_PASSWORD);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });
});

// ============================================================================
// F5.5 — Adversarial Temp-Fixture Tests for Local-Only Safety Guard (5 tests)
// ============================================================================
test.describe('Tier 2 — F5.5 Adversarial Local-Only Safety Boundary', () => {
  test('T2-F5.5-01 remote: true on D1 or R2 binding fails auditLocalOnlyBoundary', () => {
    const dir = makeTempLocalRepo({
      wranglerJsonc: JSON.stringify({
        name: 'bad-remote',
        workers_dev: false,
        preview_urls: false,
        d1_databases: [{ binding: 'DB', database_name: 'd1', remote: true }],
        r2_buckets: [{ binding: 'MEDIA', bucket_name: 'r2', remote: true }],
      }),
    });
    try {
      const audit = auditLocalOnlyBoundary(dir);
      expect(audit.ok).toBe(false);
      expect(audit.violations.some((v) => v.includes('remote'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2-F5.5-02 workers_dev: true or preview_urls: true fails auditLocalOnlyBoundary', () => {
    const dir = makeTempLocalRepo({
      wranglerJsonc: JSON.stringify({
        name: 'bad-workers-dev',
        workers_dev: true,
        preview_urls: true,
        d1_databases: [{ binding: 'DB', database_name: 'd1', remote: false }],
        r2_buckets: [{ binding: 'MEDIA', bucket_name: 'r2', remote: false }],
      }),
    });
    try {
      const audit = auditLocalOnlyBoundary(dir);
      expect(audit.ok).toBe(false);
      expect(audit.violations.some((v) => v.includes('workers_dev'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('preview_urls'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2-F5.5-03 account_id, routes, custom_domain, and lvtushouji.xyz fail while JSONC comments are resilient', () => {
    // Comments mentioning lvtushouji.xyz outside active JSON values should pass
    const cleanCommentDir = makeTempLocalRepo({
      wranglerJsonc: `// Local copy — never deploy to lvtushouji.xyz
{
  /* block comment with lvtushouji.xyz */
  "name": "local-only",
  "workers_dev": false,
  "preview_urls": false,
  "d1_databases": [{ "binding": "DB", "database_name": "d1", "remote": false, }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "r2", "remote": false, },],
}`,
    });
    try {
      expect(auditLocalOnlyBoundary(cleanCommentDir).ok).toBe(true);
    } finally {
      fs.rmSync(cleanCommentDir, { recursive: true, force: true });
    }

    const badDir = makeTempLocalRepo({
      wranglerJsonc: JSON.stringify({
        name: 'bad-prod-fields',
        account_id: '00000000000000000000000000000000',
        routes: [{ pattern: 'lvtushouji.xyz/*', custom_domain: true }],
        workers_dev: false,
        preview_urls: false,
        d1_databases: [{ binding: 'DB', database_name: 'd1', remote: false }],
        r2_buckets: [{ binding: 'MEDIA', bucket_name: 'r2', remote: false }],
      }),
    });
    try {
      const audit = auditLocalOnlyBoundary(badDir);
      expect(audit.ok).toBe(false);
      expect(audit.violations.some((v) => v.includes('account_id'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('routes'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('custom_domain'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('lvtushouji.xyz'))).toBe(true);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  test('T2-F5.5-04 package.json with wrangler deploy or --remote fails auditLocalOnlyBoundary', () => {
    const dir = makeTempLocalRepo({
      packageJson: JSON.stringify({
        name: 'bad-scripts',
        scripts: {
          deploy: 'wrangler deploy',
          migrate: 'wrangler d1 migrations apply db --remote',
        },
      }),
    });
    try {
      const audit = auditLocalOnlyBoundary(dir);
      expect(audit.ok).toBe(false);
      expect(audit.violations.some((v) => v.includes('deploy'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('--remote'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2-F5.5-05 env.prod override, duplicate wrangler.toml, and .dev.vars CLOUDFLARE_API_TOKEN fail while live repo passes', () => {
    const dir = makeTempLocalRepo({
      wranglerJsonc: JSON.stringify({
        name: 'bad-env-prod',
        workers_dev: false,
        preview_urls: false,
        d1_databases: [{ binding: 'DB', database_name: 'd1', remote: false }],
        r2_buckets: [{ binding: 'MEDIA', bucket_name: 'r2', remote: false }],
        env: {
          prod: {
            account_id: 'prod-acc',
            workers_dev: true,
          },
        },
      }),
      devVars: 'CLOUDFLARE_API_TOKEN=secret-token-value\n',
      extraFiles: {
        'wrangler.toml': 'name = "shadow-toml"\n',
      },
    });
    try {
      const audit = auditLocalOnlyBoundary(dir);
      expect(audit.ok).toBe(false);
      expect(audit.violations.some((v) => v.includes('wrangler.toml'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('env.prod'))).toBe(true);
      expect(audit.violations.some((v) => v.includes('.dev.vars') && v.includes('credential'))).toBe(
        true,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Live workspace repo must still pass cleanly
    const liveClient = createApiClient();
    expect(auditLocalOnlyBoundary(liveClient.repoRoot).ok).toBe(true);
  });
});
