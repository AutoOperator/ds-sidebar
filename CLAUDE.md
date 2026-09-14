# DS侧栏 (ds-sidebar)

DeepSeek 用量侧边栏：侧边吸附 + 悬浮滑出，实时余额/今日消耗/图表。

## 运行

- 开发：`npm start`（启动即吸附到右边缘，自动隐藏为蓝色触点细条）
- 打包：`npm run dist` → 生成到 `dist/DS侧栏-win32-x64/`
- 自检：`npx electron . --screenshot`（演示模式加 `DS_DEMO=1`；跑完自动还原配置，产物在 `shots/`）

## 架构

- Electron 主进程 + 无边框透明窗口
- `src/main/window-manager.js` 主窗口 + 触点窗口（细条 600×40，图表 900×420）
- `src/main/snap-manager.js` 吸附 / 折叠触点 / 悬浮展开（滑动+淡入）
- `src/main/ds-api.js` 数据层：余额 + 用量（按 API Key × 模型 × 桶）
- `src/main/menu-manager.js` 独立菜单小窗（≡ 菜单 + 细条上的 API 选择列表共用）
- `src/shared/pricing.js` 峰谷计费规则（主进程 require / 渲染层 `<script>` 共用同一份）
- `src/shared/models.js` 模型名归一（同上，两边共用）
- `src/main/tray-manager.js` 仅托盘，无任务栏；X 关闭回托盘
- 视图1：模型（点击循环）/ 余额 / 高峰低谷（悬停看规则+倒计时+当前北京时间）/ 今日消费 + ▾（点开 API 列表选）
- 视图2：分层堆叠条形图（按模型/按API），范围 = 今日（小时级）/ 自选起止日期 / 本月 / 上月

## 数据源

- 余额：`platform.deepseek.com/api/v0/users/get_user_summary`（User Token，网页右上角同款）
- 用量：`.../usage/by_api_key/{amount,cost}`（User Token）
- 密钥列表：`.../users/get_api_keys`（User Token）
- 凭证只有 User Token 一种：应用设置 → `~/.claude/ds-watch/user_token`（纯净模式不回退）
- 价格模式：**工作日**（周一至周五）北京时间 9-12 / 14-18 = 高峰，其余全部时段（含周末全天）= 低谷；低谷单价 = 高峰的一半。周末不算高峰是最容易漏的一条。

## 时间桶规则（写数据层前必读）

平台的桶网格**锚定在请求的 `start` 上**，粒度按跨度切：

| 请求跨度 | 返回粒度 | 对齐方式 |
| --- | --- | --- |
| ≤ 24h | 小时桶（1h 步长） | 桶时间 = start + k 小时 |
| ≥ 48h | 天桶（24h 步长） | 桶时间 = start + k 天 |

因此 **start 必须取北京日 00:00**（`bjMidnightSec()`）。早先按 UTC 日对齐（= 北京 08:00），"今天"那 24 个小时桶会横跨今天 08:00 → 明天 08:00，被按北京日期切成两段，取最后一段就是空数据 —— 细条"今日消耗"曾经永远是 ¥0.00 就是这个原因。

- 天桶时间戳是"该北京日 00:00"（= UTC 前一日 16:00），`bjDateStr()` 负责换算成 `YYYY-MM-DD`
- 桶网格由 `buildBuckets()` 自己铺满，不依赖接口零填充；缺数据的桶补 0
- 今日数据单独取一次（`getStats()` 里的 `today`），与所选的图表范围无关

## 模型名（勿再写旧名）

- **现役只有两个**：`deepseek-flash`（承载 V4.1-Flash）与 `deepseek-v4-pro`
- 历史用量行会返回一堆旧名（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-chat & deepseek-reasoner`、`deepseek-v4.1-flash-expires-on-0910` 等），`src/shared/models.js` 统一归到上面两个族；未知名字原样保留，别吞
- `getModel()` 返回配置原值（不归一），`getCanonicalModel()` 是给界面用的归一版本 —— 细条按"当前模型"过滤必须用后者，否则匹配不上任何用量行，今日又是 0

## 已知陷阱

- **不要把 API Key 这套东西加回来**。API Key 输入框在 v1.4.0 已从设置界面删除（只保留一键登录拿 User Token），但当时后端没跟着删：`getApiKey()` 会读 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`（Claude Code 自己的凭证）去请求余额，属于跨项目用凭证，已拆掉。`getCreds()` 也只返回 userToken，别再回吐 apiKey。
- `~/.claude/settings.json` 现在只剩一个用途：读 `ANTHROPIC_MODEL` 显示当前模型（非凭证）。
- 细条窗口只有 40px 高，放不下下拉：API 选择列表必须走菜单窗口（`menu:open` 带 `mode:'api'`），列表数据用主进程缓存的 `lastData`，别再现取一次网络。
- 菜单窗口 / 日期面板这类浮层要挂在不会被 `overflow:hidden` 裁掉的位置（表头就是 `overflow:hidden`，日期面板因此挂在 `#app` 上）。
- `--screenshot` 自检会在开始时存档、结束时还原整份 state（含 settings），所以自检里点过的范围不会残留。
- 触点窗口必须独立置顶（screen-saver 层级），否则吸附后会被其他窗口盖住。
- 打包时 `--out` 指向别的目录后，electron-packager 不再自动忽略 `dist/`，会把旧绿色包塞进 asar（见过 444MB 的包）；`tools/build.js` 已显式 `--ignore` 排除 `shots/` 与 `dist/`。
- `tools/deploy.js` 部署时会清空目标目录但保留 `config/`（凭证在里面），别改回整体删除。
