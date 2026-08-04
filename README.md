# DS侧栏 (ds-sidebar)

DeepSeek API 用量侧边栏。侧边吸附 + 悬浮滑出，实时显示余额 / 今日消耗 / 分模型 · 分 API 的用量图表。

## 功能

- **视图1（细条）**：模型（点击切换）| 余额 | 双倍/平价（按北京时间自动切换）| 今日消费（钱 + tokens，点击切换不同 API）
- **视图2（图表）**：按模型或按 API 分层堆叠条形图（官方风格，hover 显示各层金额 + tokens）
  - 范围：近7天 / 近30天 / 本月 / 上月
  - 指标：金额 / Tokens
  - 分组：按模型 / 按 API
- **菜单**：刷新数据、统计筛选（搜索框 + 勾选要显示的 API Key）、设置（主题、透明度、API Key、User Token）
- 侧边吸附、屏幕边缘触点展开、托盘驻留

## 数据源

| 数据 | 接口 | 凭证 |
| --- | --- | --- |
| 余额 | `api.deepseek.com/user/balance` | API Key |
| 用量（按 API × 模型 × 天） | `platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}` | User Token |
| API Key 列表 | `platform.deepseek.com/api/v0/users/get_api_keys` | User Token |

> 凭证在应用「设置」里填写，保存在本地配置文件，不会上传。User Token 是账户级凭证，可统计该账户下所有 API Key 的用量。

## 运行

```bash
npm install
npm start
```

打包绿色版：`npm run dist` → 生成到 `dist/DS侧栏-win32-x64/`

## 技术栈

- Electron 31（无边框透明窗口、托盘、吸附）
- ECharts 5（堆叠条形图）
- Node.js 内置 `fetch` 直连 DeepSeek 平台接口

## License

MIT
