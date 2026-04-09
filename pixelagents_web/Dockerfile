# PixelAgents Web container
# IMPORTANT: We must rebuild the UI bundle and vendor it into app/ui_dist at image-build time.
# Otherwise Azure Container Apps will keep serving stale JS assets even if backend code changes.

FROM node:20-bookworm-slim AS ui
WORKDIR /src

# Build UI
# Note: the repo vendors UI sources but they are not necessarily tracked by git.
# We copy the entire ui/ directory from the build context.
COPY ui ./ui
RUN cd ui && npm ci && npm run build

FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml /app/
RUN pip install --no-cache-dir -U pip \
  && pip install --no-cache-dir .

# Backend
COPY app /app/app

# Vendored UI build output
# ui build produces dist/webview/*, which we serve from app/ui_dist/
COPY --from=ui /src/ui/dist/webview /app/app/ui_dist

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8080"]
