# Thoth container image. No npm dependencies, so no install step.
#   docker build -t thoth .
#   docker run -d --name thoth --restart unless-stopped -p 3000:3000 -v thoth-app:/app thoth
# Or use docker-compose.yml.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    THOTH_SELF_RESTART=1

WORKDIR /app
# The app must own its folder so it can install updates; run as the image's unprivileged "node" user.
RUN chown node:node /app
COPY --chown=node:node . .
USER node

EXPOSE 3000
# /app is a volume so installed updates survive container re-creation (see README).
VOLUME ["/app"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node runs as PID 1: it handles SIGTERM itself (graceful stop) and exits after a server-code
# update, which the restart policy turns into a restart with the new code.
CMD ["node", "server.js"]
