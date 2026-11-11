-- =====================================================================
-- Navigator Marine — initial database schema (Stage 1)
-- Target: Supabase (PostgreSQL 15+ with PostGIS)
--
-- Principles
--   1. Provenance: every row from an outside source records source + time.
--   2. Verification: nothing is "verified" unless a human or the business
--      confirmed it. Unverified contact details are never shown as verified.
--   3. Privacy: personal locations are private by default; row-level
--      security (RLS) enforces who can read what inside the database.
--   4. No hardcoded pricing: plans and prices live in tables.
-- =====================================================================

create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists citext;

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Shared types
-- ---------------------------------------------------------------------
create type app.verification_status as enum ('unverified', 'community_confirmed', 'business_confirmed', 'staff_verified');
create type app.share_audience as enum ('private', 'selected_people', 'friends', 'group', 'public');
create type app.vessel_category as enum ('sailing', 'motor_yacht', 'recreational_other', 'fishing', 'passenger_ferry', 'cargo', 'tanker', 'tug', 'military_law', 'pleasure_unknown', 'other', 'unknown');
create type app.position_source as enum ('ais_terrestrial', 'ais_satellite', 'own_receiver', 'app_gps', 'onboard_gateway', 'manual');
create type app.moderation_status as enum ('pending', 'approved', 'rejected', 'flagged');
create type app.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'expired');
create type app.billing_store as enum ('app_store', 'play_store', 'stripe', 'manual');

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------------
-- 1. People & access
-- ---------------------------------------------------------------------
create table app.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  handle        citext unique check (handle ~ '^[a-z0-9_]{3,30}$'),
  avatar_path   text,
  home_port     text,
  bio           text check (char_length(bio) <= 1000),
  units         jsonb not null default '{"distance":"nm","speed":"kn","depth":"ft","temp":"F"}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table app.roles (
  key         text primary key,           -- 'admin', 'moderator', 'support', 'finance', 'data_ops'
  description text not null
);

create table app.user_roles (
  user_id    uuid references app.profiles(id) on delete cascade,
  role_key   text references app.roles(key) on delete cascade,
  granted_by uuid references app.profiles(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role_key)
);

create table app.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references app.profiles(id),
  action      text not null,               -- e.g. 'business_claim.approve'
  entity_type text not null,
  entity_id   text not null,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index on app.audit_log (entity_type, entity_id);
create index on app.audit_log (actor_id, created_at desc);

create or replace function app.has_role(r text) returns boolean
language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.user_roles where user_id = auth.uid() and role_key in (r, 'admin'));
$$;

-- ---------------------------------------------------------------------
-- 2. Boats
-- ---------------------------------------------------------------------
create table app.boats (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references app.profiles(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 80),
  builder           text,
  model             text,
  year              smallint check (year between 1850 and 2100),
  length_m          numeric(6,2) check (length_m > 0),
  beam_m            numeric(6,2) check (beam_m > 0),
  draft_m           numeric(5,2) check (draft_m > 0),
  hull_type         text,                  -- monohull, catamaran, RIB...
  propulsion        text,                  -- sail, power, sail+aux
  mmsi              char(9) check (mmsi ~ '^[0-9]{9}$'),
  registration_no   text,                  -- shown only to owner/crew
  hailing_port      text,
  vessel_id         bigint,                -- link to AIS vessel if it has a transponder
  public_profile    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on app.boats (owner_id);

create table app.boat_members (
  boat_id    uuid references app.boats(id) on delete cascade,
  user_id    uuid references app.profiles(id) on delete cascade,
  role       text not null default 'crew' check (role in ('co_owner', 'captain', 'crew', 'service')),
  added_at   timestamptz not null default now(),
  primary key (boat_id, user_id)
);

create or replace function app.can_access_boat(b uuid) returns boolean
language sql stable security definer set search_path = app, public as $$
  select exists (select 1 from app.boats where id = b and owner_id = auth.uid())
      or exists (select 1 from app.boat_members where boat_id = b and user_id = auth.uid());
$$;

create table app.engines (
  id            uuid primary key default gen_random_uuid(),
  boat_id       uuid not null references app.boats(id) on delete cascade,
  position      text,                      -- port, starboard, main, generator
  make          text,
  model         text,
  serial_no     text,
  fuel          text check (fuel in ('diesel', 'gasoline', 'electric', 'other')),
  horsepower    numeric(6,1),
  hours_current numeric(8,1) not null default 0,
  created_at    timestamptz not null default now()
);

create table app.equipment (
  id           uuid primary key default gen_random_uuid(),
  boat_id      uuid not null references app.boats(id) on delete cascade,
  category     text not null,              -- electronics, safety, sails, rigging...
  name         text not null,
  make         text,
  model        text,
  serial_no    text,
  installed_on date,
  expires_on   date,                       -- flares, EPIRB battery, life raft service
  notes        text
);

create table app.boat_documents (
  id           uuid primary key default gen_random_uuid(),
  boat_id      uuid not null references app.boats(id) on delete cascade,
  kind         text not null check (kind in ('registration', 'documentation', 'insurance', 'survey', 'manual', 'receipt', 'other')),
  title        text not null,
  storage_path text not null,              -- private storage bucket
  expires_on   date,
  uploaded_by  uuid references app.profiles(id),
  created_at   timestamptz not null default now()
);

create table app.boat_photos (
  id           uuid primary key default gen_random_uuid(),
  boat_id      uuid not null references app.boats(id) on delete cascade,
  storage_path text not null,
  caption      text,
  sort_order   int not null default 0
);

-- ---------------------------------------------------------------------
-- 3. Boat upkeep
-- ---------------------------------------------------------------------
create table app.maintenance_tasks (
  id               uuid primary key default gen_random_uuid(),
  boat_id          uuid not null references app.boats(id) on delete cascade,
  engine_id        uuid references app.engines(id) on delete set null,
  title            text not null,
  interval_days    int check (interval_days > 0),
  interval_hours   numeric(8,1) check (interval_hours > 0),
  last_done_on     date,
  last_done_hours  numeric(8,1),
  next_due_on      date,
  active           boolean not null default true
);

create table app.service_records (
  id          uuid primary key default gen_random_uuid(),
  boat_id     uuid not null references app.boats(id) on delete cascade,
  task_id     uuid references app.maintenance_tasks(id) on delete set null,
  business_id uuid,                        -- FK added after businesses table
  performed_on date not null,
  engine_hours numeric(8,1),
  description text not null,
  cost_cents  bigint check (cost_cents >= 0),
  currency    char(3) default 'USD'
);

create table app.engine_hour_logs (
  id         bigint generated always as identity primary key,
  engine_id  uuid not null references app.engines(id) on delete cascade,
  hours      numeric(8,1) not null check (hours >= 0),
  logged_at  timestamptz not null default now(),
  source     text not null default 'manual' check (source in ('manual', 'onboard_gateway'))
);

create table app.fuel_logs (
  id           bigint generated always as identity primary key,
  boat_id      uuid not null references app.boats(id) on delete cascade,
  logged_on    date not null,
  volume_l     numeric(8,2) not null check (volume_l > 0),
  price_cents_per_l int,
  place_id     uuid,                       -- FK added after places table
  engine_hours numeric(8,1)
);

-- ---------------------------------------------------------------------
-- 4. Ships from AIS
-- ---------------------------------------------------------------------
create table app.data_providers (
  key          text primary key,           -- 'aisstream', 'spire', 'open_meteo', 'noaa_coops'
  kind         text not null check (kind in ('ais', 'weather', 'tides', 'charts', 'places', 'payments', 'other')),
  display_name text not null,
  enabled      boolean not null default false,
  priority     int not null default 100,   -- lower wins when sources overlap
  attribution  text,                       -- credit line required by licence
  config       jsonb not null default '{}',-- non-secret settings only; keys live in secrets manager
  updated_at   timestamptz not null default now()
);

create table app.vessels (
  id            bigint generated always as identity primary key,
  mmsi          char(9) unique check (mmsi ~ '^[0-9]{9}$'),
  imo           char(7) unique check (imo ~ '^[0-9]{7}$'),
  name          text,
  call_sign     text,
  category      app.vessel_category not null default 'unknown',
  ais_ship_type smallint,
  flag_iso2     char(2),
  length_m      numeric(6,1),
  beam_m        numeric(5,1),
  source        text references app.data_providers(key),
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index vessels_name_trgm on app.vessels using gin (name gin_trgm_ops);

-- Latest known position per vessel (small, hot table; also mirrored in Redis)
create table app.vessel_latest (
  vessel_id     bigint primary key references app.vessels(id) on delete cascade,
  geom          geography(Point, 4326) not null,
  sog_kn        numeric(5,1),
  cog_deg       numeric(4,1) check (cog_deg >= 0 and cog_deg < 360),
  heading_deg   smallint check (heading_deg between 0 and 359),
  nav_status    smallint,
  destination   text,
  eta_reported  timestamptz,
  source        app.position_source not null,
  provider      text references app.data_providers(key),
  reported_at   timestamptz not null,      -- when the ship sent it
  received_at   timestamptz not null default now()
);
create index vessel_latest_geom on app.vessel_latest using gist (geom);
create index on app.vessel_latest (reported_at);

-- Full history, one partition per day (created by a scheduled job).
-- Older partitions are exported to object storage and detached.
create table app.vessel_positions (
  vessel_id    bigint not null,
  reported_at  timestamptz not null,
  geom         geography(Point, 4326) not null,
  sog_kn       numeric(5,1),
  cog_deg      numeric(4,1),
  heading_deg  smallint,
  source       app.position_source not null,
  provider     text,
  is_interpolated boolean not null default false,  -- never true for stored raw data; reserved for derived tracks
  primary key (vessel_id, reported_at)
) partition by range (reported_at);
create index on app.vessel_positions using brin (reported_at);

create or replace function app.ensure_position_partition(d date) returns void
language plpgsql as $$
declare part text := format('vessel_positions_%s', to_char(d, 'YYYYMMDD'));
begin
  execute format('create table if not exists app.%I partition of app.vessel_positions for values from (%L) to (%L)',
                 part, d, d + 1);
end $$;

create table app.port_calls (
  id           bigint generated always as identity primary key,
  vessel_id    bigint not null references app.vessels(id) on delete cascade,
  port_name    text not null,
  port_locode  char(5),
  arrived_at   timestamptz,
  departed_at  timestamptz,
  detection    text not null default 'geofence' check (detection in ('geofence', 'provider'))
);
create index on app.port_calls (vessel_id, arrived_at desc);

-- ---------------------------------------------------------------------
-- 5. Your own tracking (phone GPS) and location sharing
-- ---------------------------------------------------------------------
create table app.voyages (
  id            uuid primary key default gen_random_uuid(),
  boat_id       uuid not null references app.boats(id) on delete cascade,
  started_by    uuid references app.profiles(id),
  title         text,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  distance_nm   numeric(8,2),
  max_sog_kn    numeric(5,1),
  audience      app.share_audience not null default 'private',
  notes         text,
  track         geography(LineString, 4326)  -- simplified line for fast display
);
create index on app.voyages (boat_id, started_at desc);

create table app.voyage_points (
  voyage_id   uuid not null references app.voyages(id) on delete cascade,
  recorded_at timestamptz not null,
  geom        geography(Point, 4326) not null,
  sog_kn      numeric(5,1),
  cog_deg     numeric(4,1),
  accuracy_m  numeric(6,1),
  source      app.position_source not null default 'app_gps',
  primary key (voyage_id, recorded_at)
);

create table app.location_shares (
  id           uuid primary key default gen_random_uuid(),
  boat_id      uuid not null references app.boats(id) on delete cascade,
  owner_id     uuid not null references app.profiles(id) on delete cascade,
  audience     app.share_audience not null default 'selected_people',
  viewer_id    uuid references app.profiles(id) on delete cascade,  -- for selected_people
  group_id     uuid,                                                 -- for group (later)
  delay_minutes int not null default 0 check (delay_minutes between 0 and 1440),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (audience <> 'selected_people' or viewer_id is not null)
);
create index on app.location_shares (viewer_id);

-- ---------------------------------------------------------------------
-- 6. Following & alerts
-- ---------------------------------------------------------------------
create table app.vessel_follows (
  user_id    uuid references app.profiles(id) on delete cascade,
  vessel_id  bigint references app.vessels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, vessel_id)
);

create table app.alert_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app.profiles(id) on delete cascade,
  vessel_id  bigint references app.vessels(id) on delete cascade,
  kind       text not null check (kind in ('departure', 'arrival', 'enters_area', 'leaves_area', 'stale_position', 'weather_threshold')),
  area       geography(Polygon, 4326),
  params     jsonb not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table app.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references app.profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  data       jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on app.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 7. Places (marinas, fuel docks, ramps, anchorages, restaurants...)
-- ---------------------------------------------------------------------
create table app.place_categories (
  key        text primary key,             -- 'marina', 'fuel_dock', 'pump_out', 'boat_ramp', 'anchorage', 'mooring_field', 'restaurant', ...
  parent_key text references app.place_categories(key),
  label      text not null,
  map_layer  text not null                 -- which map toggle shows it
);

create table app.places (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  primary_category text not null references app.place_categories(key),
  categories     text[] not null default '{}',
  geom           geography(Point, 4326) not null,
  address        text,
  region         text,                     -- for launch-region filtering
  phone          text,
  website        text,
  vhf_channel    text,
  facilities     jsonb not null default '{}', -- {"transient_slips":true,"max_loa_ft":120,"fuel":["diesel","gas"]...}
  verification   app.verification_status not null default 'unverified',
  verified_at    timestamptz,
  business_id    uuid,                     -- FK added after businesses
  is_osm_derived boolean not null default false, -- ODbL share-alike layer kept separate
  search_tsv     tsvector generated always as (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(address,''))) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index places_geom on app.places using gist (geom);
create index places_tsv on app.places using gin (search_tsv);
create index places_name_trgm on app.places using gin (name gin_trgm_ops);
create index on app.places (primary_category);

create table app.place_sources (
  id           bigint generated always as identity primary key,
  place_id     uuid not null references app.places(id) on delete cascade,
  provider     text not null,              -- 'osm', 'overture', 'state_ramp_list', 'business_claim', 'staff'
  external_id  text,
  licence      text not null,              -- 'ODbL-1.0', 'CDLA-Permissive-2.0', 'public-domain', 'owner-supplied'
  fetched_at   timestamptz not null default now(),
  raw          jsonb,
  unique (provider, external_id)
);

create table app.place_hours (
  place_id  uuid references app.places(id) on delete cascade,
  weekday   smallint check (weekday between 0 and 6),
  opens     time,
  closes    time,
  season    text,                          -- e.g. 'May15-Oct15'
  primary key (place_id, weekday, season)
);

create table app.place_photos (
  id           uuid primary key default gen_random_uuid(),
  place_id     uuid not null references app.places(id) on delete cascade,
  storage_path text not null,
  uploaded_by  uuid references app.profiles(id),
  licence      text not null default 'user-granted',
  moderation   app.moderation_status not null default 'pending'
);

-- ---------------------------------------------------------------------
-- 8. Businesses, claims, quotes, reviews, corrections
-- ---------------------------------------------------------------------
create table app.service_categories (
  key        text primary key,             -- 'diesel_mechanic', 'sailmaker', 'bottom_painting'...
  group_key  text not null,                -- 'mechanics', 'repair', 'electronics', 'boat_yards', 'sailing', 'other'
  label      text not null
);

create table app.businesses (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  hq_place_id     uuid references app.places(id) on delete set null,
  service_area    geography(MultiPolygon, 4326),
  phone           text,
  email           citext,
  website         text,
  verification    app.verification_status not null default 'unverified',
  claimed_by      uuid references app.profiles(id),
  claimed_at      timestamptz,
  plan_key        text,                    -- business plan, FK below
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on app.businesses using gist (service_area);

alter table app.places add constraint places_business_fk foreign key (business_id) references app.businesses(id) on delete set null;
alter table app.service_records add constraint service_records_business_fk foreign key (business_id) references app.businesses(id) on delete set null;
alter table app.fuel_logs add constraint fuel_logs_place_fk foreign key (place_id) references app.places(id) on delete set null;

create table app.business_services (
  business_id  uuid references app.businesses(id) on delete cascade,
  category_key text references app.service_categories(key),
  brands       text[] not null default '{}',   -- e.g. {'Volvo Penta','Yanmar'} for "services Volvo Penta"
  primary key (business_id, category_key)
);

create table app.business_claims (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references app.businesses(id) on delete cascade,
  claimant_id   uuid not null references app.profiles(id) on delete cascade,
  method        text not null check (method in ('phone_callback', 'email_domain', 'document', 'postcard')),
  evidence_path text,
  status        app.moderation_status not null default 'pending',
  reviewed_by   uuid references app.profiles(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table app.quote_requests (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references app.businesses(id) on delete cascade,
  requester_id uuid not null references app.profiles(id) on delete cascade,
  boat_id     uuid references app.boats(id) on delete set null,
  message     text not null check (char_length(message) <= 4000),
  status      text not null default 'new' check (status in ('new', 'viewed', 'responded', 'closed')),
  created_at  timestamptz not null default now()
);

create table app.reviews (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references app.profiles(id) on delete cascade,
  business_id uuid references app.businesses(id) on delete cascade,
  place_id    uuid references app.places(id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  body        text check (char_length(body) <= 4000),
  moderation  app.moderation_status not null default 'pending',
  created_at  timestamptz not null default now(),
  check ((business_id is not null) <> (place_id is not null))
);

create table app.corrections (
  id          uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references app.profiles(id) on delete cascade,
  entity_type text not null check (entity_type in ('place', 'business')),
  entity_id   uuid not null,
  field       text not null,
  proposed    jsonb not null,
  status      app.moderation_status not null default 'pending',
  reviewed_by uuid references app.profiles(id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 9. Routes, saved locations, weather & tides
-- ---------------------------------------------------------------------
create table app.routes (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references app.profiles(id) on delete cascade,
  boat_id     uuid references app.boats(id) on delete set null,
  name        text not null,
  planned_sog_kn numeric(4,1),
  audience    app.share_audience not null default 'private',
  created_at  timestamptz not null default now()
);

create table app.waypoints (
  route_id   uuid references app.routes(id) on delete cascade,
  seq        int not null,
  name       text,
  geom       geography(Point, 4326) not null,
  primary key (route_id, seq)
);

create table app.saved_locations (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null references app.profiles(id) on delete cascade,
  name      text not null,
  geom      geography(Point, 4326) not null,
  icon      text,
  notes     text
);

create table app.weather_cache (
  provider    text not null references app.data_providers(key),
  model       text not null,               -- 'gfs', 'ecmwf', 'icon'...
  cell_key    text not null,               -- rounded lat/lon grid key
  valid_from  timestamptz not null,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now(),
  primary key (provider, model, cell_key, valid_from)
);

create table app.tide_stations (
  id          text primary key,            -- NOAA station id
  provider    text not null references app.data_providers(key),
  name        text not null,
  geom        geography(Point, 4326) not null,
  kind        text not null check (kind in ('tide', 'current'))
);
create index on app.tide_stations using gist (geom);

-- ---------------------------------------------------------------------
-- 10. Money: plans, features, subscriptions, sponsored placement
-- ---------------------------------------------------------------------
create table app.plans (
  key         text primary key,            -- 'free', 'plus', 'pro', 'business', 'commercial'
  audience    text not null check (audience in ('consumer', 'business', 'commercial')),
  label       text not null,
  price_cents_monthly int check (price_cents_monthly >= 0),
  price_cents_yearly  int check (price_cents_yearly >= 0),
  store_product_ids jsonb not null default '{}',  -- {"app_store":"...","play_store":"...","stripe":"price_..."}
  active      boolean not null default true,
  sort_order  int not null default 0
);
alter table app.businesses add constraint businesses_plan_fk foreign key (plan_key) references app.plans(key);

create table app.plan_features (
  plan_key    text references app.plans(key) on delete cascade,
  feature_key text not null,               -- 'history_days', 'saved_vessels_max', 'boats_max', 'offline_charts'
  value       jsonb not null,              -- number, boolean, or object
  primary key (plan_key, feature_key)
);

create table app.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references app.profiles(id) on delete cascade,
  business_id   uuid references app.businesses(id) on delete cascade,
  plan_key      text not null references app.plans(key),
  status        app.subscription_status not null,
  store         app.billing_store not null,
  external_ref  text,                      -- RevenueCat / Stripe id
  current_period_end timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((user_id is not null) <> (business_id is not null))
);

create table app.sponsored_placements (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references app.businesses(id) on delete cascade,
  category_key text references app.service_categories(key),
  area        geography(Polygon, 4326),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  label       text not null default 'Sponsored' check (label in ('Sponsored', 'Ad')),  -- always visibly labelled
  check (ends_at > starts_at)
);

create table app.provider_usage (
  provider   text references app.data_providers(key),
  day        date not null,
  calls      bigint not null default 0,
  errors     bigint not null default 0,
  primary key (provider, day)
);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
create trigger t_profiles before update on app.profiles for each row execute function app.touch_updated_at();
create trigger t_boats before update on app.boats for each row execute function app.touch_updated_at();
create trigger t_places before update on app.places for each row execute function app.touch_updated_at();
create trigger t_businesses before update on app.businesses for each row execute function app.touch_updated_at();
create trigger t_vessels before update on app.vessels for each row execute function app.touch_updated_at();
create trigger t_subscriptions before update on app.subscriptions for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------
-- Geographic search helper: places near a point
-- ---------------------------------------------------------------------
create or replace function app.places_near(lat double precision, lon double precision, radius_nm double precision, category text default null, max_results int default 50)
returns table (id uuid, name text, primary_category text, distance_nm double precision, verification app.verification_status)
language sql stable as $$
  select p.id, p.name, p.primary_category,
         st_distance(p.geom, st_makepoint(lon, lat)::geography) / 1852.0 as distance_nm,
         p.verification
  from app.places p
  where st_dwithin(p.geom, st_makepoint(lon, lat)::geography, radius_nm * 1852.0)
    and (category is null or p.primary_category = category or category = any(p.categories))
  order by p.geom <-> st_makepoint(lon, lat)::geography
  limit least(max_results, 200);
$$;

-- ---------------------------------------------------------------------
-- Row-level security
-- Public reference data is readable by everyone; personal data only by
-- its owner, crew, or people it was explicitly shared with.
-- ---------------------------------------------------------------------
alter table app.profiles enable row level security;
alter table app.boats enable row level security;
alter table app.boat_members enable row level security;
alter table app.engines enable row level security;
alter table app.equipment enable row level security;
alter table app.boat_documents enable row level security;
alter table app.boat_photos enable row level security;
alter table app.maintenance_tasks enable row level security;
alter table app.service_records enable row level security;
alter table app.engine_hour_logs enable row level security;
alter table app.fuel_logs enable row level security;
alter table app.voyages enable row level security;
alter table app.voyage_points enable row level security;
alter table app.location_shares enable row level security;
alter table app.vessel_follows enable row level security;
alter table app.alert_rules enable row level security;
alter table app.notifications enable row level security;
alter table app.routes enable row level security;
alter table app.waypoints enable row level security;
alter table app.saved_locations enable row level security;
alter table app.subscriptions enable row level security;
alter table app.quote_requests enable row level security;
alter table app.reviews enable row level security;
alter table app.corrections enable row level security;
alter table app.business_claims enable row level security;
alter table app.audit_log enable row level security;
alter table app.user_roles enable row level security;
alter table app.places enable row level security;
alter table app.businesses enable row level security;
alter table app.vessels enable row level security;
alter table app.vessel_latest enable row level security;

-- Profiles: anyone signed in can see display names; only you edit yours
create policy profiles_read on app.profiles for select to authenticated using (true);
create policy profiles_write on app.profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Boats: owner and crew; public profiles visible to everyone (no registration number via view later)
create policy boats_owner on app.boats for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy boats_crew_read on app.boats for select to authenticated using (app.can_access_boat(id) or public_profile);
create policy boat_members_read on app.boat_members for select to authenticated using (app.can_access_boat(boat_id));
create policy boat_members_owner on app.boat_members for all to authenticated
  using (exists (select 1 from app.boats b where b.id = boat_id and b.owner_id = auth.uid()))
  with check (exists (select 1 from app.boats b where b.id = boat_id and b.owner_id = auth.uid()));

-- Boat child tables: anyone with access to the boat
create policy engines_boat on app.engines for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy equipment_boat on app.equipment for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy documents_boat on app.boat_documents for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy photos_boat on app.boat_photos for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy tasks_boat on app.maintenance_tasks for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy service_boat on app.service_records for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy fuel_boat on app.fuel_logs for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy hours_boat on app.engine_hour_logs for all to authenticated
  using (exists (select 1 from app.engines e where e.id = engine_id and app.can_access_boat(e.boat_id)))
  with check (exists (select 1 from app.engines e where e.id = engine_id and app.can_access_boat(e.boat_id)));

-- Voyages: crew always; others only if the voyage was shared publicly (social rules expand later)
create policy voyages_crew on app.voyages for all to authenticated using (app.can_access_boat(boat_id)) with check (app.can_access_boat(boat_id));
create policy voyages_public on app.voyages for select to authenticated using (audience = 'public');
create policy voyage_points_crew on app.voyage_points for all to authenticated
  using (exists (select 1 from app.voyages v where v.id = voyage_id and app.can_access_boat(v.boat_id)))
  with check (exists (select 1 from app.voyages v where v.id = voyage_id and app.can_access_boat(v.boat_id)));

-- Location shares: owner manages; a named viewer can see their own grant
create policy shares_owner on app.location_shares for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid() and app.can_access_boat(boat_id));
create policy shares_viewer on app.location_shares for select to authenticated using (viewer_id = auth.uid() and (expires_at is null or expires_at > now()));

-- Personal lists
create policy follows_own on app.vessel_follows for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy alerts_own on app.alert_rules for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_own on app.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_mark on app.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy routes_own on app.routes for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy routes_public on app.routes for select to authenticated using (audience = 'public');
create policy waypoints_route on app.waypoints for all to authenticated
  using (exists (select 1 from app.routes r where r.id = route_id and (r.owner_id = auth.uid() or r.audience = 'public')))
  with check (exists (select 1 from app.routes r where r.id = route_id and r.owner_id = auth.uid()));
create policy saved_own on app.saved_locations for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy subs_own on app.subscriptions for select to authenticated using (user_id = auth.uid() or app.has_role('finance'));

-- Public reference data: readable by anyone (anon + signed in); written only by staff/services
create policy places_read on app.places for select using (true);
create policy places_staff on app.places for all to authenticated using (app.has_role('data_ops')) with check (app.has_role('data_ops'));
create policy businesses_read on app.businesses for select using (true);
create policy businesses_owner on app.businesses for update to authenticated using (claimed_by = auth.uid() or app.has_role('data_ops')) with check (claimed_by = auth.uid() or app.has_role('data_ops'));
create policy vessels_read on app.vessels for select using (true);
create policy vessel_latest_read on app.vessel_latest for select using (true);

-- Reviews & corrections: approved reviews public; authors manage their own; moderators see all
create policy reviews_read on app.reviews for select using (moderation = 'approved' or author_id = auth.uid() or app.has_role('moderator'));
create policy reviews_write on app.reviews for insert to authenticated with check (author_id = auth.uid() and moderation = 'pending');
create policy reviews_moderate on app.reviews for update to authenticated using (app.has_role('moderator'));
create policy corrections_submit on app.corrections for insert to authenticated with check (submitted_by = auth.uid() and status = 'pending');
create policy corrections_read on app.corrections for select to authenticated using (submitted_by = auth.uid() or app.has_role('data_ops'));
create policy claims_submit on app.business_claims for insert to authenticated with check (claimant_id = auth.uid() and status = 'pending');
create policy claims_read on app.business_claims for select to authenticated using (claimant_id = auth.uid() or app.has_role('moderator'));
create policy quotes_requester on app.quote_requests for insert to authenticated with check (requester_id = auth.uid());
create policy quotes_read on app.quote_requests for select to authenticated
  using (requester_id = auth.uid() or exists (select 1 from app.businesses b where b.id = business_id and b.claimed_by = auth.uid()));

-- Admin-only
create policy audit_admin on app.audit_log for select to authenticated using (app.has_role('admin'));
create policy roles_admin on app.user_roles for all to authenticated using (app.has_role('admin')) with check (app.has_role('admin'));

-- ---------------------------------------------------------------------
-- Seed reference data (no fake business or vessel data, ever)
-- ---------------------------------------------------------------------
insert into app.roles (key, description) values
  ('admin', 'Full access'), ('moderator', 'Reviews, claims, photos'), ('support', 'User support'),
  ('finance', 'Subscriptions and revenue'), ('data_ops', 'Places, businesses, data providers');

insert into app.data_providers (key, kind, display_name, enabled, attribution) values
  ('aisstream', 'ais', 'aisstream.io (beta feed)', false, null),
  ('open_meteo', 'weather', 'Open-Meteo', false, 'Weather data by Open-Meteo.com (CC BY 4.0)'),
  ('noaa_nws', 'weather', 'NOAA National Weather Service', false, 'NOAA/NWS'),
  ('noaa_coops', 'tides', 'NOAA Tides & Currents', false, 'NOAA CO-OPS'),
  ('noaa_enc', 'charts', 'NOAA Electronic Navigational Charts', false, 'Source: NOAA Office of Coast Survey. Not for navigation.'),
  ('osm', 'places', 'OpenStreetMap', false, '© OpenStreetMap contributors (ODbL)');

insert into app.place_categories (key, parent_key, label, map_layer) values
  ('marina', null, 'Marina', 'marinas'), ('yacht_club', null, 'Yacht club', 'marinas'),
  ('mooring_field', null, 'Moorings', 'moorings'), ('anchorage', null, 'Anchorage', 'anchorages'),
  ('fuel_dock', null, 'Fuel dock', 'fuel'), ('pump_out', null, 'Pump-out', 'fuel'),
  ('boat_ramp', null, 'Boat ramp', 'marinas'), ('public_dock', null, 'Public dock', 'marinas'),
  ('boat_yard', null, 'Boat yard', 'services'), ('chandlery', null, 'Chandlery / supply store', 'services'),
  ('restaurant', null, 'Waterfront restaurant', 'destinations');

insert into app.service_categories (key, group_key, label) values
  ('diesel_mechanic','mechanics','Diesel mechanic'), ('gas_mechanic','mechanics','Gasoline engine mechanic'),
  ('outboard_mechanic','mechanics','Outboard mechanic'), ('generator','mechanics','Generator specialist'),
  ('transmission','mechanics','Transmission specialist'),
  ('fiberglass','repair','Fiberglass repair'), ('gelcoat','repair','Gelcoat repair'), ('welding','repair','Marine welding'),
  ('propeller','repair','Propeller repair'), ('hull','repair','Hull repair'), ('structural','repair','Structural repair'),
  ('marine_electrician','electronics','Marine electrician'), ('nav_electronics','electronics','Navigation electronics'),
  ('radar','electronics','Radar installation'), ('autopilot','electronics','Autopilot installation'),
  ('comms','electronics','Communications systems'), ('nmea','electronics','NMEA networking'),
  ('haul_out','boat_yards','Haul-out'), ('bottom_paint','boat_yards','Bottom painting'),
  ('winter_storage','boat_yards','Winter storage'), ('summer_storage','boat_yards','Summer storage'),
  ('refit','boat_yards','Refit'), ('maintenance','boat_yards','Maintenance'),
  ('sailmaker','sailing','Sailmaker'), ('rigging','sailing','Rigging'), ('mast','sailing','Mast services'),
  ('spar','sailing','Spar repair'), ('canvas','sailing','Canvas and upholstery'),
  ('detailing','other','Boat detailing'), ('fuel_delivery','other','Fuel delivery'), ('pump_out_service','other','Pump-out service'),
  ('towing','other','Towing'), ('salvage','other','Salvage'), ('diving','other','Diving'), ('survey','other','Marine survey'),
  ('broker','other','Yacht broker'), ('captain','other','Captain'), ('delivery','other','Yacht delivery'),
  ('insurance','other','Insurance'), ('marina_service','other','Marina'), ('chandler','other','Chandler'),
  ('equipment_store','other','Boat equipment store');

-- Plan rows exist so features can be configured; prices are left null until approved in the admin dashboard.
insert into app.plans (key, audience, label, sort_order) values
  ('free','consumer','Free',0), ('plus','consumer','Plus',1), ('pro','consumer','Pro',2),
  ('business','business','Business',3), ('commercial','commercial','Commercial',4);
