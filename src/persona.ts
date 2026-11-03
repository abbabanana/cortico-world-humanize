/**
 * 人设与记忆现读（不用 provider 时副 API 只有这些；用 provider 时作为主模型上下文的补充）：
 * - 桌宠工作区的 `CONSTITUTION.md`(我是谁)和 `PARTNER.md`(对方是谁)
 * - 工作区 `partner/` 下最近改过的几份记录
 * - 配置里指定的「额外记忆文件夹」下最近改过的几份文本（给把记忆存在别处的记忆扩展）
 * 不另存一份：你改了，或者桌宠自己用工具改了，下一句话的内心就跟着走。
 * 按修改时间缓存；文件不在（换了 bot、工作区挪了）就给空串，副 API 退回通用写法。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface Persona {
  /** 桌宠的自述。 */
  self: string;
  /** 桌宠记下的、关于对方的事。 */
  partner: string;
  /** 其他记忆：partner/ 下的记录和额外记忆文件夹里的文本，按修改时间从新到旧。 */
  memory: string;
}

/** 自述、PARTNER 各最多送这么多字。 */
const MAX_CHARS = 2500;
/** 每个文件夹最多读几份、每份最多多少字。 */
const DIR_FILES = 3;
const DIR_FILE_CHARS = 1500;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.yaml', '.yml']);

/** 自述末尾那段「这份文件是我的自述……」是写给框架的说明，对揣摩心情没用。 */
const FOOTER = /\n-{3,}\s*\n[\s\S]*$/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

class CachedFile {
  private cache: { mtime: number; text: string } | null = null;

  constructor(readonly path: string, private readonly max = MAX_CHARS, private readonly clean: (text: string) => string = (t) => t) {}

  read(): string {
    if (!existsSync(this.path)) { this.cache = null; return ''; }
    let mtime = 0;
    try { mtime = statSync(this.path).mtimeMs; } catch { return this.cache?.text ?? ''; }
    if (this.cache && this.cache.mtime === mtime) return this.cache.text;
    let text = '';
    try { text = clip(this.clean(readFileSync(this.path, 'utf8')).trim(), this.max); } catch { /* 读不了就当没有 */ }
    this.cache = { mtime, text };
    return text;
  }
}

/** 一个文件夹下最近改过的几份文本，标上文件名。 */
class RecentFiles {
  private readonly files = new Map<string, CachedFile>();

  constructor(private readonly dir: () => string) {}

  read(): string {
    const dir = this.dir();
    if (!dir || !existsSync(dir)) return '';
    let names: Array<{ path: string; name: string; mtime: number }> = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && TEXT_EXT.has(extname(d.name).toLowerCase()))
        .map((d) => {
          const path = join(dir, d.name);
          let mtime = 0;
          try { mtime = statSync(path).mtimeMs; } catch { /* 读不到时间排最后 */ }
          return { path, name: d.name, mtime };
        });
    } catch { return ''; }
    names.sort((a, b) => b.mtime - a.mtime);
    const parts: string[] = [];
    for (const { path, name } of names.slice(0, DIR_FILES)) {
      let file = this.files.get(path);
      if (!file) { file = new CachedFile(path, DIR_FILE_CHARS); this.files.set(path, file); }
      const text = file.read();
      if (text) parts.push(`### ${name}\n${text}`);
    }
    return parts.join('\n\n');
  }
}

export class PersonaStore {
  private readonly self: CachedFile;
  private readonly partner: CachedFile;
  private readonly records: RecentFiles;
  private readonly extra: RecentFiles;

  /** `extraDir` 每次现读：配置页改了文件夹，下一句话就换。 */
  constructor(botDir: string, extraDir: () => string = () => '') {
    const workspace = join(botDir, 'workspace');
    this.self = new CachedFile(join(workspace, 'CONSTITUTION.md'), MAX_CHARS, (t) => t.replace(FOOTER, ''));
    this.partner = new CachedFile(join(workspace, 'PARTNER.md'));
    this.records = new RecentFiles(() => join(workspace, 'partner'));
    this.extra = new RecentFiles(() => extraDir().trim());
  }

  get(): Persona {
    return {
      self: this.self.read(),
      partner: this.partner.read(),
      memory: [this.records.read(), this.extra.read()].filter(Boolean).join('\n\n'),
    };
  }
}
