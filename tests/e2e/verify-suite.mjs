#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALL_FEATURES = [
  'F1.1', 'F1.2', 'F1.3', 'F1.4', 'F1.5', 'F1.6', 'F1.7',
  'F2.1', 'F2.2', 'F2.3', 'F2.4', 'F2.5', 'F2.6', 'F2.7',
  'F3.1', 'F3.2', 'F3.3',
  'F4.1', 'F4.2', 'F4.3',
  'F5.1', 'F5.2', 'F5.3', 'F5.4', 'F5.5',
];
const VALID_FEATURE_SET = new Set(ALL_FEATURES);

const REQUIRED_SPEC_FILES = [
  'tier1-home-design.spec.ts',
  'tier2-home-design.spec.ts',
  'tier1-atlas.spec.ts',
  'tier2-atlas.spec.ts',
  'tier1-observatory.spec.ts',
  'tier2-observatory.spec.ts',
  'tier1-vault-platform.spec.ts',
  'tier2-vault-platform.spec.ts',
  'tier3-pairwise.spec.ts',
  'tier4-journeys.spec.ts',
];

const FORBIDDEN_PROD_MARKERS = [
  'lvtushouji.xyz',
  'travel-notebook.travel-notebook.workers.dev',
  'travel-notebook-media',
];

function stripBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'await',
  'else',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'yield',
]);

function canStartRegexAt(lastSig, lastIdent, lastIdentAfterDot) {
  if (lastSig === '' || '(=,:!&|?{};[~+-*%^<>'.includes(lastSig)) {
    return true;
  }
  if (lastIdent && !lastIdentAfterDot && REGEX_PREFIX_KEYWORDS.has(lastIdent)) {
    return true;
  }
  return false;
}

/**
 * Finite-state lexer for JS/TS: strips // and /* ... * / comments while preserving
 * string literals ('...', "...", `...`), regex literals, and newline positions.
 */
function stripCommentsPreservingStrings(source) {
  const n = source.length;
  let out = '';
  let i = 0;
  let mode = 'code'; // code | single | double | template | lineComment | blockComment | regex
  let escaped = false;
  let regexInClass = false;
  let lastSignificant = '';
  let identBuf = '';
  let identEnded = false;
  let sawDot = false;
  let identAfterDot = false;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'lineComment') {
      if (ch === '\n' || ch === '\r') {
        mode = 'code';
        if (identBuf !== '') identEnded = true;
        out += ch;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 2;
        mode = 'code';
        if (identBuf !== '') identEnded = true;
      } else {
        out += ch === '\n' || ch === '\r' ? ch : ' ';
        i += 1;
      }
      continue;
    }

    if (mode === 'single') {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === "'") {
        mode = 'code';
        lastSignificant = "'";
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }

    if (mode === 'double') {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        mode = 'code';
        lastSignificant = '"';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }

    if (mode === 'template') {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '`') {
        mode = 'code';
        lastSignificant = '`';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }

    if (mode === 'regex') {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '[') {
        regexInClass = true;
      } else if (ch === ']' && regexInClass) {
        regexInClass = false;
      } else if (ch === '/' && !regexInClass) {
        mode = 'code';
        lastSignificant = '/';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      } else if (ch === '\n') {
        mode = 'code';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }

    // mode === 'code'
    if (ch === '/' && next === '/') {
      mode = 'lineComment';
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'blockComment';
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'") {
      mode = 'single';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      mode = 'double';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      mode = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && canStartRegexAt(lastSignificant, identBuf, identAfterDot)) {
      mode = 'regex';
      regexInClass = false;
      identBuf = '';
      identEnded = false;
      sawDot = false;
      identAfterDot = false;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      if (identEnded || identBuf === '') {
        identBuf = ch;
        identEnded = false;
        identAfterDot = sawDot;
        sawDot = false;
      } else {
        identBuf += ch;
      }
      lastSignificant = ch;
    } else if (/\s/.test(ch)) {
      if (identBuf !== '') identEnded = true;
    } else {
      identBuf = '';
      identEnded = false;
      identAfterDot = false;
      sawDot = ch === '.';
      lastSignificant = ch;
    }
    i += 1;
  }

  return out;
}

function stripJsonc(input) {
  const src = stripBom(input);
  let noComments = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      noComments += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      noComments += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          break;
        }
        if (src[i] === '\n' || src[i] === '\r') noComments += src[i];
        i += 1;
      }
      continue;
    }
    noComments += ch;
    i += 1;
  }
  let out = '';
  inString = false;
  escaped = false;
  for (let j = 0; j < noComments.length; j += 1) {
    const ch = noComments[j];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < noComments.length && /\s/.test(noComments[k])) k += 1;
      if (noComments[k] === '}' || noComments[k] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function collectE2eFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.artifacts' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectE2eFiles(full, results);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function extractFeatureIds(text) {
  const found = new Set();
  const regex = /(?:^|[^A-Za-z0-9])(F[1-5]\.\d+)(?=[^A-Za-z0-9]|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const id = match[1];
    if (VALID_FEATURE_SET.has(id)) {
      found.add(id);
    }
  }
  return [...found];
}

function readStringLiteral(src, startIdx) {
  const quote = src[startIdx];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  let i = startIdx + 1;
  let escaped = false;
  while (i < src.length) {
    const ch = src[i];
    if (escaped) {
      value += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === quote) {
      return { value, endIdx: i + 1 };
    }
    value += ch;
    i += 1;
  }
  return null;
}

function skipWs(src, idx) {
  let i = idx;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}

function readBalancedGroup(src, startIdx, openCh, closeCh) {
  if (src[startIdx] !== openCh) return null;
  let depth = 0;
  let i = startIdx;
  let mode = 'code';
  let escaped = false;
  let regexInClass = false;
  let lastSig = '';
  let identBuf = '';
  let identEnded = false;
  let sawDot = false;
  let identAfterDot = false;

  while (i < src.length) {
    const ch = src[i];
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      const q = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === q) {
        mode = 'code';
        lastSig = q;
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') regexInClass = true;
      else if (ch === ']' && regexInClass) regexInClass = false;
      else if (ch === '/' && !regexInClass) {
        mode = 'code';
        lastSig = '/';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      } else if (ch === '\n') {
        mode = 'code';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") { mode = 'single'; i += 1; continue; }
    if (ch === '"') { mode = 'double'; i += 1; continue; }
    if (ch === '`') { mode = 'template'; i += 1; continue; }
    if (ch === '/' && canStartRegexAt(lastSig, identBuf, identAfterDot)) {
      mode = 'regex';
      regexInClass = false;
      identBuf = '';
      identEnded = false;
      sawDot = false;
      identAfterDot = false;
      i += 1;
      continue;
    }

    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return { raw: src.slice(startIdx, i + 1), endIdx: i + 1 };
      }
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      if (identEnded || identBuf === '') {
        identBuf = ch;
        identEnded = false;
        identAfterDot = sawDot;
        sawDot = false;
      } else {
        identBuf += ch;
      }
      lastSig = ch;
    } else if (/\s/.test(ch)) {
      if (identBuf !== '') identEnded = true;
    } else {
      identBuf = '';
      identEnded = false;
      identAfterDot = false;
      sawDot = ch === '.';
      lastSig = ch;
    }
    i += 1;
  }
  return null;
}

function readBalancedObject(src, startIdx) {
  return readBalancedGroup(src, startIdx, '{', '}');
}

function readBalancedParens(src, startIdx) {
  return readBalancedGroup(src, startIdx, '(', ')');
}

function isTestCallbackEmpty(code, afterTitleIdx) {
  let cursor = skipWs(code, afterTitleIdx);
  if (code[cursor] !== ',') return false;
  cursor = skipWs(code, cursor + 1);

  // Skip optional options object (e.g. { tag: [...] })
  if (code[cursor] === '{') {
    const optObj = readBalancedObject(code, cursor);
    if (!optObj) return false;
    cursor = skipWs(code, optObj.endIdx);
    if (code[cursor] !== ',') return false;
    cursor = skipWs(code, cursor + 1);
  }

  if (/^async(?=\s|\()/.test(code.slice(cursor))) {
    cursor = skipWs(code, cursor + 5);
  }

  if (/^function\b/.test(code.slice(cursor))) {
    cursor = skipWs(code, cursor + 8);
    if (code[cursor] === '*') {
      cursor = skipWs(code, cursor + 1);
    }
    const nameMatch = code.slice(cursor).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (nameMatch) {
      cursor = skipWs(code, cursor + nameMatch[0].length);
    }
    const params = readBalancedParens(code, cursor);
    if (!params) return false;
    cursor = skipWs(code, params.endIdx);
    if (code[cursor] === ':') {
      let angleDepth = 0;
      let parenDepth = 0;
      cursor += 1;
      while (cursor < code.length) {
        const c = code[cursor];
        if (c === '<') angleDepth += 1;
        else if (c === '>' && angleDepth > 0) angleDepth -= 1;
        else if (c === '(') parenDepth += 1;
        else if (c === ')' && parenDepth > 0) parenDepth -= 1;
        else if (c === '{' && angleDepth === 0 && parenDepth === 0) break;
        cursor += 1;
      }
    }
    if (code[cursor] === '{') {
      const body = readBalancedObject(code, cursor);
      return Boolean(body && body.raw.slice(1, -1).trim() === '');
    }
    return false;
  }

  if (code[cursor] === '(') {
    const params = readBalancedParens(code, cursor);
    if (!params) return false;
    cursor = skipWs(code, params.endIdx);
  } else {
    const paramMatch = code.slice(cursor).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!paramMatch) return false;
    cursor = skipWs(code, cursor + paramMatch[0].length);
  }

  if (code[cursor] === ':') {
    let angleDepth = 0;
    let parenDepth = 0;
    cursor += 1;
    while (cursor < code.length) {
      const c = code[cursor];
      if (c === '=' && code[cursor + 1] === '>' && angleDepth === 0 && parenDepth === 0) break;
      if (c === '<') angleDepth += 1;
      else if (c === '>' && angleDepth > 0) angleDepth -= 1;
      else if (c === '(') parenDepth += 1;
      else if (c === ')' && parenDepth > 0) parenDepth -= 1;
      cursor += 1;
    }
  }

  if (code.slice(cursor, cursor + 2) !== '=>') return false;
  cursor = skipWs(code, cursor + 2);
  if (code[cursor] === '{') {
    const body = readBalancedObject(code, cursor);
    return Boolean(body && body.raw.slice(1, -1).trim() === '');
  }
  return false;
}

/**
 * Parse test(...) and test.describe(...) calls in a spec file, preserving nesting scope
 * and attributing Feature IDs from test title / { tag } or enclosing describe title / { tag }.
 */
function parseSpecFile(filePath, repoRoot) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const code = stripCommentsPreservingStrings(raw);
  const relFile = path.relative(repoRoot, filePath).replace(/\\/g, '/');

  const tests = [];
  const describeStack = []; // { depth, features }
  const pendingDescribeByBraceIdx = new Map();
  let braceDepth = 0;

  let i = 0;
  const n = code.length;
  let mode = 'code';
  let escaped = false;
  let regexInClass = false;
  let lastSig = '';
  let identBuf = '';
  let identEnded = false;
  let sawDot = false;
  let identAfterDot = false;

  while (i < n) {
    const ch = code[i];

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      const q = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === q) {
        mode = 'code';
        lastSig = q;
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') regexInClass = true;
      else if (ch === ']' && regexInClass) regexInClass = false;
      else if (ch === '/' && !regexInClass) {
        mode = 'code';
        lastSig = '/';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      } else if (ch === '\n') {
        mode = 'code';
        identBuf = '';
        identEnded = false;
        sawDot = false;
        identAfterDot = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") { mode = 'single'; i += 1; continue; }
    if (ch === '"') { mode = 'double'; i += 1; continue; }
    if (ch === '`') { mode = 'template'; i += 1; continue; }
    if (ch === '/' && canStartRegexAt(lastSig, identBuf, identAfterDot)) {
      mode = 'regex';
      regexInClass = false;
      identBuf = '';
      identEnded = false;
      sawDot = false;
      identAfterDot = false;
      i += 1;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
      if (pendingDescribeByBraceIdx.has(i)) {
        describeStack.push({
          depth: braceDepth,
          features: pendingDescribeByBraceIdx.get(i),
        });
        pendingDescribeByBraceIdx.delete(i);
      }
      lastSig = '{';
      identBuf = '';
      identEnded = false;
      sawDot = false;
      identAfterDot = false;
      i += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      while (describeStack.length > 0 && describeStack[describeStack.length - 1].depth > braceDepth) {
        describeStack.pop();
      }
      lastSig = '}';
      identBuf = '';
      identEnded = false;
      sawDot = false;
      identAfterDot = false;
      i += 1;
      continue;
    }

    // Match identifiers: test.describe(...), test(...), it(...)
    if (/[A-Za-z_$]/.test(ch)) {
      const prevChar = i > 0 ? code[i - 1] : '';
      if (!/[A-Za-z0-9_$.]/.test(prevChar)) {
        const rest = code.slice(i);
        const callMatch = rest.match(/^(test\.describe(?:\.(?:serial|parallel|only))?|test(?:\.only)?|it(?:\.only)?)\s*\(/);
        if (callMatch) {
          const kind = callMatch[1];
          const openParenIdx = i + callMatch[0].length - 1;
          let cursor = skipWs(code, openParenIdx + 1);
          const titleLit = readStringLiteral(code, cursor);
          if (titleLit) {
            let metaRaw = '';
            cursor = skipWs(code, titleLit.endIdx);
            if (code[cursor] === ',') {
              const afterComma = skipWs(code, cursor + 1);
              if (code[afterComma] === '{') {
                const obj = readBalancedObject(code, afterComma);
                if (obj) {
                  metaRaw = obj.raw;
                  cursor = obj.endIdx;
                }
              }
            }
            const combined = `${titleLit.value}\n${metaRaw}`;
            const ownFeatures = extractFeatureIds(combined);

            if (kind.startsWith('test.describe')) {
              // Find opening brace of the describe callback
              let scan = cursor;
              while (scan < n && code[scan] !== '{') {
                if (code[scan] === "'" || code[scan] === '"' || code[scan] === '`') {
                  const lit = readStringLiteral(code, scan);
                  if (lit) { scan = lit.endIdx; continue; }
                } else if (code[scan] === '(') {
                  const params = readBalancedParens(code, scan);
                  if (params) { scan = params.endIdx; continue; }
                }
                scan += 1;
              }
              if (code[scan] === '{') {
                pendingDescribeByBraceIdx.set(scan, ownFeatures);
              }
            } else {
              const inherited = new Set(ownFeatures);
              if (inherited.size === 0) {
                for (const scope of describeStack) {
                  for (const f of scope.features) inherited.add(f);
                }
              }
              tests.push({
                file: relFile,
                basename: path.basename(filePath),
                line: lineNumberAt(code, i),
                title: titleLit.value,
                features: [...inherited],
                emptyBody: isTestCallbackEmpty(code, titleLit.endIdx),
              });
            }
          }
          i = openParenIdx + 1;
          lastSig = '(';
          identBuf = '';
          identEnded = false;
          sawDot = false;
          identAfterDot = false;
          continue;
        }
      }
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      if (identEnded || identBuf === '') {
        identBuf = ch;
        identEnded = false;
        identAfterDot = sawDot;
        sawDot = false;
      } else {
        identBuf += ch;
      }
      lastSig = ch;
    } else if (/\s/.test(ch)) {
      if (identBuf !== '') identEnded = true;
    } else {
      identBuf = '';
      identEnded = false;
      identAfterDot = false;
      sawDot = ch === '.';
      lastSig = ch;
    }
    i += 1;
  }

  return { file: relFile, basename: path.basename(filePath), tests };
}

function scanStaticViolations(e2eDir, repoRoot, parsedByRel = new Map()) {
  const violations = [];
  const allFiles = collectE2eFiles(e2eDir);

  for (const filePath of allFiles) {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
    const code = stripCommentsPreservingStrings(raw);
    const isSpec = rel.startsWith('tests/e2e/specs/') && rel.endsWith('.spec.ts');
    const isVisualAudit = rel === 'tests/e2e/visual-audit.mjs';

    // 1. Forbidden src/ imports across all tests/e2e files
    const srcImportPatterns = [
      /\bfrom\s+['"`](?:[^'"`]*[\\/])?src(?:[\\/]|['"`])/g,
      /\bimport\s+['"`](?:[^'"`]*[\\/])?src(?:[\\/]|['"`])/g,
      /\brequire\s*\(\s*['"`](?:[^'"`]*[\\/])?src(?:[\\/]|['"`])/g,
      /\bimport\s*\(\s*['"`](?:[^'"`]*[\\/])?src(?:[\\/]|['"`])/g,
    ];
    for (const pat of srcImportPatterns) {
      let m;
      while ((m = pat.exec(code)) !== null) {
        violations.push(`${rel}:${lineNumberAt(code, m.index)} Forbidden src/ import: ${m[0].trim()}`);
      }
    }

    if (isSpec || isVisualAudit) {
      // 2. Forbidden trivial stubs & skip/todo/fixme
      const tautologyRe = /\bexpect\s*\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g;
      let m;
      while ((m = tautologyRe.exec(code)) !== null) {
        violations.push(`${rel}:${lineNumberAt(code, m.index)} Trivial stub assertion: ${m[0]}`);
      }
      const truthyStubRe = /\bexpect\s*\(\s*(?:true\s*\)\s*\.\s*toBeTruthy|false\s*\)\s*\.\s*toBeFalsy)\s*\(\s*\)/g;
      while ((m = truthyStubRe.exec(code)) !== null) {
        violations.push(`${rel}:${lineNumberAt(code, m.index)} Trivial stub assertion: ${m[0]}`);
      }
      const skipRe = /\b(?:test|it|describe)\.(?:skip|todo|fixme)\s*\(/g;
      while ((m = skipRe.exec(code)) !== null) {
        violations.push(`${rel}:${lineNumberAt(code, m.index)} Forbidden skipped/todo/fixme test: ${m[0]}`);
      }
      const parsed = parsedByRel.get(rel) ?? (isSpec ? parseSpecFile(filePath, repoRoot) : null);
      if (parsed) {
        for (const t of parsed.tests) {
          if (t.emptyBody) {
            violations.push(`${rel}:${t.line} Empty test body detected`);
          }
        }
      }
      const todoCommentRe = /(?:TODO\s*:\s*implement|FIXME\s*:\s*stub)/gi;
      while ((m = todoCommentRe.exec(raw)) !== null) {
        violations.push(`${rel}:${lineNumberAt(raw, m.index)} Forbidden stub marker: ${m[0]}`);
      }

      // 3. Invented data-testid selectors (exempting helpers/browser-checks.ts)
      const testIdPatterns = [
        /\.getByTestId\s*\(/g,
        /\[data-testid/g,
        /\bdata-testid\s*=/g,
        /getAttribute\s*\(\s*['"`]data-testid['"`]\s*\)/g,
        /querySelector(?:All)?\s*\(\s*['"`][^'"`]*data-testid/g,
      ];
      for (const pat of testIdPatterns) {
        while ((m = pat.exec(code)) !== null) {
          violations.push(`${rel}:${lineNumberAt(code, m.index)} Forbidden data-testid selector: ${m[0].trim()}`);
        }
      }
    }
  }

  return violations;
}

function auditLocalBoundary(repoRoot) {
  const violations = [];
  const summary = {
    workersDev: undefined,
    previewUrls: undefined,
    d1Remotes: [],
    r2Remotes: [],
  };

  for (const legacy of ['wrangler.json', 'wrangler.toml']) {
    if (fs.existsSync(path.join(repoRoot, legacy))) {
      violations.push(`Forbidden legacy config ${legacy} alongside wrangler.jsonc`);
    }
  }

  const wranglerPath = path.join(repoRoot, 'wrangler.jsonc');
  if (!fs.existsSync(wranglerPath)) {
    violations.push('Missing wrangler.jsonc');
  } else {
    try {
      const cfg = JSON.parse(stripJsonc(fs.readFileSync(wranglerPath, 'utf8')));
      summary.workersDev = cfg.workers_dev;
      summary.previewUrls = cfg.preview_urls;
      if (cfg.workers_dev !== false) violations.push(`wrangler.jsonc workers_dev must be false`);
      if (cfg.preview_urls !== false) violations.push(`wrangler.jsonc preview_urls must be false`);
      for (const forbiddenKey of ['account_id', 'routes', 'route', 'custom_domain']) {
        if (cfg[forbiddenKey] !== undefined) {
          violations.push(`wrangler.jsonc must omit ${forbiddenKey}`);
        }
      }
      const d1List = Array.isArray(cfg.d1_databases) ? cfg.d1_databases : [];
      if (d1List.length === 0) violations.push('wrangler.jsonc must declare d1_databases');
      for (const [idx, d1] of d1List.entries()) {
        summary.d1Remotes.push(d1?.remote);
        if (d1?.remote !== false) violations.push(`wrangler.jsonc d1_databases[${idx}].remote must be false`);
      }
      const r2List = Array.isArray(cfg.r2_buckets) ? cfg.r2_buckets : [];
      if (r2List.length === 0) violations.push('wrangler.jsonc must declare r2_buckets');
      for (const [idx, r2] of r2List.entries()) {
        summary.r2Remotes.push(r2?.remote);
        if (r2?.remote !== false) violations.push(`wrangler.jsonc r2_buckets[${idx}].remote must be false`);
      }
      const rawLower = fs.readFileSync(wranglerPath, 'utf8').toLowerCase();
      for (const marker of FORBIDDEN_PROD_MARKERS) {
        if (rawLower.includes(marker)) {
          violations.push(`wrangler.jsonc contains forbidden production marker '${marker}'`);
        }
      }
    } catch (err) {
      violations.push(`Failed to parse wrangler.jsonc: ${err.message}`);
    }
  }

  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    violations.push('Missing package.json');
  } else {
    try {
      const pkg = JSON.parse(stripBom(fs.readFileSync(pkgPath, 'utf8')));
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        for (const [name, cmd] of Object.entries(pkg.scripts)) {
          if (typeof cmd !== 'string') continue;
          if (/\bwrangler\b.*\b(deploy|publish|pages\s+deploy|secret\s+put|route|custom-domain|--remote)\b/i.test(cmd)) {
            violations.push(`Forbidden deploy/remote script in package.json scripts.${name}: ${cmd}`);
          }
          if (/lvtushouji\.xyz/i.test(cmd)) {
            violations.push(`Forbidden domain reference in package.json scripts.${name}`);
          }
        }
      }
    } catch (err) {
      violations.push(`Failed to parse package.json: ${err.message}`);
    }
  }

  for (const varsName of ['.dev.vars', '.dev.vars.local']) {
    const varsPath = path.join(repoRoot, varsName);
    if (!fs.existsSync(varsPath)) continue;
    const lines = fs.readFileSync(varsPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      if (/^(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=/.test(trimmed)) {
        violations.push(`Forbidden Cloudflare credential in ${varsName}:${idx + 1}`);
      }
    });
  }

  return { ok: violations.length === 0, violations, summary };
}

function runTsc(e2eDir, repoRoot) {
  const tscPath = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscPath)) {
    return { ok: false, output: 'TypeScript compiler (tsc) not found in node_modules' };
  }
  const res = spawnSync(
    process.execPath,
    [tscPath, '--noEmit', '-p', path.join(e2eDir, 'tsconfig.json')],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, status: res.status, output };
}

function runPlaywrightList(e2eDir, repoRoot, allowEmpty) {
  const pwCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(pwCli)) {
    return { ok: false, output: '@playwright/test CLI not found in node_modules', uniqueCount: 0, byFile: {} };
  }
  const args = ['test', '-c', path.join(e2eDir, 'playwright.config.ts'), '--list'];
  if (allowEmpty) args.push('--pass-with-no-tests');

  const res = spawnSync(process.execPath, [pwCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();

  const uniqueKeys = new Set();
  const byFileSet = new Map();
  for (const line of output.split(/\r?\n/)) {
    // Example: "  [desktop-light] › specs\tier3-pairwise.spec.ts:15:3 › [F1.1][F1.6] ..."
    const m = line.match(/^\s*\[[^\]]+\]\s+[›>]\s+(.+?):(\d+):(\d+)\s+[›>]\s+(.+)$/);
    if (!m) continue;
    const rawFile = m[1].replace(/\\/g, '/');
    const basename = path.basename(rawFile);
    const key = `${basename}:${m[2]}:${m[3]}:${m[4].trim()}`;
    uniqueKeys.add(key);
    if (!byFileSet.has(basename)) byFileSet.set(basename, new Set());
    byFileSet.get(basename).add(key);
  }

  const byFile = {};
  for (const [fname, keys] of byFileSet.entries()) {
    byFile[fname] = keys.size;
  }

  return {
    ok: res.status === 0,
    status: res.status,
    output,
    uniqueCount: uniqueKeys.size,
    byFile,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node tests/e2e/verify-suite.mjs [--full] [--json]');
    process.exit(0);
  }

  const isFull = argv.includes('--full');
  const isJson = argv.includes('--json');

  const e2eDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(e2eDir, '..', '..');
  const specsDir = path.join(e2eDir, 'specs');

  const errors = [];
  const warnings = [];

  // 1. Inventory existing files
  const existingSpecs = fs.existsSync(specsDir)
    ? fs.readdirSync(specsDir).filter((f) => f.endsWith('.spec.ts')).sort()
    : [];
  const hasVisualAudit = fs.existsSync(path.join(e2eDir, 'visual-audit.mjs'));

  if (isFull) {
    if (!hasVisualAudit) {
      errors.push('Missing required visual audit script: tests/e2e/visual-audit.mjs');
    }
    for (const reqSpec of REQUIRED_SPEC_FILES) {
      if (!existingSpecs.includes(reqSpec)) {
        errors.push(`Missing required spec file: tests/e2e/specs/${reqSpec}`);
      }
    }
  } else {
    if (!hasVisualAudit) {
      warnings.push('tests/e2e/visual-audit.mjs not present yet (deferred to E2E-M2 / --full gate).');
    }
  }

  // 2. Parse existing specs & compute per-tier / per-feature counts
  const parsedFiles = {};
  const parsedByRel = new Map();
  const tier1Counts = Object.fromEntries(ALL_FEATURES.map((f) => [f, 0]));
  const tier2Counts = Object.fromEntries(ALL_FEATURES.map((f) => [f, 0]));
  const tier3Counts = Object.fromEntries(ALL_FEATURES.map((f) => [f, 0]));
  const tierTotals = { tier1: 0, tier2: 0, tier3: 0, tier4: 0, other: 0 };

  for (const specName of existingSpecs) {
    const parsed = parseSpecFile(path.join(specsDir, specName), repoRoot);
    parsedByRel.set(parsed.file, parsed);
    parsedFiles[specName] = {
      count: parsed.tests.length,
      tests: parsed.tests,
    };

    if (parsed.tests.length === 0) {
      errors.push(`Spec file tests/e2e/specs/${specName} contains 0 tests.`);
    }

    const tier = specName.startsWith('tier1-')
      ? 'tier1'
      : specName.startsWith('tier2-')
        ? 'tier2'
        : specName === 'tier3-pairwise.spec.ts'
          ? 'tier3'
          : specName === 'tier4-journeys.spec.ts'
            ? 'tier4'
            : 'other';

    tierTotals[tier] += parsed.tests.length;

    for (const t of parsed.tests) {
      if ((tier === 'tier1' || tier === 'tier2' || tier === 'tier3') && t.features.length === 0) {
        const msg = `${t.file}:${t.line} Test "${t.title}" has no identifiable Feature ID (F1.1-F5.5).`;
        if (isFull) errors.push(msg);
        else warnings.push(msg);
      }
      for (const feat of t.features) {
        if (tier === 'tier1') tier1Counts[feat] += 1;
        else if (tier === 'tier2') tier2Counts[feat] += 1;
        else if (tier === 'tier3') tier3Counts[feat] += 1;
      }
    }
  }

  const totalStaticTests =
    tierTotals.tier1 + tierTotals.tier2 + tierTotals.tier3 + tierTotals.tier4 + tierTotals.other;

  // Threshold checks
  if (existingSpecs.includes('tier3-pairwise.spec.ts')) {
    if (tierTotals.tier3 < 25) {
      errors.push(`Tier 3 (tier3-pairwise.spec.ts) must have >= 25 tests, found ${tierTotals.tier3}.`);
    }
    const uncoveredTier3 = ALL_FEATURES.filter((f) => tier3Counts[f] < 1);
    if (uncoveredTier3.length > 0) {
      errors.push(`Tier 3 must cover all 25 features (F1.1-F5.5); missing: ${uncoveredTier3.join(', ')}`);
    }
  } else if (isFull) {
    errors.push('Tier 3 (tier3-pairwise.spec.ts) missing.');
  }

  if (existingSpecs.includes('tier4-journeys.spec.ts')) {
    if (tierTotals.tier4 < 13) {
      errors.push(`Tier 4 (tier4-journeys.spec.ts) must have >= 13 journeys, found ${tierTotals.tier4}.`);
    }
  } else if (isFull) {
    errors.push('Tier 4 (tier4-journeys.spec.ts) missing.');
  }

  if (isFull) {
    const lowT1 = ALL_FEATURES.filter((f) => tier1Counts[f] < 5).map((f) => `${f}=${tier1Counts[f]}`);
    if (lowT1.length > 0) {
      errors.push(`Tier 1 requires >= 5 tests per feature; under threshold: ${lowT1.join(', ')}`);
    }
    const lowT2 = ALL_FEATURES.filter((f) => tier2Counts[f] < 5).map((f) => `${f}=${tier2Counts[f]}`);
    if (lowT2.length > 0) {
      errors.push(`Tier 2 requires >= 5 tests per feature; under threshold: ${lowT2.join(', ')}`);
    }
    if (tierTotals.tier1 < 125) {
      errors.push(`Tier 1 total must be >= 125, found ${tierTotals.tier1}.`);
    }
    if (tierTotals.tier2 < 125) {
      errors.push(`Tier 2 total must be >= 125, found ${tierTotals.tier2}.`);
    }
    if (totalStaticTests < 288) {
      errors.push(`Total test count across Tiers 1-4 must be >= 288, found ${totalStaticTests}.`);
    }
  }

  // 3. Static integrity checks
  const staticViolations = scanStaticViolations(e2eDir, repoRoot, parsedByRel);
  for (const v of staticViolations) {
    errors.push(`Static integrity violation: ${v}`);
  }

  // 4. Local-only boundary audit
  const localBoundary = auditLocalBoundary(repoRoot);
  if (!localBoundary.ok) {
    for (const v of localBoundary.violations) {
      errors.push(`Local-only boundary violation: ${v}`);
    }
  }

  // 5. TypeScript compile check
  const tscResult = runTsc(e2eDir, repoRoot);
  if (!tscResult.ok) {
    errors.push(`TypeScript check failed (exit ${tscResult.status}):\n${tscResult.output}`);
  }

  // 6. Playwright --list discovery check
  const allowEmpty = !isFull && existingSpecs.length === 0;
  const pwResult = runPlaywrightList(e2eDir, repoRoot, allowEmpty);
  if (!pwResult.ok) {
    errors.push(`Playwright --list failed (exit ${pwResult.status}):\n${pwResult.output}`);
  } else if (existingSpecs.length > 0) {
    if (pwResult.uniqueCount === 0) {
      errors.push('Playwright --list discovered 0 tests despite spec files existing.');
    }
    if (isFull && pwResult.uniqueCount < 288) {
      errors.push(`Playwright --list unique test count ${pwResult.uniqueCount} < 288.`);
    }
    for (const specName of existingSpecs) {
      const staticCount = parsedFiles[specName].count;
      const pwCount = pwResult.byFile[specName] ?? 0;
      if (pwCount !== staticCount) {
        const msg = `Count difference for ${specName}: static parser=${staticCount}, playwright --list=${pwCount}`;
        if (isFull) errors.push(msg);
        else warnings.push(msg);
      }
    }
  }

  const report = {
    ok: errors.length === 0,
    mode: isFull ? 'full' : 'default',
    specFiles: existingSpecs,
    hasVisualAudit,
    tierTotals,
    totalStaticTests,
    playwrightUniqueTests: pwResult.uniqueCount,
    playwrightByFile: pwResult.byFile,
    tscOk: tscResult.ok,
    localBoundaryOk: localBoundary.ok,
    localBoundarySummary: localBoundary.summary,
    perFeature: Object.fromEntries(
      ALL_FEATURES.map((f) => [
        f,
        { tier1: tier1Counts[f], tier2: tier2Counts[f], tier3: tier3Counts[f] },
      ]),
    ),
    warnings,
    errors,
  };

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== E2E Suite Verification (${report.mode} mode) ===`);
    console.log(`Spec files (${existingSpecs.length}): ${existingSpecs.join(', ') || '(none)'}`);
    console.log(`visual-audit.mjs: ${hasVisualAudit ? 'present' : 'missing'}`);
    console.log(`TypeScript (tests/e2e/tsconfig.json): ${tscResult.ok ? 'PASS' : 'FAIL'}`);
    console.log(`Local-only boundary: ${localBoundary.ok ? 'PASS' : 'FAIL'}`);
    console.log(
      `Playwright --list: ${pwResult.ok ? 'PASS' : 'FAIL'} (${pwResult.uniqueCount} unique tests across 4 projects)`,
    );
    console.log(
      `Static test tally: Tier1=${tierTotals.tier1}, Tier2=${tierTotals.tier2}, Tier3=${tierTotals.tier3}, Tier4=${tierTotals.tier4}, Total=${totalStaticTests}`,
    );
    if (existingSpecs.length > 0) {
      console.log('Per-file counts:');
      for (const specName of existingSpecs) {
        const s = parsedFiles[specName].count;
        const p = pwResult.byFile[specName] ?? 0;
        console.log(`  - ${specName}: static=${s}, playwright=${p}`);
      }
    }
    if (warnings.length > 0) {
      console.log(`Warnings (${warnings.length}):`);
      for (const w of warnings) console.log(`  [WARN] ${w}`);
    }
    if (errors.length > 0) {
      console.error(`Errors (${errors.length}):`);
      for (const e of errors) console.error(`  [ERR] ${e}`);
    } else {
      console.log('ALL CHECKS PASSED.');
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main();
