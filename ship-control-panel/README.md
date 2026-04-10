# Ship Control Panel (Next.js demo)

Nautical-themed demo control panel with a simple hardcoded login gate.

## Credentials (demo-only)
- username: `administrator`
- password: `controlpanel123`

## Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Build

```bash
npm run build
npm run start
```

## Container build (Azure Container Apps)

```bash
docker build -t ship-control-panel:local .
docker run --rm -p 3000:3000 ship-control-panel:local
```

Notes:
- `next.config.js` sets `output: 'standalone'` for container deployment.
- Auth is intentionally minimal for demos; do not use this pattern for production.
