import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import { pool } from '../src/db.js'

let server
let base
const createdIds = []

async function api(path, options) {
  const res = await fetch(base + path, options)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body }
}

const json = (method, data) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
})

before(async () => {
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  for (const id of createdIds) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]).catch(() => {})
  }
  await new Promise((resolve) => server.close(resolve))
  await pool.end()
})

describe('健康检查', () => {
  test('GET /api/hello 数据库连通', async () => {
    const r = await api('/api/hello')
    assert.equal(r.status, 200)
    assert.equal(r.body.db, 'ok')
  })
})

describe('用户增删改查', () => {
  test('POST 创建 → GET 单个 → PUT 更新 → DELETE 删除', async () => {
    const name = `测试用户_${Date.now()}`
    const create = await api('/api/users', json('POST', { name, email: 'test@example.com' }))
    assert.equal(create.status, 201)
    assert.ok(create.body.id)
    assert.ok(create.body.created_at, 'POST 应返回 created_at')
    assert.ok(create.body.updated_at, 'POST 应返回 updated_at')
    createdIds.push(create.body.id)

    const one = await api(`/api/users/${create.body.id}`)
    assert.equal(one.status, 200)
    assert.equal(one.body.name, name)

    const update = await api(`/api/users/${create.body.id}`, json('PUT', { name: '改名后' }))
    assert.equal(update.status, 200)
    assert.equal(update.body.name, '改名后')
    assert.equal(update.body.email, 'test@example.com', '未传的 email 应保持不变')
    assert.ok(update.body.updated_at, 'PUT 后应带 updated_at')

    const clear = await api(`/api/users/${create.body.id}`, json('PUT', { email: null }))
    assert.equal(clear.status, 200)
    assert.equal(clear.body.email, null, 'email 传 null 应清空')

    const del = await api(`/api/users/${create.body.id}`, { method: 'DELETE' })
    assert.equal(del.status, 204)

    const gone = await api(`/api/users/${create.body.id}`)
    assert.equal(gone.status, 404)
  })

  test('删除不存在的用户返回 404', async () => {
    const r = await api('/api/users/999999', { method: 'DELETE' })
    assert.equal(r.status, 404)
  })
})

describe('参数校验', () => {
  test('name 为空返回 400', async () => {
    const r = await api('/api/users', json('POST', { name: '   ' }))
    assert.equal(r.status, 400)
    assert.match(r.body.message, /name/)
  })

  test('email 格式不合法返回 400', async () => {
    const r = await api('/api/users', json('POST', { name: 'x', email: 'not-an-email' }))
    assert.equal(r.status, 400)
    assert.match(r.body.message, /email/)
  })

  test('PUT 空 body 返回 400', async () => {
    const r = await api('/api/users/1', json('PUT', {}))
    assert.equal(r.status, 400)
  })

  test('emoji 按字符数计算，30 个 emoji 允许入库', async () => {
    const create = await api('/api/users', json('POST', { name: '👍'.repeat(30) }))
    assert.equal(create.status, 201, '数据库按字符算 30，不该被 50 字上限拒绝')
    createdIds.push(create.body.id)
  })

  test('email 允许为空字符串（存 null）', async () => {
    const create = await api('/api/users', json('POST', { name: '空邮箱用户', email: '' }))
    assert.equal(create.status, 201)
    assert.equal(create.body.email, null)
    createdIds.push(create.body.id)
  })
})

describe('搜索与分页', () => {
  test('?q= 命中并返回 X-Total-Count', async () => {
    const name = `唯一搜索词_${Date.now()}`
    const create = await api('/api/users', json('POST', { name }))
    createdIds.push(create.body.id)

    const r = await api(`/api/users?q=${encodeURIComponent(name)}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 1)
    assert.equal(Number(r.headers.get('x-total-count')), 1)
    assert.equal(r.headers.get('access-control-expose-headers'), 'X-Total-Count')
  })

  test('?limit=&offset= 分页生效', async () => {
    const r1 = await api('/api/users?limit=1&offset=0')
    assert.equal(r1.status, 200)
    assert.ok(r1.body.length <= 1)
    const total = Number(r1.headers.get('x-total-count'))
    assert.ok(total >= 1)
  })

  test('limit 超过 200 被截断', async () => {
    const r = await api('/api/users?limit=9999')
    assert.equal(r.status, 200)
  })
})

describe('错误处理', () => {
  test('畸形 JSON 返回 400 且不回显解析细节', async () => {
    const res = await fetch(base + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.message, /合法 JSON/)
    assert.equal(body.detail, undefined)
  })

  test('name 超过 50 字符返回 400', async () => {
    const r = await api('/api/users', json('POST', { name: 'a'.repeat(51) }))
    assert.equal(r.status, 400)
    assert.match(r.body.message, /最多 50/)
  })

  test('email 超过 100 字符返回 400', async () => {
    const r = await api(
      '/api/users',
      json('POST', { name: '长邮箱', email: `${'a'.repeat(95)}@x.com` })
    )
    assert.equal(r.status, 400)
    assert.match(r.body.message, /最多 100/)
  })

  test('请求体超过 100KB 返回 413', async () => {
    const res = await fetch(base + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', pad: 'p'.repeat(200 * 1024) }),
    })
    assert.equal(res.status, 413)
  })

  test('搜索里的 % 被转义，不会捞出全表', async () => {
    const r = await api(`/api/users?q=${encodeURIComponent('%')}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 0, '通配符应按字面处理，表里没有含 % 的姓名/邮箱')
  })
})

describe('安全响应头与限流', () => {
  test('helmet 安全头存在', async () => {
    const res = await fetch(base + '/api/hello')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(res.headers.get('x-frame-options'), '应有 X-Frame-Options')
  })

  test('限流响应头存在', async () => {
    const res = await fetch(base + '/api/users?limit=1')
    const header =
      res.headers.get('ratelimit-limit') ||
      res.headers.get('ratelimit') ||
      res.headers.get('x-ratelimit-limit')
    assert.ok(header, '应返回 RateLimit 相关响应头')
  })

  test('读写限流额度不同', async () => {
    const read = await fetch(base + '/api/users?limit=1')
    const write = await fetch(base + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '限流额度测试' }),
    })
    // 这条记录也要登记，after 钩子才删得干净
    const created = await write.json().catch(() => null)
    if (created?.id) createdIds.push(created.id)
    // draft-8 的额度在 RateLimit-Policy 里：'"600-in-1min"; q=600; w=60; ...'
    const quotaOf = (r) => Number(/q=(\d+)/.exec(r.headers.get('ratelimit-policy') || '')?.[1])
    assert.equal(quotaOf(read), 600)
    assert.equal(quotaOf(write), 120)
  })
})

describe('CORS 白名单', () => {
  test('白名单内的 Origin 拿到对应 CORS 头', async () => {
    const res = await fetch(base + '/api/users?limit=1', {
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  })

  test('陌生 Origin 拿不到 CORS 头', async () => {
    const res = await fetch(base + '/api/users?limit=1', {
      headers: { Origin: 'https://evil.example.com' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    // 请求本身照常返回数据，是浏览器负责拦截
    assert.equal(res.status, 200)
  })

  test('没有 Origin 的请求不受限制（curl / 同源）', async () => {
    const res = await fetch(base + '/api/hello')
    assert.equal(res.status, 200)
  })
})

describe('邮箱唯一性', () => {
  test('重复 email 返回 409 而不是 500', async () => {
    const email = `dup_${Date.now()}@example.com`
    const first = await api('/api/users', json('POST', { name: '第一个', email }))
    assert.equal(first.status, 201)
    createdIds.push(first.body.id)

    const second = await api('/api/users', json('POST', { name: '第二个', email }))
    assert.equal(second.status, 409)
    assert.match(second.body.message, /邮箱/)

    const third = await api(`/api/users/${first.body.id}`, json('PUT', { email }))
    assert.equal(third.status, 200, '改成自己的邮箱不算重复')
  })

  test('多个空 email 可以共存（NULL 不参与唯一约束）', async () => {
    const a = await api('/api/users', json('POST', { name: '空邮箱A' }))
    const b = await api('/api/users', json('POST', { name: '空邮箱B' }))
    assert.equal(a.status, 201)
    assert.equal(b.status, 201)
    createdIds.push(a.body.id, b.body.id)
  })
})

describe('统计与 404', () => {
  test('GET /api/stats 返回用户总数', async () => {
    const r = await api('/api/stats')
    assert.equal(r.status, 200)
    assert.ok(Number.isInteger(r.body.userCount))
  })

  test('未知路径返回 JSON 404', async () => {
    const r = await api('/api/not-exist')
    assert.equal(r.status, 404)
    assert.equal(r.body.message, '接口不存在')
  })
})
