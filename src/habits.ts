/**
 * 说话习惯体检：盯 AI 爱用的固定句式。看桌宠最近说过的话（连同它接的是对方哪句话），
 * 哪种句式最近真用过，才提醒它这次换个说法；没用过的不提，免得反倒把句式塞进它脑子里。
 *
 * 只看固定句式，别的一概不管：表情、省略号、口癖、长短、语气、爱不爱提问，都是角色自己的事。
 * 人自己讨厌的说法写在预设库的「不想听到的说法」里，一行一个，按原样匹配。
 */

export interface Turn {
  /** 桌宠这句话接的是对方的哪句话（没有就是空串）。 */
  heard: string;
  /** 桌宠说出口的字（已去掉表情动作标记）。 */
  said: string;
}

export interface Habit {
  id: string;
  /** 给人看的名字（最近记录里用）。 */
  label: string;
  count: number;
  /** 桌宠自己说过的一句，给它看是哪种。 */
  example: string;
  /** 这次怎么换。 */
  advice: string;
}

interface Pattern {
  id: string;
  label: string;
  advice: string;
  /** 用过几次就提醒。 */
  min: number;
  hit(turn: Turn): string | null;
}

/** 按句号、问号、叹号、换行切成句子；逗号不切。 */
const sentences = (text: string) => text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
const clauses = (text: string) => text.split(/[，,。！!？?…~～\s]+/).map((s) => s.trim()).filter(Boolean);
const INTERJECTION = /^(诶|欸|哇|啊|哦|噢|嗯|哈+|呀|咦|嘿|哎呀?|唔|喔)+$/;

function firstMatch(text: string, re: RegExp): string | null {
  for (const s of sentences(text)) if (re.test(s)) return s;
  return null;
}

/** 句子开头那一小截，几乎全是对方原话里的字，又以问号、叹号收尾：在学舌。 */
function echoes(turn: Turn): string | null {
  if (!turn.heard) return null;
  const heard = new Set([...turn.heard.replace(/\s/g, '')]);
  const parts = turn.said.split(/(?<=[，,。！!？?…~～])/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts.slice(0, 2)) {
    const core = part.replace(/[，,。！!？?…~～]+$/, '').trim();
    if (!core || INTERJECTION.test(core)) continue;
    const chars = [...core.replace(/\s/g, '')];
    if (chars.length < 2 || chars.length > 14) return null;
    const shared = chars.filter((c) => heard.has(c)).length / chars.length;
    const asks = /[？?！!]/.test(part) || /^你(刚)?说/.test(core);
    return shared >= 0.6 && asks ? part : null;
  }
  return null;
}

const PATTERNS: Pattern[] = [
  {
    id: 'not-but',
    label: '「不是……而是……」',
    advice: '别用「不是……而是……」「不只是……更是……」「你以为……其实……」这种先否定再翻转的说法，想说什么就直接说。',
    min: 1,
    hit: (t) => firstMatch(t.said, new RegExp([
      '(并|倒)?不是[^。！？!?]{1,24}[，,]\\s*(而|其实|只|倒)?是',
      '不(只|仅|光|单)(仅)?是[^。！？!?]{1,24}[，,]\\s*(更|还|也)是',
      '与其说[^。！？!?]+不如说',
      '你(以为|觉得)[^。！？!?]{1,24}[，,]\\s*其实',
      '问题不在[^。！？!?]{1,20}[，,]\\s*(而)?在',
    ].join('|'))),
  },
  {
    id: 'presume',
    label: '替对方预设想法',
    advice: '别替对方先想好心思再去纠正（「你可能会觉得……」「你是不是觉得……其实……」），对方没这么说就别这么接。',
    min: 1,
    hit: (t) => firstMatch(t.said, /你(可能|也许|大概)?会?(觉得|以为|认为)[^。！？!?]{0,20}(但|其实|可)|你是不是(觉得|以为)|很多人(都)?(以为|觉得)/),
  },
  {
    id: 'self-answer',
    label: '自问自答',
    advice: '别自己抛个问题再自己答（「能不能……？能。」），直接说结论。',
    min: 1,
    // 问和答跨了问号，按句切开就认不出来，所以整段一起看
    hit: (t) => /[^。！？!?]{2,20}[？?]\s*(能|会|可以|当然|没有|有)[，,。！!]/.exec(t.said)?.[0] ?? null,
  },
  {
    id: 'assistant',
    label: '助手腔收尾',
    advice: '别说「希望对你有帮助」「还需要我……吗」「有什么可以帮你」这种助手的话，你不是客服。',
    min: 1,
    hit: (t) => firstMatch(t.said, /希望(这|能|可以)?对你有(帮助|用)|还(需要|要)[^。！？!?]{0,8}吗|需要我[^。！？!?]{0,10}吗|要不要我(帮|再)|有什么[^。！？!?]{0,6}(可以|能)帮/),
  },
  {
    id: 'echo',
    label: '先复述对方的话',
    advice: '别一开口先复述对方的话（比如把对方刚说的事反问一遍），直接说你自己的反应。',
    min: 2,
    hit: echoes,
  },
  {
    id: 'either-or',
    label: '「是……还是……？」二选一反问',
    advice: '别用「是 A 还是 B？」这种二选一来问对方，想问就随口问一句，或者干脆不问。',
    min: 2,
    // 句末不一定有问号：「是身体累，还是心里累呀」
    hit: (t) => firstMatch(t.said, /是[^。！？!?，,]{1,14}[，,]\s*还是[^。！？!?，,]{1,14}/),
  },
  {
    id: 'maxim',
    label: '格言式总结',
    advice: '别下「……的人，最怕的就是……」「……就是……在……」这种总结式的断语，说你自己的感受。',
    min: 1,
    hit: (t) => firstMatch(t.said, /最怕的?(就)?是|说到底|本质上|归根结底|真正的(问题|关键)(是|在于)|关键在于|所谓[^，。]{1,8}[，,]?\s*(就是|无非)|[^，。]{1,8}就是[^，。]{1,8}在(喊|提醒|告诉)/),
  },
  {
    id: 'pivot',
    label: '「说正经的」话锋一转',
    advice: '别用「说正经的」「说实话」「认真说」这种开场来转话头。',
    min: 1,
    hit: (t) => firstMatch(t.said, /说正经的|说真的|说实话|老实(说|讲)|坦白(说|讲)|认真(地)?说|讲真|不过话说回来|话说回来/),
  },
];

/** 每种句式在最近这几轮里的次数；够提醒的按次数从多到少排。`anyCount`:用过一次就列（体检报告用）。 */
export function checkHabits(turns: readonly Turn[], banned: readonly string[] = [], anyCount = false): Habit[] {
  const found: Habit[] = [];
  for (const p of PATTERNS) {
    const hits = turns.map((t) => p.hit(t)).filter((h): h is string => !!h);
    if (hits.length >= (anyCount ? 1 : p.min)) found.push({ id: p.id, label: p.label, count: hits.length, example: hits.at(-1)!, advice: p.advice });
  }
  for (const phrase of banned) {
    const hits = turns.filter((t) => t.said.includes(phrase));
    if (hits.length) {
      found.push({
        id: `banned:${phrase}`, label: `「${phrase}」`, count: hits.length,
        example: sentences(hits.at(-1)!.said).find((s) => s.includes(phrase)) ?? phrase,
        advice: `别再说「${phrase}」。`,
      });
    }
  }
  return found.sort((a, b) => b.count - a.count);
}

/** 写给桌宠的提醒，最多 `max` 条，带它自己说过的例子。没有要提醒的给空串。 */
export function habitNote(habits: readonly Habit[], window: number, max = 3): string {
  if (!habits.length) return '';
  const items = habits.slice(0, max).map((h) => `${h.advice}（最近 ${window} 句里用了 ${h.count} 次，比如「${h.example}」）`);
  return `说话提醒：${items.join(' ')}`;
}
