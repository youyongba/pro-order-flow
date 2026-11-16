# PRO ORDER FLOW

独立 BTCUSDT 现货订单流、足迹、盘口、vPOC/VAH/VAL、Delta、大单和通知。历史K线、实时流与盘口统一现货口径。缺失价格级别成交不随机补造，但保留K线真实总Delta。支持1m/5m/15m/1h/4h/1d。

此目录为完整项目，可独立复制到其它服务器。`lib/` 等代码是本项目自己的文件，不依赖上级目录、共享服务或其它四个项目。

## 启动

使用 Node.js 22。在本目录运行（SQLite 含原生依赖，请在目标服务器安装，不要跨系统复制 node_modules）：

```bash
npm ci
cp -n .env.example .env
npm test
npm start
```

默认地址 `http://127.0.0.1:3104/`；原页面路径 `/pro_order_flow.html` 仍可访问。
默认不带凭证、不复制原 `.env`、不自动迁移存档。代理仅通过终端环境变量设置，不写入代码或 `.env`。

## 配置

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| HOST | 127.0.0.1 | 监听地址，公网使用反向代理 |
| PORT | 3104 | 本项目端口 |
| BINANCE_TIMEOUT_MS | 10000 | 现货 REST 行情请求超时，正整数，单位毫秒 |
| FEISHU_WEBHOOK_URL | 空 | 可选，飞书群自定义机器人地址 |
| FEISHU_WEBHOOK_SECRET | 空 | 可选，机器人启用签名校验时填写 |
| WEBHOOK_ENABLED | 示例为 0 | 飞书通知开关，填好新凭证后设为 1 |
| WEBHOOK_MIN_INTERVAL_MS | 30000 | 普通通知全局最小间隔，毫秒 |
| WEBHOOK_EVENT_COOLDOWN_MS | 300000 | 普通通知同类事件冷却，毫秒 |
| ORDERFLOW_DELTA_ALERT_MIN | 50 | Delta 告警阈值，单位 BTC，建议保持默认 |

本项目使用币安公开现货行情，不需要币安 API Key/Secret。也不需要旧项目的
`FEISHU_APP_*`、`FEISHU_RECEIVE_*`、`REGIME_*`、`TELEGRAM_*`、
`TRADING_NOTIFY_TG`、`AUTO_TRADE_*`、`MONITOR_*`、`AI_ANALYSIS_*`、
`MANUAL_FALLBACK_*`、`RATE1H_*` 或 `CONFIG_AUTH_TOKEN`。
本项目没有 `/api/reset`，也未实现通过 `CONFIG_AUTH_TOKEN` 保护接口，不要直接暴露到公网。

`.env.example` 是可提交模板，**不被 .gitignore 排除**；真实凭证只能放在被忽略的 `.env`。
已暴露的凭证请先轮换，不要复用。URL 直接填写，不要带 Markdown 反引号。
通知总开关为 0 或 URL 为空时不会发送；Delta 告警使用强制推送，会跳过普通通知的间隔和冷却，但仍遵守总开关。

本机需要网络代理时，仅在启动终端设置（地址按实际代理软件调整）：

```bash
https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890 npm start
```

服务器可直连币安时直接 `npm start`，不要把本地代理地址复制到服务器配置。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /healthz | 进程存活，不代表交易所数据就绪 |
| GET | /api/system | 系统身份及是否启用实盘 |
| GET | /api/proxy/klines | symbol=BTCUSDT, interval, limit<=1000, endTime?；现货 |
| GET | /api/proxy/depth | symbol=BTCUSDT, limit<=1000；现货 |
| GET | /api/auto-trade/orderflow/history | tf=1m/5m/15m/1h/4h/1d, endTime?, limit=1..150；SQLite 历史分页 |
| POST | /api/auto-trade/orderflow/backfill | JSON {startTime,endTime}；自动回补真实历史成交，返回任务 |
| GET | /api/auto-trade/orderflow/backfill/:id | 回补进度与失败原因 |
| POST | /api/auto-trade/notify-profile | tf, vpoc, vah, val, symbol；通知 |
| POST | /api/auto-trade/notify-delta | tf, delta, direction, startTime, symbol；通知 |
| GET/POST | /api/mtf_walls | 读取或保存 {tf,buy,sell} |
| WS | /ws/binance/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms | 只允许固定现货流 |

原业务接口的请求结构、字段名、鉴权方式保持不变。上游未就绪时返回原有 `ok:false` 或 503；行情错误不伪造为有效数据。

## 数据

所属存档：

- `data/mtf_walls.json`
- `data/order_flow.sqlite`（运行时伴随 `-wal` / `-shm`）

运行数据不随代码提交：`.gitignore` 排除 `data/` 内除 `.gitkeep` 外的所有文件，
以及任意目录下的 `.sqlite` / `.sqlite3` / `.db`、配套文件和常见扩展名备份。
更新部署时保留服务器的 `data/`，不要用本地数据覆盖；新环境会自动创建数据库，但不会包含旧归档。
忽略规则不影响已被 Git 跟踪的文件；若以前提交过，需先备份并在实际仓库中用
`git rm --cached -- <具体文件路径>` 仅取消跟踪，再提交这项变更。本地文件会保留，
但其他部署拉取这项删除提交前也须备份并在停机后恢复数据。不要用 `git add -f` 强制添加运行数据。

订单流按「1 分钟 × 10 USDT 价位档」持久化到 SQLite，不自动删除；服务重启后仍可查询。
更大周期从分钟档聚合，不再受后端 150 根内存上限限制。大单列表和累计统计仍为进程内存数据。
实时归档从新版本启动时开始；旧缺失分布不能从 K 线或 `mtf_walls.json` 还原，
但现在可以通过币安真实历史 `aggTrades` 回补。

右侧 Volume Profile 按当前可见 K 线时间范围统计，包含边缘部分可见的整根 K 线。
向左拖动自动分页查询，缩放会重算分布、vPOC / VAH / VAL，面板显示时间范围和完整性。
初次启动、断线跳号、尚未结束的 K 线会显示部分数据，未采集时段显示缺失，绝不按 K 线总量伪造价位分布。
页面每五秒按可见范围自动提交回补或查询进度，区分「准备中 / 下载中 / 分批轮转中」并显示 X/Y 分钟。
每个已结束分钟下载真实聚合成交并核对同分钟 K 线的总量、主动买量，成功后原子替换旧部分数据，
不与实时数据重复累计；失败显示原因并提供重试。已成功分钟持久保留，重启后重新发起会跳过完整数据。
支持超过 150 天的可见范围（如日线历史），串行限速执行，跨度越大耗时越长。可先缩小时间范围查看进度。
当前范围先获得一轮，然后与已有任务分批轮转：每轮最多 5 分钟或 6 次上游请求，
高成交量时保留分页进度，下轮继续，不要求其它范围等整个大任务完成。
相邻缺失分钟合并下载，K 线批量查询但仍逐分钟精确核验；低成交量 5 分钟通常从 10 次请求减少到 2 次，
高成交量仍需额外分页，不能保证固定提速倍数。币安请求限速和失败保护不变。
买卖量校验失败时，自动拆分为单分钟，最多额外重试两次（等待 2 秒、5 秒），每次重新下载而非叠加。
持续不一致的分钟保留为缺口，其他分钟继续回补；页面显示缺口数并允许单独重试，不会整段停住或假装完整。
差异时间和实际/预期买卖量会写入服务日志，远程偶发不一致的具体原因仍需根据这些证据确认。
拖动、缩放或切换周期会替换同一页面的旧回补任务，避免占满队列；排队繁忙或任务被调度取消时自动等待重试。
更早历史是否可用取决于币安接口；限流、网络失败或校验不一致不会被标记为完整。
前端实时分布每两秒从后台同步，价格仍实时更新；浏览历史不会写实时价位快照或触发分布通知。
历史盘口没有存档，因此历史模式隐藏 DOM；返回实时通过「运行」或双击图表重新同步。

存储、接口参数、去重和异常退出边界详见 [归档模块说明](trading/order-flow/README.md)。
数据库无限增长不等于无限磁盘，请监控容量，并定期生成一致性备份到独立磁盘：

```bash
npm run backup:orderflow -- /absolute/existing-backup-dir/order-flow.sqlite
```

备份命令拒绝覆盖已有文件。运行中不要仅复制主库文件，可能遗漏 WAL 中已提交的数据。

在首次启动前预览迁移，工具不导入 `.env`、不覆盖已有目标文件：

```bash
node scripts/migrate-state.js --from /absolute/old-project
# 仅在源、目标均已停止写入后：
node scripts/migrate-state.js --from /absolute/old-project --apply --source-stopped
```

工具原样复制并校验SHA-256，保留源文件。发现目标已有文件、目标正在运行、非法JSON或路径越界时拒绝执行。
SQLite 还会校验完整性和版本，拒绝带未合并 WAL 的源库；请使用干净停机库或一致性备份。
旧自定义路径需先整理停机快照到 `system.json` 列出的标准路径。新配置的数据路径不得越出本项目。

## 部署

```bash
pm2 start ecosystem.config.cjs
pm2 restart pro-order-flow
```

只允许单个Fork实例，禁止Cluster。PM2的cwd固定为当前项目目录。不要让nodemon监视状态文件，也不要在实盘使用开发热重载。
`nginx.conf.example` 提供本系统专用域名反向代理模板，需配置域名与TLS。服务和代理由操作人员手动启动。
升级本版本时先备份旧数据，在 Node 22 下执行 `npm ci`，再手动重启服务并刷新页面。
不需要新增 `.env` 变量；数据库会在首次启动时自动创建。不要删除 `data` 目录来部署代码。

## 验证

`npm test` 在临时目录中运行，不接触本目录或旧系统的真实交易状态。涵盖独立运行、接口、断网降级、路径隔离、
进程锁、迁移防覆盖、SQLite 重启恢复、事务回滚、强杀缺口、历史分页、可见范围分布和通知隔离。
生产入口不加载测试网络替身。实盘端到端成交与云主机网络仍需部署后核对，不能用离线测试代替。
