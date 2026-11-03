/**
 * 已适配的聊天扩展：从它们各自的事件里读出「在哪、谁、说了什么、是不是在叫桌宠」。
 * 读出来的东西给副 API 用（「在 QQ 群「摸鱼群」里 @你说」比一整行原文清楚），也用来按
 * 「只读私聊和 @桌宠的」这种规则过滤。格式按各扩展的源码写死，对应的版本写在每段旁边；
 * 认不出的事件返回 null,当作不是聊天消息。
 */
import type { EventEnvelope } from 'cortico/core/types.ts';

export interface ChatMessage {
  /** 「QQ 群「摸鱼群」」「QQ 私聊」…… */
  where: string;
  kind: 'group' | 'private';
  sender: string;
  /** 去掉了消息号、时间、发言人这些头的正文。 */
  body: string;
  /** 私聊，或者群里 @ 了桌宠 / 点了它的名。 */
  addressed: boolean;
  /** 扩展认定是桌宠的主人（只有 AstrBot 给）。 */
  owner: boolean;
}

export type PlatformMode = 'off' | 'addressed' | 'all';

export interface Adapter {
  source: string;
  label: string;
  /** 扩展的包名，配置页上写给人看。 */
  pkg: string;
  parse(e: EventEnvelope): ChatMessage | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/**
 * cortico-world-qq 0.2.x(Pal AI Lab,OneBot v11)。
 * 正文 `#<消息号> [<会话> HH:MM] <昵称>(<QQ号>): <内容>`;@ 到桌宠写成 `@<名字>(你)`。
 * 语音转写另发 `qq.transcript`,格式相同，内容前有 `[QQ语音转写]`;转写失败那条没有 user_id,跳过。
 */
const QQ_ONEBOT: Adapter = {
  source: 'qq',
  label: 'QQ（OneBot）',
  pkg: 'cortico-world-qq',
  parse(e) {
    if (e.type !== 'qq.message' && e.type !== 'qq.transcript') return null;
    const meta = obj(e.meta);
    if (meta.user_id === undefined) return null;
    const conv = obj(meta.conv);
    const kind = conv.kind === 'private' ? 'private' : 'group';
    const head = /^#\S+\s+\[([^\]]*?)\s+\d{1,2}:\d{2}\]\s+/.exec(e.text);
    const label = head?.[1] ?? '';
    const sender = str(meta.sender_name) || str(meta.user_id);
    const body = e.text.slice(head?.[0].length ?? 0).replace(/^[^:]*?\(\d+\):\s*/, '').trim();
    return {
      // 会话标签本身就是「群「名字」」或「私聊」
      where: kind === 'private' ? 'QQ 私聊' : `QQ ${label || '群'}`,
      kind,
      sender,
      body,
      addressed: kind === 'private' || /@[^\s@]*\(你\)/.test(body),
      owner: false,
    };
  },
};

/**
 * cortico-world-qqbot 0.4.x(Pal AI Lab,QQ 官方机器人接口，World id `qq-official`)。
 * 正文 `#<编号> [<会话> HH:MM] <名字>(<尾号>): <内容>`;@ 到桌宠（含群里的 @ 消息）写成 `@你`。
 * 会话在 meta.target.kind:c2c / dms 是私聊，group / channel 是群和频道。
 */
const QQ_OFFICIAL: Adapter = {
  source: 'qq-official',
  label: 'QQ 官方机器人',
  pkg: 'cortico-world-qqbot',
  parse(e) {
    if (e.type !== 'qq-official.message') return null;
    const target = obj(obj(e.meta).target);
    const kind = target.kind === 'c2c' || target.kind === 'dms' ? 'private' : 'group';
    const head = /^#\S+\s+\[([^\]]*?)\s+\d{1,2}:\d{2}\]\s+([^:]*?):\s*/.exec(e.text);
    const label = head?.[1] ?? '';
    const body = e.text.slice(head?.[0].length ?? 0).trim();
    return {
      where: kind === 'private' ? 'QQ 私聊' : `QQ ${label || '群'}`,
      kind,
      sender: (head?.[2] ?? '').trim() || '某人',
      body,
      addressed: kind === 'private' || /(^|\s)@你(\s|$)/.test(body),
      owner: false,
    };
  },
};

/**
 * cortico-world-astrbot 1.3.x(经 AstrBot 桥接 QQ)。meta 里直接有 conv、body、mentioned(私聊也算)、
 * owner、notice;正文 `【QQ群 名字 HH:MM】#id 昵称(标签)：内容`,发言人从这里取。通知类跳过。
 */
const ASTRBOT: Adapter = {
  source: 'astrbot',
  label: 'AstrBot',
  pkg: 'cortico-world-astrbot',
  parse(e) {
    if (e.type !== 'astrbot.message') return null;
    const meta = obj(e.meta);
    if (meta.notice === true) return null;
    const conv = obj(meta.conv);
    const kind = conv.kind === 'private' ? 'private' : 'group';
    const sender = /^【[^】]*】(?:#\S+\s+)?([^(：]+)/.exec(e.text)?.[1]?.trim() || '某人';
    const name = str(conv.name) || str(conv.id);
    return {
      where: kind === 'private' ? 'QQ 私聊' : `QQ 群${name ? `「${name}」` : ''}`,
      kind,
      sender,
      body: (str(meta.body) || e.text).trim(),
      addressed: meta.mentioned === true || kind === 'private',
      owner: meta.owner === true,
    };
  },
};

export const ADAPTERS: readonly Adapter[] = [QQ_ONEBOT, QQ_OFFICIAL, ASTRBOT];

export const adapterFor = (source: string) => ADAPTERS.find((a) => a.source === source);

/** 给副 API 的「对方刚刚……」和正文。 */
export function describe(m: ChatMessage): { via: string; text: string } {
  const how = m.kind === 'private' ? '对你说' : m.addressed ? '@你说' : '说（没有点你的名）';
  return {
    via: `在${m.where}里${how}`,
    text: `${m.sender}${m.owner ? '（你的主人）' : ''}：${m.body}`,
  };
}
