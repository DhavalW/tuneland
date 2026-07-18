# Tuneland

Your music, as a place. Tuneland turns your songs into a voxel world your
fans can walk, fly and dig through. You bury real loot for them: links to a
new release, coupon codes, notes. Your world can link corners with other
artists' worlds, so fans wander from your land straight into theirs.

Your world runs on **your own** free Cloudflare account and **your own**
GitHub account. Nobody else holds your music or your data.

## Get your world (no coding, about five minutes)

1. **Press the button.**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DhavalW/tuneland)

   It signs you into Cloudflare (make a free account if you don't have one),
   connects GitHub (same), copies this project into your GitHub, sets up the
   storage your world needs, and deploys. Accept the defaults and press
   deploy.

2. **Claim your world.** When the deploy finishes you get a link like
   `https://tuneland-world.YOURNAME.workers.dev`. Open it, tap **Artist
   dashboard**, then **Claim this world**. Do this right away, from your own
   phone or computer: the first person to claim a world owns it.

3. **Make it yours.** In the dashboard: name your world, upload songs, color
   your areas, bury loot, then press **Join the Tuneland map** so fans and
   other artists can find you.

Full walkthrough with pictures: https://midhrami.com/tuneland/

## What your fans get

- A 3 by 3 grid of land: your home stage in the middle, fields around it,
  arenas in the corners. Every area can play a different song of yours.
- Walking, flying (press F or the wing button), digging, and teleporting to
  the next area with alt+click (long-press on phones).
- A radar that wakes up near buried loot and pings faster as they close in.
- Little monsters (glooms) in the arenas to dodge.
- Friends: fans swap friend codes and get a heads-up when a friend is in
  the same area.
- Crossing: if you link a corner with another artist, fans walk from your
  world into theirs with no loading screen.

## Updates

Your copy updates itself. Once a day it checks the main Tuneland project
and, if the game got better, pulls the new code and redeploys your world
automatically. Your settings, songs and loot are never touched: they live
in your Cloudflare storage, not in the code.

## For developers

- `public/` is the game and dashboard, served as static assets.
- `src/worker.js` is the whole API: world config, loot and claims, song
  streaming from R2, a presence Durable Object, admin and superuser auth.
- `wrangler.jsonc` declares the D1 database, R2 bucket and Durable Object;
  the Deploy to Cloudflare flow provisions them. The D1 schema creates
  itself on first request.
- `PLAN.md` describes the full architecture, including how corner links
  and cross-world determinism work.

Local dev: `npx wrangler dev` (you will need to create a D1 database and
R2 bucket once and put their IDs in `wrangler.jsonc`).
