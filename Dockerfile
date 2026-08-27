# Railway builds this instead of guessing with nixpacks. Nixpacks was detecting
# the Vite output as a static site and adding a Caddy phase, and its generated
# Dockerfile installed dependencies twice, which collided with Railway's build
# cache mount. This is explicit and does the same thing every time.
#
# Delete this file to fall back to nixpacks.

# ---------------------------------------------------------------- build stage
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first, so a change to application code does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci

# The front end is compiled here, where the dev dependencies (Vite) exist.
COPY vite.config.js index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
RUN npm run build

# -------------------------------------------------------------- runtime stage
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. Vite and its plugins stay behind in the build
# stage; the server never imports them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist

# Run as a non-root user. node:22-slim ships a `node` user for exactly this.
USER node

# Railway injects PORT; this is only the default for running the image locally.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
