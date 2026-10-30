# dsh-default-model

在 **设置 → 默认模型** 里把 DeepSeek Harness 的默认模型（provider / model / 推理档位）**固定**下来：
新建的对话、重启之后的对话、以及 SurfCore 的 QQ 工作区，都用你在这里选的那一个。

## 安装

```pwsh
dsh plugin --profile desktop add github:LFELKEEA/dsh-default-model
```

装完**重启 Harness**（宿主插件不支持热重载），然后在 **设置 → 默认模型** 里选。

只带前端半边的插件装不上会报 `dsh.bundle` 缺失 —— 这个包的 `package.json` 里
`dsh.bundle.patch` 与根目录的 `cordis.patch.yml` 是齐的，一条命令即可。

## 它解决什么

Harness 的默认模型存在组合条目里（`config: { provider, model, reasoningEffort }`），改它原本只有三条路：

- 手编辑 profile 的 `cordis.patch.yml` —— 容易写错，哪一份 profile 生效也不直观；
- `dsh-model-override` 这类插件读环境变量 `DSH_MODEL` 再猴补丁 `currentSelection()` ——
  只能在启动前定死，UI 里改不了，也看不到真实目录；
- 用 Harness 输入框旁的模型选择器 —— **它会顺手改掉全局默认**：`selectModel()` 切完会话模型后会
  在后台 `agentDefaultModel.saveSelection()`，于是「默认模型」永远等于你最后在任意一个对话里点过的模型。
  你以为改了默认，其实下一个对话又变回去了。

这个插件把两件事分开：

1. **改默认**：设置页选 provider / model / 档位，走官方 `agentDefaultModel.saveSelection()`；
2. **固定默认**：把同一份选择写进插件自己的状态文件（`<DSH_HOME>/default-model.json`），
   并用只读覆盖 `agentDefaultModel.currentSelection()`，让「任何会话里换模型」都带不走它。

所以「保存为默认模型」= 固定：之后随便在哪个对话里切模型，默认仍然是这里选的这个；想放开就点 **解除固定**。

## 为什么「固定」不会又被带跑

固定之后仍有两个力量想把默认值改回去，插件分别挡住了：

1. **有人在会话里切模型** —— DSH 会在后台 `saveSelection()` 写回组合条目。插件只覆写「读口」
   （`currentSelection()`），写入照常发生、也不报错，但**读出来的永远是固定值**，
   所以新会话、`modelCatalog.default`、SurfCore 的 QQ 工作区拿到的都是固定值。
2. **组合条目被热重载** —— 上面那次写入会让 `agent-default-model` 重载，服务**实例可能换新**，
   新实例上没有我们的覆盖。插件每 2 秒对一次账（读出来的不是固定值就重装），
   所以「固定了但聊一次又变」这种半失效状态会在 2 秒内自愈。

状态文件是**唯一真相源**；组合条目里那份只是镜像，让原生读口也看到同一个值（镜像失败不影响固定，
`/state` 的 `mirrored` 会说明原因）。

## 用法

1. 安装后在 **设置 → 默认模型** 打开这一页。
2. 选 provider → 在列表里点一个模型（也可以直接填模型 id）。
3. 需要的话选推理档位；不选就是「跟随模型默认」。
4. 点 **保存为默认模型** —— 卡片会显示「已固定」，并告诉你原生默认值是什么。
5. 想恢复 Harness 原生的行为，点 **解除固定**（`POST /reset`）：删状态文件、卸掉覆盖，立刻回到原样。

## 与 SurfCore 配合（QQ 聊天 / QQ 黑话学习）

SurfCore 的两个 QQ 工作区默认**跟随 DSH 的默认模型**（`config.json → dsh.followDefaultModel`，默认 `true`），
它读的是 `session.modelCatalog.default`，也就是这里的 `currentSelection()`；所以：

- 在这里改了默认模型 → QQ 工作区下一轮就用它（桥接有 15 秒缓存，最多慢 15 秒）；
- 在 SurfCore 控制台把「跟随 DSH 默认模型」勾掉 → 用 `config.json` 里写死的模型，与这里无关。

不需要为本机写死任何 provider / 模型：插件只存「你选的那个」，别人装上之后选自己的，互不影响。
（历史坑：桥接以前只读 `config.json`，而 `selectModel` 又会把默认改回 config 值，两处互相拉锯 ——
见 SurfCore 仓库 `docs/PITFALLS.md` #90。）

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：`/dsh-default-model/api/{state,save,reset}`，读目录、读/写状态文件、装/卸覆盖、镜像回组合条目 |
| `client.js` | 浏览器半边：注册 `settings.section` 分页 |
| `cordis.patch.yml` | bundle 插入行 `id: default-model` |
| `locale/*.json` | 插件管理器显示名与描述 |
| `scripts/smoke.mjs` | Host 半边测试（假服务 + 假 configEditor，不碰真实 `~/.dsh`） |
| `scripts/client-smoke.mjs` | 浏览器半边测试（自写迷你 React + 假 fetch） |

状态文件长这样（BOM 容错，Windows 编辑器写的带 BOM 也能读）：

```json
{ "provider": "dfy", "model": "deepseek-v4.1-flash-1017", "reasoningEffort": "max" }
```

安装覆盖按三级回退，每一级都用**行为**验证（读一次 `currentSelection()` 看是不是固定值）：
`own-assign` → `own-define`（实例不可写时）→ `proto-assign`（实例被冻结时）。
都失败时不会假装成功：`/state` 返回 `attached:false` 和 `attachError`，设置页原样显示。

每次安装都用 `ctx.get('agentDefaultModel').currentSelection()` **重新取一次**读回来复核，
不在被改的那个对象上自证 —— 宿主可能给 `ctx.get()` 返回不同的包装对象，只看自己改的那份会误判。

宿主路由只接受本机回环 Host，写操作要求 `application/json`，并放行桌面壳的
`dsh-app:` 来源（跨站网页仍然被拒）。连接层给的 403 会硬拦；401（缺浏览器凭证，
桌面壳转发请求时不带 cookie）只记一条日志后放行 —— 本机进程本来就能直接改
`cordis.patch.yml`，真正要挡的是跨站写入，那条由 Origin 校验负责。

## 自测

```pwsh
node scripts/smoke.mjs        # Host 半边：56/56
node scripts/client-smoke.mjs # 浏览器半边（自写迷你 React）：19/19
```

`scripts/client-smoke.mjs` 用 `node:vm` 跑 `client.js`，把渲染树走成文本再点按钮，
所以「选模型 → 出现未保存提示 → 保存 → 显示已固定 → 解除固定」这条链路不依赖真浏览器。
它还会断言请求地址正好是 `<origin>/dsh-default-model/api/state` —— 地址拼错时页面
只会显示一句「HTTP 404」，假 fetch 不校验 URL 就发现不了（这条踩过一次）。

Host 半边的关键断言：`service.saveSelection(other)` 之后 `service.currentSelection()` 仍是固定值
（模拟 `sessionController.selectModel()` 的后台覆盖）、实例被 `Object.freeze` 时靠原型覆盖仍生效、
带 BOM 的状态文件能读、`/reset` 之后实例上不留自己的 `currentSelection`。

## 排查

- 页面显示「读取失败：HTTP 404」→ 路由前缀拼错（`API_ROOT = 'dsh-default-model/api'` 只拼一次）。
- 页面显示「已固定，但没挂上」→ 看 `<DSH_HOME>/default-model.boot.json`（启动自检）和
  `default-model.debug.json`（每次装覆盖的结果）；桌面壳默认关闭浏览器访问，外部 curl 一律 403，
  这两个文件是主要证据来源。
- 改了代码后行为没变 → 新壳的宿主插件**不支持热重载**，`plugin_manager` 的 toggle 会返回
  `application:"restart-required"`，必须重启 DSH。

## 兼容性

- 需要 Harness 暴露 `agentDefaultModel` 服务；没有时页面只读并说明原因，不会假装保存成功。
- 没有 `llm` 服务时模型列表为空，但仍可手动填 provider / model。
- 没有 `configEditor` 服务时无法镜像回组合条目（`mirrored: "skipped"`），但固定照样生效。