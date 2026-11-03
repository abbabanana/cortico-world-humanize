/**
 * 口吻样本库：每种情境几句「这个桌宠会怎么说」的示范，告诉模型「像这样说」。
 *
 * 和预设库不同，样本就是人设的一部分，所以按人设自动生成，存在部署目录（`<部署>/humanize/VOICE.md`），
 * 不随扩展分发。生成后每句先过一遍说话习惯体检，用了套路句式的扔掉，免得示范本身带 AI 味。
 *
 * 文件头记着生成时的人设指纹和正文指纹：人设变了、正文没被人改过，就按新人设重写；
 * 人改过就不覆盖，只在配置页提示。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LLMUsage } from 'cortico/core/types.ts';
import type { HumanizeConfigSection } from './config.ts';
import { checkHabits } from './habits.ts';
import type { Persona } from './persona.ts';

export interface VoiceFile {
  /** 情境名 → 示范句。 */
  scenes: Map<string, string[]>;
  /** 生成时的人设指纹；人手写的文件没有。 */
  personaSig: string | null;
  /** 正文被人改过（和生成时的正文指纹对不上）。 */
  edited: boolean;
}

/** 找不到对应情境时用这一组。 */
export const GENERIC = '通用';
const PER_SCENE = 5;
const MARK = /<!--\s*humanize:\s*persona=(\w+)\s+body=(\w+)\s*-->/;

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

export function personaSignature(p: Persona): string {
  return sha(`${p.self}\u0000${p.partner}`);
}

const HEADER = [
  '# 口吻样本',
  '',
  '> 每种情境下这个桌宠会怎么说的几句示范。每次回复挑两句跟在心事后面，让它学口气和长短，不照抄。',
  '> 「## 情境名」下面一行一句，情境名和预设库里的对上；「## 通用」在找不到对应情境时用。',
  '> 这份是按人设自动写的，可以随便改。改过以后人设再变也不会被覆盖；想按新人设重写，删掉这份文件，',
  '> 或者在配置页勾「重写口吻样本」。',
];

/** 正文（去掉文件头和指纹注释）——指纹只算这部分，人改了注释和说明不算改正文。 */
function bodyOf(text: string): string {
  return text.split(/\r?\n/).filter((l) => !l.trim().startsWith('>') && !MARK.test(l) && !/^#\s/.test(l.trim())).join('\n').trim();
}

export function parseVoice(text: string): VoiceFile {
  const scenes = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>')) continue;
    const head = /^##\s*(.+)$/.exec(line);
    if (head) {
      const name = head[1].replace(/^情境\s*[:：]\s*/, '').trim();
      current = scenes.get(name) ?? [];
      scenes.set(name, current);
      continue;
    }
    if (current && line.startsWith('-')) {
      const sample = line.slice(1).trim().replace(/^[「“"]|[」”"]$/g, '');
      if (sample) current.push(sample);
    }
  }
  const mark = MARK.exec(text);
  return {
    scenes,
    personaSig: mark?.[1] ?? null,
    edited: mark ? sha(bodyOf(text)) !== mark[2] : true,
  };
}

export function renderVoice(scenes: Map<string, string[]>, personaSig: string): string {
  const body = [...scenes].map(([name, lines]) => [`## ${name}`, ...lines.map((l) => `- ${l}`)].join('\n')).join('\n\n');
  return [...HEADER, `<!-- humanize: persona=${personaSig} body=${sha(bodyOf(body))} -->`, '', body, ''].join('\n');
}

/** 按修改时间缓存的读取。 */
export class VoiceStore {
  private cache: { mtime: number; file: VoiceFile } | null = null;

  constructor(readonly path: string) {}

  exists(): boolean { return existsSync(this.path); }

  get(): VoiceFile | null {
    if (!existsSync(this.path)) { this.cache = null; return null; }
    let mtime = 0;
    try { mtime = statSync(this.path).mtimeMs; } catch { /* 读不到时间就重读 */ }
    if (this.cache && this.cache.mtime === mtime && mtime !== 0) return this.cache.file;
    let file: VoiceFile;
    try { file = parseVoice(readFileSync(this.path, 'utf8')); } catch { return null; }
    this.cache = { mtime, file };
    return file;
  }

  write(text: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, text, 'utf8');
    this.cache = null;
  }
}

const SYSTEM = [
  '你在给一个桌面宠物写「口吻样本」：每种情境下，它真会怎么开口说的几句话。这些句子会拿去给它当说话的示范，所以要像真人随口说的，不像 AI。',
  '',
  '要求：',
  '- 完全照着它的人设：性子、在意的事、对对方的称呼。但人设里的口癖、句末语气尾巴一律不要写进样本：样本是拿来示范「不带口癖也像它」的，口癖它自己会偶尔带。',
  '- 长短要错开：有的就两三个字（「嗯？」「还不睡啊」），有的一整句；不要每句都一样长。',
  '- 直接说自己的反应和想法。别把对方的话复述一遍；别用「不是……而是……」「不只是……更是……」；别用「是 A 还是 B？」反问；别下「……最怕的就是……」这种格言；别说「说正经的」「说实话」；别劝休息、别讲安全常识，除非这个情境本来就该这么说。',
  '- 大多数句子说完就停，不用每句都抛个问题回去。',
  '- 只写说出口的字，不写动作、表情标记，不加引号。',
  '',
  '只输出一个 JSON 对象：键是情境名（原样照抄给定的，外加「通用」），值是这个情境下的句子数组，每个情境 8 句（会从中挑出最好的几句）。',
].join('\n');

function userPrompt(persona: Persona, scenes: Array<{ name: string; note: string; style: string }>): string {
  return [
    '## 桌宠是谁',
    persona.self || '（没有人设：就当一个亲切、有点小脾气、会撒娇的桌面小伙伴。）',
    '',
    '## 它记下的、关于对方的事',
    persona.partner || '（还没有记录。）',
    '',
    '## 情境',
    ...scenes.map((s) => `- ${s.name}：${s.note}${s.style ? `（分寸：${s.style}）` : ''}`),
    `- ${GENERIC}：随便什么时候都能用的`,
  ].join('\n');
}

export interface GenerateResult {
  scenes: Map<string, string[]> | null;
  /** 体检扔掉的句子数。 */
  dropped: number;
  ms: number;
  usage?: LLMUsage;
  error?: string;
}

/** 调副 API 按人设写样本，过体检，每个情境留 PER_SCENE 句。 */
export async function generateVoice(
  persona: Persona,
  scenes: Array<{ name: string; note: string; style: string }>,
  api: HumanizeConfigSection['api'],
  apiKey: string,
  stop?: AbortSignal,
): Promise<GenerateResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(90_000);
  const signal = stop ? AbortSignal.any([timeout, stop]) : timeout;
  const body: Record<string, unknown> = {
    model: api.model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(persona, scenes) }],
    temperature: 1,
    max_tokens: 3000,
    stream: false,
  };
  if (api.effort.trim()) body.reasoning_effort = api.effort.trim();
  try {
    const res = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return { scenes: null, dropped: 0, ms: Date.now() - started, error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const raw = await res.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, number> };
    const content = String(raw.choices?.[0]?.message?.content ?? '');
    const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out = new Map<string, string[]>();
    let dropped = 0;
    for (const name of [...scenes.map((s) => s.name), GENERIC]) {
      const lines = Array.isArray(parsed[name]) ? (parsed[name] as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      const clean = lines
        .map((l) => l.replace(/【[^】]*】|<[^>]*>/g, '').replace(/^[「“"]|[」”"]$/g, '').trim())
        .filter(Boolean);
      // 样本自己先过一遍体检：示范里有套路句式，等于教它套路
      const kept = clean.filter((said) => checkHabits([{ heard: '', said }], [], true).length === 0);
      dropped += clean.length - kept.length;
      if (kept.length) out.set(name, kept.slice(0, PER_SCENE));
    }
    const u = raw.usage;
    const usage = u ? {
      promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0,
      cacheHitTokens: u.prompt_cache_hit_tokens ?? 0, cacheMissTokens: u.prompt_cache_miss_tokens ?? 0,
    } : undefined;
    return out.size ? { scenes: out, dropped, ms: Date.now() - started, usage } : { scenes: null, dropped, ms: Date.now() - started, usage, error: '回复里没有可用的样本' };
  } catch (error) {
    return { scenes: null, dropped: 0, ms: Date.now() - started, error: timeout.aborted ? '超时' : error instanceof Error ? error.message : String(error) };
  }
}

/** 从这个情境里挑 `n` 句，避开最近用过的；情境没有就用「通用」。 */
export function pickSamples(file: VoiceFile, scene: string | undefined, n: number, recent: readonly string[]): string[] {
  const pool = (scene && file.scenes.get(scene)) || file.scenes.get(GENERIC) || [];
  const fresh = pool.filter((l) => !recent.includes(l));
  const from = fresh.length >= n ? fresh : pool;
  const picked: string[] = [];
  const left = [...from];
  while (picked.length < n && left.length) picked.push(left.splice(Math.floor(Math.random() * left.length), 1)[0]!);
  return picked;
}
