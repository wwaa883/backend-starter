// 极简结构化日志：每行一个 JSON，方便直接被日志工具（Loki、CloudWatch 等）解析
// 不引第三方库，减少依赖面
function write(level, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const logger = {
  info: (fields) => write('info', fields),
  warn: (fields) => write('warn', fields),
  // 错误统一把 message/code/stack 序列化成字段，避免把整个 Error 对象打成 "[object Object]"
  error: (fields, err) =>
    write('error', {
      ...fields,
      ...(err
        ? {
            errMsg: err.message,
            errCode: err.code ?? null,
            stack: err.stack?.split('\n').slice(0, 6),
          }
        : {}),
    }),
}
