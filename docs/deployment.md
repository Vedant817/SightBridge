# Deployment Guide

## Vercel frontend

SightBridge deploys the browser UI to Vercel from the monorepo root using `vercel.json`. The Vercel build is intentionally filtered to `@sightbridge/web...` so the frontend build does not install or compile the native mediasoup worker used by the separate SFU service.

The root `package.json` also declares `next`, `react`, and `react-dom` so Vercel's Next.js framework detection can identify the app version when the Vercel project Root Directory is the repository root. If you instead configure the Vercel project Root Directory to `apps/web`, keep the same environment variables below and let Vercel detect Next.js from `apps/web/package.json`.

Required Vercel environment variables:

- `NEXT_PUBLIC_API_URL`: public HTTPS URL of the API service.
- `NEXT_PUBLIC_MEDIA_URL`: public HTTPS/WSS URL of the media-server service.

## Free hosted database

Use Neon Postgres free tier for the production database:

- `DATABASE_URL`: Neon pooled connection string for the running API.
- `DIRECT_URL`: Neon direct/unpooled connection string for Prisma migrations.

Run migrations from the API service or a CI job:

```bash
pnpm --filter @sightbridge/api deploy:neon
```

## Realtime and media hosting

Vercel serverless functions are not suitable for the long-lived UDP/WebRTC media worker. Deploy these separately on a Node-capable host with UDP support, such as Fly.io, Render, Railway, a VPS, or a Kubernetes cluster:

- `apps/api`: long-running HTTP + Socket.IO process.
- `apps/media-server`: long-running mediasoup SFU with UDP ports `40000-40100` exposed.

Convex is a strong option for future managed realtime state and presence. The current code keeps realtime chat/presence in Socket.IO because the SFU and call session control already require long-lived processes; Neon is used as the free hosted durable database.
