FROM node:22.23.2-bookworm-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/attendance.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node ops ./ops
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
