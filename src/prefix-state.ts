/**
 * 系统前缀是不是最新的。活人感的环境说明和 humanize_feel 工具都在前缀里，前缀只在
 * 挂载、卸载、新会话、上下文交接时重建；Coopanion 重启后沿用旧前缀。所以换了模式、或者扩展更新
 * 改了环境说明之后，前缀会旧一阵。这里记下最近一次拼前缀时的模式和环境说明的指纹（落盘，
 * 重启也在），和此刻该有的比一比，不一样就提醒人去 World 页关开一次。
 *
 * provider 模式按当前端点的配置判断（部署 config.json 的 activeProvider → 那个端点的 kind,
 * 再问 provider 挂的牌子包没包这种 kind），不看「最近有没有转发过请求」：重启后第一次拼前缀时
 * provider 还没转发过，看时间会误判。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { providerMarker } from './bridge.ts';

export type Mode = 'provider' | 'tool' | 'push';

export const MODE_LABEL: Record<Mode, string> = {
  provider: 'provider 模式（心事直接塞进请求）',
  tool: '「先感受再开口」模式（桌宠先调用 humanize_feel）',
  push: '抢时间模式（心事作为事件推送）',
};

/** 活人感 provider 的端点类型。 */
const HUMANIZE_KIND = 'humanize';

interface Saved {
  prefix?: { mode: Mode; sig: string };
  /** 已经提醒过的变化，同一种变化只提醒一次。 */
  told?: string[];
}

export function signature(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12);
}

/** 读一份 JSON,按路径和修改时间缓存（路径会变：换了端点就是另一份文件）。 */
class JsonFile {
  private cache: { path: string; mtime: number; value: Record<string, unknown> | null } | null = null;

  constructor(private readonly path: () => string) {}

  read(): Record<string, unknown> | null {
    const path = this.path();
    if (!path || !existsSync(path)) return null;
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { return null; }
    if (this.cache?.path === path && this.cache.mtime === mtime) return this.cache.value;
    let value: Record<string, unknown> | null = null;
    try { value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { /* 写到一半等下次 */ }
    this.cache = { path, mtime, value };
    return value;
  }
}

export class PrefixState {
  private readonly deployment: JsonFile;
  private readonly endpoint: JsonFile;
  private saved: Saved;
  private readonly file: string;

  constructor(private readonly botDir: string, dataDir: string) {
    this.file = join(dataDir, 'state.json');
    this.deployment = new JsonFile(() => join(botDir, 'config.json'));
    this.endpoint = new JsonFile(() => {
      const name = this.activeEndpoint();
      return name ? join(dirname(botDir), 'providers', name, 'config.json') : '';
    });
    this.saved = {};
    try { if (existsSync(this.file)) this.saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved; } catch { /* 坏了就当没有 */ }
  }

  /** 当前端点名。 */
  activeEndpoint(): string {
    const name = this.deployment.read()?.activeProvider;
    return typeof name === 'string' ? name : '';
  }

  /** 当前端点的模块（kind）；读不到给空串。 */
  activeKind(): string {
    const kind = this.endpoint.read()?.kind;
    return typeof kind === 'string' ? kind : '';
  }

  /** 当前端点有没有被「活人感」provider 包着：装了 provider,且它包住了这种端点。 */
  providerConfigured(): boolean {
    const kind = this.activeKind();
    return !!kind && !!providerMarker()?.wraps(kind);
  }

  /** 当前端点是不是活人感端点（卸 provider 前要先切回原端点）。 */
  onHumanizeEndpoint(): boolean {
    return this.activeKind() === HUMANIZE_KIND;
  }

  /** 拼前缀时记下当时的模式和指纹。 */
  built(mode: Mode, sig: string): void {
    const prev = this.saved.prefix;
    if (prev?.mode === mode && prev.sig === sig) return;
    this.saved.prefix = { mode, sig };
    this.save();
  }

  /** 前缀里的说明和此刻该有的不一样时，给出旧的那份；一样或者从没记过（不知道）给 null。 */
  stale(mode: Mode, sig: string): { mode: Mode; sig: string } | null {
    const prev = this.saved.prefix;
    if (!prev || (prev.mode === mode && prev.sig === sig)) return null;
    return prev;
  }

  /** 这种变化提醒过没有；没提醒过就记一笔并返回 true。 */
  firstTime(key: string): boolean {
    const told = this.saved.told ?? [];
    if (told.includes(key)) return false;
    this.saved.told = [...told, key].slice(-20);
    this.save();
    return true;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.saved, null, 2), 'utf8');
    } catch { /* 存不了就下次再说 */ }
  }
}
