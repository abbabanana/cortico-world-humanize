/**
 * World 与「活人感」provider 之间的桥：两个包装在同一个进程里，靠 globalThis 上一个约定好的
 * Symbol 碰头，谁也不 import 谁。World 启动时挂上，停用时摘掉；provider 找不到桥就原样转发。
 * 改这里的形状要同时改 cortico-provider-humanize/src/bridge.ts,并把 version 加一。
 */
export const BRIDGE_KEY = Symbol.for('cortico-humanize.bridge');
export const BRIDGE_VERSION = 2;

/** 主模型这次请求里看到的东西，provider 原样转述（已截短）。 */
export interface MainContext {
  /** 系统前缀：人设、文件清单、各 World 的环境说明、记忆扩展写进去的内容。 */
  instructions: string;
  /** 最近几条上下文，一条一行：对话、桌宠说的话、读文件和回忆事件的结果。 */
  recent: string[];
}

export interface HumanizeBridge {
  version: typeof BRIDGE_VERSION;
  /** 把事件库里刚到的事件收进来（同步）。provider 在请求刚到时调，免得 World 的轮询还没看到。 */
  sync(): void;
  /**
   * 这批事件里有正在想或刚想好的心事时，交出它（想完才 resolve）；没有返回 null。
   * 交出去以后 World 不再推事件、也不再经工具交。`main` 是主模型这次的上下文，
   * World 还没开始想时用它来想；不想共享时给 null。
   */
  claim(cursors: readonly number[], main: MainContext | null): Promise<string | null> | null;
  /** provider 每次转发请求都报一声；World 据此判断 provider 是否在用，决定要不要给模型 humanize_feel。 */
  touch(): void;
}

export function installBridge(bridge: HumanizeBridge): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = bridge;
}

export function removeBridge(bridge: HumanizeBridge): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[BRIDGE_KEY] === bridge) delete g[BRIDGE_KEY];
}
