# ADR-0001: Core architecture

Status: Proposed (awaiting owner approval) · 2026-11-11

## Decision

- TypeScript everywhere; pnpm + Turborepo monorepo.
- Mobile: React Native + Expo (iPhone first). Web and admin: Next.js.
- Maps: Mapbox SDKs behind a thin wrapper so MapLibre can replace it.
- Database: Supabase Postgres + PostGIS; row-level security for privacy.
- Live data: separate Node.js ingest workers (AIS stream, weather, tides) writing to Postgres; latest ship positions mirrored in Redis.
- Ship history: daily partitions; partitions older than the plan's history window exported to object storage (Parquet) and detached.
- Payments: RevenueCat for in-app subscriptions; Stripe for web and business plans.

## Why

Mainstream, hireable, and every component is open source or replaceable, so the code, data and infrastructure stay under the company's control.

## Reversibility

- Supabase → self-hosted Supabase or plain Postgres: moderate effort, no data loss.
- Mapbox → MapLibre: moderate effort (styles and offline packs need rework).
- AIS/weather suppliers: low effort by design (provider interfaces in `packages/core`).

## Open questions

See "Decisions that need your approval" in the Stage 1 Technical Plan.
