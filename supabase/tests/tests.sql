-- Schema tests. Each block raises an exception on failure.
grant usage on schema app to authenticated, anon;
grant select, insert, update, delete on all tables in schema app to authenticated;
grant select on app.places, app.vessels, app.vessel_latest, app.businesses to anon;
grant execute on all functions in schema app to authenticated, anon;

-- Two users
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.test');
insert into app.profiles (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'Bob');
insert into app.boats (id, owner_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Test Boat A');
insert into app.voyages (boat_id, started_at) values ('aaaaaaaa-0000-0000-0000-000000000001', now());

-- TEST 1: privacy — Bob cannot see Alice's private boat or voyage
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$ begin
  if (select count(*) from app.boats) <> 0 then raise exception 'FAIL: Bob can see Alice''s boat'; end if;
  if (select count(*) from app.voyages) <> 0 then raise exception 'FAIL: Bob can see Alice''s voyage'; end if;
  raise notice 'PASS 1: private boats and voyages hidden from other users';
end $$;

-- TEST 2: Bob cannot write a boat owned by Alice
do $$ begin
  begin
    insert into app.boats (owner_id, name) values ('11111111-1111-1111-1111-111111111111', 'Spoof');
    raise exception 'FAIL: Bob inserted a boat for Alice';
  exception when insufficient_privilege then
    raise notice 'PASS 2: cannot create records as another user';
  end;
end $$;

-- TEST 3: Alice sees her own boat
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$ begin
  if (select count(*) from app.boats) <> 1 then raise exception 'FAIL: Alice cannot see her boat'; end if;
  raise notice 'PASS 3: owner sees own boat';
end $$;

-- TEST 4: Alice adds Bob as crew -> Bob can see the boat
insert into app.boat_members (boat_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$ begin
  if (select count(*) from app.boats) <> 1 then raise exception 'FAIL: crew cannot see boat'; end if;
  raise notice 'PASS 4: invited crew can see boat';
end $$;

reset role;

-- TEST 6: geographic search distance is correct.
-- Two test points (not real businesses) 1 degree of latitude apart on the same meridian.
-- 1 degree of latitude near 41N is ~60.0 nm (WGS84: ~111,050 m / 1852 = 59.96 nm).
insert into app.places (name, primary_category, geom) values
  ('TEST POINT ORIGIN', 'marina', st_makepoint(-71.0, 41.0)::geography),
  ('TEST POINT NORTH',  'marina', st_makepoint(-71.0, 42.0)::geography);
do $$ declare d double precision; begin
  select distance_nm into d from app.places_near(41.0, -71.0, 100) where name = 'TEST POINT NORTH';
  if d is null or abs(d - 59.96) > 0.1 then raise exception 'FAIL: distance % nm, expected ~59.96', d; end if;
  if (select count(*) from app.places_near(41.0, -71.0, 30)) <> 1 then raise exception 'FAIL: radius filter'; end if;
  raise notice 'PASS 6: 1 degree latitude = % nm; radius filter works', round(d::numeric, 2);
end $$;

-- TEST 7: anonymous visitors can read public places but not boats
set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  if (select count(*) from app.places) <> 2 then raise exception 'FAIL: anon cannot read places'; end if;
  begin
    perform 1 from app.boats;
    raise exception 'FAIL: anon read boats';
  exception when insufficient_privilege then
    raise notice 'PASS 7: public places readable, boats not';
  end;
end $$;
reset role;

-- TEST 8: daily partitions for ship history
select app.ensure_position_partition('2026-11-11');
insert into app.vessels (mmsi, name) values ('367000001', 'TEST VESSEL');
insert into app.vessel_positions (vessel_id, reported_at, geom, source)
  select id, '2026-11-11 12:00Z', st_makepoint(-71.3, 41.5)::geography, 'ais_terrestrial' from app.vessels;
do $$ begin
  if (select count(*) from app.vessel_positions_20261111) <> 1 then raise exception 'FAIL: partition routing'; end if;
  raise notice 'PASS 8: ship positions land in daily partition';
end $$;

-- TEST 9: bad identifiers are rejected
do $$ begin
  begin insert into app.vessels (mmsi) values ('12345'); raise exception 'FAIL: short MMSI accepted';
  exception when check_violation then raise notice 'PASS 9: invalid MMSI rejected'; end;
end $$;

-- TEST 10: sponsored placements must carry a visible label
do $$ begin
  begin
    insert into app.businesses (id, name) values ('bbbbbbbb-0000-0000-0000-000000000001', 'TEST BUSINESS');
    insert into app.sponsored_placements (business_id, starts_at, ends_at, label)
      values ('bbbbbbbb-0000-0000-0000-000000000001', now(), now() + interval '1 day', 'Featured');
    raise exception 'FAIL: unlabeled sponsorship accepted';
  exception when check_violation then raise notice 'PASS 10: sponsored listings must be labeled';
  end;
end $$;
