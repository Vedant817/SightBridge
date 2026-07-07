# Deployment Guide

## Vercel frontend

SightBridge deploys the browser UI to Vercel using `vercel.json`. The Vercel build is intentionally filtered to `@sightbridge/web...` so the frontend build does not install or compile the native mediasoup worker used by the separate SFU service.

The root `package.json` also declares `next`, `react`, and `react-dom` so Vercel's Next.js framework detection can identify the app version when the Vercel project Root Directory is the repository root. If you instead configure the Vercel project Root Directory to `apps/web`, keep the same environment variables below and let Vercel detect Next.js from `apps/web/package.json`.

If the Vercel project Root Directory is `apps/api`, keep the Output Directory as `../web/.next`. Vercel resolves output paths relative to the configured Root Directory, so `apps/web/.next` would incorrectly resolve to `apps/api/apps/web/.next`.

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


## Production safety checks

When `NODE_ENV=production`, the API and media services fail fast if demo or localhost-only settings are still present:

- `SEED_AGENT_PASSWORD=password123` is blocked.
- Placeholder/localhost `JWT_SECRET` and `INVITE_SECRET` values are blocked.
- `ANNOUNCED_IP` is required and cannot be `127.0.0.1` or `localhost`.

Keep the default `agent@sightbridge.local` / `password123` credentials only for local development.

## TURN configuration

For restrictive NAT or firewall environments, run coturn or use a managed TURN provider and set:

- `TURN_URL`: comma-separated `turn:` / `turns:` URLs.
- `TURN_USERNAME`: TURN username.
- `TURN_PASSWORD`: TURN password.

The media server includes these values in the browser transport options so clients can relay media through TURN when direct UDP connectivity fails.

## Realtime and media hosting

Vercel serverless functions are not suitable for the long-lived UDP/WebRTC media worker. Deploy these separately on a Node-capable host with UDP support, such as Fly.io, Render, Railway, a VPS, or a Kubernetes cluster:

- `apps/api`: long-running HTTP + Socket.IO process.
- `apps/media-server`: long-running mediasoup SFU with UDP ports `40000-40100` exposed.

Convex is a strong option for future managed realtime state and presence. The current code keeps realtime chat/presence in Socket.IO because the SFU and call session control already require long-lived processes; Neon is used as the free hosted durable database.
