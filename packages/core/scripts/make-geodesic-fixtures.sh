set -e
PGBIN=/usr/lib/postgresql/16/bin; D=$(mktemp -d); P=55433
$PGBIN/initdb -D $D -U postgres >/dev/null; $PGBIN/pg_ctl -D $D -o "-p $P -k /tmp" -l $D/log start >/dev/null; sleep 2
psql -h /tmp -p $P -U postgres -qAt <<'SQL'
create extension postgis;
select setseed(0.42);
with pts as (
  select (random()*140-70) lat1, (random()*360-180) lon1, (random()*140-70) lat2, (random()*360-180) lon2 from generate_series(1,200)
  union all select 41.4901,-71.3128,41.1720,-71.5770   -- Newport RI area to Block Island area (approx.)
  union all select 41.0,-71.0,41.0,-70.99
  union all select 41.0,-71.0,41.0001,-71.0
)
select json_agg(json_build_object('p1',json_build_object('lat',lat1,'lon',lon1),'p2',json_build_object('lat',lat2,'lon',lon2),
  'distanceM', st_distance(st_makepoint(lon1,lat1)::geography, st_makepoint(lon2,lat2)::geography, true),
  'bearingDeg', degrees(st_azimuth(st_makepoint(lon1,lat1)::geography, st_makepoint(lon2,lat2)::geography))))
from pts;
SQL
$PGBIN/pg_ctl -D $D -m immediate stop >/dev/null
