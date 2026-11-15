FROM docker.io/library/node:24-bookworm-slim AS app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_CHECK_IN_ENABLED
RUN npm run build:staging
USER node
EXPOSE 3001
# Exec form with node itself as PID 1: npm would swallow SIGTERM before the drain handler in main.ts ran.
CMD ["node", "--import", "tsx", "server/main.ts"]

FROM docker.io/library/nginx:1.27-alpine AS web
COPY --from=app /app/build /usr/share/nginx/html
RUN mv /usr/share/nginx/html/security-headers.conf /etc/nginx/security-headers.conf
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx
COPY containers/nginx.conf /etc/nginx/templates/nginx.conf.template
