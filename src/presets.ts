/**
 * 预设库：一份给人改的 Markdown。`## 情境：名字` 下有「说明」「风格」和若干 `- 情绪：一句话`;
 * `## 小动作：名字` 下是若干 `- 一句话`。`>` 开头的行是注释。解析宽松：认不出的行跳过。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface Scene {
  name: string;
  /** 什么时候算这种情境，给副 API 判断用。 */
  note: string;
  /** 这种情境下的说话分寸。 */
  style: string;
  /** 情绪 → 内心句。 */
  lines: Map<string, string[]>;
}

export interface Presets {
  scenes: Scene[];
  /** 小动作名 → 心情句。 */
  actions: Map<string, string[]>;
  /** 「## 不想听到的说法」下的短语：桌宠最近说过，就提醒它别再说。 */
  banned: string[];
}

/** 找不到对应情绪时用的那一组。 */
export const FALLBACK_EMOTION = '通用';

const COLON = /[:：]/;

export function parsePresets(text: string): Presets {
  const scenes: Scene[] = [];
  const actions = new Map<string, string[]>();
  const banned: string[] = [];
  let scene: Scene | null = null;
  let action: string[] | null = null;
  let inBanned = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>')) continue;
    if (/^##\s*不想听到的说法/.test(line)) { inBanned = true; scene = null; action = null; continue; }
    if (line.startsWith('#')) inBanned = false;
    if (inBanned) {
      const phrase = line.replace(/^-\s*/, '').replace(/^[「“"]|[」”"]$/g, '').trim();
      if (phrase) banned.push(phrase);
      continue;
    }
    const head = /^##\s*(情境|小动作)\s*[:：]\s*(.+)$/.exec(line);
    if (head) {
      const name = head[2].trim();
      if (head[1] === '情境') {
        scene = { name, note: '', style: '', lines: new Map() };
        scenes.push(scene);
        action = null;
      } else {
        action = actions.get(name) ?? [];
        actions.set(name, action);
        scene = null;
      }
      continue;
    }
    if (line.startsWith('#')) { scene = null; action = null; continue; }
    if (action && line.startsWith('-')) {
      const body = line.slice(1).trim();
      if (body) action.push(body);
      continue;
    }
    if (!scene) continue;
    if (line.startsWith('-')) {
      const body = line.slice(1).trim();
      const at = body.search(COLON);
      if (at <= 0) continue;
      const emotion = body.slice(0, at).trim();
      const thought = body.slice(at + 1).trim();
      if (!thought) continue;
      const list = scene.lines.get(emotion) ?? [];
      list.push(thought);
      scene.lines.set(emotion, list);
      continue;
    }
    const field = /^(说明|风格)\s*[:：]\s*(.*)$/.exec(line);
    if (field) {
      if (field[1] === '说明') scene.note = field[2].trim();
      else scene.style = field[2].trim();
    }
  }
  return { scenes, actions, banned };
}

/** 全部情绪名（不含「通用」），按首次出现的顺序。 */
export function emotionsOf(presets: Presets): string[] {
  const seen = new Set<string>();
  for (const s of presets.scenes) for (const e of s.lines.keys()) if (e !== FALLBACK_EMOTION) seen.add(e);
  return [...seen];
}

/**
 * 按修改时间缓存的读取：用户在 WebUI 改完保存，下一次读就是新内容。
 * `paths` 依次尝试，取第一个存在的（部署覆盖优先，包内默认兜底）。
 */
export class PresetStore {
  private cache: { path: string; mtime: number; presets: Presets } | null = null;

  constructor(private readonly paths: () => string[]) {}

  get(): Presets {
    const path = this.paths().find((p) => existsSync(p));
    if (!path) return { scenes: [], actions: new Map(), banned: [] };
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { /* 读不到时间就每次重读 */ }
    if (this.cache && this.cache.path === path && this.cache.mtime === mtime && mtime !== 0) return this.cache.presets;
    const presets = parsePresets(readFileSync(path, 'utf8'));
    this.cache = { path, mtime, presets };
    return presets;
  }
}
