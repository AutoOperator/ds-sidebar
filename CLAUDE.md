# DS侧栏 (ds-sidebar)

DeepSeek 用量侧边栏：侧边吸附 + 悬浮滑出，实时余额/今日消耗/图表。

## 运行

- 开发：`npm start`（启动即吸附到右边缘，自动隐藏为蓝色触点细条）
- 打包：`npm run dist` → 生成到 `dist/DS侧栏-win32-x64/`

## 架构

- Electron 主进程 + 无边框透明窗口
- `src/main/window-manager.js` 主窗口 + 触点窗口
- `src/main/snap-manager.js` 吸附 / 折叠触点 / 悬浮展开（滑动+淡入）
- `src/main/ds-api.js` 数据层：余额 + 用量（按 API Key × 模型 × 天）
- `src/shared/pricing.js` 峰谷计费规则（主进程 require / 渲染层 `<script>` 共用同一份实现）
- `src/main/tray-manager.js` 仅托盘，无任务栏；X 关闭回托盘
- 视图1：模型（点击切换）/ 余额 / 高峰低谷（按时间，悬停看规则与倒计时）/ 今日消费（点击切换 API）
- 视图2：分层堆叠条形图（按模型/按API），官方风格 tooltip（金额+tokens）

## 数据源

- 余额：`platform.deepseek.com/api/v0/users/get_user_summary`（User Token，网页右上角同款）
- 用量：`platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}`（User Token）
- 密钥列表：`platform.deepseek.com/api/v0/users/get_api_keys`（User Token）
- 凭证只有 User Token 一种：应用设置 → `~/.claude/ds-watch/user_token`（纯净模式不回退）
- 价格模式：**工作日**（周一至周五）北京时间 9-12 / 14-18 = 高峰，其余全部时段（含周末全天）= 低谷；低谷单价 = 高峰的一半。周末不算高峰是最容易漏的一条。

## 模型名（勿再写旧名）

- 现役：`deepseek-flash`（承载 V4.1-Flash）、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`（视觉实验版）
- 已退役但仍可调用的旧名：`deepseek-v4-flash` —— 历史用量行仍会返回，别当成未知模型
- 旧别名 `deepseek-chat` / `deepseek-reasoner` 由 V4 Flash 承载
- `getModel()` 必须原样返回配置里的模型名才能和用量接口的 `model` 字段对上，**不要做新旧名归一**；只有兜底默认值随现名走

## 已知陷阱

- **不要把 API Key 这套东西加回来**。API Key 输入框在 v1.4.0 已从设置界面删除（只保留一键登录拿 User Token），但当时后端没跟着删：`getApiKey()` 会读 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`（Claude Code 自己的凭证）去请求余额，属于跨项目用凭证，已拆掉。`getCreds()` 也只返回 userToken，别再回吐 apiKey。
- `~/.claude/settings.json` 现在只剩一个用途：读 `ANTHROPIC_MODEL` 显示当前模型（非凭证）。要彻底断开对 Claude 配置的依赖就把 `getModel()` 的兜底也改成常量。
- 平台用量 API 会返回整月所有天（未来日期零填充）→ ds-api.js 按当天日期过滤后再取近 30 天
- 触点窗口必须独立置顶（screen-saver 层级），否则吸附后会被其他窗口盖住
- 视图2 三个统计卡在 800px 窗口下数值会被截断（可用宽 46px / 需要约 56px），要修得先定是加宽窗口还是精简表头
