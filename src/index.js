import app from './app.js'
import { testConnection } from './db.js'

const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
  console.log(`后端已启动：http://localhost:${PORT}`)
  try {
    await testConnection()
    console.log('MySQL 连接成功')
  } catch (e) {
    console.error('MySQL 连接失败：', e.message)
  }
})
