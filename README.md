# Navigator Marine

One app. One map. Everything boating.

Monorepo for the Navigator Marine iPhone, Android and web apps, admin dashboard, data workers and database.

## Layout

| Folder | What it is | Status |
| --- | --- | --- |
| `apps/mobile` | iPhone + Android app (React Native + Expo) | Stage 2 |
| `apps/web` | Public web app (Next.js) | Stage 2 |
| `apps/admin` | Admin dashboard (Next.js) | Stage 8 |
| `packages/core` | Shared types, data-provider interfaces, navigation math | Started, tested |
| `packages/design-tokens` | Colors, type, spacing, touch sizes | First draft |
| `services/ingest` | AIS / weather / tide ingestion workers | Stage 4 |
| `supabase/migrations` | Database schema (Postgres + PostGIS) | Started, tested |
| `docs/` | Architecture decisions and data rules | Started |

## Running the tests

```bash
pnpm install
pnpm test            # shared code (navigation math, AIS validation, freshness)
pnpm test:db         # loads the schema into a throwaway Postgres + PostGIS and checks privacy rules
```

## Ground rules (from the product brief)

- No fake data presented as real. Unverified data is labelled. Stale AIS positions are labelled stale.
- Navigation features are planning aids, not certified navigation equipment.
- Personal locations are private by default.
- Secrets never ship in client code; see `.env.example`.
- Sponsored listings are always labelled.
- Prices live in the database, not in code.
