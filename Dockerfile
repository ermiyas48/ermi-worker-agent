FROM mcr.microsoft.com/playwright:v1.63.0-jammy
# Force Railway to rebuild from the Playwright runtime image.
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && node -e "console.log('Playwright runtime version:', require('playwright/package.json').version)"
COPY . .
ENV PROFILE_PATH=/data/profiles/chatgpt
ENV DATA_PATH=/data/state
ENV HEADLESS=false
ENV NODE_ENV=production
ENV PORT=3000
ENV STARTUP_SCRIPT=scripts/start-prod.sh
RUN mkdir -p /data/profiles/chatgpt /data/state /data/logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["bash","scripts/start-prod.sh"]
