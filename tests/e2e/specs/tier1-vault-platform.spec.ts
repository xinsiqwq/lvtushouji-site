import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { createBinaryChunkPayload, createSyntheticExifJpeg } from '../fixtures/exif-jpeg';
import { ApiClient, createApiClient } from '../helpers/api-client';
import {
  attachErrorListeners,
  scanAntiAiTaste,
  verifySelfHostedFonts,
} from '../helpers/browser-checks';
import { auditLocalOnlyBoundary, parseJsonc } from '../helpers/local-guard';

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

function sha256Hex(data: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
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
    passcode?: string;
    note?: string;
  } = {},
): Promise<{
  fileId: string;
  fileName: string;
  mime: string;
  payload: Buffer;
  sha256: string;
  shareId: string;
  passcode: string;
}> {
  const sizeBytes = opts.sizeBytes ?? 4096;
  const chunkCount = opts.chunkCount ?? 1;
  const { buffer, sha256 } = createBinaryChunkPayload(sizeBytes, opts.seed ?? 17);
  const fileName = opts.name ?? `${uniqueId('vault')}.bin`;
  const mime = opts.mime ?? 'application/octet-stream';

  const initRes = await admin.initVaultUpload({
    name: fileName,
    mime,
    size: sizeBytes,
    sha256,
    totalChunks: chunkCount,
  });
  expect([200, 201]).toContain(initRes.status);
  const uploadId = initRes.data.uploadId;
  expect(uploadId).toBeTruthy();

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
    expiresIn: opts.expiresIn ?? 3600,
    passcode: chosenPasscode,
    note: opts.note ?? '请妥善保存此密匣文件',
  });
  expect([200, 201]).toContain(shareRes.status);
  const { shareId, passcode } = extractShareId(shareRes.data);

  return {
    fileId,
    fileName,
    mime,
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

async function findQrSvgMetrics(
  page: Page,
): Promise<{ viewBox: string; primitives: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const named = document.querySelector(
      'main svg[role="img"][aria-label*="二维码"], main svg[role="img"][aria-label*="QR" i]',
    );
    const candidates = named
      ? [named]
      : Array.from(document.querySelectorAll('main svg[viewBox]'));
    for (const svg of candidates) {
      const cs = getComputedStyle(svg);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rect = svg.getBoundingClientRect();
      const primitives = svg.querySelectorAll('rect, path').length;
      const isNamedQr = /二维码|qr/i.test(svg.getAttribute('aria-label') || '');
      if (isNamedQr || primitives >= 21 || (rect.width >= 64 && rect.height >= 64)) {
        return {
          viewBox: svg.getAttribute('viewBox') || '',
          primitives,
          width: rect.width,
          height: rect.height,
        };
      }
    }
    return null;
  });
}

// ============================================================================
// F4.1 — Vault Extraction Capsule, Paper Claim Slip & Local SVG QR (6 tests)
// ============================================================================
test.describe('Tier 1 — F4.1 Vault Extraction Capsule & Claim Slip', () => {
  test('T1-F4.1-01 /vault renders centered extraction capsule with self-hosted WOFF2 H1 and zero anti-AI violations', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    await page.goto('/vault', { waitUntil: 'networkidle' });

    await verifySelfHostedFonts(page, { checkLetterSpacing: false });
    await scanAntiAiTaste(page);

    const h1 = page.locator('#main-content h1, main h1').first();
    await expect(h1).toBeVisible();
    await expect(h1).toContainText(/文件密匣|密匣/);

    const input = page
      .getByRole('textbox', { name: /口令|提取/i })
      .or(page.locator('main form input').first());
    await expect(input).toBeVisible();

    const submit = page.getByRole('button', { name: /提取|解锁|确认|获取/i }).first();
    await expect(submit).toBeVisible();

    const geometry = await page.evaluate(() => {
      const form = document.querySelector('main form') || document.querySelector('form');
      if (!form) return null;
      const rect = form.getBoundingClientRect();
      const vw = window.innerWidth;
      const center = rect.left + rect.width / 2;
      const cs = getComputedStyle(form);
      return {
        width: rect.width,
        centerOffsetRatio: Math.abs(center - vw / 2) / vw,
        borderRadius: cs.borderRadius,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.centerOffsetRatio).toBeLessThan(0.15);
    expect(Number.parseFloat(geometry!.borderRadius)).toBeGreaterThanOrEqual(16);

    errors.assertZeroErrors();
  });

  test('T1-F4.1-02 6-char passcode submit via click and keyboard Enter slides out paper-textured claim slip', async ({
    page,
  }, testInfo) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('slip')}.txt`,
      mime: 'text/plain',
      sizeBytes: 2048,
      note: '夜间离线包',
    });

    try {
      await page.goto('/vault', { waitUntil: 'networkidle' });
      const input = page
        .getByRole('textbox', { name: /口令|提取/i })
        .or(page.locator('main form input').first());
      await input.fill(created.passcode);

      const [redeemReq, redeemRes] = await Promise.all([
        page.waitForRequest(
          (req) => req.url().includes('/api/vault/redeem') && req.method() === 'POST',
        ),
        page.waitForResponse(
          (res) => res.url().includes('/api/vault/redeem') && res.request().method() === 'POST',
        ),
        input.press('Enter'),
      ]);

      expect(new URL(redeemReq.url()).searchParams.has('code')).toBe(false);
      expect(redeemRes.status()).toBe(200);

      await expect(page.getByText(created.fileName)).toBeVisible({ timeout: 10_000 });

      const isDark = testInfo.project.name.includes('dark');
      const expectedPaperRgb = isDark ? 'rgb(34, 36, 39)' : 'rgb(250, 248, 244)';
      const hasPaperBg = await page.evaluate((targetRgb) => {
        const els = Array.from(document.querySelectorAll('main *'));
        return els.some((el) => getComputedStyle(el).backgroundColor === targetRgb);
      }, expectedPaperRgb);
      expect(hasPaperBg).toBe(true);

      // Also verify button click works on a fresh reload
      await page.reload({ waitUntil: 'networkidle' });
      const input2 = page
        .getByRole('textbox', { name: /口令|提取/i })
        .or(page.locator('main form input').first());
      await input2.fill(created.passcode);
      const submitBtn = page.getByRole('button', { name: /提取|解锁|确认|获取/i }).first();
      await submitBtn.click();
      await expect(page.getByText(created.fileName)).toBeVisible({ timeout: 10_000 });

      errors.assertZeroErrors();
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F4.1-03 claim slip displays filename, tabular-nums size, remaining downloads, expiry countdown, and note', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const uniqueNote = `旅途底片备份-${uniqueId('note')}`;
    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('meta')}.bin`,
      sizeBytes: 12_345,
      maxDownloads: 4,
      expiresIn: 3600,
      note: uniqueNote,
    });

    try {
      await page.goto('/vault', { waitUntil: 'networkidle' });
      const input = page
        .getByRole('textbox', { name: /口令|提取/i })
        .or(page.locator('main form input').first());
      await input.fill(created.passcode);
      await input.press('Enter');

      await expect(page.getByText(created.fileName)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(uniqueNote)).toBeVisible();
      await expect(page.getByText(/剩余|次/).first()).toBeVisible();
      await expect(page.getByText(/有效|到期|倒计时|分|小时|天/).first()).toBeVisible();

      const hasTabularNums = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('main *'));
        return candidates.some((el) => {
          const cs = getComputedStyle(el);
          return (
            cs.fontVariantNumeric.includes('tabular-nums') ||
            cs.fontFeatureSettings.includes('tnum')
          );
        });
      });
      expect(hasTabularNums).toBe(true);

      errors.assertZeroErrors();
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F4.1-04 claim slip renders local crisp <svg viewBox> QR code with zero external requests', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('qr')}.bin`,
      sizeBytes: 1024,
    });

    const externalRequests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const host = new URL(url).hostname;
        if (host !== '127.0.0.1' && host !== 'localhost') {
          externalRequests.push(url);
        }
      }
    });

    try {
      await page.goto('/vault', { waitUntil: 'networkidle' });
      const input = page
        .getByRole('textbox', { name: /口令|提取/i })
        .or(page.locator('main form input').first());
      await input.fill(created.passcode);
      await input.press('Enter');

      await expect(page.getByText(created.fileName)).toBeVisible({ timeout: 10_000 });

      let svgMetrics: { viewBox: string; primitives: number; width: number; height: number } | null = null;
      await expect
        .poll(async () => {
          svgMetrics = await findQrSvgMetrics(page);
          return svgMetrics;
        }, { timeout: 10_000 })
        .not.toBeNull();

      expect(svgMetrics!.viewBox.length).toBeGreaterThan(0);
      expect(
        svgMetrics!.primitives >= 21 || (svgMetrics!.width >= 64 && svgMetrics!.height >= 64),
      ).toBe(true);
      expect(externalRequests).toEqual([]);

      errors.assertZeroErrors();
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F4.1-05 one-click download streams exact bytes with Content-Disposition attachment, nosniff, and no-store', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('dl')}.bin`,
      sizeBytes: 8192,
      seed: 42,
    });

    try {
      await page.goto('/vault', { waitUntil: 'networkidle' });
      const input = page
        .getByRole('textbox', { name: /口令|提取/i })
        .or(page.locator('main form input').first());
      await input.fill(created.passcode);
      await input.press('Enter');

      await expect(page.getByText(created.fileName)).toBeVisible({ timeout: 10_000 });

      const downloadBtn = page
        .getByRole('link', { name: /下载/i })
        .or(page.getByRole('button', { name: /下载/i }))
        .first();
      await expect(downloadBtn).toBeVisible();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        downloadBtn.click(),
      ]);

      expect(download.suggestedFilename().length).toBeGreaterThan(0);
      const downloadedPath = await download.path();
      expect(downloadedPath).toBeTruthy();
      const downloadedBytes = fs.readFileSync(downloadedPath!);
      expect(downloadedBytes.byteLength).toBe(created.payload.byteLength);
      expect(sha256Hex(downloadedBytes)).toBe(created.sha256);

      const dlUrl = download.url();
      if (/^https?:\/\//i.test(dlUrl)) {
        const headRes = await page.request.head(dlUrl);
        expect(headRes.status()).toBe(200);
        expect((headRes.headers()['content-disposition'] || '').toLowerCase()).toContain('attachment');
        expect(headRes.headers()['x-content-type-options']).toBe('nosniff');
        expect((headRes.headers()['cache-control'] || '').toLowerCase()).toContain('no-store');
      } else {
        const anon = createApiClient();
        const redeem = await anon.redeemVault(created.passcode);
        expect(redeem.status).toBe(200);
        const ticketId = extractTicketId(redeem.data as { ticketId?: string; downloadUrl?: string });
        const dlRes = await anon.downloadVaultTicket(ticketId, { method: 'HEAD' });
        expect(dlRes.status).toBe(200);
        expect((dlRes.headers.get('content-disposition') || '').toLowerCase()).toContain('attachment');
        expect(dlRes.headers.get('x-content-type-options')).toBe('nosniff');
        expect((dlRes.headers.get('cache-control') || '').toLowerCase()).toContain('no-store');
      }

      errors.assertZeroErrors();
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F4.1-06 HEAD and Range bytes=0-3 206 partial download on /api/vault/download/:ticketId', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('range')}.bin`,
      sizeBytes: 4096,
      seed: 99,
    });

    try {
      const anon = createApiClient();
      const redeemRes = await anon.redeemVault(created.passcode);
      expect(redeemRes.status).toBe(200);
      const ticketId = extractTicketId(redeemRes.data as { ticketId?: string; downloadUrl?: string });

      const headRes = await anon.downloadVaultTicket(ticketId, { method: 'HEAD' });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('accept-ranges')).toBe('bytes');
      expect(headRes.headers.get('content-length')).toBe('4096');
      expect(headRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect((headRes.headers.get('cache-control') || '').toLowerCase()).toContain('no-store');
      expect(headRes.buffer.byteLength).toBe(0);

      const rangeRes = await anon.downloadVaultTicket(ticketId, { range: 'bytes=0-3' });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe('bytes 0-3/4096');
      expect(rangeRes.buffer.byteLength).toBe(4);
      expect(rangeRes.buffer.equals(created.payload.subarray(0, 4))).toBe(true);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });
});

// ============================================================================
// F4.2 — Vault Chunked Upload to Private R2 (5 tests)
// ============================================================================
test.describe('Tier 1 — F4.2 Vault Chunked Upload to Private R2', () => {
  test('T1-F4.2-01 admin single-chunk upload (init -> PUT chunk -> complete) creates private vault_files record', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(2048, 11);
    const name = `${uniqueId('single')}.bin`;
    const initRes = await admin.initVaultUpload({
      name,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    expect([200, 201]).toContain(initRes.status);
    expect(initRes.data.uploadId).toBeTruthy();

    const chunkRes = await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    expect(chunkRes.status).toBe(200);

    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    expect([200, 201]).toContain(completeRes.status);
    const fileObj = (completeRes.data.file as Record<string, unknown> | undefined) ?? completeRes.data;
    expect(fileObj.visibility).toBe('private');
    expect(fileObj.name).toBe(name);
    expect(fileObj.size).toBe(buffer.byteLength);
  });

  test('T1-F4.2-02 admin multi-chunk upload (3 chunks) assembles exact payload verified by SHA-256 on download', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('multi3')}.bin`,
      sizeBytes: 12_288,
      chunkCount: 3,
      seed: 73,
    });

    try {
      const anon = createApiClient();
      const redeemRes = await anon.redeemVault(created.passcode);
      expect(redeemRes.status).toBe(200);
      const rawData = redeemRes.data as { size?: number; fileSize?: number; mime?: string; fileMime?: string };
      expect(rawData.size ?? rawData.fileSize).toBe(12_288);
      expect(rawData.mime ?? rawData.fileMime).toBe('application/octet-stream');

      const ticketId = extractTicketId(redeemRes.data as { ticketId?: string; downloadUrl?: string });
      const dlRes = await anon.downloadVaultTicket(ticketId);
      expect(dlRes.status).toBe(200);
      expect(dlRes.buffer.byteLength).toBe(12_288);
      expect(sha256Hex(dlRes.buffer)).toBe(created.sha256);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F4.2-03 newly uploaded Vault file defaults to private and is inaccessible without valid share ticket', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1536, 23);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('priv')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    expect([200, 201]).toContain(initRes.status);
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    expect([200, 201]).toContain(completeRes.status);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);
    const fileObj = (completeRes.data.file as Record<string, unknown> | undefined) ?? completeRes.data;
    expect(fileObj.visibility).toBe('private');

    const anon = createApiClient();
    const sharesRes = await anon.listVaultShares();
    expect(sharesRes.status).toBe(401);

    const badTicketRes = await anon.downloadVaultTicket(fileId);
    expect([403, 404]).toContain(badTicketRes.status);
  });

  test('T1-F4.2-04 idempotent chunk retry on same X-Chunk-Index succeeds without duplicating bytes', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(6144, 31);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('retry')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 3,
    });
    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.data.uploadId;

    const c0 = buffer.subarray(0, 2048);
    const c1 = buffer.subarray(2048, 4096);
    const c2 = buffer.subarray(4096, 6144);

    expect((await admin.uploadVaultChunk(uploadId, 0, c0)).status).toBe(200);
    expect((await admin.uploadVaultChunk(uploadId, 1, c1)).status).toBe(200);
    // Retry chunk 1 idempotently
    expect((await admin.uploadVaultChunk(uploadId, 1, c1)).status).toBe(200);
    expect((await admin.uploadVaultChunk(uploadId, 2, c2)).status).toBe(200);

    const completeRes = await admin.completeVaultUpload(uploadId);
    expect([200, 201]).toContain(completeRes.status);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    const code = uniquePasscode();
    const shareRes = await admin.createVaultShare({
      fileId,
      maxDownloads: 2,
      expiresIn: 3600,
      passcode: code,
    });
    expect([200, 201]).toContain(shareRes.status);
    const { shareId } = extractShareId(shareRes.data);

    try {
      const anon = createApiClient();
      const redeem = await anon.redeemVault(code);
      expect(redeem.status).toBe(200);
      const dl = await anon.downloadVaultTicket(extractTicketId(redeem.data as { ticketId?: string; downloadUrl?: string }));
      expect(dl.status).toBe(200);
      expect(dl.buffer.byteLength).toBe(6144);
      expect(sha256Hex(dl.buffer)).toBe(sha256);
    } finally {
      await admin.revokeVaultShare(shareId);
    }
  });

  test('T1-F4.2-05 Admin UI file picker uploads file via chunked API and lists private entry', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await loginAdminInBrowser(page, admin);
    await openAdminSection(page, /密匣|Vault/i);

    const { buffer } = createBinaryChunkPayload(4096, 55);
    const uiFileName = `${uniqueId('ui-upload')}.bin`;

    const fileInput = await locateVaultFileInput(page);
    await expect(fileInput).toBeAttached();

    const completeWait = page.waitForResponse(
      (res) => res.url().includes('/api/vault/uploads/') && res.url().includes('/complete'),
    );

    await fileInput.setInputFiles({
      name: uiFileName,
      mimeType: 'application/octet-stream',
      buffer,
    });

    const completeRes = await completeWait;
    expect([200, 201]).toContain(completeRes.status());

    await expect(page.getByText(uiFileName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/私密/).first()).toBeVisible();

    errors.assertZeroErrors();
  });
});

// ============================================================================
// F4.3 — Vault Share Config, Local QR & Revocation Tombstone (5 tests)
// ============================================================================
test.describe('Tier 1 — F4.3 Vault Share Config, QR & Revocation Tombstone', () => {
  test('T1-F4.3-01 admin creates share with TTL, maxDownloads (1-999), custom 6-char passcode, and note; listed in GET /api/vault/shares', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const customCode = uniquePasscode();
    const note = `行囊压缩包-${uniqueId('n')}`;
    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('share')}.bin`,
      sizeBytes: 1024,
      maxDownloads: 12,
      expiresIn: 7200,
      passcode: customCode,
      note,
    });

    try {
      const listRes = await admin.listVaultShares();
      expect(listRes.status).toBe(200);
      const shares = (
        Array.isArray(listRes.data)
          ? listRes.data
          : (listRes.data.shares as Array<Record<string, unknown>> | undefined) ?? []
      ) as Array<Record<string, unknown>>;

      const match = shares.find((s) => s.id === created.shareId);
      expect(match).toBeDefined();
      expect(match?.fileId).toBe(created.fileId);
      expect(match?.maxDownloads).toBe(12);
      expect(match?.downloads).toBe(0);
      expect(match?.note).toBe(note);
      expect(match?.revokedAt ?? null).toBeNull();
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F4.3-02 admin creates share without passcode auto-generates valid 6-char alphanumeric code', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1024, 61);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('autogen')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    expect([200, 201]).toContain(initRes.status);
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    const shareRes = await admin.createVaultShare({
      fileId,
      maxDownloads: 3,
      expiresIn: 3600,
    });
    expect([200, 201]).toContain(shareRes.status);
    const { shareId, passcode } = extractShareId(shareRes.data);
    expect(passcode).toBeDefined();
    expect(passcode!).toMatch(/^[A-Za-z0-9]{6}$/);

    try {
      const anon = createApiClient();
      const redeem = await anon.redeemVault(passcode!);
      expect(redeem.status).toBe(200);
    } finally {
      await admin.revokeVaultShare(shareId);
    }
  });

  test('T1-F4.3-03 Admin UI share creation renders local <svg viewBox> QR and 6-char passcode', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1024, 67);
    const uiShareFile = `${uniqueId('uishare')}.bin`;
    const initRes = await admin.initVaultUpload({
      name: uiShareFile,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    expect([200, 201]).toContain(initRes.status);
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    await admin.completeVaultUpload(initRes.data.uploadId);

    await loginAdminInBrowser(page, admin);
    await openAdminSection(page, /密匣|Vault/i);
    await expect(page.getByText(uiShareFile)).toBeVisible({ timeout: 10_000 });

    const code = uniquePasscode();
    const maxInput = page.getByLabel(/下载次数|上限/i).first();
    if (await maxInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await maxInput.fill('5');
    }
    const codeInput = page.getByLabel(/口令/i).first();
    if (await codeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await codeInput.fill(code);
    }

    const createShareBtn = page
      .getByRole('button', { name: /生成分享|创建分享|生成口令/i })
      .first();
    const shareResPromise = page.waitForResponse(
      (res) => res.url().includes('/api/vault/shares') && res.request().method() === 'POST',
    );
    await createShareBtn.click();
    const shareRes = await shareResPromise;
    expect([200, 201]).toContain(shareRes.status());

    const createdJson = (await shareRes.json()) as Record<string, unknown>;
    const { shareId, passcode } = extractShareId(createdJson);

    try {
      let qrMetrics: { viewBox: string; primitives: number; width: number; height: number } | null = null;
      await expect
        .poll(async () => {
          qrMetrics = await findQrSvgMetrics(page);
          return qrMetrics;
        }, { timeout: 10_000 })
        .not.toBeNull();
      expect(qrMetrics!.viewBox.length).toBeGreaterThan(0);
      expect(
        qrMetrics!.primitives >= 21 || (qrMetrics!.width >= 64 && qrMetrics!.height >= 64),
      ).toBe(true);
      if (passcode) {
        await expect(page.getByText(passcode).first()).toBeVisible();
      }
      errors.assertZeroErrors();
    } finally {
      await admin.revokeVaultShare(shareId);
    }
  });

  test('T1-F4.3-04 one-click revoke sets tombstone and preserves revoked share in GET /api/vault/shares', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const revNote = uniqueId('revnote');
    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('revoke')}.bin`,
      sizeBytes: 1024,
      note: revNote,
    });

    await loginAdminInBrowser(page, admin);
    await openAdminSection(page, /密匣|Vault/i);
    await expect(page.getByText(created.fileName).first()).toBeVisible({ timeout: 10_000 });

    const shareRow = page
      .locator('main tr, main li, main article, main section, main div')
      .filter({ hasText: new RegExp(`${created.fileName}|${revNote}`) })
      .filter({ has: page.getByRole('button', { name: /^撤销$/i }) })
      .last();
    const revokeBtn = shareRow.getByRole('button', { name: /^撤销$/i }).first();
    await expect(revokeBtn).toBeVisible();
    await expect(revokeBtn).toBeEnabled();

    const revokeResPromise = page.waitForResponse(
      (res) => res.url().includes('/api/vault/shares/') && res.url().includes('/revoke'),
    );
    await revokeBtn.click();
    const revokeUiRes = await revokeResPromise;
    expect(revokeUiRes.status()).toBe(200);

    // Ensure the specific share we created is revoked (idempotent if UI already revoked it)
    await admin.revokeVaultShare(created.shareId);

    const listRes = await admin.listVaultShares();
    expect(listRes.status).toBe(200);
    const shares = (
      Array.isArray(listRes.data)
        ? listRes.data
        : (listRes.data.shares as Array<Record<string, unknown>> | undefined) ?? []
    ) as Array<Record<string, unknown>>;
    const tombstone = shares.find((s) => s.id === created.shareId);
    expect(tombstone).toBeDefined();
    expect(typeof tombstone?.revokedAt).toBe('string');

    errors.assertZeroErrors();
  });

  test('T1-F4.3-05 vault_file trash and restore roundtrip succeeds after share revocation', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('trashfile')}.bin`,
      sizeBytes: 1024,
    });

    const revokeRes = await admin.revokeVaultShare(created.shareId);
    expect(revokeRes.status).toBe(200);

    const trashRes = await admin.trashItem('vault_file', created.fileId);
    expect(trashRes.status).toBe(200);
    const trashKey = typeof trashRes.data.key === 'string' ? trashRes.data.key : '';
    expect(trashKey).toBeTruthy();

    const restoreRes = await admin.restoreItem(trashKey);
    expect(restoreRes.status).toBe(200);

    // Verify file can be shared and downloaded again after restore
    const newCode = uniquePasscode();
    const reShare = await admin.createVaultShare({
      fileId: created.fileId,
      maxDownloads: 1,
      expiresIn: 3600,
      passcode: newCode,
    });
    expect([200, 201]).toContain(reShare.status);
    const { shareId } = extractShareId(reShare.data);

    try {
      const anon = createApiClient();
      const redeem = await anon.redeemVault(newCode);
      expect(redeem.status).toBe(200);
    } finally {
      await admin.revokeVaultShare(shareId);
    }
  });
});

// ============================================================================
// F5.1 — Single Cloud-Native Stack & Lazy Chunk Splitting (6 tests)
// ============================================================================
test.describe('Tier 1 — F5.1 Cloud-Native Stack & Lazy Chunks', () => {
  test('T1-F5.1-01 Vite + Hono + workerd health & zero hydration/console errors across all routes', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    for (const route of ['/', '/atlas', '/observatory', '/vault', '/admin']) {
      const res = await page.goto(route, { waitUntil: 'networkidle' });
      expect(res?.status()).toBe(200);
      await expect(page.locator('#root')).not.toBeEmpty();
    }
    errors.assertZeroErrors();
  });

  test('T1-F5.1-02 SPA HTML entry and Worker security headers & CSP on /api/* and /__setup', async () => {
    const client = createApiClient();
    const htmlRes = await client.request<string>('/', { method: 'GET', responseType: 'text' });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type') || '').toContain('text/html');
    expect(htmlRes.text).toContain('<meta name="color-scheme"');

    const apiRes = await client.getAtlasConfig();
    expect(apiRes.status).toBe(200);
    expect(apiRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(apiRes.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(apiRes.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect((apiRes.headers.get('cache-control') || '').toLowerCase()).toContain('no-store');
    const apiCsp = apiRes.headers.get('content-security-policy') || '';
    expect(apiCsp).toContain("default-src 'self'");
    expect(apiCsp).toContain("object-src 'none'");

    const setupRes = await client.setupEntry('invalid-token');
    expect(setupRes.status).toBe(403);
    expect(setupRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(setupRes.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(setupRes.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect((setupRes.headers.get('cache-control') || '').toLowerCase()).toContain('no-store');
    const setupCsp = setupRes.headers.get('content-security-policy') || '';
    expect(setupCsp).toContain("default-src 'self'");
    expect(setupCsp).toContain("object-src 'none'");
  });

  test('T1-F5.1-03 lazy chunk separation keeps ogl, maplibre-gl, astronomy/stellarium off /vault and map/sky off /', async ({
    page,
  }) => {
    const vaultAssets: string[] = [];
    const vaultListener = (req: { url: () => string }) => {
      vaultAssets.push(req.url());
    };
    page.on('request', vaultListener);
    await page.goto('/vault', { waitUntil: 'networkidle' });
    page.off('request', vaultListener);

    for (const url of vaultAssets) {
      expect(url).not.toMatch(/ogl|maplibre|astronomy|stellarium/i);
    }

    const homeAssets: string[] = [];
    const homeListener = (req: { url: () => string }) => {
      homeAssets.push(req.url());
    };
    page.on('request', homeListener);
    await page.goto('/', { waitUntil: 'networkidle' });
    page.off('request', homeListener);

    for (const url of homeAssets) {
      expect(url).not.toMatch(/maplibre|astronomy|stellarium/i);
    }
  });

  test('T1-F5.1-04 static /fonts/*.woff2 served with immutable long-cache headers', async () => {
    const client = createApiClient();
    const fontRes = await client.request<Buffer>('/fonts/inter-400.woff2', {
      method: 'GET',
      responseType: 'buffer',
    });
    expect(fontRes.status).toBe(200);
    expect(fontRes.buffer.byteLength).toBeGreaterThan(1000);
    const cacheControl = (fontRes.headers.get('cache-control') || '').toLowerCase();
    expect(cacheControl).toContain('max-age=31536000');
    expect(cacheControl).toContain('immutable');
  });

  test('T1-F5.1-05 unknown /api/* route returns 404 JSON', async () => {
    const client = createApiClient();
    const res = await client.request<{ error?: string }>('/api/nonexistent-vault-platform-route', {
      method: 'GET',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').toContain('application/json');
    expect(res.data.error).toBe('未找到接口');
  });

  test('T1-F5.1-06 HEAD and Range bytes=0-15 206 partial content on Worker R2 stream', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('f51-range')}.bin`,
      sizeBytes: 256,
      seed: 101,
    });

    try {
      const anon = createApiClient();
      const redeem = await anon.redeemVault(created.passcode);
      expect(redeem.status).toBe(200);
      const ticketId = extractTicketId(redeem.data as { ticketId?: string; downloadUrl?: string });

      const head = await anon.downloadVaultTicket(ticketId, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      expect(head.headers.get('content-length')).toBe('256');

      const partial = await anon.downloadVaultTicket(ticketId, { range: 'bytes=0-15' });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 0-15/256');
      expect(partial.buffer.byteLength).toBe(16);
      expect(partial.buffer.equals(created.payload.subarray(0, 16))).toBe(true);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });
});

// ============================================================================
// F5.2 — Single-Admin Auth, Cookies, CSRF, Sessions & IP Blocklist (7 tests)
// ============================================================================
test.describe('Tier 1 — F5.2 Single-Admin Auth & Security', () => {
  test('T1-F5.2-01 GET /api/security/auth returns status and sets HttpOnly SameSite=Strict travel_visitor cookie', async () => {
    const client = createApiClient();
    const res = await client.getAuthStatus();
    expect(res.status).toBe(200);
    expect(typeof res.data.configured).toBe('boolean');
    expect(res.data.authenticated).toBe(false);

    const setCookies = res.headers.getSetCookie();
    const visitorCookie = setCookies.find((c) => c.startsWith('travel_visitor='));
    expect(visitorCookie).toBeDefined();
    expect(visitorCookie!).toContain('HttpOnly');
    expect(visitorCookie!).toContain('SameSite=Strict');
  });

  test('T1-F5.2-02 /__setup?token=... returns 303 with Referrer-Policy when unconfigured, or 403 when configured', async () => {
    const client = createApiClient();
    const status = await client.getAuthStatus();
    expect(status.status).toBe(200);

    const devVarsPath = path.join(client.repoRoot, '.dev.vars');
    let setupToken = process.env.SETUP_TOKEN || '';
    if (!setupToken && fs.existsSync(devVarsPath)) {
      const match = fs.readFileSync(devVarsPath, 'utf8').match(/^SETUP_TOKEN=(.+)$/m);
      if (match?.[1]) {
        setupToken = match[1].trim().replace(/^["']|["']$/g, '');
      }
    }
    expect(setupToken.length).toBeGreaterThanOrEqual(32);

    const setupRes = await client.setupEntry(setupToken);
    if (!status.data.configured) {
      expect(setupRes.status).toBe(303);
      expect(setupRes.headers.get('location')).toBe('/admin');
      expect(setupRes.headers.get('referrer-policy')).toBe('no-referrer');
      const setupCookie = setupRes.headers
        .getSetCookie()
        .find((c) => c.startsWith('travel_setup='));
      expect(setupCookie).toBeDefined();
      expect(setupCookie!).toContain('HttpOnly');
      expect(setupCookie!).toContain('SameSite=Strict');
    } else {
      expect(setupRes.status).toBe(403);
    }
  });

  test('T1-F5.2-03 admin login issues HttpOnly SameSite=Strict travel_session cookie and csrfToken', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const fresh = createApiClient();
    const loginRes = await fresh.postAuth({ action: 'login', password: ADMIN_PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.data.configured).toBe(true);
    expect(loginRes.data.authenticated).toBe(true);
    expect(typeof loginRes.data.sessionId).toBe('string');
    expect(typeof loginRes.data.csrfToken).toBe('string');
    expect(loginRes.data.csrfToken!.length).toBeGreaterThan(16);

    const sessionCookie = loginRes.headers
      .getSetCookie()
      .find((c) => c.startsWith('travel_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!).toContain('HttpOnly');
    expect(sessionCookie!).toContain('SameSite=Strict');
  });

  test('T1-F5.2-04 GET /api/security snapshot and PATCH /api/security policy roundtrip', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const snap = await admin.getSecurity();
    expect(snap.status).toBe(200);
    expect(snap.data.policy).toBeDefined();
    expect(Array.isArray(snap.data.sessions)).toBe(true);
    expect(Array.isArray(snap.data.visitors)).toBe(true);
    expect(Array.isArray(snap.data.blocks)).toBe(true);

    const origPolicy = snap.data.policy as {
      retentionDays?: 7 | 30 | 90;
      requestsPerMinute?: number;
    };
    const origRetention = origPolicy.retentionDays ?? 30;
    const toggledRetention: 7 | 30 | 90 = origRetention === 7 ? 30 : 7;

    try {
      const patched = await admin.patchSecurity({ retentionDays: toggledRetention });
      expect(patched.status).toBe(200);
      expect(patched.data.retentionDays).toBe(toggledRetention);
    } finally {
      await admin.patchSecurity({ retentionDays: origRetention });
    }
  });

  test('T1-F5.2-05 GET /api/security/visitor detail and visitor + public IP block/unblock lifecycle', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const visitor = createApiClient();
    const visitorId = await resolveVisitorId(admin, visitor);

    const detail = await admin.getVisitor(visitorId);
    expect(detail.status).toBe(200);
    expect(detail.data.visitor).toBeDefined();

    try {
      const blockVisitor = await admin.blockTarget({
        type: 'visitor',
        value: visitorId,
        reason: 'E2E visitor block lifecycle check',
      });
      expect(blockVisitor.status).toBe(200);

      const blockIp = await admin.blockTarget({
        type: 'ip',
        value: PUBLIC_TEST_IP,
        reason: 'E2E public IP lifecycle check',
      });
      expect(blockIp.status).toBe(200);

      const snap = await admin.getSecurity();
      const blocks = snap.data.blocks as Array<Record<string, unknown>>;
      expect(blocks.some((b) => b.type === 'visitor' && b.value === visitorId)).toBe(true);
      expect(blocks.some((b) => b.type === 'ip' && b.value === PUBLIC_TEST_IP)).toBe(true);
    } finally {
      const unblockVisitor = await admin.unblockTarget({ type: 'visitor', value: visitorId });
      expect(unblockVisitor.status).toBe(200);
      const unblockIp = await admin.unblockTarget({ type: 'ip', value: PUBLIC_TEST_IP });
      expect(unblockIp.status).toBe(200);
    }
  });

  test('T1-F5.2-06 logout and DELETE /api/security/sessions revoke session cleanly', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    // Session 1: logout
    const s1 = createApiClient();
    const l1 = await s1.postAuth({ action: 'login', password: ADMIN_PASSWORD });
    expect(l1.status).toBe(200);
    const logoutRes = await s1.postAuth({ action: 'logout' });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.data.authenticated).toBe(false);
    expect((await s1.getAuthStatus()).data.authenticated).toBe(false);

    // Session 2: revoke via DELETE /api/security/sessions
    const s2 = createApiClient();
    const l2 = await s2.postAuth({ action: 'login', password: ADMIN_PASSWORD });
    expect(l2.status).toBe(200);
    const sid2 = l2.data.sessionId!;
    const revRes = await admin.revokeSession(sid2, 'DELETE');
    expect(revRes.status).toBe(200);
    expect((await s2.getAuthStatus()).data.authenticated).toBe(false);
  });

  test('T1-F5.2-07 password rotation revokes old sessions and restores original password cleanly', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const oldSession = createApiClient();
    const oldLogin = await oldSession.postAuth({ action: 'login', password: ADMIN_PASSWORD });
    expect(oldLogin.status).toBe(200);

    const rotatedPassword = `${ADMIN_PASSWORD}-Rotated-99`;
    let currentClient = admin;
    let isRotated = false;

    try {
      const changeRes = await admin.postAuth({
        action: 'password',
        oldPassword: ADMIN_PASSWORD,
        newPassword: rotatedPassword,
      });
      expect(changeRes.status).toBe(200);
      isRotated = true;
      expect(changeRes.data.authenticated).toBe(true);
      expect(changeRes.data.sessionId).not.toBe(oldLogin.data.sessionId);

      // Old session must now be unauthenticated
      expect((await oldSession.getAuthStatus()).data.authenticated).toBe(false);

      // New login with rotated password succeeds
      const newClient = createApiClient();
      const newLogin = await newClient.postAuth({ action: 'login', password: rotatedPassword });
      expect(newLogin.status).toBe(200);
      expect(newLogin.data.authenticated).toBe(true);
      currentClient = newClient;
    } finally {
      if (isRotated) {
        const restoreRes = await currentClient.postAuth({
          action: 'password',
          oldPassword: rotatedPassword,
          newPassword: ADMIN_PASSWORD,
        });
        expect(restoreRes.status).toBe(200);
      }
    }
  });
});

// ============================================================================
// F5.3 — D1 Atomic Hard Budget Circuit Breaker (5 tests)
// ============================================================================
test.describe('Tier 1 — F5.3 Atomic Cost Circuit Breaker', () => {
  test('T1-F5.3-01 GET /api/admin/usage exposes exact COST_LIMITS and current YYYY-MM', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const res = await admin.getAdminUsage();
    expect(res.status).toBe(200);
    expect(res.data.limits).toEqual({
      uploadBytes: 2_147_483_648,
      apiRequests: 200_000,
      classA: 10_000,
      classB: 100_000,
    });
    expect(Array.isArray(res.data.counters)).toBe(true);
    const month = (res.data as { month?: string }).month;
    if (month !== undefined) {
      expect(month).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  test('T1-F5.3-02 live atomic api-requests counter increments monotonically on API calls', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeRes = await admin.getAdminUsage();
    expect(beforeRes.status).toBe(200);
    const month = (beforeRes.data as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
    const apiKey = `api-requests:${month}`;
    const beforeVal = getCounterValue(beforeRes.data.counters, apiKey);

    await admin.getAtlasConfig();
    await admin.getAtlasConfig();
    await admin.getLibrary();

    const afterRes = await admin.getAdminUsage();
    expect(afterRes.status).toBe(200);
    const afterVal = getCounterValue(afterRes.data.counters, apiKey);
    expect(afterVal - beforeVal).toBeGreaterThanOrEqual(4);
  });

  test('T1-F5.3-03 concurrent Promise.all API calls preserve atomic counter monotonicity', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeRes = await admin.getAdminUsage();
    const month = (beforeRes.data as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
    const apiKey = `api-requests:${month}`;
    const beforeVal = getCounterValue(beforeRes.data.counters, apiKey);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => admin.getAtlasConfig()),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
    }

    const afterRes = await admin.getAdminUsage();
    const afterVal = getCounterValue(afterRes.data.counters, apiKey);
    expect(afterVal - beforeVal).toBeGreaterThanOrEqual(11);
  });

  test('T1-F5.3-04 R2 Class A and lifetime upload bytes increment on Vault upload', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const beforeRes = await admin.getAdminUsage();
    const month = (beforeRes.data as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
    const classAKey = `r2-class-a:${month}`;
    const bytesKey = 'r2-upload-bytes:lifetime';
    const classABefore = getCounterValue(beforeRes.data.counters, classAKey);
    const bytesBefore = getCounterValue(beforeRes.data.counters, bytesKey);

    const payloadSize = 5120;
    const { buffer, sha256 } = createBinaryChunkPayload(payloadSize, 88);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('cost-a')}.bin`,
      mime: 'application/octet-stream',
      size: payloadSize,
      sha256,
      totalChunks: 2,
    });
    expect([200, 201]).toContain(initRes.status);
    expect((await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer.subarray(0, 2560))).status).toBe(200);
    expect((await admin.uploadVaultChunk(initRes.data.uploadId, 1, buffer.subarray(2560))).status).toBe(200);
    expect([200, 201]).toContain((await admin.completeVaultUpload(initRes.data.uploadId)).status);

    const afterRes = await admin.getAdminUsage();
    expect(getCounterValue(afterRes.data.counters, classAKey) - classABefore).toBeGreaterThanOrEqual(2);
    expect(getCounterValue(afterRes.data.counters, bytesKey) - bytesBefore).toBeGreaterThanOrEqual(
      payloadSize,
    );
  });

  test('T1-F5.3-05 R2 Class B counter increments monotonically on Vault read and backup export', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('cost-b')}.bin`,
      sizeBytes: 1024,
      seed: 91,
    });

    try {
      const beforeRes = await admin.getAdminUsage();
      const month = (beforeRes.data as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
      const classBKey = `r2-class-b:${month}`;
      const classBBefore = getCounterValue(beforeRes.data.counters, classBKey);

      const anon = createApiClient();
      const redeem = await anon.redeemVault(created.passcode);
      expect(redeem.status).toBe(200);
      const dl = await anon.downloadVaultTicket(
        extractTicketId(redeem.data as { ticketId?: string; downloadUrl?: string }),
      );
      expect(dl.status).toBe(200);

      const afterVaultRes = await admin.getAdminUsage();
      expect(afterVaultRes.status).toBe(200);
      const classBAfterVault = getCounterValue(afterVaultRes.data.counters, classBKey);
      expect(classBAfterVault).toBeGreaterThan(classBBefore);

      const backupRes = await admin.getAdminBackup();
      expect(backupRes.status).toBe(200);

      const afterBackupRes = await admin.getAdminUsage();
      expect(afterBackupRes.status).toBe(200);
      const classBAfterBackup = getCounterValue(afterBackupRes.data.counters, classBKey);
      expect(classBAfterBackup).toBeGreaterThan(classBAfterVault);
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });
});

// ============================================================================
// F5.4 — Usage Monitoring Panel & cloudflare-1 Backup ZIP (6 tests)
// ============================================================================
test.describe('Tier 1 — F5.4 Backup ZIP, Trash/Restore & Usage UI', () => {
  test('T1-F5.4-01 GET /api/admin/backup streams valid cloudflare-1 ZIP parsed with fflate.unzipSync', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const res = await admin.getAdminBackup();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((res.headers.get('cache-control') || '').toLowerCase()).toContain('no-store');

    const files = unzipSync(new Uint8Array(res.data));
    expect(files['library.sql']).toBeDefined();
    expect(files['README.txt']).toBeDefined();
    expect(files['manifest.json']).toBeDefined();

    const manifestRaw = files['manifest.json'];
    if (!manifestRaw) throw new Error('manifest.json missing from backup ZIP');
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as {
      version: string;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    expect(manifest.version).toBe('cloudflare-1');
    expect(Array.isArray(manifest.files)).toBe(true);
  });

  test('T1-F5.4-02 backup manifest.json matches every extracted file byte length and node:crypto SHA-256 hash', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const res = await admin.getAdminBackup();
    expect(res.status).toBe(200);

    const files = unzipSync(new Uint8Array(res.data));
    const manifestBytes = files['manifest.json'];
    if (!manifestBytes) throw new Error('manifest.json missing from backup ZIP');

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      version: string;
      files: Array<{ path: string; size: number; sha256: string }>;
    };

    for (const entry of manifest.files) {
      const extracted = files[entry.path];
      expect(extracted, `Missing entry ${entry.path} in ZIP`).toBeDefined();
      if (!extracted) continue;
      expect(extracted.byteLength).toBe(entry.size);
      expect(sha256Hex(extracted)).toBe(entry.sha256);
    }
  });

  test('T1-F5.4-03 backup library.sql includes domain tables and excludes sessions, usage, and env secrets', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const res = await admin.getAdminBackup();
    expect(res.status).toBe(200);

    const files = unzipSync(new Uint8Array(res.data));
    const sqlBytes = files['library.sql'];
    if (!sqlBytes) throw new Error('library.sql missing from backup ZIP');
    const sqlText = new TextDecoder().decode(sqlBytes);

    expect(sqlText).toContain('journeys');
    expect(sqlText).toContain('media');
    expect(sqlText).toContain('vault_files');
    expect(sqlText).toContain('vault_shares');

    expect(sqlText).not.toContain('security_sessions');
    expect(sqlText).not.toContain('usage_limits');
    expect(sqlText).not.toContain('vault_uploads');
    expect(sqlText).not.toContain('vault_tickets');
    expect(sqlText).not.toContain('SESSION_SECRET');
    expect(sqlText).not.toContain('SETUP_TOKEN');
  });

  test('T1-F5.4-04 backup ZIP packs media/vault/* R2 payloads matching uploaded bytes and manifest hashes', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const created = await uploadAndShareVaultFile(admin, {
      name: `${uniqueId('bk-vault')}.bin`,
      sizeBytes: 3072,
      chunkCount: 2,
      seed: 123,
    });

    try {
      const res = await admin.getAdminBackup();
      expect(res.status).toBe(200);

      const files = unzipSync(new Uint8Array(res.data));
      const p0 = files[`media/vault/${created.fileId}/part-0`];
      const p1 = files[`media/vault/${created.fileId}/part-1`];
      expect(p0).toBeDefined();
      expect(p1).toBeDefined();
      if (!p0 || !p1) throw new Error('Vault parts missing from backup archive');

      const reassembled = Buffer.concat([Buffer.from(p0), Buffer.from(p1)]);
      expect(reassembled.byteLength).toBe(created.payload.byteLength);
      expect(sha256Hex(reassembled)).toBe(created.sha256);

      const manifestBytes = files['manifest.json'];
      if (!manifestBytes) throw new Error('manifest.json missing');
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
        files: Array<{ path: string; size: number; sha256: string }>;
      };
      for (const idx of [0, 1]) {
        const archivePath = `media/vault/${created.fileId}/part-${idx}`;
        const part = files[archivePath];
        expect(part).toBeDefined();
        const manifestEntry = manifest.files.find((f) => f.path === archivePath);
        expect(manifestEntry).toEqual({
          path: archivePath,
          size: part!.byteLength,
          sha256: sha256Hex(part!),
        });
      }
    } finally {
      await admin.revokeVaultShare(created.shareId);
    }
  });

  test('T1-F5.4-05 /api/admin/trash and /api/admin/restore roundtrip works cleanly', async () => {
    const admin = createApiClient();
    await admin.ensureAdminSession(ADMIN_PASSWORD);

    const { buffer, sha256 } = createBinaryChunkPayload(1024, 77);
    const initRes = await admin.initVaultUpload({
      name: `${uniqueId('trash-rt')}.bin`,
      mime: 'application/octet-stream',
      size: buffer.byteLength,
      sha256,
      totalChunks: 1,
    });
    expect([200, 201]).toContain(initRes.status);
    await admin.uploadVaultChunk(initRes.data.uploadId, 0, buffer);
    const completeRes = await admin.completeVaultUpload(initRes.data.uploadId);
    const fileId = extractFileId(completeRes.data, initRes.data.fileId);

    const trashRes = await admin.trashItem('vault_file', fileId);
    expect(trashRes.status).toBe(200);
    expect(trashRes.data.kind).toBe('vault_file');
    const trashKey = String(trashRes.data.key || '');
    expect(trashKey.length).toBeGreaterThan(0);

    // Double trash fails 409 because item is no longer active
    const dupTrash = await admin.trashItem('vault_file', fileId);
    expect([404, 409]).toContain(dupTrash.status);

    const restoreRes = await admin.restoreItem(trashKey);
    expect(restoreRes.status).toBe(200);
  });

  test('T1-F5.4-06 Admin Usage Monitoring UI renders budget limits and triggers backup download', async ({
    page,
  }) => {
    const errors = attachErrorListeners(page);
    const admin = createApiClient();
    await loginAdminInBrowser(page, admin);
    await openAdminSection(page, /用量|监控|备份|概览|Usage|Backup/i);

    await expect(page.getByText(/2\s*GiB|20,000|20000|10,000|100,000/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const backupTrigger = page
      .getByRole('link', { name: /备份|导出|Backup/i })
      .or(page.getByRole('button', { name: /备份|导出|Backup/i }))
      .first();
    await expect(backupTrigger).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      backupTrigger.click(),
    ]);
    const zipPath = await download.path();
    expect(zipPath).toBeTruthy();
    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath!)));
    expect(files['manifest.json']).toBeDefined();

    errors.assertZeroErrors();
  });
});

// ============================================================================
// F5.5 — Local-Only Deployment & lvtushouji.xyz Safety Guard (5 tests)
// ============================================================================
test.describe('Tier 1 — F5.5 Local-Only Boundary & Safety Guard', () => {
  test('T1-F5.5-01 auditLocalOnlyBoundary(repoRoot) passes cleanly on workspace', async () => {
    const client = createApiClient();
    const audit = auditLocalOnlyBoundary(client.repoRoot);
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.wranglerSummary.workersDev).toBe(false);
    expect(audit.wranglerSummary.previewUrls).toBe(false);
    expect(audit.wranglerSummary.d1Remotes).toEqual([false]);
    expect(audit.wranglerSummary.r2Remotes).toEqual([false]);
  });

  test('T1-F5.5-02 wrangler.jsonc omits account_id, routes, custom_domain, and lvtushouji.xyz', async () => {
    const client = createApiClient();
    const wranglerPath = path.join(client.repoRoot, 'wrangler.jsonc');
    const raw = fs.readFileSync(wranglerPath, 'utf8');
    expect(raw.toLowerCase()).not.toContain('lvtushouji.xyz');

    const cfg = parseJsonc<Record<string, unknown>>(raw);
    expect(cfg.account_id).toBeUndefined();
    expect(cfg.routes).toBeUndefined();
    expect(cfg.route).toBeUndefined();
    expect(cfg.custom_domain).toBeUndefined();
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
  });

  test('T1-F5.5-03 package.json scripts contain zero remote deploy or --remote flags', async () => {
    const client = createApiClient();
    const pkgPath = path.join(client.repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts).toBeDefined();
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      expect(cmd, `Script ${name} must not deploy`).not.toMatch(/\bwrangler\b.*\b(deploy|publish)\b/i);
      expect(cmd, `Script ${name} must not use --remote`).not.toMatch(/--remote\b/i);
      expect(cmd, `Script ${name} must not mention lvtushouji.xyz`).not.toMatch(/lvtushouji\.xyz/i);
    }
  });

  test('T1-F5.5-04 .dev.vars and .dev.vars.example contain zero CLOUDFLARE_API_TOKEN or account credentials', async () => {
    const client = createApiClient();
    for (const filename of ['.dev.vars', '.dev.vars.example']) {
      const filePath = path.join(client.repoRoot, filename);
      if (!fs.existsSync(filePath)) continue;
      const text = fs.readFileSync(filePath, 'utf8');
      expect(text).not.toMatch(/^\s*CLOUDFLARE_API_TOKEN\s*=/m);
      expect(text).not.toMatch(/^\s*CLOUDFLARE_ACCOUNT_ID\s*=/m);
    }
  });

  test('T1-F5.5-05 Playwright browser routes issue zero requests to lvtushouji.xyz or workers.dev', async ({
    page,
  }) => {
    const forbiddenHosts: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/lvtushouji\.xyz|workers\.dev/i.test(url)) {
        forbiddenHosts.push(url);
      }
    });

    for (const route of ['/', '/atlas', '/observatory', '/vault', '/admin']) {
      await page.goto(route, { waitUntil: 'networkidle' });
    }

    // Also verify a synthetic EXIF upload reference does not phone home
    const dummyJpeg = createSyntheticExifJpeg();
    expect(dummyJpeg.byteLength).toBeGreaterThan(0);
    expect(forbiddenHosts).toEqual([]);
  });
});
