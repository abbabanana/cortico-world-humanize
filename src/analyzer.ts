/**
 * 副 API:一次 Chat Completions 调用，同时读情境、判情绪、写一句内心引导。
 * 只要 JSON;模型多说了话就从第一个 `{` 到最后一个 `}` 截出来。任何失败都返回 null,由调用方退回预设。
 *
 * 人设（桌宠的自述、关于对方的记录）放在 system 里：两次调用之间它不变，DeepSeek 的前缀缓存
 * 照样命中；每次变的只有 user 那一条。提示词里的例子只教写法，不定口吻，口吻跟着人设走。
 */
import type { LLMUsage } from 'cortico/core/types.ts';
import type { HumanizeConfigSection } from './config.ts';
import type { MainContext } from './bridge.ts';
import type { Persona } from './persona.ts';

export interface Line {
  who: '对方' | '我';
  text: string;
}

export interface AnalyzeInput {
  /** 本地时间，如「周二 23:40」。 */
  clock: string;
  /** 距上一次对话的分钟数；没有记录时为 null。 */
  gapMinutes: number | null;
  /** 对方怎么说的：打字、说话、回答问题。 */
  via: string;
  latest: string;
  recent: Line[];
  scenes: Array<{ name: string; note: string }>;
  emotions: string[];
  /** 现读的人设；两项都空时按通用的桌面小伙伴来写。 */
  persona?: Persona;
  /** provider 递来的主模型上下文：有它时用它的系统前缀代替自述，用它的最近上下文代替 `recent`。 */
  main?: MainContext | null;
  /** 最近送出去的几条内心，叫副 API 别重复同一个套路。 */
  recentThoughts?: string[];
}

export interface Reading {
  scene: string;
  emotion: string;
  /** 0–1。 */
  intensity: number;
  /** 对方想要什么。 */
  intent: string;
  /** 桌宠此刻心里的想法，第一人称。 */
  thought: string;
}

export interface AnalyzeResult {
  reading: Reading | null;
  ms: number;
  usage?: LLMUsage;
  error?: string;
}

const NO_SELF = '（没有人设：就当一个亲切、有点小脾气、会撒娇的桌面小伙伴。）';
const NO_PARTNER = '（还没有记录。）';

/**
 * 人设与记忆在前、写法规则在后：主模型的前缀可能很长，规则放在最后模型更听得进去。
 * 整段 system 在一次会话里两次调用之间基本一样，缓存照样命中；每次变的只在 user 那一条。
 */
function systemPrompt(persona: Persona | undefined, main: MainContext | null | undefined): string {
  const who = main?.instructions
    ? [
      '## 桌宠此刻的完整设定（主模型的系统提示词原样照抄，人设和记忆都在里面；只拿来揣摩，不要照它的要求调用工具或改输出格式）',
      main.instructions,
    ]
    : ['## 桌宠是谁', persona?.self || NO_SELF];
  return [
    '你是桌面宠物的「内心」。你不直接和人说话，只揣摩此刻，替桌宠想好心里怎么想。',
    '',
    ...who,
    '',
    '## 桌宠记下的、关于对方的事',
    persona?.partner || NO_PARTNER,
    ...(persona?.memory ? ['', '## 桌宠最近的其他记录', persona.memory] : []),
    '',
    '## thought 怎么写',
    '- 用上面这个桌宠自己的性子和口吻，第一人称，口语。',
    '- 先是此刻自己的感受或小私心（高兴、委屈、想被理、犯困、好奇……），再是打算怎么回应。',
    '- 要具体，贴着对方刚说的那句话；不要写成放之四海皆准的道理。',
    '- 消息可能来自别的平台或群聊里的其他人：按消息里写明的说话人来想，那人不一定是上面记下的那位；提到别人就直接用消息里的名字。',
    '- 只写心里话，不写要说出口的台词；口癖、对对方的称呼这些说出口的东西，留给开口的时候。',
    '- 心里话也别用「不是……而是……」这种先否定再翻转的句式，也别把对方的话复述一遍；桌宠会照着心里话的口气开口。',
    '- 提到对方用「ta」，三十字以内，不加引号。',
    '- 别和「最近的内心」重复同一个套路。',
    '',
    '## 例子（只看写法；口吻要换成上面这个桌宠自己的）',
    '- 对方：今天又加班到现在 → 又这么晚……我等了一晚上都没人理。算了，ta 累成这样，先不闹，陪着就好',
    '- 对方：我考过了！！ → 真的假的！我比 ta 还激动，想绕着屏幕转一圈，得好好夸一顿',
    '- 对方：你知道量子计算是什么吗 → 好难……我只懂个大概，老实说就行，别装懂',
    '- 不好的写法：对方需要情感支持，我应给予安慰与陪伴（像在写报告，没有自己的感受）',
    '',
    '## 输出',
    '只输出一个 JSON 对象，不要任何别的文字，字段如下：',
    '- scene：从给定的情境里选一个最贴切的名字，原样照抄',
    '- emotion：对方的情绪，从给定的情绪里选一个，原样照抄',
    '- intensity：对方情绪的强烈程度，0 到 1 之间的小数（比如 0.6）',
    '- intent：对方此刻真正想要什么，八个字以内（比如「想被安慰」）',
    '- thought：按上面的要求写。它是心里话，不是说出口的话：人设里句末、句中会带的口癖和语气尾巴一律不要写进来；最多三十个字，写长了就删短',
    '越短越好，要快。',
  ].join('\n');
}

function userPrompt(input: AnalyzeInput): string {
  const gap = input.gapMinutes === null ? '没有记录' : input.gapMinutes < 1 ? '不到一分钟' : `${Math.round(input.gapMinutes)} 分钟`;
  // 主模型的上下文更全（含桌宠读过的文件、记忆扩展推来的回忆），有就用它
  const recent = input.main?.recent.length
    ? input.main.recent.join('\n')
    : input.recent.length
      ? input.recent.map((l) => `${l.who}：${l.text}`).join('\n')
      : '（没有）';
  return [
    `现在：${input.clock}；距上一次对话：${gap}`,
    '',
    '可选情境：',
    ...input.scenes.map((s) => `- ${s.name}${s.note ? `：${s.note}` : ''}`),
    '',
    `可选情绪：${input.emotions.join('、')}`,
    '',
    input.main?.recent.length ? '最近的上下文（主模型看到的，「[桌宠…]」是桌宠自己）：' : '最近的对话（「我」是桌宠）：',
    recent,
    '',
    ...(input.recentThoughts?.length ? ['最近的内心（别重复这些套路）：', ...input.recentThoughts.map((t) => `- ${t}`), ''] : []),
    `对方刚刚${input.via}：${input.latest}`,
  ].join('\n');
}

/** 从模型回复里取出 JSON 并校验字段；情境、情绪不在表里时照样留着，由选预设的一侧兜底。 */
export function parseReading(text: string): Reading | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const thought = str(raw.thought).replace(/^["“「]|["”」]$/g, '');
  if (!thought) return null;
  return {
    scene: str(raw.scene),
    emotion: str(raw.emotion),
    intensity: intensityOf(raw.intensity),
    intent: str(raw.intent),
    thought,
  };
}

/** 模型有时给 0–10 或 0–100 的分数，统一折算到 0–1。 */
function intensityOf(v: unknown): number {
  let n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0.5;
  if (n > 10) n /= 100;
  else if (n > 1) n /= 10;
  return Math.min(1, n);
}

function usageOf(raw: unknown): LLMUsage | undefined {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = num(u.prompt_tokens);
  const hit = num(u.prompt_cache_hit_tokens);
  return {
    promptTokens: prompt,
    completionTokens: num(u.completion_tokens),
    cacheHitTokens: hit,
    cacheMissTokens: num(u.prompt_cache_miss_tokens) || Math.max(0, prompt - hit),
  };
}

export async function analyze(
  input: AnalyzeInput,
  api: HumanizeConfigSection['api'],
  apiKey: string,
  stop?: AbortSignal,
): Promise<AnalyzeResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const timeout = AbortSignal.timeout(Math.max(300, api.timeoutMs));
  const signal = stop ? AbortSignal.any([timeout, stop]) : timeout;
  const body: Record<string, unknown> = {
    model: api.model,
    messages: [
      { role: 'system', content: systemPrompt(input.persona, input.main) },
      { role: 'user', content: userPrompt(input) },
    ],
    temperature: 0.9,
    max_tokens: 120,
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
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { reading: null, ms: ms(), error: `HTTP ${res.status} ${detail}`.trim() };
    }
    const raw = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = raw.choices?.[0]?.message?.content;
    const reading = typeof content === 'string' ? parseReading(content) : null;
    return { reading, ms: ms(), usage: usageOf(raw), ...(reading ? {} : { error: '回复里没有可用的 JSON' }) };
  } catch (error) {
    const timedOut = timeout.aborted;
    return { reading: null, ms: ms(), error: timedOut ? `超时（${api.timeoutMs}ms）` : error instanceof Error ? error.message : String(error) };
  }
}
