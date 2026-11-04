import { join } from 'node:path';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { HUMANIZE_DEFAULTS, HUMANIZE_ID, type HumanizeConfigSection } from './config.ts';
import { FEEL_TOOL, FEEL_TOOL_DECL, HumanizeWorld, INNER_EVENT, NOTICE_EVENT } from './world.ts';

export const HUMANIZE: WorldDefinition<HumanizeConfigSection> = {
  id: HUMANIZE_ID,
  label: '活人感',
  defaults: () => structuredClone(HUMANIZE_DEFAULTS),
  // ctx.cfg 是 `worlds.humanize` 的活引用：热改的键现读即生效
  create: (ctx) => new HumanizeWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    dataDir: join(ctx.dataDir, HUMANIZE_ID),
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
    persist: (patch) => ctx.persist(patch),
    restart: () => ctx.restart(),
  }),
  describe: {
    tools: describeTools([FEEL_TOOL_DECL], {
      [FEEL_TOOL]: {
        zh: '桌宠回答前先感受一下：等副 API 按情境与情绪想好内心，再把它交给桌宠。',
        en: 'Lets the pet feel the moment before answering: waits for the side model to write its inner thought from the situation and mood, then hands it over.',
      },
    }),
    events: [{
      type: INNER_EVENT,
      description: {
        zh: '桌宠此刻的内心想法：对方说话时由副 API 按情境与情绪写成，小动作时从预设库抽取。',
        en: "The pet's inner thought for this moment: written by the side model from the situation and mood when the person speaks, drawn from the preset library on small actions.",
      },
      trigger: 'preempt',
    }, {
      type: NOTICE_EVENT,
      description: {
        zh: '请桌宠转告对方的提醒：换了模式或扩展更新后，系统前缀需要刷新；还在用旧版「活人感」端点时，卸载 provider 前要先切回原端点。每种变化一次。',
        en: 'A reminder the pet passes on: the system prefix needs a refresh after a mode change or an update; on a legacy Humanize endpoint, switch back before uninstalling the provider. Once per change.',
      },
      trigger: 'flush',
    }],
  },
};
