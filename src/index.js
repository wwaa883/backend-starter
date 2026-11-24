import app from './app.js'
import { testConnection } from './db.js'
import { logger } from './logger.js'

const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
  logger.info({ event: 'server_start', port: Number(PORT) })
  try {
    await testConnection()
    logger.info({ event: 'db_connected' })
  } catch (e) {
    logger.error({ event: 'db_connect_failed' }, e)
  }
})
