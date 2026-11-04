# 活人感 · cortico-world-humanize

给 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌宠用的 Cortico World 扩展，让桌宠说话更像个人。

- **开口前先有心事**：有人对桌宠说话时，先读一下情境、对方的情绪和桌宠自己的记忆，递给它一句「此刻心里的想法」，再让它开口。
- **盯住 AI 的固定句式**：桌宠最近要是用了「不是……而是……」、一开口先复述你的话这类句式，下次就提醒它换个说法。**只管固定句式**，口癖、语气、长短都照角色自己的样子来。
- **人设不写死**：每次现读桌宠工作区里的 `CONSTITUTION.md` 和 `PARTNER.md`。你改了人设，或者桌宠自己改了，下一句话就跟着变。
- **开关即用**：在 World 页打开就生效，关掉不留痕迹。所有设置都在 Coopanion 页面里。

搭配 [活人感 provider（cortico-provider-humanize）](https://github.com/abbabanana/cortico-provider-humanize) 效果最好，见下面「三种交付方式」。

## 安装

1. Coopanion 的「扩展」页搜「活人感」，安装 `cortico-world-humanize`。推荐把 `cortico-provider-humanize` 也装上（可选，装上就生效，不用设置）。
2. 重启 Coopanion。
3. World 页打开「活人感」。

主模型已经是 DeepSeek 的话，什么都不用填，它会借用那个端点的 Key。用别家的话，在「配置 → 副 API」里填地址、模型和 Key（Key 保存后转存到本机部署的 `.env`，输入框随即清空）。

## 它什么时候工作

| 消息 | 读不读 |
|---|---|
| 桌宠：打字、开口、回答问题 | 一直读 |
| 控制台页的消息 | 一直读 |
| QQ：`cortico-world-qq`、`cortico-world-qqbot`、`cortico-world-astrbot` | 专门适配过。默认只读私聊和 @桌宠的，可以改成群里全读或不读 |
| 其他扩展（别的 QQ、微信、B 站……） | 配置页自动列出见过的来源，勾上的才读 |
| 戳、摸、扔、放下、换装 | 不调副 API，按概率从预设库抽一句心情 |

同一个对话里连着来好几句，只想最新那句；本机和各个聊天扩展各想各的，互不作废。

副 API 一次调用大约 1–2 秒。默认用 DeepSeek 并关掉思考，花费很少；用量记在 Coopanion 的用量统计里，标签是「活人感 · 副 API」。

## 三种交付方式

| 方式 | 什么时候 | 效果 |
|---|---|---|
| **provider 模式** | 装了活人感 provider（装上就自动包住你现在用的端点） | provider 在主模型请求发出前等心事，塞进请求再发。一轮就带着心事开口，最推荐 |
| 先感受再开口（默认） | 没用 provider | 桌宠先调用 `humanize_feel`，工具等副 API 想好再交回去。每次都赶得上，但主模型多一轮 |
| 抢时间 | 没用 provider，且关掉「先感受再开口」 | 心事作为事件推进去，桌宠已经开口就作废 |

## 说话习惯体检（只管固定句式）

活人感会记下「对方说了什么 → 桌宠回了什么」，在桌宠最近 12 句里查这些句式。**真用过的**才在心事后面附一句提醒，带上次数和它自己说过的原话：

- 「不是……而是……」「不只是……更是……」「你以为……其实……」
- 一开口先复述对方的话
- 「是……还是……？」二选一反问
- 「……最怕的就是……」这类格言式总结
- 「说正经的」「说实话」这类开场
- 替对方预设想法、自问自答、助手腔收尾
- 你自己写在预设库「不想听到的说法」里的说法（默认是空的）

只提醒用过的，不塞一整张禁用表：禁用表写得越长，模型越容易换一种说法表达同样的味道。

## 页面里有什么

- **配置**：基本设置、副 API、QQ 扩展、其他聊天来源
- **提示词**：预设库（情境、情绪、小动作、不想听到的说法）、环境提示词、口吻样本、最近 20 轮记录
- **数据**：清空最近记录和计数
- 导航栏：副 API 和系统前缀两个状态灯，以及几个计数

## 系统前缀要刷新的时候

Coopanion 重启后沿用旧的系统前缀。换了模式或者活人感更新了说明之后，桌宠会用气泡提醒一次，World 页也会一直显示，直到你把活人感**关掉再打开一次**（聊天记录保留）。打开「自动刷新」的话，它会等桌宠空闲时自己关开一次。

## 数据和隐私

副 API 看得到：对方刚说的话和最近几条对话、桌宠的人设和记忆文件；用 provider 并开着「把主模型的完整上下文交给副 API」时，还有主模型这次请求的系统前缀和最近上下文。副 API 和主模型是同一家（默认都是 DeepSeek）时，这些内容本来就会发给那一家；**换成别家，就等于把对话也发给了那一家**，这个开关可以关。

活人感不改 Coopanion 程序目录里的任何文件。它写的东西只有：

- `<部署>\data\humanize\`：最近记录、前缀状态、见过的聊天来源
- `<部署>\humanize\`：口吻样本，以及你在提示词页签里改过的预设库和环境提示词
- 配置里的 `worlds.humanize` 一段，你填了 Key 时部署 `.env` 里的 `HUMANIZE_API_KEY`
- 推进事件库的心事和提醒事件

## 市场标签说明

- `companion`、`internal-state`：它给桌宠递心情和内心想法。
- `qq`、`im`：专门适配了几个 QQ 扩展。
- `high-cost`：对方每说一句话都会多一次副 API 调用；用 provider 时副 API 还会带上主模型的上下文。
- `injection-risk`：读 QQ 群这类来源时，群友写的话会经过副 API 影响写给桌宠的心事。默认只读私聊和 @桌宠的；介意的话把 QQ 扩展设成 off。
- `experimental`：还在测试，只在少数环境里验证过（Windows、DeepSeek）。

## 停用和卸载

- **暂时不用**：World 页关掉「活人感」。Coopanion 会立刻重建系统前缀，环境说明和 `humanize_feel` 工具一起拿掉。
- **卸载**：在「扩展」页卸掉两个包，然后重启。只有一种情况要先做一步：你用 0.1.0 时在「模型」页新建过「活人感」端点，而且当前端点还是它，那要**先把当前端点切回原来那个**，不然卸掉 provider 后桌宠会说不了话。
- **清干净**：想连数据一起去掉，删掉上面「数据和隐私」里列的两个文件夹和配置段即可。

## 开发

源码是 TypeScript，Coopanion 用 tsx 直接加载，不用编译。本地开发时，在 Coopanion 的 `data\extensions\` 里用它自带的 pnpm 把这个文件夹链接进来，然后重启 Coopanion：

```
pnpm add link:<这个文件夹> --store-dir=<Coopanion>\data\pnpm\store
```

代码改完要重启 Coopanion；预设库和配置改完不用重启。

## 许可证

MIT

---

## English

**Humanize** is a Cortico World for the Coopanion desktop pet. When someone talks to the pet, it reads the situation, the person's mood and the pet's own persona and memory files, and hands the pet a short inner thought before it answers. It also watches the pet's recent lines for stock AI sentence patterns ("not X but Y", parroting the other person's words back, either-or questions, aphorisms, and similar) and reminds the pet to say it another way when one shows up. It only targets sentence patterns: catchphrases, tone and length are left to the character.

Install it from Coopanion's Extensions page, restart, and turn it on in the World page. It works best together with [cortico-provider-humanize](https://github.com/abbabanana/cortico-provider-humanize), which puts the inner thought straight into the main model's request; install it and restart, there is nothing to configure. Prompts, presets and detection are Chinese only for now. Licensed under MIT.
