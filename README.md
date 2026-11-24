# backend-starter

[![CI](https://github.com/wwaa883/backend-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/wwaa883/backend-starter/actions/workflows/ci.yml)

Express 5 + mysql2 的最小后端，读写 MySQL 的 `demo` 库。

## 环境要求

Node **≥ 26**（`.nvmrc` 里写了 `26`，装了 nvm 的话 `nvm use` 就能对上），MySQL 8.4。

## 启动

```bash
cp .env.example .env   # 第一次：把 DB_PASSWORD 改成你自己的密码
npm install
npm run dev     # nodemon 热重载
npm start       # 普通启动
npm test        # 接口自动化测试（node:test，会连真实数据库）
npm run lint    # ESLint
npm run format        # Prettier 格式化
npm run format:check  # 只检查不改，CI 用的就是它
```

默认端口 `3000`，数据库连接配置在 `.env`（不进 Git，仓库里只放 `.env.example`）。

Windows 上一键起整套环境（MySQL 服务 → 后端 → 前端 + 打开浏览器）：

```powershell
pwsh -File scripts\dev-start.ps1            # 加 -NoBrowser 只起服务不开浏览器
```

脚本按自己所在位置推算仓库路径，`frontend-starter` 默认是与本仓库同级的目录。

## 数据表

`demo.users`：

| 字段         | 类型                                                            | 说明                                      |
| ------------ | --------------------------------------------------------------- | ----------------------------------------- |
| `id`         | INT UNSIGNED AUTO_INCREMENT                                     | 主键                                      |
| `name`       | VARCHAR(50) NOT NULL                                            | 姓名，按字符（码点）计长，emoji 算 1 个字 |
| `email`      | VARCHAR(100) NULL，唯一索引 `uk_users_email`                    | 可为空；非空时全表唯一                    |
| `created_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP                             | 创建时间                                  |
| `updated_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP | 更新时间                                  |

时区：MySQL 会话按服务器本地时区存 `DATETIME`/`TIMESTAMP`，接口以 UTC（带 `Z`）输出，前端负责按本机时区渲染。

## 接口

| 方法   | 路径             | 说明                                                                                                                                              |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/hello`     | 健康检查，顺带检测 MySQL 连通                                                                                                                     |
| GET    | `/api/users`     | 用户列表，支持 `?q=` 搜索、`?limit=`(1..200)/`?offset=` 分页，总数在响应头 `X-Total-Count`（已通过 `Access-Control-Expose-Headers` 暴露给浏览器） |
| GET    | `/api/users/:id` | 单个用户，不存在返回 404                                                                                                                          |
| POST   | `/api/users`     | 新增，body: `{ "name": "...", "email": "..." }`，`email` 可省略或传 `null`；返回 201 + 完整行（含 `id`/`created_at`/`updated_at`）                |
| PUT    | `/api/users/:id` | 部分更新，body 里给 `name` 和/或 `email`（`email: null` 表示清空）；返回更新后的完整行                                                            |
| DELETE | `/api/users/:id` | 删除，返回 204                                                                                                                                    |
| GET    | `/api/stats`     | 用户总数 `{ "userCount": n }`                                                                                                                     |

所有列表与单条接口返回的行结构完全一致：`{ id, name, email, created_at, updated_at }`。

校验规则：`name` 去空格后不能为空、按 Unicode 码点计数不超过 50（一个 emoji 算 1 个字）；`email` 允许空值，非空时必须是 `x@y.z` 形式，否则返回 400。

错误处理：畸形 JSON → 400、字段超长 → 400、请求体超 100 KB → 413、邮箱已被占用 → 409（`{"message":"这个邮箱已经被使用"}`，由数据库唯一索引兜底，POST 和 PUT 都会返回）、未知路径 → JSON 404（`{"message":"接口不存在"}`）、服务端异常 → 500 且不回显内部堆栈。

## 安全与限流

- `helmet` 默认安全响应头（`X-Content-Type-Options`、`X-Frame-Options`、`Strict-Transport-Security` 等），并关闭 `X-Powered-By`
- CORS 白名单：默认只放行 `http://localhost:5173` 与 `http://127.0.0.1:5173`，用环境变量 `CORS_ORIGIN` 覆盖（多个用逗号分隔）。无 `Origin` 的请求（curl、服务端调用）照常放行，陌生来源不加 CORS 头并记一条 `cors_blocked` 日志
- `express-rate-limit` 分两档：读接口（GET）**600 次 / 分钟**、写接口（POST/PUT/DELETE）**120 次 / 分钟**，超限返回 429 `{"message":"请求太频繁，请稍后重试"}`，响应头 `RateLimit-Policy` 里有本档额度
- 搜索关键字里的 `%` `_` 会被转义，避免通配符注入
- 密码等配置只在 `.env`，不入库

## 日志

每行一个 JSON，方便直接丢给日志工具：启动与连接池事件走 `src/logger.js`，HTTP 访问日志形如
`{"time":"...","level":"info","event":"http","method":"GET","path":"/api/users","status":200,"ms":12,"ip":"::1"}`，
错误带 `errMsg` / `errCode` / `stack` 前几行。

## 部署相关

- **优雅退出**：`Ctrl+C` 或容器 `stop` 时先停止接收新请求、再关闭连接池，5 秒内没退完强制结束；`unhandledRejection` / `uncaughtException` 也会写进日志再退，不会静默挂掉。
- **前面的代理**：只有挂了 Nginx / 负载均衡才需要配 `TRUST_PROXY`（数字表示信任的跳数），配了限流才会按真实客户端 IP 算；直连部署不要配，否则客户端能伪造 `X-Forwarded-For` 绕过限流。

## 用 Docker 起整套环境

`docker-compose.yml` 里包含 MySQL 8.4 和本服务：

```bash
docker compose up -d --build     # 首次会拉镜像 + 建表 + 灌一条示例数据
docker compose ps                # 看两个容器是否 healthy
docker compose down -v           # 连数据卷一起清掉
```

端口说明：宿主机 `3307` → 容器 MySQL，宿主机 `3001` → 容器内 API（因为 3306/3000 已被本机 MySQL84 和本地 dev 占用）。容器内的表结构由 `docker/mysql/initdb/01-init.sql` 在首次启动时自动创建。

## 结构

- `src/app.js` —— 路由与业务逻辑（导出 `app`，方便测试直接挂载）
- `src/index.js` —— 启动入口
- `src/db.js` —— 连接池与连通性检测
- `src/logger.js` —— 结构化 JSON 日志
- `test/api.test.js` —— 26 个接口测试用例（CRUD、搜索分页、参数校验、emoji 长度、安全头、读写两档限流额度、CORS 白名单、邮箱唯一性、404）
- `scripts/dev-start.ps1` —— 一键启动脚本
- `.env.example` —— 配置模板
- `Dockerfile` / `docker-compose.yml` / `docker/mysql/initdb/` —— 容器化运行（镜像用 `npm ci --omit=dev` 装依赖、以 `node` 非 root 用户跑）
- `.github/workflows/ci.yml` —— CI：MySQL service + lint + 格式检查 + 建表 + 测试
- `.github/dependabot.yml` —— 每周自动提依赖升级 PR
- `.editorconfig` / `.gitattributes` / `.prettierignore` —— 编辑风格与换行符统一
- `LICENSE` —— MIT
- `logs/` —— 后台运行时的输出日志（不提交）
