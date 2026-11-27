import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FONTS_DIR = path.join(ROOT, 'public', 'fonts');

function readFirstFourBytes(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

describe('self-hosted WOFF2 font assets', () => {
  it('stores genuine wOF2 binaries in public/fonts/ with OFL.txt and no raw TTF/OTF/WOFF', () => {
    expect(fs.existsSync(path.join(FONTS_DIR, 'OFL.txt'))).toBe(true);
    expect(fs.existsSync(path.join(FONTS_DIR, 'fonts.css'))).toBe(true);

    const entries = fs.readdirSync(FONTS_DIR);
    expect(entries.filter((f) => /\.(ttf|otf|woff)$/i.test(f))).toEqual([]);

    const woff2Files = entries.filter((f) => f.endsWith('.woff2')).sort();
    expect(woff2Files.length).toBe(137);

    for (const file of woff2Files) {
      const magic = readFirstFourBytes(path.join(FONTS_DIR, file));
      expect(magic.toString('ascii'), `${file} must start with wOF2`).toBe('wOF2');
    }
  });

  it('keeps fonts.css, index.html preloads, and tokens.css free of external URLs and Microsoft YaHei', () => {
    const fontsCss = fs.readFileSync(path.join(FONTS_DIR, 'fonts.css'), 'utf-8');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
    const tokensCss = fs.readFileSync(
      path.join(ROOT, 'src', 'client', 'styles', 'tokens.css'),
      'utf-8',
    );

    expect(fontsCss).not.toMatch(/https?:\/\/|url\(\s*['"]?\/\//i);
    for (const content of [fontsCss, indexHtml, tokensCss]) {
      expect(content).not.toMatch(/Microsoft YaHei|微软雅黑|SimSun/i);
    }

    const cssUrls = [...fontsCss.matchAll(/url\('\/fonts\/([^']+)'\)\s+format\('woff2'\)/g)].map(
      (m) => m[1],
    );
    const woff2Files = fs
      .readdirSync(FONTS_DIR)
      .filter((f) => f.endsWith('.woff2'))
      .sort();
    expect(cssUrls.sort()).toEqual(woff2Files);

    const preloadHrefs = [
      ...indexHtml.matchAll(
        /<link\s+rel="preload"\s+as="font"\s+type="font\/woff2"[^>]*href="\/fonts\/([^"]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(preloadHrefs.length).toBeGreaterThanOrEqual(4);
    for (const href of preloadHrefs) {
      expect(woff2Files).toContain(href);
    }
  });
});
