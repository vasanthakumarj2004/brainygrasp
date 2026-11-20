FROM nginx:stable-alpine
COPY deploy/nginx/frontend.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /usr/share/nginx/html/
COPY admin/ /usr/share/nginx/html/admin/
# Preserve legacy /frontend/... URLs without duplicating files.
RUN ln -s /usr/share/nginx/html /usr/share/nginx/html/frontend
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1
