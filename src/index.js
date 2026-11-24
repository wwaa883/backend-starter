import app from './app.js'
import { pool, testConnection } from './db.js'
import { logger } from './logger.js'

const PORT = process.env.PORT || 3000

const server = app.listen(PORT, async () => {
  logger.info({ event: 'server_start', port: Number(PORT) })
  try {
    await testConnection()
    logger.info({ event: 'db_connected' })
  } catch (e) {
    logger.error({ event: 'db_connect_failed' }, e)
  }
})

// 收到 Ctrl+C / 容器 stop 时先停止接新请求，再关连接池，避免连接泄漏
let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  logger.info({ event: 'shutdown_start', signal })

  const forceExit = setTimeout(() => {
    logger.warn({ event: 'shutdown_timeout' })
    process.exit(1)
  }, 5000)
  forceExit.unref()

  server.close(async () => {
    try {
      await pool.end()
      logger.info({ event: 'shutdown_done' })
      process.exit(0)
    } catch (e) {
      logger.error({ event: 'shutdown_error' }, e)
      process.exit(1)
    }
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// 兜底：异步里漏掉的异常至少留下可查的日志，而不是静默退出
process.on('unhandledRejection', (reason) => {
  logger.error({ event: 'unhandled_rejection' }, reason)
})
process.on('uncaughtException', (err) => {
  logger.error({ event: 'uncaught_exception' }, err)
  shutdown('uncaughtException')
})
