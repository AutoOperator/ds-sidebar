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
- `src/main/tray-manager.js` 仅托盘，无任务栏；X 关闭回托盘
- 视图1：模型（点击切换）/ 余额 / 双倍平价（按时间）/ 今日消费（点击切换 API）
- 视图2：分层堆叠条形图（按模型/按API），官方风格 tooltip（金额+tokens）

## 数据源

- 余额：`api.deepseek.com/user/balance`（API Key）
- 用量：`platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}`（User Token）
- 密钥列表：`platform.deepseek.com/api/v0/users/get_api_keys`（User Token）
- 价格模式：北京时间 9-12 / 14-18 = 双倍，其余平价

## 已知陷阱

- 平台用量 API 会返回整月所有天（未来日期零填充）→ ds-api.js 按当天日期过滤后再取近 30 天
- 触点窗口必须独立置顶（screen-saver 层级），否则吸附后会被其他窗口盖住
