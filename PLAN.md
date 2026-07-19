# Tuneland: plan

Tuneland turns the Terrain idea (a song becomes a voxel world) into a
federated network of artist worlds. Every artist deploys their own world to
their own GitHub and their own Cloudflare account in a few clicks, worlds
link up at their corners into one connected map, and fans wander from world
to world hunting buried loot while the artist's music plays.

This document is the build plan. It is committed first, before the code, so
the shape of the system is reviewable on its own.

## The two repos

**`DhavalW/tuneland` (this repo)** is the artist world template. One copy of
it per artist, running on that artist's Cloudflare account:

- `public/` — the game a fan plays, plus the artist dashboard. Served as
  Workers static assets.
- `src/worker.js` — one Worker: the world's API (config, loot, claims,
  songs, presence) and its admin API.
- `wrangler.jsonc` — declares the assets, a D1 database, an R2 bucket and a
  presence Durable Object so the Deploy to Cloudflare flow can provision
  everything automatically.
- `.github/workflows/tuneland-sync.yml` — keeps the artist's copy up to date
  with this repo, automatically.

**`DhavalW/midhrami-website`** hosts the hub:

- `/tuneland/` — landing page: what Tuneland is, and a step-by-step walk
  through deploying a world (built for people who have never seen a
  terminal).
- `/tuneland/admin/` — the superuser console (see Superuser below).
- A small registry Worker under `/tuneland/api/` — the directory of
  registered worlds and the coordinator for corner links. The site stays a
  static-assets deploy; the Worker only handles `/tuneland/api/*` and passes
  everything else through to the assets.

## The artist's path, in a few clicks

Artists are not technical. The whole setup is:

1. Open midhrami.com/tuneland and press **Create your world**. That is a
   [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/DhavalW/tuneland)
   button. Cloudflare's flow signs them in (free account), connects GitHub
   (free account), copies this repo into their GitHub, provisions the D1
   database, R2 bucket and Durable Object from `wrangler.jsonc`, writes the
   new resource IDs into their copy's `wrangler.jsonc`, and deploys. From
   then on every push to their repo redeploys automatically (Workers
   Builds).
2. Open `https://<their-world>.workers.dev/dashboard/` and press **Claim
   this world**. First visitor gets the admin token (kept in their browser;
   a hash is kept in D1). The landing page tells them to do this right after
   deploying.
3. Fill in their name and world name, add songs, bury loot, press **Join the
   Tuneland map** to register with the hub.

No terminals, no config files, no secrets to paste.

## World model

A world is a 3×3 grid of areas, each 96×96 blocks (voxel columns up to 48
high), rendered as one continuous 288×288 landscape:

```
1 2 3        1,3,5,7 = corners (linkable arenas)
8 C 4        2,4,6,8 = the artist's outer areas
7 6 5        C       = the artist's home area
```

Corners are numbered 1, 3, 5, 7 clockwise from top-left, matching the
request. Internally areas are row-major indices 0..8 with compass names
(NW, N, NE, W, C, E, SW, S, SE).

**Linking.** An artist requests a link from one of their corners to another
registered world. The other artist approves it in their dashboard. A link
joins opposite corners (my NE is your SW), because geometrically the two
grids overlap diagonally at that tile. A linked corner is one shared common
arena: both artists can bury loot in it, and fans of both worlds meet in it.

**Determinism.** Terrain is a pure function of seed strings, using the same
`xmur3`/`mulberry32`/value-noise stack as Terrain and Shardfall:

- Own areas: seed = `world|<worldId>` (one continuous height function over
  the whole grid, so area borders inside a world are seamless).
- Linked corners: seed = `link|<idA>.<cornerA>|<idB>.<cornerB>` with the
  lexicographically smaller world id first. Both sides compute the corner
  from tile-local coordinates, so the shared arena is block-for-block
  identical from either world, even when the registry is unreachable. The
  corner blends into each world's own terrain over a margin inside the tile.

**Crossing worlds.** Inside a shared corner the two worlds' maps are the
same, so when a fan walks past the middle of the corner heading outward, the
client silently swaps its world context to the neighbor (fetches the
neighbor's config from the neighbor's own Worker, cross-origin) and rebuilds
the far chunks. The fan never sees a seam or a loading screen: the blocks
around them do not change. Flying and walking both cross the same way.

**Music models the terrain.** Tracks are uploaded in the dashboard to the
artist's own R2 bucket and served by their own Worker (`/api/songs/…`),
which satisfies "their songs served via their own CF". The dashboard
analyzes the audio in the artist's browser at upload time (same envelope
analysis as Terrain) and stores the envelope in D1. That stored envelope is
authoritative, so the geometry it drives is identical for every fan even
when audio fails to load: loud passages rise into ridges, quiet passages
sink into water valleys.

The artist picks the world's shape in the dashboard:

- **Concentric rings**: the first song is the innermost land, each next
  song a ring around it; walking outward from the center walks the
  discography in order.
- **Rectangular lanes**: each song gets its own north-to-south lane,
  adjacent west to east in order; walking south walks through the song.

Songs are ordered and colored per track in the dashboard. Whichever song's
ground a fan stands on is the song they hear, seeked to roughly that point
of the track. **Time markers**: every 30 seconds of song time is marked on
the land as a glowing stripe plus pylons carrying the time in floating
voxel digits (rings mark at the four compass points of each ring, lanes
gate each lane), and the HUD shows the song and position continuously.
Corner arenas stay outside the song mapping: they are neutral shared
ground, colored from the arena key so both sides of a link render them
identically. Tracks with no stored envelope get a deterministic
pseudo-envelope, and worlds with no tracks fall back to plain seeded hills.

**Rights.** Artists host these files on their own accounts, in public, so
the dashboard carries a copyright warning and a per-upload confirmation
that the artist holds the rights to the recording; the README and the hub
landing page repeat it.

## Fan gameplay

- **Walk and fly.** Shardfall's player physics (AABB per-axis resolve,
  joystick + drag look on phones, WASD + mouse on desktop). `F` or the HUD
  wing button toggles flying at any time: gravity off, Space/Shift (or
  on-screen buttons) for up/down.
- **Teleport.** Alt+click (long-press on phones) a spot in a neighboring
  area teleports the fan there, with a voxel-burst effect. Same DDA raycast
  as Shardfall's dig targeting.
- **Loot.** Artists bury loot boxes anywhere in their 9 areas and in shared
  corners. A loot box holds a title, a message, a link (new release, video)
  and/or a coupon code. Scarcity is by count (a claim limit), by time (an
  appears-at and/or disappears-at window), or both combined ("first 50
  fans during release weekend"). Positions come from the owning Worker;
  contents are only revealed on a claim call, which atomically re-checks
  every scarcity rule and decrements the count. When the limit is hit or
  the window closes, the box disappears for everyone. Fans dig (local, non-persistent edits) to
  uncover the chest, then open it.
- **Radar.** A Shardfall-style radar: hidden until a live loot box is within
  ~28 blocks, then a circular sweep pops up with a bearing blip and
  Geiger-style pings that speed up as the fan closes in.
- **Monsters.** Corner arenas (linked or not) have little voxel critters,
  deterministic from the arena seed, that wander and chase. Getting caught
  is cheap-fatal: screen shake, voxel burst, respawn at the arena edge.
  Home and edge areas are safe.
- **Friends.** A fan has a local identity (id + name in localStorage) and a
  friend code to share. Presence runs over a WebSocket to a hibernating
  Durable Object per area (shared corners use the lexicographically smaller
  world's hub so both sides meet). Fans in the same area see each other as
  name-tagged markers (10-second beacons, receive-light), and get a toast
  when a friend enters their area.
- **Persistence.** Terrain is deterministic; loot state lives in the owning
  artist's D1; a fan's found-loot log lives in their browser plus the claims
  table.

## Resilience

A linked world going down must not break anything:

- Linked-corner terrain needs no network (deterministic seed formula).
- Neighbor config, loot and links responses are cached in localStorage and
  reused when the neighbor is unreachable; a quiet "this world is asleep"
  chip shows instead of an error, loot claims for that world queue a retry.
- Every fetch has a timeout; the game plays fully solo if every API is dead
  (fan just can't claim loot or see friends until it recovers).
- The registry being down only pauses new registrations and link changes;
  play is unaffected because links are cached in each world's D1 and each
  client's localStorage.

## Auth

Three principals, no accounts anywhere:

- **Artist**: claim-token. First `POST /api/admin/claim` on a fresh world
  mints a random token; D1 stores its SHA-256; the browser keeps the token.
  All `/api/admin/*` calls take it as a Bearer token. Claiming requires
  accepting the artist agreement (midhrami.com/tuneland/agreement): the
  artist bears responsibility for the world's content and usage and
  indemnifies Midhrami. Acceptance is recorded (timestamp + version) in the
  world's D1 and again in the registry at registration, which refuses
  worlds that have not accepted. Pre-agreement worlds accept it from a
  dashboard banner before they can continue.
- **Superuser (Dhaval)**: an Ed25519 keypair generated in the
  `/tuneland/admin/` console (private key stays in that browser; export for
  backup). The public key is stored once in the registry via a
  one-time-setup endpoint guarded by an `ADMIN_SECRET` Dhaval sets on the
  midhrami Worker. Every artist Worker accepts `/api/admin/*` requests
  signed with that key (headers: timestamp + signature over
  method|path|body-hash|timestamp), verifying against the registry's
  published public key (cached in D1, 1-hour TTL). So the superuser can do
  everything an artist can, in any world, and artists configure nothing.
- **World ↔ registry**: at registration the registry hands the world a
  secret (stored hashed registry-side, plaintext in the world's D1). Link
  requests and heartbeats are authenticated with it. Registration is
  verified by the registry calling back `https://<origin>/api/world` and
  checking the world id matches, so you can only register a world you run.

## Cloudflare free tier budget

- Game, dashboard, landing: static assets — free, unlimited.
- Terrain, monsters, digging: client-side — free.
- D1 (per artist): a handful of rows; reads on world load (config + loot
  positions, one query each, indexed), writes only on claims and dashboard
  edits. Nowhere near 100k writes/day.
- R2: songs (10 GB free is hundreds of tracks); served through the Worker.
- Durable Objects (free plan, SQLite-backed): presence only, in-memory,
  hibernating WebSockets, join/leave plus 10-second beacons. The protocol
  is receive-light. If a world outgrows the free DO request budget the
  client degrades to solo play automatically — the same path as an outage.
- Registry D1: worlds + links, tiny.

## Auto-update of every artist world

`tuneland-sync.yml` runs daily (and on demand) in each artist's repo:

1. Clone `DhavalW/tuneland` main.
2. Overwrite the artist repo's tree with it, **except** `wrangler.jsonc`
   (holds their provisioned resource IDs) and `.github/workflows/` (GitHub
   tokens cannot push workflow changes).
3. Commit and push if anything changed. Workers Builds redeploys.
4. If nothing changed for ~50 days, touch a keepalive file so GitHub never
   disables the schedule.

Because every piece of artist state lives in Cloudflare (D1/R2), never in
the repo, the overwrite is always safe. Changes that need new bindings in
`wrangler.jsonc` are rare and will ship with a dashboard banner asking the
artist to press one "update" link (documented when it happens).

## API surfaces

Artist Worker (`https://<world>.workers.dev`):

```
GET  /api/world                    public config: id, name, artist, areas,
                                   tracks + envelopes, active links
GET  /api/loot?area=<key>          live loot positions for an area
POST /api/loot/claim               {lootId, fanId} -> contents | gone
GET  /api/songs/<key>              stream from R2
WS   /api/presence/<areaKey>       presence hub (Durable Object)
POST /api/admin/claim              first-claim of a fresh world
GET/PUT /api/admin/profile         name, artist, bio, world layout
POST /api/admin/tracks/reorder     song order (terrain order)
PUT  /api/admin/tracks/:id         song title and color
POST/DELETE /api/admin/tracks      upload song (+envelope) / remove
GET/POST/DELETE /api/admin/loot    manage loot (full contents + counts)
POST /api/admin/register           register/refresh with the hub
GET  /api/admin/links              own + incoming link requests (via hub)
POST /api/admin/links/request      ask another world for a corner link
POST /api/admin/links/respond      approve/decline an incoming request
```

Area keys: `own:<0..8>` for the world's own areas, and
`link|<idA>.<cA>|<idB>.<cB>` (canonical order) for shared corners.

Registry Worker (`https://midhrami.com/tuneland/api`):

```
POST /register                     callback-verified; issues world secret
POST /heartbeat                    world liveness
GET  /worlds                       public directory
GET  /links?world=<id>             public link list for a world
POST /links/request|respond        world-secret authenticated
GET  /super/pubkey                 the superuser public key
POST /super/init                   one-time, ADMIN_SECRET guarded
```

## Deployment notes for the hub (one-time, Dhaval only)

The registry needs a D1 database. To keep midhrami-website deploys green,
the D1 binding ships commented out in `wrangler.jsonc` with exact
instructions (`docs/tuneland-registry-setup.md`): create the database, paste
its id, uncomment, set `ADMIN_SECRET`, open `/tuneland/admin/` once to
generate and install the superuser key. Until then the registry answers 503
and every page and world degrades gracefully.

## Build order (this branch)

1. This plan.
2. Artist Worker + `wrangler.jsonc` (D1 auto-migrates on first request).
3. Game client.
4. Artist dashboard.
5. Sync workflow + artist-facing README.
6. Hub: registry Worker, landing page, admin console, docs, sitemap.
7. Verify (Playwright run of the game, `node --check` everywhere), push.

## Out of scope for v1 (noted for later)

- Live avatar movement smoother than 10-second beacons.
- Loot anti-cheat beyond per-fan claim uniqueness and rate limits (it is an
  arcade, not a bank).
- Custom domains for artist worlds (workers.dev is fine and free).
