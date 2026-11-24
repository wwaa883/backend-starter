FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production

# 先只拷依赖清单，利用镜像层缓存；npm ci 保证按 lockfile 装，版本可复现
COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src

ENV PORT=3000
EXPOSE 3000

# 不要用 root 跑业务进程
USER node

CMD ["node", "src/index.js"]
