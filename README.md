# MobiWave Signature Manager

Production architecture: **React/Vite on Vercel + Vercel serverless API + Neon PostgreSQL + Drizzle + existing MobiWave mail/Roundcube infrastructure**.

## What is implemented
- React + TypeScript + Vite frontend.
- Vercel-native catch-all API function under `api/[[...route]].ts`.
- Neon PostgreSQL via Drizzle ORM.
- CRUD API for core management resources.
- Signature rendering with safe email HTML and duplicate markers.
- Sender/employee signature resolution with policy controls.
- Gateway authentication and fail-open contract.
- Health and gateway verification endpoints.
- Initial MobiWave seed data.
- No SMTP credentials or message bodies are stored by the application.

## Deploy
1. Create a Neon PostgreSQL database and copy its pooled connection string into `DATABASE_URL`.
2. Set `SIGNATURE_GATEWAY_API_KEY` in Vercel Production and Preview environments.
3. Deploy this repository as a Vercel project. Build command is `npm run build`; output is `frontend/dist`.
4. Run `npm run db:push` once against Neon, then `npm run db:seed`.

## Mail gateway
Vercel is the control/API plane. **Do not point SMTP at Vercel.** Keep Roundcube/Postfix/Exim as the mail system. A lightweight gateway/milter calls:

`POST /api/signatures/resolve`

with `x-signature-gateway-key` and JSON containing `organizationId`, `sender`, `messageType`, and `bodyHtml`. If the API is unavailable, the gateway should send the original message unchanged.

Recommended gateway cache: sender + organization + signature version, with short TTL and invalidation/refresh through heartbeat or configuration changes. Do not send SMTP passwords or full message archives to the API.

## Local development
```bash
npm install
cp .env.example .env
npm run db:push
npm run db:seed
npm run dev
```

Frontend: `http://localhost:5173`  
API: `http://localhost:8080`
