/**
 * 副 API 密钥从哪来：先用自己存进部署 `.env` 的 `HUMANIZE_API_KEY`;没有就找一个地址同主机的
 * 模型端点（`<部署根>/providers/<端点名>/`），借它 `.env` 里的那把 key。这样已经配好 DeepSeek
 * 主模型的人什么都不用填。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KEY_SECRET } from './config.ts';

export interface KeySource {
  key: string;
  /** 给人看的来源；没有 key 时为空串。 */
  from: string;
}

function host(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function readEnv(path: string, name: string): string {
  if (!existsSync(path)) return '';
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
    if (!m || m[1] !== name) continue;
    return m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return '';
}

/** 同主机端点里的 key;一个都没有时返回 null。 */
function endpointKey(botDir: string, baseUrl: string): KeySource | null {
  const want = host(baseUrl);
  const root = join(dirname(botDir), 'providers');
  if (!want || !existsSync(root)) return null;
  let names: string[] = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(root, name, 'config.json'), 'utf8')) as { baseUrl?: unknown; secret?: unknown };
      if (typeof entry.baseUrl !== 'string' || host(entry.baseUrl) !== want) continue;
      if (typeof entry.secret !== 'string' || !entry.secret) continue;
      const key = process.env[entry.secret] || readEnv(join(root, name, '.env'), entry.secret);
      if (key) return { key, from: `模型端点「${name}」` };
    } catch { /* 坏掉的端点配置跳过 */ }
  }
  return null;
}

export function resolveKey(secret: (name: string) => string, botDir: string, baseUrl: string): KeySource {
  let own = '';
  try { own = secret(KEY_SECRET); } catch { /* 没有就是没有 */ }
  if (own) return { key: own, from: '本扩展保存的 key' };
  return endpointKey(botDir, baseUrl) ?? { key: '', from: '' };
}
