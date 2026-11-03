/**
 * 活人感 World:给桌宠递「内心」。
 *
 * - 有人对桌宠说话（桌宠、控制台、适配过的 QQ 扩展、勾上的其他来源）：调副 API 读情境、写一句
 *   内心引导，后面跟上「说话提醒」（桌宠最近真用过的套路句式）。交给桌宠有三条路：
 *   - provider 模式（当前端点是「活人感」provider 包着的那个）：provider 在主模型请求发出前来认领，
 *     顺带递来主模型的上下文；心事想好后由它塞进请求。主模型这一轮就带着心事开口。
 *   - 先感受再开口（`wait`,默认）：环境提示词让模型先调用 `humanize_feel`,工具等副 API 的结果
 *     回来，把内心交回给模型，模型读完再说话。
 *   - 抢时间：引导回来后用 preempt 推进去；模型还没开口时 Core 会取消在途的一轮，带着引导重新请求。
 *   模型已经开口（正文或别的工具调用）就放弃这一条，不留到下一轮。
 *   不同对话（本机、各个聊天扩展）各想各的，一边来了新消息不会作废另一边正在想的。
 * - 戳、摸、扔、换装：不调副 API,按概率从预设库抽一句，以 piggyback 跟着那批事件一起送。
 * - 前缀里的说明旧了（换了模式、更新了环境说明）：请桌宠转告一次，或者开着自动刷新时等空闲关开自己。
 *
 * 事件库每 250ms 看一次新事件；配置页写入不回调 World,密钥输入框和前缀新旧也在这里每秒对一次。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EventEnvelope, OutputTap, RunPhase, StoragePart, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { analyze, type Line, type Reading } from './analyzer.ts';
import { BRIDGE_VERSION, installBridge, removeBridge, type HumanizeBridge, type MainContext } from './bridge.ts';
import { HUMANIZE_ID, KEY_SECRET, configGroups, type HumanizeConfigSection } from './config.ts';
import { FALLBACK_EMOTION, PresetStore, emotionsOf, type Presets, type Scene } from './presets.ts';
import { PersonaStore } from './persona.ts';
import { MODE_LABEL, PrefixState, signature, type Mode } from './prefix-state.ts';
import { BUILTIN_SPEAK, SourceRegistry, configKey } from './sources.ts';
import { ADAPTERS, adapterFor, describe as describeChat } from './adapters.ts';
import { checkHabits, habitNote, type Turn } from './habits.ts';
import { VoiceStore, generateVoice, personaSignature, pickSamples, renderVoice } from './voice.ts';
import { resolveKey } from './secret.ts';

export const INNER_EVENT = `${HUMANIZE_ID}.inner`;
export const NOTICE_EVENT = `${HUMANIZE_ID}.notice`;
export const FEEL_TOOL = `${HUMANIZE_ID}_feel`;

export const FEEL_TOOL_DECL = {
  name: FEEL_TOOL,
  description: '对方刚对你说完话（打字、开口、回答你的问题）时，先调用它感受一下此刻的心情和说话分寸，读完结果再用 pet_say 回应。被戳、被摸这类小动作和你自己主动开口时不用调用。结果是你自己的心里话，不要念出来。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  tags: ['read'] as const,
};

/** 没有正在想的心事时，工具的回执。 */
const NO_FEELING = '【内心】此刻没有特别的心事，照你平常的样子说话就好。';
/** 工具来得晚、心事已经想完了：这么久以内想好的照样交回去。 */
const RECENT_FEELING_MS = 30_000;
/** provider 这么久以内转发过请求，就算它在用：不再给模型 humanize_feel。 */
const PROVIDER_LIVE_MS = 10 * 60_000;
/** 按事件游标记住的最近几次心事，供 provider 认领。 */
const THINKING_KEEP = 8;
/** provider 在用时，等它把主模型的上下文递过来再开始想，最多等这么久。 */
const MAIN_CONTEXT_WAIT_MS = 400;
/**
 * 其他来源的消息：provider 在用时，等主模型真的醒来回应这批消息（provider 来认领）才想，
 * 最多等这么久（Core 合批最长 15 秒）；没等到说明主模型没醒，不花这一次。
 */
const EXTRA_CLAIM_WAIT_MS = 16_000;
/** 其他来源的消息：不用 provider 时，等那个来源安静这么久再想（和 Core 合批的安静间隔一致）。 */
const QUIET_GAP_MS = 2_500;

/** 怎么开始想：等不等 provider 递上下文、等多久、没等到还想不想。 */
interface StartWhen {
  waitMs: number;
  /** true:没等到 provider 认领就不想（其他来源的消息）。 */
  requireClaim: boolean;
}

const PET = 'desktop-pet';
const TOUCH_NAMES: Record<string, string> = { poke: '戳', pet: '摸', throw: '扔', drop: '放下' };
const FIGURE_NAME = '换装';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PRESETS = join(PACKAGE_DIR, 'presets', 'PRESETS.md');
const DEFAULT_ENV_PROMPT = join(PACKAGE_DIR, 'src', 'ENV_PROMPT.md');

const TICK_MS = 250;
const KEY_SYNC_TICKS = 4;
const TRANSCRIPT_MAX = 40;
/** 说话习惯体检看桌宠最近说的这么多句。 */
const HABIT_WINDOW = 12;
/** 启动时从会话记录里补回最近的对话，最多读这么多行（从文件末尾往前）。 */
const SEED_LINES = 600;
const RECENT_LINES_MAX = 8;
/** 叫副 API 别重复的最近几条内心。 */
const RECENT_THOUGHTS = 3;
const LOG_MAX = 20;
/** 隔了这么久才说话算「久别重逢」。 */
const LONG_GAP_MINUTES = 180;
/** 每次回复挑几句口吻样本；最近用过的这么多句尽量不重复。 */
const SAMPLES_PER_REPLY = 2;
const RECENT_SAMPLES = 6;
/** 隔这么多次轮询（约一分钟）看一次人设有没有变、要不要重写口吻样本。 */
const VOICE_CHECK_TICKS = 240;

export interface HumanizeOptions {
  cfg: HumanizeConfigSection;
  timezone: string;
  botDir: string;
  dataDir: string;
  secret(name: string): string;
  storeSecret(name: string, value: string): void;
  persist(patch: Partial<HumanizeConfigSection>): void;
  /** 按配置重启自己（关开一次）：Core 卸载再挂载，系统前缀随之重建。 */
  restart(): Promise<void>;
}

type Outcome = 'api' | 'preset' | 'late' | 'light' | 'skipped' | 'prefix' | 'voice';

/** 一次对话想出来的内心。 */
interface Feeling {
  body: string;
  outcome: 'api' | 'preset';
  via: string;
  meta: Record<string, unknown>;
  ms?: number;
  error?: string;
}

/** 正在想的那一次：工具在等它，或者想完后由推送方取走。 */
interface Thinking {
  promise: Promise<Feeling | null>;
  /** 工具已经把它交给模型了，不要再推事件。 */
  consumed: boolean;
  /** 用不上了就掐掉，别白调副 API。 */
  ctrl: AbortController;
}

interface LogEntry {
  at: string;
  trigger: string;
  outcome: Outcome;
  text: string;
  ms?: number;
  error?: string;
  /** 怎么交到桌宠手里的：经工具，还是推事件。 */
  how?: string;
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  api: '副 API 引导',
  preset: '预设兜底',
  late: '来不及（桌宠已开口）',
  light: '小动作轻预设',
  skipped: '跳过',
  prefix: '前缀',
  voice: '已更新',
};

/** 去掉气泡脚本里的表情动作标记，只留说出口的字。 */
const spoken = (script: string) => script.replace(/【[^】]*】|<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export class HumanizeWorld implements World {
  readonly id = HUMANIZE_ID;
  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private ticks = 0;
  private lastCursor = 0;
  private readonly stopped = new AbortController();
  /**
   * 每个对话当前在等副 API 的那一次；同一对话来了新消息就作废旧的。本机（桌宠、控制台）算一个
   * 对话，每个聊天扩展各算一个，互不作废。
   */
  private readonly pending = new Map<string, AbortController>();
  private thinking: Thinking | null = null;
  /** 事件游标 → 那句话引出的心事，provider 按帧里的游标来认领。 */
  private readonly thinkingByCursor = new Map<number, Thinking>();
  /** 事件游标 → 在等 provider 递主模型上下文的那一次（递来就开始想；undefined = 没等到）。 */
  private readonly awaitingMain = new Map<number, (main: MainContext | null | undefined) => void>();
  /** 其他来源各自的「安静计时」：不用 provider 时，来源安静下来才想最后那一条。 */
  private readonly quiet = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sources: SourceRegistry;
  /** provider 最近一次转发请求的时刻。 */
  private providerAt: number | null = null;
  private readonly bridge: HumanizeBridge = {
    version: BRIDGE_VERSION,
    sync: () => this.tick(),
    claim: (cursors, main) => this.claim(cursors, main),
    touch: () => { this.providerAt = Date.now(); },
  };
  /** 最近一次想好的内心，工具来晚了也能交回去。 */
  private lastFeeling: { feeling: Feeling; at: number } | null = null;
  /** 从上一次触发起，模型是否已经对外输出（正文或 humanize_feel 以外的工具调用）。 */
  private spoke = false;
  /** 从上一次触发起，模型是否已经调用了 humanize_feel。 */
  private feelCalled = false;
  private readonly transcript: Line[] = [];
  private lastUserAt: number | null = null;
  private readonly recentLines: string[] = [];
  private readonly log: LogEntry[] = [];
  private readonly stats = { api: 0, preset: 0, late: 0, light: 0, apiMs: 0, waited: 0 };
  private keyNote = '';
  private readonly presets: PresetStore;
  private readonly persona: PersonaStore;
  /** 最近几条副 API 写的内心，下一次叫它别重复同一个套路。 */
  private readonly recentThoughts: string[] = [];
  private readonly overrideDir: string;
  private readonly prefixState: PrefixState;
  /** 主循环此刻在做什么；自动刷新只在 idle 时动手。 */
  private phase: RunPhase['state'] = 'idle';
  /** 已经发起了自动刷新，等 Core 把自己关开。 */
  private refreshing = false;
  private readonly voice: VoiceStore;
  /** 正在写口吻样本。 */
  private writingVoice = false;
  private readonly recentSamples: string[] = [];

  constructor(private readonly opts: HumanizeOptions) {
    this.overrideDir = join(opts.botDir, HUMANIZE_ID);
    this.prefixState = new PrefixState(opts.botDir, opts.dataDir);
    this.sources = new SourceRegistry(opts.dataDir, HUMANIZE_ID, new Set(ADAPTERS.map((a) => a.source)));
    this.presets = new PresetStore(() => [join(this.overrideDir, 'PRESETS.md'), DEFAULT_PRESETS]);
    this.persona = new PersonaStore(opts.botDir, () => this.cfg.memoryDir);
    this.voice = new VoiceStore(join(this.overrideDir, 'VOICE.md'));
  }

  private get cfg(): HumanizeConfigSection { return this.opts.cfg; }

  // ---------------------------------------------------------------- 契约

  /**
   * 「活人感」provider 在转发主模型的请求：心事由它直接塞进请求，不用工具。
   * 先看当前端点的配置（拼前缀时 provider 可能还没转发过），读不到再看它最近有没有报到。
   */
  private providerLive(): boolean {
    return this.prefixState.providerConfigured()
      || (this.providerAt !== null && Date.now() - this.providerAt < PROVIDER_LIVE_MS);
  }

  private mode(): Mode {
    return this.providerLive() ? 'provider' : this.cfg.wait ? 'tool' : 'push';
  }

  /** 前缀里活人感那部分的指纹：环境说明模板和工具说明，换了就要刷新。 */
  private envSignature(): string {
    let template = '';
    try { template = readFileSync(this.readable(join(this.overrideDir, 'ENV_PROMPT.md'), DEFAULT_ENV_PROMPT), 'utf8'); } catch { /* 没有模板也算一种 */ }
    return signature(template, FEEL_TOOL_DECL.description);
  }

  tools(): ToolDef[] {
    if (this.mode() === 'provider') return [];
    return [{
      ...FEEL_TOOL_DECL,
      // 读完心事再动：同一条输出里排在它后面的 pet_say 不执行，模型要看到结果再说话
      barrierAfter: true,
      handler: () => this.feel(),
    }];
  }

  /** 每次前缀重建时 Core 来取；顺手记下这一版前缀是按什么模式、什么说明拼的。 */
  envPromptVars(): Record<string, string> {
    const mode = this.mode();
    this.prefixState.built(mode, this.envSignature());
    const wait: Record<Mode, string> = {
      provider: '「【内心】」会直接跟着对方的话一起出现，不需要调用任何工具。',
      tool: `对方刚对你说完话时，先调用 \`${FEEL_TOOL}\` 感受一下，读完结果再开口；被戳、被摸和你主动开口时不用。`,
      push: `\`${FEEL_TOOL}\` 可以不用调用：「【内心】」会自己出现在事件里。`,
    };
    return { 'humanize.wait': wait[mode] };
  }

  onRunPhase(phase: RunPhase): void {
    this.phase = phase.state;
  }

  outputTap(): OutputTap {
    return {
      onEvent: (event) => {
        const e = event as { type?: string; item?: { type?: string; name?: string; arguments?: string } };
        if (e.type === 'response.output_text.delta') this.spoke = true;
        if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
          if (e.item.name === FEEL_TOOL) this.feelCalled = true;
          else this.spoke = true;
        }
        if (e.type === 'response.output_item.done' && e.item?.type === 'function_call' && e.item.name === 'pet_say') {
          try {
            const script = (JSON.parse(e.item.arguments ?? '{}') as { script?: unknown }).script;
            if (typeof script === 'string' && spoken(script)) this.remember({ who: '我', text: spoken(script) });
          } catch { /* 参数没写完整就不记 */ }
        }
      },
      // 不声明 externalizes:按框架默认规则判定，和桌宠自己的接收器一致
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.lastCursor = host.store.latestCursor();
    this.seedTranscript();
    this.syncKey();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    installBridge(this.bridge);
    void this.ensureVoice();
  }

  async stop(): Promise<void> {
    removeBridge(this.bridge);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
    this.stopped.abort();
    for (const timer of this.quiet.values()) clearTimeout(timer);
    this.quiet.clear();
    this.sources.flush();
    this.host = undefined;
  }

  // ---------------------------------------------------------------- 事件

  private tick(): void {
    const host = this.host;
    if (!host) return;
    if (++this.ticks % KEY_SYNC_TICKS === 0) {
      this.syncKey();
      this.checkPrefix();
      if (this.ticks % (KEY_SYNC_TICKS * 60) === 0) this.sources.flush();
      // 勾了「重写」就马上写；否则大约一分钟看一次人设变没变
      if (this.cfg.rewriteVoice || this.ticks % VOICE_CHECK_TICKS === 0) void this.ensureVoice();
    }
    const latest = host.store.latestCursor();
    if (latest <= this.lastCursor) return;
    const events = host.store.range({ fromCursor: this.lastCursor + 1, toCursor: latest });
    this.lastCursor = latest;
    for (const e of events) {
      if (e.source === this.id) continue;
      try {
        this.sources.note(e);
        this.onEvent(e);
      } catch (error) { host.log.warn(`活人感处理事件 ${e.type} 出错：${String(error)}`); }
    }
  }

  private onEvent(e: EventEnvelope): void {
    const via = BUILTIN_SPEAK[e.type];
    if (via) {
      const text = typeof e.meta?.text === 'string' && e.meta.text.trim() ? e.meta.text.trim() : e.text;
      void this.onSpeak(e, via, text, { waitMs: MAIN_CONTEXT_WAIT_MS, requireClaim: false });
      return;
    }
    // 专门适配过的 QQ 扩展：读出在哪、谁、说了什么、有没有叫桌宠，按设置过滤
    const adapter = adapterFor(e.source);
    if (adapter) {
      const chat = e.origin === 'external' ? adapter.parse(e) : null;
      if (!chat) return;
      const mode = this.cfg.platforms?.[e.source] ?? 'addressed';
      if (mode === 'off' || (mode === 'addressed' && !chat.addressed)) return;
      const { via, text } = describeChat(chat);
      this.onExtra(e, via, text);
      return;
    }
    if (e.origin === 'external' && this.cfg.sources?.[configKey(e.source, e.type)]) {
      this.onExtra(e, `在「${e.source}」那边发来消息`, e.text);
      return;
    }
    if (e.source !== PET) return;
    if (e.type === `${PET}.touch`) {
      const kind = (e.meta?.touch as { kind?: string } | undefined)?.kind;
      const name = kind ? TOUCH_NAMES[kind] : undefined;
      if (name) this.onLight(name);
      return;
    }
    if (e.type === `${PET}.figure`) {
      const figure = e.meta?.figure as { kind?: string } | undefined;
      if (figure && figure.kind !== 'failed') this.onLight(FIGURE_NAME);
    }
  }

  /**
   * 勾上的其他来源来了一条：provider 在用时等主模型醒来认领再想；不然等这个来源安静下来，
   * 想最后那一条（群聊一阵刷屏只想一次）。
   */
  private onExtra(e: EventEnvelope, via: string, text: string): void {
    if (this.providerLive()) {
      void this.onSpeak(e, via, text, { waitMs: EXTRA_CLAIM_WAIT_MS, requireClaim: true });
      return;
    }
    const prev = this.quiet.get(e.source);
    if (prev) clearTimeout(prev);
    this.quiet.set(e.source, setTimeout(() => {
      this.quiet.delete(e.source);
      void this.onSpeak(e, via, text, { waitMs: 0, requireClaim: false });
    }, QUIET_GAP_MS));
  }

  private async onSpeak(e: EventEnvelope, via: string, text: string, when: StartWhen): Promise<void> {
    const at = Date.parse(e.ts);
    // 「隔了多久」只算对方在桌宠、控制台上的话；QQ 群里别人说话不算
    const builtin = !!BUILTIN_SPEAK[e.type];
    const gapMinutes = builtin && this.lastUserAt !== null && Number.isFinite(at) ? (at - this.lastUserAt) / 60_000 : null;
    if (builtin && Number.isFinite(at)) this.lastUserAt = at;
    const recent = this.transcript.slice(-Math.max(0, this.cfg.contextTurns));
    this.remember({ who: '对方', text: builtin ? text : `[${via}] ${text}` });

    const channel = builtin ? 'local' : e.source;
    this.pending.get(channel)?.abort();
    const mine = new AbortController();
    this.pending.set(channel, mine);
    this.spoke = false;
    this.feelCalled = false;
    // provider 在用时先等它来认领（顺带递来主模型这次的上下文）再开始想；
    // 其他来源的消息没等到认领就说明主模型没醒，这一次不想
    const waits = when.waitMs > 0 && this.providerLive() && (this.cfg.shareContext || when.requireClaim);
    const main = waits ? this.waitMain(e.cursor, when.waitMs) : Promise.resolve(null);
    const thinking: Thinking = {
      promise: main.then((m) => (m === undefined && when.requireClaim ? null : this.think(text, at, gapMinutes, recent, via, mine, m ?? null))),
      consumed: false,
      ctrl: mine,
    };
    this.thinking = thinking;
    this.thinkingByCursor.set(e.cursor, thinking);
    while (this.thinkingByCursor.size > THINKING_KEEP) this.thinkingByCursor.delete(this.thinkingByCursor.keys().next().value!);

    const feeling = await thinking.promise;
    if (mine.signal.aborted || this.pending.get(channel) !== mine || !this.host) return;
    this.pending.delete(channel);
    if (!feeling) return;
    this.lastFeeling = { feeling, at: Date.now() };
    // 工具已经交给模型了，或者模型正在调用工具（马上就会拿到）：不再推事件
    if (thinking.consumed || this.feelCalled) return;
    if (this.spoke) {
      this.stats.late++;
      this.record({ trigger: via, outcome: 'late', text: feeling.body, ms: feeling.ms, error: feeling.error });
      return;
    }
    this.count(feeling);
    this.record({ trigger: via, outcome: feeling.outcome, text: feeling.body, ms: feeling.ms, error: feeling.error, how: '推送事件' });
    void this.push(feeling.body, 'preempt', feeling.meta);
  }

  /** `humanize_feel` 的回执：等正在想的那一次，想完交回；没有在想的就给最近一次或一句「没什么心事」。 */
  private async feel(): Promise<string> {
    // 轮询最多晚 250ms:先把刚到的消息收进来，免得交出上一句话的心事
    this.tick();
    const thinking = this.thinking;
    const started = Date.now();
    if (thinking && !thinking.consumed) {
      const feeling = await thinking.promise;
      if (feeling && !thinking.consumed) {
        thinking.consumed = true;
        this.stats.waited++;
        this.count(feeling);
        const waited = Date.now() - started;
        this.record({ trigger: feeling.via, outcome: feeling.outcome, text: feeling.body, ms: feeling.ms, error: feeling.error, how: `经工具交给桌宠，桌宠等了 ${waited}ms` });
        return feeling.body;
      }
    }
    const last = this.lastFeeling;
    if (last && Date.now() - last.at < RECENT_FEELING_MS) return last.feeling.body;
    return NO_FEELING;
  }

  /**
   * provider 认领：这批事件里最新那句话的心事。认领后 World 不再推事件、工具也不再交。
   * 那句话已经被新消息顶掉（作废）时 promise 给 null,provider 照常转发。
   */
  private claim(cursors: readonly number[], main: MainContext | null): Promise<string | null> | null {
    const cursor = [...cursors].reverse().find((c) => this.thinkingByCursor.has(c));
    const thinking = cursor === undefined ? undefined : this.thinkingByCursor.get(cursor);
    if (!thinking || thinking.consumed) return null;
    // 一批里有好几句话各自在想（比如本机一句、QQ 一句）：只交最新那句，其余的也算交过了，
    // 免得它们想完后发现没人认领，又自己推一遍事件
    for (const c of cursors) {
      const other = this.thinkingByCursor.get(c);
      if (other && other !== thinking && !other.consumed) {
        other.consumed = true;
        other.ctrl.abort();
        this.awaitingMain.get(c)?.(undefined);
      }
    }
    thinking.consumed = true;
    this.awaitingMain.get(cursor!)?.(this.cfg.shareContext ? main : null);
    const started = Date.now();
    return thinking.promise.then((feeling) => {
      if (!feeling) return null;
      this.stats.waited++;
      this.count(feeling);
      this.record({ trigger: feeling.via, outcome: feeling.outcome, text: feeling.body, ms: feeling.ms, error: feeling.error, how: `经 provider 注入，主模型晚发了 ${Date.now() - started}ms` });
      return feeling.body;
    });
  }

  /**
   * 等 provider 来认领，最多 `ms`。认领了给主模型上下文（不共享时 null）；没等到给 undefined,
   * 由调用方决定是照常读文件来想，还是这次不想。
   */
  private waitMain(cursor: number, ms: number): Promise<MainContext | null | undefined> {
    return new Promise((resolve) => {
      const done = (main: MainContext | null | undefined) => {
        clearTimeout(timer);
        this.awaitingMain.delete(cursor);
        resolve(main);
      };
      const timer = setTimeout(() => done(undefined), ms);
      this.awaitingMain.set(cursor, done);
    });
  }

  private count(feeling: Feeling): void {
    this.stats[feeling.outcome]++;
    if (feeling.outcome === 'api' && feeling.ms !== undefined) this.stats.apiMs += feeling.ms;
  }

  /** 调副 API(或直接用预设)想出这一次的内心；作废了或预设库是空的返回 null。 */
  private async think(text: string, at: number, gapMinutes: number | null, recent: Line[], via: string, mine: AbortController, main: MainContext | null = null): Promise<Feeling | null> {
    // 等认领的工夫里又来了新消息，这一次已经作废
    if (mine.signal.aborted) return null;
    const presets = this.presets.get();
    const date = Number.isFinite(at) ? new Date(at) : new Date();
    const fallbackScene = this.guessScene(presets, date, gapMinutes);
    let reading: Reading | null = null;
    let ms: number | undefined;
    let error: string | undefined;

    const key = this.cfg.guide ? resolveKey(this.opts.secret, this.opts.botDir, this.cfg.api.baseUrl).key : '';
    if (this.cfg.guide && !key) error = '没有可用的 API Key';
    if (key) {
      const result = await analyze({
        clock: this.clock(date),
        gapMinutes,
        via,
        latest: text,
        recent,
        scenes: presets.scenes.map((s) => ({ name: s.name, note: s.note })),
        emotions: emotionsOf(presets),
        persona: this.persona.get(),
        main,
        recentThoughts: [...this.recentThoughts],
      }, this.cfg.api, key, AbortSignal.any([mine.signal, this.stopped.signal]));
      ms = result.ms;
      error = result.error;
      reading = result.reading;
      if (result.usage) this.host?.reportUsage(result.usage, { model: this.cfg.api.model, label: '活人感 · 副 API' });
    }
    if (mine.signal.aborted) return null;

    const scene = (reading && presets.scenes.find((s) => s.name === reading.scene)) || fallbackScene;
    const thought = reading?.thought ?? (scene ? this.pickLine(scene, reading?.emotion) : null);
    if (reading?.thought) {
      this.recentThoughts.push(reading.thought);
      if (this.recentThoughts.length > RECENT_THOUGHTS) this.recentThoughts.shift();
    }
    if (!thought) {
      this.record({ trigger: via, outcome: 'skipped', text: '预设库是空的', ms, error });
      return null;
    }
    const outcome = reading ? 'api' : 'preset';
    return {
      body: [this.innerText(scene, reading, thought), this.sampleLine(scene?.name), this.habitReminder()].filter(Boolean).join('\n'),
      outcome,
      via,
      meta: { by: outcome, scene: scene?.name ?? '', emotion: reading?.emotion ?? '' },
      ms,
      error,
    };
  }

  private onLight(action: string): void {
    if (!this.cfg.light || Math.random() >= this.cfg.lightChance) return;
    const lines = this.presets.get().actions.get(action);
    const line = lines?.length ? this.pickFrom(lines) : null;
    if (!line) return;
    this.stats.light++;
    const body = `【内心】${line}`;
    this.record({ trigger: action, outcome: 'light', text: body });
    // 跟着这次小动作所在的那批事件一起送，不单独叫醒模型
    void this.push(body, 'piggyback', { by: 'light', action });
  }

  private async push(text: string, trigger: 'preempt' | 'piggyback', meta: Record<string, unknown>): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type: INNER_EVENT,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text,
        meta,
      }, { trigger });
    } catch (error) {
      host.log.warn(`活人感推送内心事件失败：${String(error)}`);
    }
  }

  // ---------------------------------------------------------------- 选预设

  private innerText(scene: Scene | null, reading: Reading | null, thought: string): string {
    const parts = ['【内心】'];
    if (scene || reading) {
      const mood = reading?.emotion ? `，对方${reading.emotion}${reading.intensity >= 0.7 ? '得厉害' : ''}` : '';
      parts.push(`此刻像是「${scene?.name ?? reading?.scene ?? ''}」${mood}`);
      if (reading?.intent) parts.push(`，ta 想要的是：${reading.intent}`);
      parts.push('。');
    }
    parts.push(`我心里想：${thought}`);
    if (scene?.style) parts.push(`\n分寸：${scene.style}`);
    return parts.join('');
  }

  private guessScene(presets: Presets, date: Date, gapMinutes: number | null): Scene | null {
    const byName = (name: string) => presets.scenes.find((s) => s.name === name);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.opts.timezone, hour: 'numeric', hourCycle: 'h23' }).format(date));
    if (gapMinutes !== null && gapMinutes >= LONG_GAP_MINUTES && byName('久别重逢')) return byName('久别重逢')!;
    if ((hour >= 23 || hour < 5) && byName('深夜')) return byName('深夜')!;
    if (hour >= 5 && hour < 9 && byName('清晨')) return byName('清晨')!;
    return byName('闲聊') ?? presets.scenes[0] ?? null;
  }

  private pickLine(scene: Scene, emotion?: string): string | null {
    const lines = (emotion && scene.lines.get(emotion)) || scene.lines.get(FALLBACK_EMOTION) || [...scene.lines.values()].flat();
    return lines.length ? this.pickFrom(lines) : null;
  }

  /** 随机抽一行，尽量避开最近用过的。 */
  private pickFrom(lines: readonly string[]): string {
    const fresh = lines.filter((l) => !this.recentLines.includes(l));
    const pool = fresh.length ? fresh : lines;
    const line = pool[Math.floor(Math.random() * pool.length)]!;
    this.recentLines.push(line);
    if (this.recentLines.length > RECENT_LINES_MAX) this.recentLines.shift();
    return line;
  }

  private clock(date: Date): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.opts.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date);
  }

  // ---------------------------------------------------------------- 口吻样本

  /** 这次的「像这样说」：从当前情境挑两句，避开最近用过的。没开或者还没有样本给空串。 */
  private sampleLine(scene: string | undefined): string {
    if (!this.cfg.voice) return '';
    const file = this.voice.get();
    if (!file) return '';
    const picked = pickSamples(file, scene, SAMPLES_PER_REPLY, this.recentSamples);
    if (!picked.length) return '';
    for (const p of picked) {
      this.recentSamples.push(p);
      if (this.recentSamples.length > RECENT_SAMPLES) this.recentSamples.shift();
    }
    return `说话可以像这样（只学口气和长短，别照抄）：${picked.map((p) => `「${p}」`).join(' ')}`;
  }

  /** 人设变了、样本没被人改过：样本是按旧人设写的，要重写。 */
  private voiceOutdated(): { outdated: boolean; edited: boolean } {
    const file = this.voice.get();
    if (!file) return { outdated: false, edited: false };
    const sig = personaSignature(this.persona.get());
    return { outdated: !!file.personaSig && file.personaSig !== sig, edited: file.edited };
  }

  /**
   * 没有样本、勾了「重写」、或者人设变了而样本没被人改过：调副 API 按当前人设写一份。
   * 写不成（没 key、出错）就算了，下次再试；回复照常，只是不带「像这样说」。
   */
  private async ensureVoice(): Promise<void> {
    if (this.writingVoice || !this.cfg.voice || !this.cfg.guide || !this.host) return;
    const file = this.voice.get();
    const { outdated, edited } = this.voiceOutdated();
    if (file && !this.cfg.rewriteVoice && !(outdated && !edited)) return;
    const key = resolveKey(this.opts.secret, this.opts.botDir, this.cfg.api.baseUrl).key;
    if (!key) return;
    this.writingVoice = true;
    const why = !file ? '还没有口吻样本' : this.cfg.rewriteVoice ? '勾了重写' : '人设变了';
    try {
      const persona = this.persona.get();
      const scenes = this.presets.get().scenes.map((s) => ({ name: s.name, note: s.note, style: s.style }));
      const result = await generateVoice(persona, scenes, this.cfg.api, key, this.stopped.signal);
      if (result.usage) this.host?.reportUsage(result.usage, { model: this.cfg.api.model, label: '活人感 · 口吻样本' });
      if (!result.scenes) {
        this.record({ trigger: '口吻样本', outcome: 'skipped', text: `${why}，但这次没写成，过一会儿再试。`, ms: result.ms, error: result.error });
        return;
      }
      this.voice.write(renderVoice(result.scenes, personaSignature(persona)));
      if (this.cfg.rewriteVoice) this.opts.persist({ rewriteVoice: false });
      const total = [...result.scenes.values()].reduce((n, l) => n + l.length, 0);
      this.record({ trigger: '口吻样本', outcome: 'voice', text: `${why}：按当前人设写好了 ${result.scenes.size} 种情境、${total} 句${result.dropped ? `（有 ${result.dropped} 句用了套路句式，扔了）` : ''}。在「提示词」页签的「口吻样本」里能看能改。`, ms: result.ms });
    } finally {
      this.writingVoice = false;
    }
  }

  /** 桌宠最近的话连同它接的那句，给习惯体检用。 */
  private habitTurns(): Turn[] {
    const turns: Turn[] = [];
    let heard = '';
    for (const line of this.transcript) {
      if (line.who === '对方') { heard = line.text; continue; }
      turns.push({ heard, said: line.text });
      heard = '';
    }
    return turns.slice(-HABIT_WINDOW);
  }

  /** 最近真用过的套路句式，写成一句提醒跟在心事后面；没有就空串。 */
  private habitReminder(): string {
    const turns = this.habitTurns();
    return habitNote(checkHabits(turns, this.presets.get().banned), turns.length);
  }

  /**
   * 重启后内存里的对话是空的，体检要攒一阵才有用：从会话记录（`<data>/session-main.jsonl`）
   * 末尾补回最近的「对方说的 → 桌宠说的」。读不到就算了。
   */
  private seedTranscript(): void {
    const file = join(dirname(this.opts.dataDir), 'session-main.jsonl');
    let lines: string[] = [];
    try { lines = readFileSync(file, 'utf8').split('\n').slice(-SEED_LINES); } catch { return; }
    for (const raw of lines) {
      if (!raw.includes('external_event_frame') && !raw.includes('"pet_say"') && !raw.includes('function_call_output')) continue;
      let item: { type?: string; name?: string; call_id?: string; arguments?: string; output?: unknown } | undefined;
      try { item = (JSON.parse(raw) as { item?: typeof item }).item; } catch { continue; }
      if (item?.type === 'function_call_output' && String(item.call_id).startsWith('evf_') && typeof item.output === 'string') {
        const said = item.output.split('\n').filter((l) => /\]\s*\S+?[:：]/.test(l)).at(-1);
        if (said) this.remember({ who: '对方', text: said.replace(/^.*?\]\s*(\[[^\]]*\]\s*)?[^:：]*[:：]/, '').trim() });
      }
      if (item?.type === 'function_call' && item.name === 'pet_say') {
        try {
          const script = (JSON.parse(item.arguments ?? '{}') as { script?: unknown }).script;
          if (typeof script === 'string' && spoken(script)) this.remember({ who: '我', text: spoken(script) });
        } catch { /* 不完整的跳过 */ }
      }
    }
  }

  private remember(line: Line): void {
    this.transcript.push(line);
    if (this.transcript.length > TRANSCRIPT_MAX) this.transcript.shift();
  }

  // ---------------------------------------------------------------- 前缀新旧

  /** 前缀里的说明旧了：那时的模式和此刻的。不旧（或者不知道）给 null。 */
  private staleness(): { from: Mode; to: Mode; sigChanged: boolean } | null {
    const mode = this.mode();
    const sig = this.envSignature();
    const old = this.prefixState.stale(mode, sig);
    return old ? { from: old.mode, to: mode, sigChanged: old.sig !== sig } : null;
  }

  /** 每秒对一次：旧了就提醒（每种变化一次），开着自动刷新就等空闲时关开自己。 */
  private checkPrefix(): void {
    if (this.refreshing || !this.host) return;
    const stale = this.staleness();
    if (!stale) return;
    const key = `${stale.from}>${stale.to}|${this.envSignature()}`;
    const what = stale.from !== stale.to
      ? `换成了${MODE_LABEL[stale.to]}`
      : '更新了给桌宠的说明';
    const uninstall = stale.to === 'provider'
      ? '另外记一下：以后要卸载「活人感 provider」的话，先在「模型」页把端点切回原来那个，不然我会说不了话。'
      : '';
    if (this.cfg.autoRefresh) {
      if (this.phase !== 'idle' || !this.prefixState.firstTime(`refresh:${key}`)) return;
      this.refreshing = true;
      const told = this.cfg.notify && this.prefixState.firstTime(key)
        ? this.notice(`活人感${what}，我已经自动刷新了一下，现在就生效。${uninstall}`)
        : Promise.resolve();
      this.record({ trigger: '前缀', outcome: 'prefix', text: `${what}：自动关开一次，重建前缀。` });
      // 提醒先落库再关开自己，免得事件跟着旧实例一起作废
      void told.then(() => this.opts.restart()).catch((error) => {
        this.refreshing = false;
        this.host?.log.warn(`活人感自动刷新失败：${String(error)}`);
      });
      return;
    }
    if (this.cfg.notify && this.prefixState.firstTime(key)) {
      void this.notice(`活人感${what}，要完全生效还差一步：到 Coopanion 的 World 页，把「活人感」关掉再打开一次，聊天记录会保留。${uninstall}`);
      this.record({ trigger: '前缀', outcome: 'prefix', text: `${what}：已提醒去 World 页关开一次。` });
    }
  }

  /** 请桌宠用一两句话转告对方。和 Coopanion 自己告诉桌宠设置变了是同一个路子。 */
  private async notice(text: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host.pushEvent({
      type: NOTICE_EVENT,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `[活人感 · 给对方的提醒] 请用一两句话、用你自己的口吻把这件事告诉对方，不用带内心戏。这是一次性的提醒，转告就行，不要记进工作区或记忆里：${text}`,
    }, { trigger: 'flush' }).catch((error) => host.log.warn(`活人感推送提醒失败：${String(error)}`));
  }

  /** 此刻要人注意的事，放在配置页最上面。 */
  private notes(): string[] {
    const notes: string[] = [];
    const stale = this.staleness();
    if (stale) {
      const what = stale.from !== stale.to ? `从${MODE_LABEL[stale.from]}换成了${MODE_LABEL[stale.to]}` : '活人感更新了给桌宠的说明';
      notes.push(this.cfg.autoRefresh
        ? `${what}，等桌宠空闲下来会自动刷新一次。`
        : `${what}，但桌宠的系统前缀还是旧的：把这一页的「活人感」关掉再打开一次就好，聊天记录会保留。`);
    }
    const voice = this.voiceOutdated();
    if (this.cfg.voice && voice.outdated && voice.edited) {
      notes.push('人设改过了，但口吻样本是按旧人设写的（你改过它，所以没有自动重写）：想按新人设重写，勾一下下面的「重写口吻样本」。');
    }
    if (this.prefixState.providerConfigured()) {
      notes.push(`当前端点「${this.prefixState.activeEndpoint()}」由活人感 provider 包着。以后要卸载 provider，先在「模型」页把端点切回原来的那个，不然桌宠会说不了话。`);
    }
    return notes;
  }

  // ---------------------------------------------------------------- 密钥与记录

  /** 输入框里有字就转存进部署 `.env` 并清空；顺带刷新密钥来源的说明。 */
  private syncKey(): void {
    const typed = this.cfg.apiKey.trim();
    if (typed) {
      try {
        this.opts.storeSecret(KEY_SECRET, typed);
        this.opts.persist({ apiKey: '' });
      } catch (error) {
        this.keyNote = `保存失败：${error instanceof Error ? error.message : String(error)}`;
        return;
      }
    }
    const { from } = resolveKey(this.opts.secret, this.opts.botDir, this.cfg.api.baseUrl);
    this.keyNote = from ? `当前使用：${from}。` : '当前没有可用的 key：请在这里填一个，或者先配好同一家的模型端点。';
  }

  private record(entry: Omit<LogEntry, 'at'>): void {
    this.log.push({ at: nowIso(this.opts.timezone).slice(11, 19), ...entry });
    if (this.log.length > LOG_MAX) this.log.shift();
    this.writeLog();
  }

  private logPath(): string { return join(this.opts.dataDir, 'recent.md'); }

  /** 最近记录写成一份 Markdown,在「提示词」页签里就能看，不用另做面板。 */
  private writeLog(): void {
    const lines = ['# 活人感 · 最近记录', '', '> 只读：每轮自动覆盖，改了也没用。最新的在最上面。', ''];
    for (const e of [...this.log].reverse()) {
      const extra = [e.ms !== undefined ? `副 API ${e.ms}ms` : '', e.how ?? '', e.error ? `出错：${e.error}` : ''].filter(Boolean).join('，');
      lines.push(`## ${e.at} · ${e.trigger} · ${OUTCOME_LABEL[e.outcome]}${extra ? `（${extra}）` : ''}`, '', e.text, '');
    }
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      writeFileSync(this.logPath(), lines.join('\n'), 'utf8');
    } catch { /* 写不了日志不影响功能 */ }
  }

  // ---------------------------------------------------------------- WebUI

  webUi(): WorldWebUiDecl {
    const keyOk = !!resolveKey(this.opts.secret, this.opts.botDir, this.cfg.api.baseUrl).key;
    const lamp: WorldLamp = !this.cfg.guide
      ? { label: '副 API', state: 'offline', hint: '已关闭，只用预设库' }
      : keyOk
        ? { label: '副 API', state: 'online', hint: this.keyNote }
        : { label: '副 API', state: 'error', hint: '没有可用的 API Key' };
    const avg = this.stats.api ? Math.round(this.stats.apiMs / this.stats.api) : 0;
    const storage: StoragePart[] = [{
      key: 'recent',
      label: '最近记录',
      kind: 'memory',
      note: '只清掉页面上的记录和计数，不影响桌宠。',
      stat: () => `${this.log.length} 条`,
      clear: () => {
        this.log.length = 0;
        Object.assign(this.stats, { api: 0, preset: 0, late: 0, light: 0, apiMs: 0, waited: 0 });
        this.writeLog();
        return '已清空';
      },
    }];
    if (!existsSync(this.logPath())) this.writeLog();
    const stale = this.staleness();
    const prefixLamp: WorldLamp = stale
      ? { label: '系统前缀', state: this.cfg.autoRefresh ? 'loading' : 'error', hint: this.cfg.autoRefresh ? '等桌宠空闲后自动刷新' : '需要刷新：把活人感关掉再打开一次' }
      : { label: '系统前缀', state: 'online', hint: `最新（${MODE_LABEL[this.mode()]}）` };
    return {
      label: '活人感',
      lamps: [lamp, prefixLamp],
      badges: [
        { label: '前缀', value: stale ? '需要刷新' : '最新', tone: stale ? 'off' : 'on' },
        { label: '副 API 引导', value: this.stats.api, tone: 'on' },
        { label: '预设兜底', value: this.stats.preset, tone: 'plain' },
        { label: '等内心再开口', value: this.stats.waited, tone: 'plain' },
        { label: '来不及', value: this.stats.late, tone: this.stats.late ? 'off' : 'plain' },
        { label: '小动作', value: this.stats.light, tone: 'plain' },
        { label: '平均耗时', value: avg ? `${avg}ms` : '—', tone: 'plain' },
      ],
      config: configGroups(this.keyNote, this.notes(), this.sources.list()),
      promptDocs: [
        {
          key: `worlds.${HUMANIZE_ID}.presets`,
          title: '活人感 · 预设库',
          description: '情境、情绪和小动作对应的内心句。改完保存，下一次就生效。',
          path: this.readable(join(this.overrideDir, 'PRESETS.md'), DEFAULT_PRESETS),
          deploymentPath: join(this.overrideDir, 'PRESETS.md'),
        },
        {
          key: `worlds.${HUMANIZE_ID}.envPrompt`,
          title: '活人感 · 环境提示词',
          description: '告诉模型「【内心】」和「说话提醒」是什么、该怎么用。改完把活人感关开一次就生效（开着自动刷新时会自己刷新）。',
          path: this.readable(join(this.overrideDir, 'ENV_PROMPT.md'), DEFAULT_ENV_PROMPT),
          deploymentPath: join(this.overrideDir, 'ENV_PROMPT.md'),
          role: 'envPrompt',
          vars: [{ name: 'humanize.wait', description: '「先感受再开口」开着时，要求桌宠先调用 humanize_feel;关着时说明不用调用。' }],
        },
        {
          key: `worlds.${HUMANIZE_ID}.voice`,
          title: '活人感 · 口吻样本',
          description: '每种情境下这个桌宠会怎么说的示范，按人设自动写的。改完保存下一次就生效；改过以后人设再变也不会被覆盖。',
          path: this.voice.path,
        },
        {
          key: `worlds.${HUMANIZE_ID}.recent`,
          title: '活人感 · 最近 20 轮记录',
          description: '每一轮读到了什么情境、送了什么引导、花了多久。只读，自动覆盖。',
          path: this.logPath(),
        },
      ],
      storage,
    };
  }

  private readable(override: string, fallback: string): string {
    return existsSync(override) ? override : fallback;
  }
}
