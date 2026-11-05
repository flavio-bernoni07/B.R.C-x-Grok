# The dashboard, on a machine that is not the demo laptop.
# linux/amd64: Cloudflare Containers only run that architecture.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY . .

WORKDIR /app/agent-core
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm install --frozen-lockfile \
  && pnpm exec next build apps/web

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["pnpm", "exec", "next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", "3000"]
