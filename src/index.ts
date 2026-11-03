/** 包入口：默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { HUMANIZE } from './definition.ts';

export default HUMANIZE;
export { HUMANIZE };
export type { HumanizeConfigSection } from './config.ts';
