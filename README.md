<p align="center">
  <h1 align="center">dsh-image-compressor</h1>
</p>

<p align="center">
  <strong>DSH 双层插件：拖放 / 粘贴时把超过部署图片限制的图片在浏览器内自动压缩，重新喂入官方输入条并弹官方 Toast 聚合通知；同时以 Host 包装器把 <code>read_image</code> 工具对超限图片的拒绝转为自动压缩入库。</strong><br />
  <sub>document 捕获阶段拦截 &bull; <code>tools/execute</code> around-dispatch 接缝 &bull; 压缩目标以 <code>imageLimits</code> 部署实际值为准 &bull; 未超限零介入 &bull; GIF 动画不压缩</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/FengZhiHen1/dsh-image-compressor?color=64748b" alt="License" /></a>
  <a href="https://github.com/FengZhiHen1/dsh-image-compressor"><img src="https://img.shields.io/badge/platform-web-lightergreen" alt="platform: web" /></a>
  <a href="https://github.com/FengZhiHen1/dsh-image-compressor/releases"><img src="https://img.shields.io/github/v/release/FengZhiHen1/dsh-image-compressor?sort=semver" alt="release" /></a>
</p>

## 为什么需要它

DSH 对话中附加图片受部署配置限制（`attachment-local`，默认单张 5MB、单张 4000 万像素，可配）。客户端 `InputBar` 在拖放 / 粘贴时同步校验字节，超限即 toast 拒绝进入附件栏；用户只能离开对话手工压缩再拖回。

`dsh-image-compressor` 把这一步自动化：在浏览器 document 捕获阶段拦截拖放与粘贴，把超限图片压缩到限制以内后重新喂入官方输入条（正常进附件栏预览），并以一行 Toast 汇总压缩结果。

- 🚀 **拖放 / 粘贴自动压缩**：两个官方摄入入口全覆盖，压缩后正常进附件栏预览、直接可发送。
- 🛠️ **read_image 自动压缩**：Agent 读取超限图片文件（字节 / 像素 / 单边边长）不再报错——Host 侧 `tools/execute` 包装器把超限图片压缩入库（sharp 引擎），模型照常看到图片，并附一条 notice 说明压缩前后与"磁盘文件未变"。
- 🧭 **以部署实际值为准**：压缩目标读取 `imageLimits` 投影（单张字节 / 单张像素 / 单边边长），不硬编码、不改限制配置。
- 🖼️ **像素超限等比缩放**：压缩路径内解码后超出 `maxImagePixels` 则等比缩至限制内，宽高比不变、不放大。
- 🔕 **未超限零介入**：字节预筛全同步完成，≤ 限制的批次完全放行，无延迟、无通知。
- 🧱 **GIF 动画不压缩**：按原文件随批次放行，超限时由官方提示兜底。
- 🩹 **失败兜底不丢图**：单张解码 / 编码失败按原文件继续，批次其余照常压缩；尽力而为仍超限时如实标注；任何图片不会因本插件消失。
- 🧹 **生命周期零残留**：卸载后监听、通知层与全部副作用清除，行为回官方原样。

## 安装（接入选定 DSH profile）

本插件是一个 DSH 客户端插件包：`dsh plugin add` 会把它的 bundle patch 与 client 清单纳入所选 profile，启动该 profile 即生效。仓库已提交编译产物 `lib/`，git 依赖无需 prepare 钩子即可直接使用。

先安装 DSH CLI：

```sh
npm install -g @deepseek-ai/dsh
```

然后把插件接入你自己的 profile（把 `<profile>` 换成实际 profile 名，如 `web`）。

### 方式一：GitHub git 依赖（未发布 npm 时推荐；ref 钉定 commit / tag 保证可复现）

```sh
dsh plugin --profile <profile> add github:FengZhiHen1/dsh-image-compressor#<commit 或 tag>
```

### 方式二：本地源码（开发 / 试验直挂）

```sh
dsh plugin --profile <profile> add link:/绝对路径/到/dsh-image-compressor
```

### 方式三：npm 发布包（发布到 npm 后可用）

```sh
dsh plugin --profile <profile> add dsh-image-compressor@<version>
```

随后启动：

```sh
dsh web          # 或任意 profile：dsh --profile <profile>
```

不想全局安装 DSH？用 `pnpm dlx` 跑同一条命令：

```sh
pnpm dlx --package=@deepseek-ai/dsh dsh plugin --profile <profile> add github:FengZhiHen1/dsh-image-compressor#<commit 或 tag>
```

## 工作原理

```text
用户拖放 / 粘贴图片
      │
      ▼
document 捕获阶段（插件监听，先于一切官方处理）
      │   同步判定：注入标记？有会话？会话忙？有 imageLimits？批次含 >maxImageBytes 的图？
      ▼
无需处理 ────────────────► 放行（官方流程原样，零干预）
      │
需要处理
      ▼
preventDefault + stopPropagation（吞掉原事件）
      │
      ▼
串行逐张压缩：解码 → 像素判定 → 格式选择 → 质量迭代
（GIF 与失败张按原文件入列，字节不变）
      │
      ▼
构造 DataTransfer（按原始顺序）→ 派发注入 drop 事件（带防重入标记）
      │
      ▼
官方 InputBar 的 document 级 drop 监听 → intakeImages → 附件栏 + Toast 通知（聚合一条）
```

**Host 面（`read_image` 工具）**：

```text
Agent 调用 read_image(超限图片)
      │
      ▼
tools/execute 包装器（与官方超时插件同一接缝）
      │   判定：非 read_image？GIF？无附件服务？类型不在白名单？
      ▼
无需处理 ────────────────► next()（官方流程原样，零干预）
      │
      ├─ 字节 > min(maxImageBytes, maxMessageImageBytes)
      │    → 跳过必败的官方路径，自核图像能力门后直接接管
      │
      └─ 字节未超限 → next() 官方先行；
         仅"像素/边长拒绝"或 FS_TOO_LARGE 竞态时修复接管
      │
      ▼
ctx.fs 合规读取 → sharp 等比缩放（含边长限制）→ 质量阶梯迭代
      │
      ▼
attachments.saveImage 官方入库 → 补发 fs/observed
      │
      ▼
自创 value 经 read_image 官方 schema 归一化 + 官方 render
→ 模型看到图片 + 一条压缩 notice（additionalContexts）
```

- **拦截**：`drop`（官方为 document 冒泡原生监听）与 `paste`（textarea 的 React 合成事件，委托在 root 容器）都在 document 捕获阶段先于官方处理执行；`stopPropagation` 即可阻断。
- **判定**：事件回调内全同步、零异步（防重入 → 有会话 → 非 running → 有 `imageLimits` → 存在可压缩图且单张 > `maxImageBytes`），任一不满足即放行。
- **压缩引擎**（`createImageBitmap` + canvas + `toBlob`，零第三方运行时依赖）：
  - 格式：JPEG → JPEG 重编码；PNG / WebP → WebP 优先（保 alpha），不支持时 JPEG 白底合成；
  - 像素：`width × height > maxImagePixels` → 等比缩至限制内（不放大）；
  - 迭代：quality `0.85 → 0.7 → 0.5 → 0.3 → 0.15`，仍超限则尺寸 ×0.75，总轮次上限 6，再耗尽返回最小历史结果并标 `overLimit`。
- **Host 引擎**（sharp，部署树同源依赖）：同一质量阶梯与轮次上限；等比缩放同时满足像素与单边边长（`maxImageDimension`）；EXIF 自动定向；迭代耗尽仍超限返回 null 并回退官方报错（入库会再次强制限制，超限产物无法落库）。
- **通知**：拖放/粘贴每批接管聚合一条（单张 / 多张 / 部分失败 / 尽力而为 / 格式变化 / 粘贴文本丢弃），挂 `conversation.input.dock` 座位，渲染官方 `Toast`；read_image 每次接管附一条插件来源 notice（additionalContexts，模型可见）。
- **适配点**：机制依赖官方 `InputBar` 的 document 级 drop 监听与 React root 委托；官方 UI 变更时按 `intake-interception.md` 的适配点清单核对更新。

## 当前限制

- **粘贴接管时剪贴板文本部分随之丢弃**：`ClipboardEvent` 无法从构造器填充文本；仅批次含超限图片时接管，纯文本粘贴永不接管。
- **GIF 动画不压缩**：不引入 GIF 编解码库；两个功能面超限时均由官方提示兜底。
- **非目标**（保留官方提示）：每消息 20 张、每消息总 100MB 超限；设置页 / 质量参数配置；官方暂无文件选择按钮入口（未来新增按同一拦截机制扩展 `change` 捕获）。
- **像素超限但字节未超限** 的罕见图在客户端摄入面不触发压缩（字节预筛决策），由官方 / Host 提示兜底；`read_image` 面无此限制（官方失败后自动修复接管，含单边边长）。
- **read_image 面接管边界**：源文件 >128MB 或解码像素 >1.5 亿不接管（防内存炸弹）；压缩迭代耗尽仍超限、解码/入库失败一律回退官方报错；磁盘原文件永不被修改（压缩产物仅入附件库）。
- **read_image 修复识别依赖官方拒绝文案后缀**（像素/边长拒绝无类型化错误码）：上游改写该文案时退化为官方原样报错，不会出现错误行为。

## 验证与验收

- **单元测试**：57 项全绿（`node --test`），覆盖客户端压缩引擎管线、拦截判定矩阵、批次不变量、通知聚合、apply 生命周期、bundle 冒烟，以及 Host 面 read_image 判定矩阵（直通 / 修复 / 直接接管 / 能力门 / 缓存 / 兜底）与 sharp 引擎管线契约（真实 sharp 夹具 + admission 级 saveImage 桩）；引擎与事件层零耦合（纯函数面可独立 import）。
- **浏览器实测**（headless Chromium + CDP，见 `scripts/probe/`）：
  - missing evidence 闭环：注入 drop 触发官方 document 监听、React 捕获阻断粘贴、40MP 解码、WebP 编码；
  - 端到端（对运行中的 test profile 实测）：超限拖放压缩入栏 + Toast、粘贴压缩（含文本丢弃提示）、小图零介入、GIF 官方提示、混合顺序一致、部分失败如实通知、卸载后拖放回官方原样。
- **Host 面端到端**（真实 profile 会话触发 `read_image`）：待实测。

## 项目结构

```text
plugins/dsh-image-compressor/
├── src/
│   ├── index.ts               Host 入口：注册 read_image 的 tools/execute 压缩包装器
│   ├── host/                  Host 半边（Node）
│   │   ├── read-image-wrapper.ts  tools/execute 拦截、判定矩阵、压缩接管、fs/observed 补发、进程内缓存
│   │   └── engine.ts          sharp 压缩引擎（像素+边长等比缩放 + 质量阶梯，镜像客户端常数）
│   └── client/                Browser 客户端
│       ├── index.tsx          入口：词典注册 → 通知队列 → 捕获监听 → dock 座位；dispose 全清
│       ├── intake.ts          捕获阶段 drop/paste 拦截、同步判定、批次处理与注入
│       ├── compressor.ts      压缩引擎（字节预筛 + canvas 重编码管线 + 可注入 codec seam）
│       ├── notify-store.ts    模块级通知队列 store（uSES 订阅 / publish / 出队）
│       ├── Notifications.tsx  `conversation.input.dock` 座位组件（渲染官方 Toast）
│       └── locales.ts         zh / en 词典 + 通知文案聚合
├── lib/                       编译产物：host entry（lib/index.js + lib/host/）+ client bundle（lib/client.js）
├── scripts/
│   ├── run-tool.mjs / build-client.mjs   构建链（tsc + tsdown → cjs browser bundle）
│   └── probe/                 浏览器实测工具（CDP 驱动 + 拖放/粘贴/基线场景）
├── tmp-probe/                 阶段1 missing evidence 探针页
├── tests/                     Node 单测（引擎 / 判定 / 通知 / apply / 冒烟）
├── cordis.patch.yml           DSH bundle patch：仅 insert 自身 id 一行
├── tsconfig.json              编译配置（host + client）
└── package.json               dsh.bundle.patch + dsh.client{ platform: 'web', inject: [...] } 双面包清单
```

## 构建与测试

```sh
pnpm install
pnpm build      # tsc（host）+ tsc + tsdown（client）→ lib/
pnpm test       # 全量构建后跑 Node 单测
```

- 需要 Node 24.11+ 与 pnpm；DSH host/client 包为 peer 依赖，由目标 profile 提供，构建从本地 devDependencies 解析其类型。
- 不要提交 `.npmrc` / 任何 npm token；本仓库默认忽略本地 npm 配置与密钥类文件。

## 相关文档

需求、机制与决策的唯一权威在 DSH_Plugins 仓库的 `docs/design/dsh-image-compressor/`（requirements / technical-details / decisions）；本仓库的 README 只做面向使用者的概述。

## License

[MIT](./LICENSE)
