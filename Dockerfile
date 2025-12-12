FROM oven/bun:1
WORKDIR /usr/src/app
COPY . .
RUN bun install
RUN bun run build
USER bun
CMD bun run start