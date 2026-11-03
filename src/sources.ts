/**
 * 哪些事件算「有人在跟桌宠说话」。
 * - 内建：桌宠的打字、开口、回答问题，控制台页的消息。一直读。
 * - 其他来源（各种 QQ、微信、B 站……扩展）：格式各不相同，没法挨个适配。这里记下见过的
 *   「来源 · 事件类型」和最近一条长什么样，配置页列成勾选框，人勾哪个读哪个；默认不勾。
 * 见过的清单落盘，重启后配置页照样列得出来。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';

/** 内建的说话事件 → 「对方刚刚……」后面那几个字。 */
export const BUILTIN_SPEAK: Record<string, string> = {
  'desktop-pet.message': '打字说',
  'desktop-pet.speech': '开口说',
  'desktop-pet.answer': '回答了问题',
  'console.message': '在控制台页上说',
};

/** 这些来源不进清单：桌宠自己（小动作另有处理）、活人感自己、Coopanion 的系统通知。 */
const NOT_LISTED = new Set(['desktop-pet', 'coopanion', 'core', 'persona']);

/** 看着像聊天消息的事件类型，清单里标一句，方便人挑。 */
const CHATTY = /message|msg|chat|speech|text|danmaku|comment|reply|mention|private|group|dm|whisper/i;

const SAMPLE_CHARS = 40;
const LIST_MAX = 40;

export interface Seen {
  key: string;
  source: string;
  type: string;
  count: number;
  sample: string;
  chatty: boolean;
}

/** 配置路径里不能有点：`qq-final.group_message` → `qq-final~group_message`。 */
export const configKey = (source: string, type: string) => `${source}|${type}`.replace(/\./g, '~');

export class SourceRegistry {
  private readonly seen = new Map<string, Seen>();
  private readonly file: string;
  private dirty = false;

  /** `skip`:另有专门设置的来源（已适配的 QQ 扩展），不进这份清单。 */
  constructor(dataDir: string, private readonly selfId: string, private readonly skip: ReadonlySet<string> = new Set()) {
    this.file = join(dataDir, 'sources.json');
    try {
      if (existsSync(this.file)) {
        for (const s of JSON.parse(readFileSync(this.file, 'utf8')) as Seen[]) this.seen.set(s.key, s);
      }
    } catch { /* 坏了就重新记 */ }
  }

  /** 记一笔；内建的、不进清单的、内部事件都不记。 */
  note(e: EventEnvelope): void {
    if (e.origin !== 'external' || e.source === this.selfId || NOT_LISTED.has(e.source) || this.skip.has(e.source) || BUILTIN_SPEAK[e.type]) return;
    const key = configKey(e.source, e.type);
    const sample = e.text.replace(/\s+/g, ' ').trim();
    const prev = this.seen.get(key);
    if (!prev && this.seen.size >= LIST_MAX) return;
    this.seen.set(key, {
      key, source: e.source, type: e.type,
      count: (prev?.count ?? 0) + 1,
      sample: sample.length > SAMPLE_CHARS ? `${sample.slice(0, SAMPLE_CHARS)}…` : sample,
      chatty: CHATTY.test(e.type),
    });
    if (!prev) this.save(); else this.dirty = true;
  }

  /** 隔一阵存一次计数和样例（新来源当场就存）。 */
  flush(): void {
    if (this.dirty) this.save();
  }

  list(): Seen[] {
    return [...this.seen.values()].filter((s) => !this.skip.has(s.source)).sort((a, b) => Number(b.chatty) - Number(a.chatty) || b.count - a.count);
  }

  private save(): void {
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.list(), null, 2), 'utf8');
    } catch { /* 存不了下次再说 */ }
  }
}
