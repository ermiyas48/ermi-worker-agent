FROM mcr.microsoft.com/playwright:v1.48.0-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV PROFILE_PATH=/data/profiles/chatgpt
ENV DATA_PATH=/data/state
ENV HEADLESS=true
ENV NODE_ENV=production
ENV PORT=3000
RUN mkdir -p /data/profiles/chatgpt /data/state /data/logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
