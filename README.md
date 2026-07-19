# Tuneland

Your songs, as a place. Tuneland turns your music into a voxel world your
fans can walk, fly and dig through. You bury real loot for them: links to a
new release, coupon codes, notes. Your world can link corners with other
artists' worlds, so fans wander from your land straight into theirs.

Tuneland runs the way a good DIY gig runs. Your world lives on **your own**
free Cloudflare account and **your own** GitHub account: no sponsors, no
platform in the middle, no cut taken, and nobody else holds your music or
your data. On the public map every world gets the same size type, whether
it registered first or fiftieth. There are no headliners here.

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
   phone or computer: the first person to claim a world owns it. Claiming
   means accepting the [artist agreement](https://midhrami.com/tuneland/agreement/):
   your world and everything it hosts and does are your responsibility, and
   Midhrami is indemnified and not responsible for it.

3. **Make it yours.** In the dashboard: name your world, upload songs, color
   your areas, bury loot, then press **Join the Tuneland map** so fans and
   other artists can find you.

Full walkthrough with pictures: https://midhrami.com/tuneland/

## What your fans get

- Land built from your actual songs. Loud passages rise into ridges, quiet
  passages sink into water valleys. You choose the shape: **concentric
  rings** (your first song is the innermost land, each next song a ring
  around it) or **rectangular lanes** (each song gets its own lane, side by
  side). Whichever song's ground a fan stands on is the song they hear,
  from about that point in the track.
- Not a musician? Land can also be made from a picture, from your words,
  or from a skyline you draw by hand, and podcast episodes upload as audio
  the same way songs do. Each piece gets its own region, color and
  markers, exactly like a track.
- Glowing time markers cross the land every 30 seconds of each song, with
  the time spelled out in floating voxel digits, so fans always know how
  deep into a track they are standing.
- Arenas in the four corners: neutral ground with monsters, loot, and the
  links to other artists' worlds.
- Walking, flying (press F or the wing button), digging, and teleporting to
  the next area with alt+click (long-press on phones).
- A radar that wakes up near buried loot and pings faster as they close
  in. Loot can be scarce by count ("first 50 fans"), by time ("release
  weekend only"), or both at once.
- Little monsters (glooms) in the arenas to dodge.
- Friends: fans swap friend codes and get a heads-up when a friend is in
  the same area.
- Crossing: if you link a corner with another artist, fans walk from your
  world into theirs with no loading screen.
- A fan passport: chests found (with "finder #7 of this drop" ranks),
  worlds visited and crowned, day streaks from a daily echo chest, tamed
  glooms, kilometers wandered, and a share card to post.
- Listening quests: standing through a whole piece marks it walked, and
  walking every piece crowns your world.
- Photo mode and race links: fans snap framed shots that link friends to
  the exact spot, and set time trials a friend's ghost can be raced on.

## What you get as the artist

- A numbers card in your dashboard: visits, fans, hours in world, which
  pieces get walked end to end, chest counts, all measured in your own
  Cloudflare, nobody else's.
- Email loot: drops that offer (or require) an email signup to open.
  Addresses land in your own storage and export as CSV. Your list, yours.
- Campaign templates: release day, tour stop, and presave hunt prefill
  the loot form with a working plan.
- A public spot on the map of Tuneland at midhrami.com/tuneland/map/ once
  you register.

## Your music, your rights

Only upload music you have the rights to. Your world hosts its songs on
your own Cloudflare account, in public. That means your own recordings, or
recordings you have written permission to host and share. Covers, remixes
with uncleared samples, and other people's tracks can get your Cloudflare
and GitHub accounts suspended and can expose you to copyright claims. The
dashboard asks you to confirm this for every upload, and you are
responsible for what your world serves.

Claiming a world means accepting the
[Tuneland artist agreement](https://midhrami.com/tuneland/agreement/): you
bear responsibility for your world's content and usage, correct or not,
and Midhrami Studios is indemnified and not responsible for it.

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
