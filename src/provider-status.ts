/**
 * 「活人感 provider」此刻是什么状态，给 World 页的状态灯用。
 *
 * provider 加载后会在 globalThis 挂牌子（见 bridge.ts）。没挂牌子时分不清是「没装」「装了还没重启」
 * 还是「装的是对不上的旧版」，所以再去扩展目录看一眼装没装、装的哪一版。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'cortico-provider-humanize';
/** 这一版 World 要求的 provider 最低版本（桥第 4 版）。 */
export const PROVIDER_MIN = '0.3.0';
const CACHE_MS = 5_000;

const OWN_DIR = fileURLToPath(new URL('..', import.meta.url));

let cache: { at: number; botDir: string; version: string | null } | null = null;

/** 扩展目录里装着的 provider 版本；没装（或找不到）给 null。 */
export function installedProviderVersion(botDir: string): string | null {
  if (cache && cache.botDir === botDir && Date.now() - cache.at < CACHE_MS) return cache.version;
  const candidates = [
    // Coopanion:<data>/home/<部署> 和 <data>/extensions/node_modules
    join(dirname(dirname(botDir)), 'extensions', 'node_modules', PACKAGE, 'package.json'),
    // 和本包装在同一个 node_modules 里
    join(OWN_DIR, '..', PACKAGE, 'package.json'),
  ];
  let version: string | null = null;
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
      if (typeof v === 'string') { version = v; break; }
    } catch { /* 读不了就当没找到 */ }
  }
  cache = { at: Date.now(), botDir, version };
  return version;
}

/** a < b(只比主、次、修订号）。 */
export function older(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
