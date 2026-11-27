import fs from 'node:fs';
import path from 'node:path';

export interface LocalBoundaryAuditResult {
  ok: boolean;
  violations: string[];
  checkedFiles: string[];
  wranglerSummary: {
    workersDev: unknown;
    previewUrls: unknown;
    d1Remotes: Array<boolean | undefined>;
    r2Remotes: Array<boolean | undefined>;
  };
}

const FORBIDDEN_MARKERS = [
  'lvtushouji.xyz',
  'travel-notebook.travel-notebook.workers.dev',
  'travel-notebook-media',
] as const;

/**
 * Pass 1: Remove UTF-8 BOM, // line comments, and /* block comments * / outside strings,
 * preserving newlines for accurate diagnostics and throwing on unterminated /* comments.
 * Pass 2: Remove trailing commas immediately preceding '}' or ']' outside strings.
 */
export function stripJsoncCommentsAndTrailingCommas(input: string): string {
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  // Pass 1: Strip comments while tracking JSON string literals
  let noComments = '';
  let i = 0;
  const n = source.length;
  let inString = false;
  let escaped = false;

  while (i < n) {
    const ch = source[i]!;
    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n' && source[i] !== '\r') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      let closed = false;
      noComments += ' ';
      while (i < n) {
        const c = source[i]!;
        if (c === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (c === '\n' || c === '\r') {
          noComments += c;
        }
        i += 1;
      }
      if (!closed) {
        throw new SyntaxError('Unterminated block comment in JSONC input');
      }
      continue;
    }

    noComments += ch;
    i += 1;
  }

  // Pass 2: Strip trailing commas before '}' or ']'
  let out = '';
  inString = false;
  escaped = false;
  const m = noComments.length;

  for (let j = 0; j < m; j += 1) {
    const ch = noComments[j]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      let k = j + 1;
      while (k < m && /\s/.test(noComments[k]!)) {
        k += 1;
      }
      const next = noComments[k];
      if (next === '}' || next === ']') {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

export function parseJsonc<T = unknown>(input: string): T {
  return JSON.parse(stripJsoncCommentsAndTrailingCommas(input)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectConfigTree(
  node: unknown,
  pathLabel: string,
  violations: string[],
): void {
  if (typeof node === 'string') {
    const lower = node.toLowerCase();
    for (const marker of FORBIDDEN_MARKERS) {
      if (lower.includes(marker)) {
        violations.push(`Forbidden production marker '${marker}' found at ${pathLabel}`);
      }
    }
    return;
  }

  if (Array.isArray(node)) {
    for (let idx = 0; idx < node.length; idx += 1) {
      inspectConfigTree(node[idx], `${pathLabel}[${idx}]`, violations);
    }
    return;
  }

  if (!isPlainObject(node)) {
    return;
  }

  for (const [key, val] of Object.entries(node)) {
    const childPath = `${pathLabel}.${key}`;
    if (key === 'custom_domain') {
      violations.push(`Forbidden key 'custom_domain' at ${childPath}`);
    }
    if (key === 'remote' && val === true) {
      violations.push(`Forbidden 'remote: true' at ${childPath}`);
    }
    inspectConfigTree(val, childPath, violations);
  }
}

export function auditLocalOnlyBoundary(repoRoot: string): LocalBoundaryAuditResult {
  const violations: string[] = [];
  const checkedFiles: string[] = [];
  const d1Remotes: Array<boolean | undefined> = [];
  const r2Remotes: Array<boolean | undefined> = [];
  let workersDev: unknown = undefined;
  let previewUrls: unknown = undefined;

  const wranglerJsoncPath = path.join(repoRoot, 'wrangler.jsonc');
  const wranglerJsonPath = path.join(repoRoot, 'wrangler.json');
  const wranglerTomlPath = path.join(repoRoot, 'wrangler.toml');

  if (fs.existsSync(wranglerJsonPath)) {
    checkedFiles.push(wranglerJsonPath);
    violations.push(`Ambiguous config: ${wranglerJsonPath} must not exist alongside wrangler.jsonc`);
  }
  if (fs.existsSync(wranglerTomlPath)) {
    checkedFiles.push(wranglerTomlPath);
    violations.push(`Ambiguous config: ${wranglerTomlPath} must not exist alongside wrangler.jsonc`);
  }

  if (!fs.existsSync(wranglerJsoncPath)) {
    violations.push(`Missing required local Wrangler config: ${wranglerJsoncPath}`);
  } else {
    checkedFiles.push(wranglerJsoncPath);
    try {
      const raw = fs.readFileSync(wranglerJsoncPath, 'utf8');
      const cfg = parseJsonc<Record<string, unknown>>(raw);

      if (!isPlainObject(cfg)) {
        violations.push('wrangler.jsonc root must be a JSON object');
      } else {
        workersDev = cfg.workers_dev;
        previewUrls = cfg.preview_urls;

        if (cfg.workers_dev !== false) {
          violations.push(`wrangler.jsonc must set "workers_dev": false (got ${JSON.stringify(cfg.workers_dev)})`);
        }
        if (cfg.preview_urls !== false) {
          violations.push(`wrangler.jsonc must set "preview_urls": false (got ${JSON.stringify(cfg.preview_urls)})`);
        }
        if (cfg.account_id !== undefined) {
          violations.push('wrangler.jsonc must omit "account_id" in local-only mode');
        }
        if (cfg.routes !== undefined) {
          violations.push('wrangler.jsonc must omit "routes" in local-only mode');
        }
        if (cfg.route !== undefined) {
          violations.push('wrangler.jsonc must omit "route" in local-only mode');
        }

        // Validate D1 bindings (Wrangler v4 places remote: false per binding)
        const d1List = Array.isArray(cfg.d1_databases) ? cfg.d1_databases : [];
        if (d1List.length === 0) {
          violations.push('wrangler.jsonc must declare at least one d1_databases binding with "remote": false');
        }
        d1List.forEach((entry, idx) => {
          const remote = isPlainObject(entry) ? (entry.remote as boolean | undefined) : undefined;
          d1Remotes.push(remote);
          if (remote !== false) {
            violations.push(`wrangler.jsonc d1_databases[${idx}] must set "remote": false (got ${JSON.stringify(remote)})`);
          }
        });

        // Validate R2 bindings
        const r2List = Array.isArray(cfg.r2_buckets) ? cfg.r2_buckets : [];
        if (r2List.length === 0) {
          violations.push('wrangler.jsonc must declare at least one r2_buckets binding with "remote": false');
        }
        r2List.forEach((entry, idx) => {
          const remote = isPlainObject(entry) ? (entry.remote as boolean | undefined) : undefined;
          r2Remotes.push(remote);
          if (remote !== false) {
            violations.push(`wrangler.jsonc r2_buckets[${idx}] must set "remote": false (got ${JSON.stringify(remote)})`);
          }
        });

        // Validate env.* overrides if present
        if (isPlainObject(cfg.env)) {
          for (const [envName, envVal] of Object.entries(cfg.env)) {
            if (!isPlainObject(envVal)) continue;
            if (envVal.workers_dev !== undefined && envVal.workers_dev !== false) {
              violations.push(`wrangler.jsonc env.${envName}.workers_dev must be false`);
            }
            if (envVal.preview_urls !== undefined && envVal.preview_urls !== false) {
              violations.push(`wrangler.jsonc env.${envName}.preview_urls must be false`);
            }
            if (envVal.account_id !== undefined) {
              violations.push(`wrangler.jsonc env.${envName} must omit "account_id"`);
            }
            if (envVal.routes !== undefined || envVal.route !== undefined) {
              violations.push(`wrangler.jsonc env.${envName} must omit "routes"/"route"`);
            }
            if (Array.isArray(envVal.d1_databases)) {
              envVal.d1_databases.forEach((entry, idx) => {
                const remote = isPlainObject(entry) ? (entry.remote as boolean | undefined) : undefined;
                d1Remotes.push(remote);
                if (remote !== false) {
                  violations.push(`wrangler.jsonc env.${envName}.d1_databases[${idx}] must set "remote": false`);
                }
              });
            }
            if (Array.isArray(envVal.r2_buckets)) {
              envVal.r2_buckets.forEach((entry, idx) => {
                const remote = isPlainObject(entry) ? (entry.remote as boolean | undefined) : undefined;
                r2Remotes.push(remote);
                if (remote !== false) {
                  violations.push(`wrangler.jsonc env.${envName}.r2_buckets[${idx}] must set "remote": false`);
                }
              });
            }
          }
        }

        inspectConfigTree(cfg, 'wrangler.jsonc', violations);
      }
    } catch (err) {
      violations.push(`Failed to parse ${wranglerJsoncPath}: ${(err as Error).message}`);
    }
  }

  // Audit package.json scripts
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    violations.push(`Missing required package.json: ${packageJsonPath}`);
  } else {
    checkedFiles.push(packageJsonPath);
    try {
      const rawPkg = fs.readFileSync(packageJsonPath, 'utf8');
      const pkg = JSON.parse(rawPkg.charCodeAt(0) === 0xfeff ? rawPkg.slice(1) : rawPkg) as Record<string, unknown>;
      if (isPlainObject(pkg.scripts)) {
        for (const [scriptName, cmd] of Object.entries(pkg.scripts)) {
          if (typeof cmd !== 'string') continue;
          if (
            /\bwrangler(?:\s+--?[a-z0-9-]+(?:=[^\s;&|]+|\s+(?!--|deploy\b|publish\b|pages\b|secret\b|route\b|custom-domain\b)[^\s;&|]+)?)*\s+(?:deploy|publish|pages\s+deploy|secret\s+put|route|custom-domain)\b/i.test(
              cmd,
            )
          ) {
            violations.push(`Forbidden deploy script in package.json scripts.${scriptName}: ${cmd}`);
          }
          if (/\bwrangler\b.*--remote\b/i.test(cmd)) {
            violations.push(`Forbidden --remote wrangler flag in package.json scripts.${scriptName}: ${cmd}`);
          }
          if (/lvtushouji\.xyz/i.test(cmd)) {
            violations.push(`Forbidden production domain reference in package.json scripts.${scriptName}: ${cmd}`);
          }
        }
      }
    } catch (err) {
      violations.push(`Failed to parse ${packageJsonPath}: ${(err as Error).message}`);
    }
  }

  // Optional .dev.vars check (if present)
  for (const varsName of ['.dev.vars', '.dev.vars.local']) {
    const varsPath = path.join(repoRoot, varsName);
    if (!fs.existsSync(varsPath)) continue;
    checkedFiles.push(varsPath);
    const lines = fs.readFileSync(varsPath, 'utf8').split(/\r?\n/);
    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;
      if (/^(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=/.test(line)) {
        violations.push(`Forbidden Cloudflare production credential in ${varsName}:${idx + 1}`);
      }
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedFiles,
    wranglerSummary: {
      workersDev,
      previewUrls,
      d1Remotes,
      r2Remotes,
    },
  };
}

export function assertLocalOnlyBoundary(repoRoot: string): LocalBoundaryAuditResult {
  const result = auditLocalOnlyBoundary(repoRoot);
  if (!result.ok) {
    throw new Error(`Local-only safety boundary audit failed:\n- ${result.violations.join('\n- ')}`);
  }
  return result;
}
