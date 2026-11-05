/**
 * 一键切到「活人感」端点、一键切回。
 *
 * 和 Coopanion「模型」页的「复制端点」做的是同一件事，只是替新手点了：照着当前的 Coo 端点复制一份
 * (地址、模型、思考档、Key 原样)，模块改成 `humanize`,再把当前部署的 activeProvider 指过去。
 * 只在人勾了配置项时才动，不碰别的端点、不改框架代码。
 *
 * Coopanion 运行中只在启动时（或打开「模型」页时）读端点配置，所以切换要重启后才生效。
 * 写之前占用和「模型」页同一把锁（providers/.write-lock），它正在保存时就不动。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HUMANIZE_KIND = 'humanize';
/** 活人感端点能包住的模块：provider 只包 Coo。 */
const WRAPPABLE = 'coo';

export interface SwitchResult {
  ok: boolean;
  /** 给人看的结果，放进配置页顶部。 */
  message: string;
  /** 成功时：切换前后的端点名。 */
  from?: string;
  to?: string;
}

interface Entry { kind?: unknown; baseUrl?: unknown; [key: string]: unknown }

function readJson(file: string): Record<string, unknown> | null {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null; } catch { return null; }
}

function paths(botDir: string) {
  const providers = join(dirname(botDir), 'providers');
  return { providers, deployment: join(botDir, 'config.json'), lock: join(providers, '.write-lock') };
}

/** 和「模型」页同一把锁；拿不到（它正在保存）就返回 null。 */
function locked<T>(lock: string, work: () => T): T | null {
  try { mkdirSync(dirname(lock), { recursive: true }); mkdirSync(lock); } catch { return null; }
  try { return work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** 只改 activeProvider,其余原样（读-改-写，和框架自己写 config.json 的方式一样）。 */
function setActive(deployment: string, name: string): void {
  const raw = readJson(deployment) ?? {};
  raw.activeProvider = name;
  writeFileSync(deployment, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

export function activeEndpoint(botDir: string): { name: string; entry: Entry | null } {
  const { providers, deployment } = paths(botDir);
  const name = readJson(deployment)?.activeProvider;
  if (typeof name !== 'string' || !name) return { name: '', entry: null };
  return { name, entry: readJson(join(providers, name, 'config.json')) as Entry | null };
}

/** 照着当前的 Coo 端点复制一个活人感端点并切过去。 */
export function switchToHumanize(botDir: string): SwitchResult {
  const { providers, deployment, lock } = paths(botDir);
  const { name, entry } = activeEndpoint(botDir);
  if (!name || !entry) return { ok: false, message: '还没有选好的模型端点：先在「模型」页配好一个能用的端点。' };
  if (entry.kind === HUMANIZE_KIND) return { ok: false, message: `当前端点「${name}」已经是活人感端点了。` };
  if (entry.kind !== WRAPPABLE) {
    return { ok: false, message: `当前端点「${name}」的类型是 ${String(entry.kind)}，活人感 provider 只能包住 Coo 连接。先在「模型」页换成 Coo 连接的端点再切。` };
  }
  const result = locked(lock, (): SwitchResult => {
    // 名字：<原名>-humanize;已有同名的活人感端点就照新的配置覆盖，被别的类型占了就加序号
    let target = `${name}-humanize`;
    for (let i = 2; ; i++) {
      const existing = readJson(join(providers, target, 'config.json'));
      if (!existing || existing.kind === HUMANIZE_KIND) break;
      target = `${name}-humanize-${i}`;
    }
    const dir = join(providers, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ ...entry, kind: HUMANIZE_KIND }, null, 2)}\n`, 'utf8');
    const env = join(providers, name, '.env');
    if (existsSync(env)) copyFileSync(env, join(dir, '.env'));
    setActive(deployment, target);
    return {
      ok: true, from: name, to: target,
      message: `已照着「${name}」复制出活人感端点「${target}」并切过去（地址、模型、Key 都一样）。重启 Coopanion 后生效。以后要卸载活人感 provider，先勾「切回原来的端点」。`,
    };
  });
  return result ?? { ok: false, message: '「模型」页正在保存端点，过几秒再勾一次。' };
}

/** 从活人感端点切回原来的端点：先用记下的，没有就找地址相同的非活人感端点。 */
export function switchBack(botDir: string, remembered: string | undefined): SwitchResult {
  const { providers, deployment, lock } = paths(botDir);
  const { name, entry } = activeEndpoint(botDir);
  if (!name || entry?.kind !== HUMANIZE_KIND) return { ok: false, message: `当前端点「${name || '（未选）'}」不是活人感端点，不用切回。` };
  const usable = (n: string | undefined) => {
    if (!n) return false;
    const e = readJson(join(providers, n, 'config.json'));
    return !!e && e.kind !== HUMANIZE_KIND;
  };
  let back = usable(remembered) ? remembered! : '';
  if (!back) {
    const base = name.replace(/-humanize(-\d+)?$/, '');
    if (usable(base)) back = base;
  }
  if (!back) return { ok: false, message: `没找到「${name}」原来对应的端点：到「模型」页自己选一个。` };
  const done = locked(lock, () => { setActive(deployment, back); return true; });
  if (!done) return { ok: false, message: '「模型」页正在保存端点，过几秒再勾一次。' };
  return { ok: true, from: name, to: back, message: `已切回「${back}」。重启 Coopanion 后生效。活人感端点「${name}」还留着，用不上可以在「模型」页删掉。` };
}
