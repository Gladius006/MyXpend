FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/app.js"]
