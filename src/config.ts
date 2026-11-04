import type { ConfigGroup } from 'cortico/core/types.ts';
import { ADAPTERS, type PlatformMode } from './adapters.ts';
import type { Seen } from './sources.ts';

export const HUMANIZE_ID = 'humanize';

/** 部署 `.env` 里副 API 密钥的变量名。 */
export const KEY_SECRET = 'HUMANIZE_API_KEY';

/** config.json 的 `worlds.humanize` 段。WebUI 热改就地写这个对象，World 每次用时现读。 */
export interface HumanizeConfigSection {
  enabled: boolean;
  /** 对方说话时调用副 API 读情境、写内心引导；关掉则只用预设库。 */
  guide: boolean;
  /**
   * 先感受再开口：桌宠收到对方的话先调用 `humanize_feel`,等副 API 的结果回来再说话。
   * 关掉则是抢时间模式：引导回来时桌宠还没开口才用得上。
   */
  wait: boolean;
  /**
   * 用「活人感」provider 把心事直接塞进主模型请求。provider 扩展本身没有开关（Coopanion 不支持
   * 停用 provider 扩展），开关放在这里：关掉后 provider 原样转发，桌宠改回先调用 humanize_feel。
   */
  useProvider: boolean;
  /** 摸头、戳、换装这类小动作也带一句轻预设（不调副 API）。 */
  light: boolean;
  /** 小动作带轻预设的概率，0–1；动作频繁时别每次都带。 */
  lightChance: number;
  /** 给副 API 看的最近对话条数。 */
  contextTurns: number;
  /**
   * 用「活人感」provider 时，把主模型这次请求的系统前缀和最近上下文原样交给副 API:
   * 人设、记忆扩展塞进去的东西、桌宠刚读过的文件，副 API 都看得到。
   */
  shareContext: boolean;
  /** 额外记忆文件夹：读其中最近改过的几份文本，给把记忆存在工作区以外的记忆扩展。空 = 不读。 */
  memoryDir: string;
  /** 前缀过期（换了模式、扩展更新了说明）时，让桌宠用气泡提醒一次。 */
  notify: boolean;
  /** 前缀过期时，等桌宠空闲下来自动把活人感关开一次，让前缀重建；聊天记录保留。 */
  autoRefresh: boolean;
  /** 其他来源里要读的「来源|事件类型」（点换成 ~），true = 读。配置页按见过的清单列出来。 */
  sources: Record<string, boolean>;
  /** 每次回复挑两句口吻样本跟在心事后面（「像这样说」）。 */
  voice: boolean;
  /** 一次性：勾上后按当前人设重写口吻样本，写完自动取消。 */
  rewriteVoice: boolean;
  /** 已适配的聊天扩展各读哪些：off 不读、addressed 只读私聊和 @桌宠的、all 群里每批都读。缺省 addressed。 */
  platforms: Record<string, PlatformMode>;
  api: {
    /** OpenAI 兼容地址，请求发往 `<baseUrl>/chat/completions`。 */
    baseUrl: string;
    model: string;
    /** `reasoning_effort` 的值；DeepSeek 用 `none` 关掉思考。空 = 不传。 */
    effort: string;
    /** 副 API 的硬超时，超时就退回预设。 */
    timeoutMs: number;
  };
  /**
   * 密钥输入框：填进来后 World 把它存进部署 `.env`（仅本人可读）并把这里清空，
   * config.json 里不留明文。
   */
  apiKey: string;
}

export const HUMANIZE_DEFAULTS: HumanizeConfigSection = {
  enabled: false,
  guide: true,
  wait: true,
  useProvider: true,
  light: true,
  lightChance: 0.5,
  contextTurns: 6,
  shareContext: true,
  memoryDir: '',
  notify: true,
  autoRefresh: false,
  sources: {},
  // 样本会带着改说话的长短和口气，不只是句式：默认不开，想要再开
  voice: false,
  rewriteVoice: false,
  platforms: Object.fromEntries(ADAPTERS.map((a) => [a.source, 'addressed' as PlatformMode])),
  api: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    effort: 'none',
    // 实测 DeepSeek 关思考一次 1.2–1.8 秒；再晚桌宠多半已经开口，等也没用
    timeoutMs: 2500,
  },
  apiKey: '',
};

const K = `worlds.${HUMANIZE_ID}`;

/**
 * 两组配置：基本开关与副 API。`keyStatus` 是密钥此刻的来源，写进密钥项的说明里；
 * `notes` 是此刻要人注意的事（前缀要刷新、卸载 provider 的顺序），放在基本设置最上面。
 */
export function configGroups(keyStatus: string, notes: string[] = [], seen: Seen[] = []): ConfigGroup[] {
  const owner = `world:${HUMANIZE_ID}` as const;
  const intro = '对方说话时走「副 API 引导」，小动作时走「轻预设」。预设库在「提示词」页签里可以直接改。';
  // 已适配的聊天扩展：一个一个下拉框（装没装都列，没装的不起作用）
  const platforms: ConfigGroup = {
    id: `${owner}:platforms`,
    owner,
    schema: {
      type: 'object',
      title: 'QQ 扩展',
      description: '这几个 QQ 扩展专门适配过：副 API 知道消息来自哪个群还是私聊、是谁说的、有没有 @桌宠。「只读私聊和 @它的」最省钱；「群里全读」时群聊越热闹花费越多。用 provider 时都只在桌宠真要回应时才调一次。',
      properties: Object.fromEntries(ADAPTERS.map((a) => [`${K}.platforms.${a.source}`, {
        type: 'string' as const,
        title: `${a.label}（${a.pkg}）`,
        enum: ['addressed', 'all', 'off'],
        description: 'addressed = 只读私聊和 @它的（默认）；all = 群里的也读；off = 不读',
        'x-hot': true,
      }])),
    },
  };
  // 见过的其他来源，一项一个勾选框；一个都没见过时整组不出现
  const sources: ConfigGroup[] = seen.length ? [{
    id: `${owner}:sources`,
    owner,
    schema: {
      type: 'object',
      title: '其他聊天来源',
      description: '桌宠和控制台页的消息一直会读，上面那几个 QQ 扩展另有设置。这里列的是活人感见过的其他来源（别的 QQ、微信、B 站等扩展），勾上的才读。用 provider 时只在桌宠真的要回应那批消息时才调一次副 API；不用 provider 时等那个来源安静 2.5 秒再调。群聊很热闹的话，副 API 的花费会跟着涨。',
      properties: Object.fromEntries(seen.map((s) => [`${K}.sources.${s.key}`, {
        type: 'boolean' as const,
        title: `${s.source} · ${s.type}${s.chatty ? '（像是聊天消息）' : ''}`,
        description: `见过 ${s.count} 条，最近一条：${s.sample || '（没有正文）'}`,
        'x-hot': true,
      }])),
    },
  }] : [];
  return [
    {
      id: owner,
      owner,
      schema: {
        type: 'object',
        title: '基本设置',
        description: [...notes.map((n) => `⚠️ ${n}`), intro].join('\n\n'),
        properties: {
          [`${K}.guide`]: {
            type: 'boolean', title: '对话时调用副 API 生成引导',
            description: '关掉后只从预设库里抽引导，不花副 API 的钱，也不会让桌宠多等。', 'x-hot': true,
          },
          [`${K}.wait`]: {
            type: 'boolean', title: '先感受再开口',
            description: '开着：桌宠收到你的话先等副 API 想好心情再回答，每次都用得上，但回应慢一秒左右。关掉：抢时间，桌宠开口太快时这一轮的引导就作废。改完在下一次会话开始时完全生效。',
            'x-hot': true,
          },
          [`${K}.useProvider`]: {
            type: 'boolean', title: '用「活人感 provider」', 'x-hot': true,
            description: '装了「活人感 provider」才有用（没装时开着也没关系）。开着：心事直接跟着你的话发给模型，桌宠一轮就开口。关掉：provider 原样转发、什么都不做，桌宠改回先调用 humanize_feel。Coopanion 的模型扩展没有停用开关，所以开关放在这里。改完把活人感关掉再打开一次才完全生效。',
          },
          [`${K}.light`]: {
            type: 'boolean', title: '小动作也带轻预设',
            description: '被戳、被摸、被拎起、换装时，从预设库抽一句心情给它。', 'x-hot': true,
          },
          [`${K}.lightChance`]: {
            type: 'number', title: '小动作带预设的概率', minimum: 0, maximum: 1, multipleOf: 0.05,
            'x-scale': 0.01, 'x-suffix': '%', 'x-hot': true,
            description: '动作很频繁时调低一点，免得每次反应都一个样。',
          },
          [`${K}.contextTurns`]: {
            type: 'integer', title: '给副 API 看的最近对话条数', minimum: 2, maximum: 20, 'x-hot': true,
            description: '越多越懂上下文，但也越慢越贵。',
          },
          [`${K}.shareContext`]: {
            type: 'boolean', title: '把主模型的完整上下文交给副 API', 'x-warning': true, 'x-hot': true,
            description: '只在用「活人感」provider 时有效：人设、记忆扩展的内容、桌宠刚读过的文件，副 API 都看得到，心情揣摩得更准。副 API 和主模型是同一家（默认都是 DeepSeek）时没有区别；换成别家，就等于把对话也发给了那一家。',
          },
          [`${K}.memoryDir`]: {
            type: 'string', title: '额外记忆文件夹', 'x-path': { kind: 'directory' }, 'x-hot': true,
            description: '记忆扩展把记忆存在工作区以外时，选它的文件夹：副 API 会读里面最近改过的几份文本。工作区 partner/ 下的记录本来就会读，不用选。',
          },
          [`${K}.voice`]: {
            type: 'boolean', title: '用口吻样本示范「像这样说」', 'x-hot': true,
            description: '每次回复从当前情境的口吻样本里挑两句跟在心事后面，让桌宠学口气和长短。会连带改变说话的长短和口气，不只是句式，所以默认关着。打开后第一次会按人设自动写一份样本，在「提示词」页签里能看能改。',
          },
          [`${K}.rewriteVoice`]: {
            type: 'boolean', title: '重写口吻样本', 'x-hot': true,
            description: '勾上后按现在的人设重写一份口吻样本（会覆盖你的修改），写完自动取消勾选。人设改了而你改过样本时用。',
          },
          [`${K}.notify`]: {
            type: 'boolean', title: '前缀需要刷新时让桌宠提醒我', 'x-hot': true,
            description: '换了模式（比如装上或卸掉 provider、开关「先感受再开口」），或者活人感更新了说明之后，桌宠会用气泡说一次。每种变化只提醒一次。',
          },
          [`${K}.autoRefresh`]: {
            type: 'boolean', title: '前缀需要刷新时自动刷新', 'x-hot': true,
            description: '等桌宠空闲下来，自动把活人感关开一次，让新的说明生效；聊天记录保留。关着时需要你自己到这一页关开一次。',
          },
        },
      },
    },
    {
      id: `${owner}:api`,
      owner,
      schema: {
        type: 'object',
        title: '副 API',
        description: '用来读情境、写内心引导的模型。默认 DeepSeek 并关掉思考：便宜又快。任何 OpenAI 兼容的 Chat 接口都能填。',
        properties: {
          [`${K}.apiKey`]: {
            type: 'string', title: 'API Key',
            description: `填入保存后会转存到本机部署的 .env，这一栏随即清空。${keyStatus}`, 'x-hot': true,
          },
          [`${K}.api.baseUrl`]: { type: 'string', title: '接口地址', description: '请求发往「地址/chat/completions」。', 'x-hot': true },
          [`${K}.api.model`]: { type: 'string', title: '模型', 'x-hot': true },
          [`${K}.api.effort`]: {
            type: 'string', title: '思考档（reasoning_effort）',
            description: 'DeepSeek 填 none 关掉思考；其他平台不认识这个参数时留空。', 'x-hot': true,
          },
          [`${K}.api.timeoutMs`]: {
            type: 'integer', title: '超时', minimum: 300, maximum: 10000, 'x-suffix': 'ms', 'x-hot': true,
            description: '超过这个时间就放弃副 API、改用预设，桌宠不会被卡住。「来不及」计数很高时说明副 API 比桌宠开口还慢，调大也没用，可以换更快的模型或关掉副 API。',
          },
        },
      },
    },
    platforms,
    ...sources,
  ];
}
