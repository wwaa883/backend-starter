import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { pool, testConnection } from './db.js'
import { logger } from './logger.js'

const app = express()
// 不暴露技术栈信息
app.disable('x-powered-by')

// 部署在反向代理/容器前面时才开：让 req.ip 取真实客户端 IP，限流才按人算。
// 默认关闭，避免客户端自己伪造 X-Forwarded-For 绕过限流。数字表示信任的跳数，也可以是 'loopback' 等。
if (process.env.TRUST_PROXY) {
  const raw = process.env.TRUST_PROXY.trim()
  app.set('trust proxy', /^\d+$/.test(raw) ? Number(raw) : raw)
}

// 纯 JSON API，不需要 CSP 和跨域资源策略；其余安全响应头保留
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }))

// CORS 白名单：由 CORS_ORIGIN 控制（逗号分隔多个），默认只放行本地开发前端。
// 没有 Origin 的请求（curl、同源、服务端调用）不受影响。
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
      // 不抛错、也不返回 CORS 头，让浏览器自己拦掉
      logger.warn({ event: 'cors_blocked', origin })
      return callback(null, false)
    },
    optionsSuccessStatus: 204,
  })
)

app.use(express.json({ limit: '100kb' }))

// 结构化访问日志：每行一个 JSON，含方法、路径、状态码、耗时
app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    logger.info({
      event: 'http',
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
      ip: req.ip,
    })
  })
  next()
})

// 限流拆成两档：读接口宽松（600 次/分钟），写接口收紧（120 次/分钟）
const limitOptions = (limit) => ({
  windowMs: 60 * 1000,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: '请求太频繁，请稍后重试' },
})
const readLimiter = rateLimit(limitOptions(600))
const writeLimiter = rateLimit(limitOptions(120))

app.use('/api', (req, res, next) => {
  const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
  return (isRead ? readLimiter : writeLimiter)(req, res, next)
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NAME = 50
const MAX_EMAIL = 100

// 姓名：去空格后非空，且按“字符数”不超过数据库列长度（emoji 也算 1 个字）
function validateName(input) {
  const value = String(input ?? '').trim()
  if (!value) return { error: 'name 不能为空' }
  if (Array.from(value).length > MAX_NAME) return { error: `name 最多 ${MAX_NAME} 个字符` }
  return { value }
}

// 统一处理 email：空字符串/null 视为“不填”，非法格式返回错误文案
function normalizeEmail(input) {
  if (input === undefined) return { provided: false }
  if (input === null || String(input).trim() === '') return { provided: true, value: null }
  const value = String(input).trim()
  if (Array.from(value).length > MAX_EMAIL)
    return { provided: true, error: `email 最多 ${MAX_EMAIL} 个字符` }
  if (!EMAIL_RE.test(value)) return { provided: true, error: 'email 格式不正确' }
  return { provided: true, value }
}

// 把用户输入里的 LIKE 通配符转义掉，避免搜 "%" 把全表捞出来
function escapeLike(input) {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// 唯一索引冲突（email 重复）翻译成 409，而不是笼统的 500
function isDuplicateEmail(e) {
  return e?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(e?.message || '')
}

// 健康检查：同时检查 MySQL 是否连通
app.get('/api/hello', async (req, res) => {
  try {
    await testConnection()
    res.json({ message: '后端连通成功（Express + MySQL）', db: 'ok' })
  } catch (e) {
    logger.error({ event: 'health_db_down' }, e)
    res.status(500).json({ message: '后端在线但数据库连不上', db: 'down' })
  }
})

// 查询用户列表：支持搜索（?q=）与分页（?limit=&offset=）
app.get('/api/users', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)

    const where = q ? 'WHERE name LIKE ? OR email LIKE ?' : ''
    const like = q ? `%${escapeLike(q)}%` : ''
    const params = q ? [like, like] : []

    const [rows] = await pool.query(
      `SELECT id, name, email, created_at, updated_at FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    )
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users ${where}`, params)

    res.set('X-Total-Count', String(total))
    res.set('Access-Control-Expose-Headers', 'X-Total-Count')
    res.json(rows)
  } catch (e) {
    next(e)
  }
})

// 查询单个用户
app.get('/api/users/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ message: '用户不存在' })
    res.json(rows[0])
  } catch (e) {
    next(e)
  }
})

// 新增用户
app.post('/api/users', async (req, res, next) => {
  try {
    const { name, email } = req.body || {}
    const nameCheck = validateName(name)
    if (nameCheck.error) return res.status(400).json({ message: nameCheck.error })

    const mail = normalizeEmail(email)
    if (mail.error) return res.status(400).json({ message: mail.error })

    let result
    try {
      ;[result] = await pool.query('INSERT INTO users (name, email) VALUES (?, ?)', [
        nameCheck.value,
        mail.value ?? null,
      ])
    } catch (e) {
      if (isDuplicateEmail(e)) return res.status(409).json({ message: '这个邮箱已经被使用' })
      throw e
    }
    // 回读完整行，保证 POST 与 GET 的字段一致（含 created_at / updated_at）
    const [rows] = await pool.query(
      'SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?',
      [result.insertId]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    next(e)
  }
})

// 更新用户（部分字段更新，未传的字段保持不变）
app.put('/api/users/:id', async (req, res, next) => {
  try {
    const { name, email } = req.body || {}
    if (name === undefined && email === undefined) {
      return res.status(400).json({ message: '至少要提供 name 或 email' })
    }
    if (name !== undefined) {
      const nameCheck = validateName(name)
      if (nameCheck.error) return res.status(400).json({ message: nameCheck.error })
    }
    const mail = normalizeEmail(email)
    if (mail.error) return res.status(400).json({ message: mail.error })

    const sets = []
    const params = []
    if (name !== undefined) {
      sets.push('name = ?')
      params.push(validateName(name).value)
    }
    if (mail.provided) {
      sets.push('email = ?')
      params.push(mail.value)
    }
    params.push(req.params.id)

    let result
    try {
      ;[result] = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params)
    } catch (e) {
      if (isDuplicateEmail(e)) return res.status(409).json({ message: '这个邮箱已经被使用' })
      throw e
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: '用户不存在' })

    const [rows] = await pool.query(
      'SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?',
      [req.params.id]
    )
    res.json(rows[0])
  } catch (e) {
    next(e)
  }
})

// 删除用户
app.delete('/api/users/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ message: '用户不存在' })
    res.status(204).end()
  } catch (e) {
    next(e)
  }
})

// 统计信息（演示聚合查询）
app.get('/api/stats', async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT COUNT(*) AS userCount FROM users')
    res.json(row)
  } catch (e) {
    next(e)
  }
})

// 未匹配的路径统一返回 JSON，而不是 HTML 错误页
app.use((req, res) => {
  res.status(404).json({ message: '接口不存在', path: req.originalUrl })
})

// 兜底错误处理：客户端的错归客户端，服务端的错只记日志，不回显内部细节
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // 请求体太大（express.json 的 limit 触发）
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: '请求体过大（上限 100KB）' })
  }
  // 请求体不是合法 JSON
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({ message: '请求体必须是合法 JSON' })
  }
  logger.error({ event: 'unhandled_error', method: req.method, path: req.originalUrl }, err)
  res.status(500).json({ message: '服务器内部错误' })
})

export default app
