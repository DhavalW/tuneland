/* Tuneland world client.
 *
 * A 3x3 grid of 96x96 voxel areas: the artist's home in the middle, outer
 * areas around it, arenas in the corners. Corners can be linked to other
 * artists' worlds; the shared arena terrain is a pure function of the link
 * id, so both sides compute identical blocks with no server involved.
 *
 * Sections: utils / identity / config / world math / generation / renderer /
 * audio / player & input / monsters / loot & radar / presence / crossing /
 * HUD wiring / boot.
 */
(function () {
  'use strict';

  /* ═══════════ utils ═══════════ */
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seeded = (str) => mulberry32(xmur3(str)());

  function makeNoise2D(rand) {
    const G = 64, grid = new Float32Array(G * G);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    const sm = (t) => t * t * (3 - 2 * t);
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const x0 = ((xi % G) + G) % G, y0 = ((yi % G) + G) % G;
      const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G;
      const a = grid[y0 * G + x0], b = grid[y0 * G + x1], c = grid[y1 * G + x0], d = grid[y1 * G + x1];
      const u = sm(xf), v = sm(yf);
      return lerp(lerp(a, b, u), lerp(c, d, u), v);
    };
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tl1_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tl1_' + k, JSON.stringify(v)); } catch (e) {} }
  };
  function vibrate(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} } }
  function randHexClient(n) {
    const b = new Uint8Array(n);
    (crypto.getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; }));
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  function b64uEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(str) {
    const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  const jsonToB64u = (obj) => b64uEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const b64uToJson = (str) => JSON.parse(new TextDecoder().decode(b64uDecode(str)));
  /* race paths: [x,z] samples quantized to decimeters, delta-encoded */
  function encodePath(samples) {
    const n = Math.min(samples.length, 240);
    if (!n) return '';
    const buf = new Int16Array(n * 2);
    let px = 0, pz = 0;
    for (let i = 0; i < n; i++) {
      const qx = Math.round(clamp(samples[i][0], 0, 288) * 10);
      const qz = Math.round(clamp(samples[i][1], 0, 288) * 10);
      buf[i * 2] = qx - px; buf[i * 2 + 1] = qz - pz;
      px = qx; pz = qz;
    }
    return b64uEncode(new Uint8Array(buf.buffer, 0, n * 4));
  }
  function decodePath(str) {
    try {
      if (typeof str !== 'string' || !str) return null;
      const u = b64uDecode(str);
      const nb = u.byteLength - (u.byteLength % 4);
      if (nb < 8) return null;
      const v = new Int16Array(u.buffer.slice(0, nb));
      const out = [];
      let px = 0, pz = 0;
      for (let i = 0; i + 1 < v.length; i += 2) {
        px += v[i]; pz += v[i + 1];
        out.push([px / 10, pz / 10]);
      }
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  function fetchJson(url, opts, ms) {
    return new Promise((resolve, reject) => {
      const ctrl = window.AbortController ? new AbortController() : null;
      const tm = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new Error('timeout')); }, ms || 8000);
      fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}))
        .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then((d) => { clearTimeout(tm); resolve(d); })
        .catch((e) => { clearTimeout(tm); reject(e); });
    });
  }
  function hsl2rgb(h, s, l) {
    const f = (nn) => {
      const k = (nn + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const scale3 = (a, k) => [clamp(a[0] * k, 0, 1), clamp(a[1] * k, 0, 1), clamp(a[2] * k, 0, 1)];

  /* ═══════════ fan identity & friends ═══════════ */
  let fan = store.get('fan', null);
  if (!fan || !fan.id) { fan = { id: 'f' + randHexClient(8), name: '' }; store.set('fan', fan); }
  let friends = store.get('friends', []); // [{id, name}]
  function saveFan() { store.set('fan', fan); }
  function addFriend(code) {
    const m = String(code || '').trim().match(/^(f[0-9a-f]{16})~(.{1,24})/);
    if (!m) return false;
    if (m[1] === fan.id) return false;
    friends = friends.filter((f) => f.id !== m[1]);
    friends.push({ id: m[1], name: m[2] });
    store.set('friends', friends);
    return true;
  }
  const isFriend = (id) => friends.some((f) => f.id === id);

  /* ═══════════ fan passport (all local, all yours) ═══════════ */
  const PP = {
    get() { return store.get('pp', { km: 0, tamed: 0, echoes: 0, streak: 0, lastEcho: '', bestFinder: 0 }); },
    set(pp) { store.set('pp', pp); },
    bump(k, n) { const pp = this.get(); pp[k] = (pp[k] || 0) + n; this.set(pp); return pp; }
  };
  function rememberVisit(worldId, name) {
    const v = store.get('visited', {});
    v[worldId] = name;
    store.set('visited', v);
  }
  function rememberFind(entry) {
    const log = store.get('foundLog', []);
    log.unshift(entry);
    store.set('foundLog', log.slice(0, 100));
    if (entry.f) {
      const pp = PP.get();
      if (!pp.bestFinder || entry.f < pp.bestFinder) { pp.bestFinder = entry.f; PP.set(pp); }
    }
  }
  const questsDone = () => store.get('questsDone', {}); // {worldId: {songId: true}}
  const crowns = () => store.get('crowns', {});         // {worldId: worldName}

  /* ═══════════ play stats: one tiny beacon per session, to the world's
     own Worker (the artist's budget, the artist's numbers) ═══════════ */
  const Stats = {
    target: null, v: 0, u: 0, secs: 0, c: [], f: 0,
    begin(origin, worldId) {
      if (this.target && this.target !== origin) this.flush();
      this.target = origin;
      this.v = 1;
      const dayKey = 'seen_' + worldId;
      const today = new Date().toISOString().slice(0, 10);
      if (store.get(dayKey, '') !== today) { this.u = 1; store.set(dayKey, today); }
    },
    tick(dt) { if (this.target) this.secs += dt; },
    complete(id) { if (this.c.indexOf(id) < 0) this.c.push(id); },
    find() { this.f++; },
    flush() {
      if (!this.target || W.cfg && W.cfg.demo) { this.reset(); return; }
      const mins = Math.floor(this.secs / 60);
      if (!this.v && !this.u && !mins && !this.c.length && !this.f) return;
      const body = JSON.stringify({ v: this.v, u: this.u, m: mins, c: this.c.slice(0, 12), f: this.f });
      try {
        if (!(navigator.sendBeacon && navigator.sendBeacon(this.target + '/api/stats', body))) {
          fetch(this.target + '/api/stats', { method: 'POST', body, keepalive: true }).catch(() => {});
        }
      } catch (e) {}
      this.secs -= mins * 60;
      this.v = 0; this.u = 0; this.c = []; this.f = 0;
    },
    reset() { this.v = 0; this.u = 0; this.secs = 0; this.c = []; this.f = 0; }
  };
  addEventListener('visibilitychange', () => { if (document.hidden) Stats.flush(); });
  setInterval(() => { if (S.playing) Stats.flush(); }, 4 * 60e3);

  /* ═══════════ world config ═══════════ */
  const OWN_ORIGIN = location.origin;
  const DEMO = /[?&#]demo/.test(location.href);

  function demoConfig() {
    return {
      ok: true, worldId: 'wdemo0000demo', name: 'Tuneland demo world', artist: 'The Tuneland makers',
      bio: 'A world with no artist yet. Wander, dig, meet the glooms.',
      layout: 'rings',
      hues: [0.62, 0.55, 0.08, 0.45, 0.33, 0.72, 0.85, 0.25, 0.95],
      areaTracks: [null, null, null, null, null, null, null, null, null],
      tracks: [
        { id: 'demoA', title: 'First movement', url: null, hue: 0.33, envelope: null },
        { id: 'demoB', title: 'Second movement', url: null, hue: 0.62, envelope: null }
      ],
      links: [], demo: true
    };
  }
  function normalizeConfig(d, origin) {
    if (!d || !d.ok || !d.worldId) return null;
    return {
      worldId: String(d.worldId), origin,
      name: String(d.name || 'A Tuneland world').slice(0, 80),
      artist: String(d.artist || '').slice(0, 80),
      bio: String(d.bio || '').slice(0, 400),
      layout: d.layout === 'lanes' || d.layout === 'rectangular' ? 'lanes' : 'rings',
      hues: Array.isArray(d.hues) && d.hues.length === 9 ? d.hues.map((h) => clamp(Number(h) || 0, 0, 1)) : demoConfig().hues,
      areaTracks: Array.isArray(d.areaTracks) && d.areaTracks.length === 9 ? d.areaTracks : demoConfig().areaTracks,
      tracks: Array.isArray(d.tracks) ? d.tracks.slice(0, 24).map((t) => ({
        id: String(t.id || ''), title: String(t.title || 'Untitled').slice(0, 120),
        url: typeof t.url === 'string' ? t.url : null,
        hue: Number.isFinite(Number(t.hue)) ? clamp(Number(t.hue), 0, 1) : null,
        envelope: t.envelope && Array.isArray(t.envelope.env) ? t.envelope : null
      })) : [],
      links: Array.isArray(d.links) ? d.links.filter((l) => l && l.other && l.other.id && [1, 3, 5, 7].indexOf(Number(l.corner)) >= 0)
        .map((l) => ({
          id: String(l.id || ''), corner: Number(l.corner),
          other: { id: String(l.other.id), origin: String(l.other.origin || ''), name: String(l.other.name || 'a linked world').slice(0, 80) }
        })) : [],
      demo: !!d.demo
    };
  }
  function loadConfig(origin) {
    // cache-then-network so a sleeping world still lets fans in
    const ck = 'cfg_' + origin;
    return fetchJson(origin + '/api/world', {}, 7000)
      .then((d) => {
        const cfg = normalizeConfig(d, origin);
        if (!cfg) throw new Error('bad config');
        store.set(ck, { at: Date.now(), cfg });
        return cfg;
      })
      .catch(() => {
        const cached = store.get(ck, null);
        if (cached && cached.cfg) { cached.cfg.stale = true; return cached.cfg; }
        return null;
      });
  }

  /* ═══════════ world math ═══════════ */
  const AREA = 96, GRID = 3, SXZ = AREA * GRID, SY = 48, SEA = 12, CS = 16, CGRID = SXZ / CS;
  const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, SAND = 4, WATER = 5, WOOD = 6, LEAF = 7, CHEST = 8, ROCK = 9, SNOW = 10, PILLAR = 11, MARKER = 12, DAILY = 13;
  const RMAX = 138;   // rings layout: outer radius of the modeled discography
  const LANE_M = 14;  // lanes layout: shoreline margin before the timeline starts

  // corner numbering per the design: 1=NW 3=NE 5=SE 7=SW (clockwise from top-left)
  const CORNER_AREA = { 1: 0, 3: 2, 5: 8, 7: 6 };      // corner number -> area index (row-major)
  const AREA_CORNER = { 0: 1, 2: 3, 8: 5, 6: 7 };
  const OPP_CORNER = { 1: 5, 3: 7, 5: 1, 7: 3 };
  const CORNER_TILE0 = { 1: [0, 0], 3: [2, 0], 5: [2, 2], 7: [0, 2] }; // [col,row] of tile
  const OUTER_PT = { 1: [0, 0], 3: [96, 0], 5: [96, 96], 7: [0, 96] }; // tile-local outward corner

  const areaOf = (x, z) => {
    const c = clamp(Math.floor(x / AREA), 0, 2), r = clamp(Math.floor(z / AREA), 0, 2);
    return r * 3 + c;
  };
  const AREA_NAMES = ['Northwest arena', 'North fields', 'Northeast arena', 'West fields', 'Home stage', 'East fields', 'Southwest arena', 'South fields', 'Southeast arena'];
  const isCornerArea = (i) => i === 0 || i === 2 || i === 6 || i === 8;

  function linkKeyFor(cfg, corner) {
    const link = cfg.links.find((l) => l.corner === corner);
    if (!link) return null;
    const a = { id: cfg.worldId, c: corner }, b = { id: link.other.id, c: OPP_CORNER[corner] };
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    return 'link|' + lo.id + '.' + lo.c + '|' + hi.id + '.' + hi.c;
  }

  /* ═══════════ world generation ═══════════ */
  const W = {
    cfg: null,          // active world config
    blocks: null, heights: null, markers: null,
    n2: null,           // world-seed noise
    arenaFns: {},       // corner number -> {n2, key}
    songs: [],          // ordered: [{id,title,url,hue,dur,arr,beats,pal}]
    arenaPals: {}, fallbackPal: null,
    lootByArea: {},     // areaKey -> [{id,x,z,origin}]
    lootBlocks: new Map(), // "x,z,y" -> loot entry
    trees: [], ready: false
  };

  const bIdx = (x, y, z) => (x * SXZ + z) * SY + y;
  function getB(x, y, z) {
    if (y < 0) return ROCK;
    if (x < 0 || x >= SXZ || z < 0 || z >= SXZ || y >= SY) return AIR;
    return W.blocks[bIdx(x, y, z)];
  }
  const isSolid = (x, y, z) => { const b = getB(x, y, z); return b !== AIR && b !== WATER; };

  function palFromHue(hue, arena) {
    const top = hsl2rgb(hue, arena ? 0.32 : 0.48, arena ? 0.36 : 0.44);
    return {
      top,
      side: scale3(mix3(top, [0.45, 0.33, 0.22], 0.55), 0.95),
      dirt: mix3([0.45, 0.33, 0.22], top, 0.2),
      stone: mix3([0.5, 0.52, 0.56], top, 0.22),
      sand: mix3([0.85, 0.78, 0.54], top, 0.15),
      water: mix3([0.16, 0.4, 0.62], hsl2rgb(hue, 0.5, 0.4), 0.35),
      leaf: hsl2rgb((hue + 0.06) % 1, 0.45, 0.38),
      snow: mix3([0.9, 0.92, 0.95], top, 0.12),
      accent: hsl2rgb((hue + 0.5) % 1, 0.85, 0.6),
      sky: scale3(hsl2rgb(hue, 0.45, 0.32), 0.75),
      fog: hsl2rgb(hue, 0.3, 0.45)
    };
  }

  /* a plausible song arc for tracks with no stored analysis, deterministic
     for everyone so the terrain still agrees across fans */
  function pseudoEnvelope(seedKey) {
    const rand = seeded(seedKey);
    const n = 300, env = new Array(n), dur = 30;
    for (let i = 0; i < n; i++) env[i] = clamp(0.32 + 0.3 * Math.sin(i / 18 + rand() * 6) + rand() * 0.12, 0, 1);
    const bpm = 92 + Math.floor(rand() * 40);
    const beats = [];
    for (let t = 0.5; t < dur; t += 60 / bpm) beats.push(t);
    return { dur, env, beats };
  }

  function buildSongs(cfg) {
    W.songs = cfg.tracks.map((t) => {
      let envd = t.envelope;
      if (!envd || !Array.isArray(envd.env) || !envd.env.length) envd = pseudoEnvelope('pseudoenv|' + t.id);
      const hue = t.hue !== null && t.hue !== undefined ? t.hue : (xmur3('hue|' + t.id)() % 1000) / 1000;
      return {
        id: t.id, title: t.title, url: t.url, hue,
        dur: clamp(Number(envd.dur) || 30, 10, 600),
        arr: envd.env, beats: Array.isArray(envd.beats) ? envd.beats : [],
        pal: palFromHue(hue, false)
      };
    });
  }

  function terrainFns(cfg) {
    W.n2 = makeNoise2D(seeded('world|' + cfg.worldId));
    W.arenaFns = {};
    W.arenaPals = {};
    for (const c of [1, 3, 5, 7]) {
      const key = linkKeyFor(cfg, c) || ('arena|' + cfg.worldId + '.' + c);
      W.arenaFns[c] = { key, n2: makeNoise2D(seeded(key)) };
      // arena colors derive from the arena key, so a shared arena looks
      // identical from both linked worlds
      W.arenaPals[c] = palFromHue((xmur3('arenahue|' + key)() % 1000) / 1000, true);
    }
    W.fallbackPal = palFromHue(cfg.hues[4], false);
  }

  function sampleEnv(song, t) {
    const arr = song.arr;
    const f = clamp(t / song.dur * arr.length, 0, arr.length - 1.001);
    const i = f | 0;
    return lerp(arr[i], arr[Math.min(arr.length - 1, i + 1)], f - i);
  }

  /* which song models the terrain at (x,z), and where in it we are.
     rings: first song is the innermost disc, later songs ring outward.
     lanes: each song is a north-to-south lane, west to east in order. */
  function songAt(x, z) {
    const n = W.songs.length;
    if (!n) return null;
    if (W.cfg.layout === 'lanes') {
      const song0 = clamp(Math.floor(x / SXZ * n), 0, n - 1);
      const song = W.songs[song0];
      const span = SXZ - 2 * LANE_M;
      const t = clamp((z - LANE_M) / span, 0, 1) * song.dur;
      return { song, idx: song0, t, tPerBlock: song.dur / span };
    }
    const r = Math.hypot(x - SXZ / 2, z - SXZ / 2);
    const band = RMAX / n;
    if (r >= RMAX) {
      const song = W.songs[n - 1];
      return { song, idx: n - 1, t: song.dur, tPerBlock: song.dur / band, beyond: true };
    }
    const idx = clamp(Math.floor(r / band), 0, n - 1);
    const song = W.songs[idx];
    return { song, idx, t: (r - idx * band) / band * song.dur, tPerBlock: song.dur / band };
  }

  function paletteAt(x, z) {
    const c = AREA_CORNER[areaOf(x, z)];
    if (c !== undefined && W.arenaPals[c]) return W.arenaPals[c];
    const sa = songAt(x, z);
    return sa ? sa.song.pal : W.fallbackPal;
  }
  const palAtPlayer = () => paletteAt(clamp(P.x, 0, SXZ - 1), clamp(P.z, 0, SXZ - 1));

  /* the land is the music: loud is high and jagged, quiet sinks into water */
  function baseHeight(x, z) {
    const sa = songAt(x, z);
    let h;
    if (!sa) {
      const n = W.n2(x / 34, z / 34) + 0.5 * W.n2(x / 13, z / 13) + 0.25 * W.n2(x / 6, z / 6);
      h = 4 + (n / 1.75) * 22;
      const dx = (x - SXZ / 2) / (SXZ / 2), dz = (z - SXZ / 2) / (SXZ / 2);
      h += Math.max(0, 1 - Math.sqrt(dx * dx + dz * dz) * 2.2) * 5;
    } else {
      const level = sampleEnv(sa.song, sa.t);
      h = 4.5 + level * 20 +
        W.n2(x / 7.5, z / 7.5) * (1.2 + level * 5.5) +
        W.n2(x / 23 + 9.1, z / 23) * 2.5 * level;
      const calm = clamp(level / 0.22, 0, 1);
      const s = calm * calm * (3 - 2 * calm);
      h = lerp(1.5 + W.n2(x / 11, z / 11) * 1.6, h, s);
      if (sa.beyond) h = Math.min(h, 3);
    }
    // shoreline: the grid is an island in a void sea
    const edge = Math.min(x, z, SXZ - 1 - x, SXZ - 1 - z);
    return lerp(1, h, clamp(edge / 18, 0, 1));
  }
  function arenaHeight(fn, u, v) {
    // arenas: a sunken bowl with a rim, easy to read, fair to fight in
    const n = fn.n2(u / 21, v / 21) + 0.5 * fn.n2(u / 9, v / 9);
    const du = (u - AREA / 2) / (AREA / 2), dv = (v - AREA / 2) / (AREA / 2);
    const d = Math.sqrt(du * du + dv * dv);
    let h = 9 + (n / 1.5) * 6 - Math.max(0, 1 - d * 1.6) * 3.5;
    h += Math.max(0, d - 0.72) * 15; // rim
    return h;
  }
  function heightAt(x, z) {
    const ai = areaOf(x, z);
    const corner = AREA_CORNER[ai];
    const base = baseHeight(x, z);
    if (corner === undefined) return base;
    const fn = W.arenaFns[corner];
    const [tc, tr] = CORNER_TILE0[corner];
    const u = x - tc * AREA, v = z - tr * AREA;
    // blend from own terrain at the inner (grid-facing) edges to pure arena
    // terrain inside; the arena interior is identical on both sides of a link
    const ou = OUTER_PT[corner][0], ov = OUTER_PT[corner][1];
    const innerU = ou === 0 ? AREA - u : u;
    const innerV = ov === 0 ? AREA - v : v;
    return blendArena(base, arenaHeight(fn, u, v), innerU, innerV);
  }
  function blendArena(own, arena, innerU, innerV) {
    // innerU/innerV: how far into the tile from the edges shared with the
    // rest of the grid; 0 at those edges (must match own terrain exactly)
    const t = clamp(Math.min(innerU, innerV) / 16, 0, 1);
    const s = t * t * (3 - 2 * t);
    return lerp(own, arena, s);
  }

  function genWorld(cfg, onlyHeights) {
    W.cfg = cfg;
    buildSongs(cfg);
    terrainFns(cfg);
    W.blocks = new Uint8Array(SXZ * SY * SXZ);
    W.heights = new Uint8Array(SXZ * SXZ);
    for (let x = 0; x < SXZ; x++) {
      for (let z = 0; z < SXZ; z++) {
        let h = Math.round(heightAt(x, z));
        h = clamp(h, 1, SY - 8);
        W.heights[x * SXZ + z] = h;
        if (onlyHeights) continue;
        W.blocks[bIdx(x, 0, z)] = ROCK;
        for (let y = 1; y <= h; y++) {
          let b = STONE;
          if (y === h) {
            if (h <= SEA + 1) b = SAND;
            else if (h >= 34) b = SNOW;
            else b = GRASS;
          } else if (y >= h - 2) b = h <= SEA + 1 ? SAND : DIRT;
          W.blocks[bIdx(x, y, z)] = b;
        }
        for (let y = h + 1; y <= SEA; y++) W.blocks[bIdx(x, y, z)] = WATER;
      }
    }
    if (onlyHeights) return;

    // trees in the fields (never in arenas), seeded per world
    const trand = seeded('trees|' + cfg.worldId);
    W.trees = [];
    let planted = 0, tries = 0;
    while (planted < 90 && tries++ < 3000) {
      const x = 4 + Math.floor(trand() * (SXZ - 8)), z = 4 + Math.floor(trand() * (SXZ - 8));
      if (isCornerArea(areaOf(x, z))) continue;
      const h = W.heights[x * SXZ + z];
      if (h <= SEA + 2 || h >= 32 || getB(x, h, z) !== GRASS) continue;
      const th = 4 + Math.floor(trand() * 2);
      for (let y = h + 1; y <= h + th; y++) W.blocks[bIdx(x, y, z)] = WOOD;
      for (let dy = th - 1; dy <= th + 1; dy++) {
        const r = dy === th + 1 ? 1 : 2;
        for (let lx = -r; lx <= r; lx++) for (let lz = -r; lz <= r; lz++) {
          if (Math.abs(lx) === r && Math.abs(lz) === r && r === 2) continue;
          const wx = x + lx, wz = z + lz, wy = h + dy + 1;
          if (wx < 0 || wx >= SXZ || wz < 0 || wz >= SXZ || wy >= SY) continue;
          if (W.blocks[bIdx(wx, wy, wz)] === AIR) W.blocks[bIdx(wx, wy, wz)] = LEAF;
        }
      }
      planted++;
    }

    // arena pillars: glowing markers seeded per arena (same on both sides of a link)
    for (const c of [1, 3, 5, 7]) {
      const fn = W.arenaFns[c];
      const prand = seeded('pillars|' + fn.key);
      const [tc, tr] = CORNER_TILE0[c];
      for (let i = 0; i < 5; i++) {
        const u = 14 + Math.floor(prand() * (AREA - 28)), v = 14 + Math.floor(prand() * (AREA - 28));
        const x = tc * AREA + u, z = tr * AREA + v;
        const h = W.heights[x * SXZ + z];
        if (h <= SEA + 1) continue;
        const ph = 3 + Math.floor(prand() * 5);
        for (let y = h + 1; y <= Math.min(SY - 2, h + ph); y++) W.blocks[bIdx(x, y, z)] = PILLAR;
      }
    }

    buildTimeMarkers();
    placeDailyEcho();
    W.ready = true;
  }

  /* ── the daily echo: one glowing block a day, same spot for everyone,
     found once per day per fan; pure client, zero server ── */
  function placeDailyEcho() {
    W.echo = null;
    const day = new Date().toISOString().slice(0, 10);
    if (store.get('echo_' + W.cfg.worldId, '') === day) return; // already found today
    const erand = seeded('daily|' + W.cfg.worldId + '|' + day);
    for (let tries = 0; tries < 60; tries++) {
      const x = 8 + Math.floor(erand() * (SXZ - 16));
      const z = 8 + Math.floor(erand() * (SXZ - 16));
      if (AREA_CORNER[areaOf(x, z)] !== undefined) continue;
      const h = W.heights[x * SXZ + z];
      if (h <= SEA + 1) continue;
      W.blocks[bIdx(x, h, z)] = DAILY;
      W.echo = { x, z, day };
      return;
    }
  }
  function echoFound(hit) {
    W.blocks[bIdx(hit.x, hit.y, hit.z)] = AIR;
    markDirtyAt(hit.x, hit.z);
    const day = new Date().toISOString().slice(0, 10);
    store.set('echo_' + W.cfg.worldId, day);
    W.echo = null;
    const pp = PP.get();
    const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    pp.streak = pp.lastEcho === yesterday ? (pp.streak || 0) + 1 : 1;
    pp.lastEcho = day;
    pp.echoes = (pp.echoes || 0) + 1;
    PP.set(pp);
    Sfx.loot();
    burst(hit.x + 0.5, hit.y + 1, hit.z + 0.5, [0.95, 0.66, 0.25], 26, 8);
    showToast('☼ daily echo found · streak ' + pp.streak + (pp.streak > 1 ? ' days' : ' day'), 3200);
    vibrate([20, 30, 20]);
  }

  /* ── distance markers: one every 30 seconds of each song ──
     Glowing stripes across the terrain, plus pylons carrying the time in
     voxel digits, so fans always know how deep into a song they stand. */
  const FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
    '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
    '6': '111100111101111', '7': '111001010010010', '8': '111101111101111',
    '9': '111101111001111', ':': '000010000010000'
  };
  function setBlockIfAir(x, y, z, b) {
    if (x < 0 || x >= SXZ || z < 0 || z >= SXZ || y < 1 || y >= SY) return;
    if (W.blocks[bIdx(x, y, z)] === AIR) W.blocks[bIdx(x, y, z)] = b;
  }
  function placeDigits(label, cx, yBase, cz, dx, dz) {
    const wTotal = label.length * 4 - 1;
    const off = -Math.floor(wTotal / 2);
    for (let ci = 0; ci < label.length; ci++) {
      const glyph = FONT[label[ci]];
      if (!glyph) continue;
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
        if (glyph[r * 3 + c] !== '1') continue;
        const o = off + ci * 4 + c;
        setBlockIfAir(cx + o * dx, yBase + (4 - r), cz + o * dz, MARKER);
      }
    }
  }
  function fmtTime(t) {
    const s = Math.max(0, Math.round(t));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function placePylon(x, z) {
    const h = W.heights[x * SXZ + z];
    if (h <= SEA) return h;
    for (let y = h + 1; y <= Math.min(SY - 2, h + 5); y++) setBlockIfAir(x, y, z, MARKER);
    return h;
  }
  function buildTimeMarkers() {
    W.markers = new Uint8Array(SXZ * SXZ);
    if (!W.songs.length) return;
    // stripe every 30s of song time, skipping the arenas (neutral ground)
    for (let x = 0; x < SXZ; x++) for (let z = 0; z < SXZ; z++) {
      if (AREA_CORNER[areaOf(x, z)] !== undefined) continue;
      const sa = songAt(x, z);
      if (!sa || sa.beyond || sa.t < 3) continue;
      const tm = sa.t % 30;
      if (Math.min(tm, 30 - tm) < sa.tPerBlock * 0.8) W.markers[x * SXZ + z] = 1;
    }
    // pylons + voxel-digit time labels
    const n = W.songs.length;
    if (W.cfg.layout === 'lanes') {
      const laneW = SXZ / n, span = SXZ - 2 * LANE_M;
      for (let i = 0; i < n; i++) {
        const song = W.songs[i];
        for (let k = 1; k * 30 < song.dur; k++) {
          const zm = Math.round(LANE_M + (k * 30 / song.dur) * span);
          if (zm < 20 || zm > SXZ - 20) continue;
          // the walkable stretch of this lane at zm, dodging the corner arenas
          let gx0 = Math.round(i * laneW), gx1 = Math.round((i + 1) * laneW);
          if (zm < AREA || zm >= 2 * AREA) { gx0 = Math.max(gx0, AREA); gx1 = Math.min(gx1, 2 * AREA); }
          if (gx1 - gx0 < 12) continue;
          const cx = Math.floor((gx0 + gx1) / 2);
          placePylon(gx0 + 2, zm);
          placePylon(gx1 - 3, zm);
          const yb = Math.max(W.heights[cx * SXZ + zm], SEA) + 4;
          placeDigits(fmtTime(k * 30), cx, Math.min(yb, SY - 7), zm, 1, 0);
        }
      }
    } else {
      const band = RMAX / n, c0 = SXZ / 2;
      for (let i = 0; i < n; i++) {
        const song = W.songs[i];
        for (let k = 1; k * 30 < song.dur; k++) {
          const rm = (i + k * 30 / song.dur) * band;
          if (rm < 10 || rm >= RMAX) continue;
          // markers at the four compass points of the ring; digits face the walker
          const pts = [
            { x: c0, z: c0 - rm, dx: 1, dz: 0 }, { x: c0 + rm, z: c0, dx: 0, dz: 1 },
            { x: c0, z: c0 + rm, dx: 1, dz: 0 }, { x: c0 - rm, z: c0, dx: 0, dz: 1 }
          ];
          for (const p of pts) {
            const px = Math.round(p.x), pz = Math.round(p.z);
            if (px < 8 || px >= SXZ - 8 || pz < 8 || pz >= SXZ - 8) continue;
            if (AREA_CORNER[areaOf(px, pz)] !== undefined) continue;
            const h = placePylon(px, pz);
            if (h > SEA) placeDigits(fmtTime(k * 30), px, Math.min(h + 4, SY - 7), pz, p.dx, p.dz);
          }
        }
      }
    }
  }

  /* loot placement: server gives (x,z); the chest sits 2 under the surface */
  function placeLootBlocks() {
    // clear previous chest blocks
    for (const [k] of W.lootBlocks) {
      const [x, z, y] = k.split(',').map(Number);
      if (getB(x, y, z) === CHEST) { W.blocks[bIdx(x, y, z)] = STONE; markDirtyAt(x, z); }
    }
    W.lootBlocks.clear();
    for (const areaKey in W.lootByArea) {
      for (const item of W.lootByArea[areaKey]) {
        const x = clamp(Math.round(item.x), 1, SXZ - 2), z = clamp(Math.round(item.z), 1, SXZ - 2);
        const h = W.heights[x * SXZ + z];
        const y = clamp(h - 2, 1, h); // never above the ground it hides in
        if (getB(x, y, z) === CHEST) continue;
        W.blocks[bIdx(x, y, z)] = CHEST;
        W.lootBlocks.set(x + ',' + z + ',' + y, item);
        markDirtyAt(x, z);
      }
    }
  }

  function areaKeyOf(ai) {
    const c = AREA_CORNER[ai];
    if (c !== undefined) return W.arenaFns[c].key; // link|... or arena|...
    return 'own:' + ai;
  }

  async function loadLootForArea(ai) {
    const key = areaKeyOf(ai);
    if (W.lootByArea[key]) return;
    W.lootByArea[key] = [];
    if (W.cfg.demo) {
      // three practice chests, deterministic
      const drand = seeded('demoloot|' + key);
      for (let i = 0; i < (key === 'own:4' ? 3 : 1); i++) {
        W.lootByArea[key].push({
          id: 'demo' + key + i, demo: true,
          x: Math.floor(drand() * AREA) + (ai % 3) * AREA,
          z: Math.floor(drand() * AREA) + Math.floor(ai / 3) * AREA,
          origin: null
        });
      }
      placeLootBlocks();
      return;
    }
    const origins = [W.cfg.origin];
    const corner = AREA_CORNER[ai];
    if (corner !== undefined) {
      const link = W.cfg.links.find((l) => l.corner === corner);
      if (link && link.other.origin && link.other.origin !== W.cfg.origin) origins.push(link.other.origin);
    }
    const results = await Promise.all(origins.map((o) =>
      fetchJson(o + '/api/loot?area=' + encodeURIComponent(key), {}, 6000)
        .then((d) => ({ o, loot: d && d.ok && Array.isArray(d.loot) ? d.loot : [] }))
        .catch(() => ({ o, loot: [], down: true }))
    ));
    const merged = [];
    for (const r of results) {
      if (r.down && r.o !== W.cfg.origin) showToast('the linked world is asleep · its loot is hidden for now', 2600);
      for (const l of r.loot.slice(0, 40)) {
        if (typeof l.id !== 'string' || !Number.isFinite(Number(l.x)) || !Number.isFinite(Number(l.z))) continue;
        merged.push({ id: l.id, x: Number(l.x), z: Number(l.z), origin: r.o });
      }
    }
    W.lootByArea[key] = merged;
    placeLootBlocks();
  }

  /* ═══════════ renderer (WebGL1, chunked, vertex colors + AO + fog) ═══════════ */
  const glCv = $('gl');
  let gl = null, prog = null, loc = {}, ptsProg = null;
  const chunks = new Map(); // key ci*CGRID+cj -> {vbo,count,wvbo,wcount,dirty,built}

  const VS = 'attribute vec3 aPos; attribute vec3 aCol; attribute float aGlow;' +
    'uniform mat4 uMVP; uniform vec3 uEye;' +
    'varying vec3 vCol; varying float vGlow; varying float vDist;' +
    'void main(){ gl_Position = uMVP * vec4(aPos,1.0); vCol=aCol; vGlow=aGlow; vDist=distance(aPos,uEye); }';
  const FS = 'precision mediump float;' +
    'varying vec3 vCol; varying float vGlow; varying float vDist;' +
    'uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;' +
    'uniform float uAlpha; uniform vec3 uGlowCol; uniform float uPulse; uniform float uFlash;' +
    'void main(){' +
    '  vec3 c = vCol;' +
    '  c = mix(c, uGlowCol * (1.1 + uPulse * 0.9), vGlow * (0.55 + 0.45 * uPulse));' +
    '  float f = smoothstep(uFogNear, uFogFar, vDist);' +
    '  c = mix(c, uFog, f);' +
    '  c += uFlash * vec3(0.85,0.92,1.0) * (1.0 - f * 0.7) * 0.4;' +
    '  gl_FragColor = vec4(c, uAlpha);' +
    '}';
  const VS_PTS = 'attribute vec3 aPos; attribute vec4 aCol; attribute float aSize;' +
    'uniform mat4 uMVP; uniform float uScale; varying vec4 vCol;' +
    'void main(){ gl_Position = uMVP * vec4(aPos,1.0); float w = max(gl_Position.w, 0.5);' +
    'gl_PointSize = clamp(aSize * uScale / w, 1.0, 72.0); vCol = aCol; }';
  const FS_PTS = 'precision mediump float; varying vec4 vCol;' +
    'void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float a = 1.0 - dot(p,p);' +
    'if (a <= 0.0) discard; gl_FragColor = vec4(vCol.rgb, vCol.a * a); }';

  function makeProgram(vsrc, fsrc, attrs, unis) {
    function sh(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
      return s;
    }
    const v = sh(gl.VERTEX_SHADER, vsrc), f = sh(gl.FRAGMENT_SHADER, fsrc);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    const o = { p, a: {}, u: {} };
    attrs.forEach((n) => { o.a[n] = gl.getAttribLocation(p, n); });
    unis.forEach((n) => { o.u[n] = gl.getUniformLocation(p, n); });
    return o;
  }
  function initGL() {
    if (gl) return true;
    gl = glCv.getContext('webgl', { antialias: true, alpha: false }) || glCv.getContext('experimental-webgl');
    if (!gl) return false;
    prog = makeProgram(VS, FS, ['aPos', 'aCol', 'aGlow'],
      ['uMVP', 'uEye', 'uFog', 'uFogNear', 'uFogFar', 'uAlpha', 'uGlowCol', 'uPulse', 'uFlash']);
    ptsProg = makeProgram(VS_PTS, FS_PTS, ['aPos', 'aCol', 'aSize'], ['uMVP', 'uScale']);
    if (!prog || !ptsProg) { gl = null; return false; }
    prog.dynVbo = gl.createBuffer();
    prog.ptsVbo = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    return true;
  }
  function sizeGL() {
    if (!gl) return;
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    glCv.width = Math.max(1, Math.floor(glCv.clientWidth * dpr));
    glCv.height = Math.max(1, Math.floor(glCv.clientHeight * dpr));
    gl.viewport(0, 0, glCv.width, glCv.height);
  }
  addEventListener('resize', sizeGL);

  const FACES = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], sh: 0.78 },
    { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], sh: 0.66 },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], sh: 1.0 },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], sh: 0.5 },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], sh: 0.88 },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], sh: 0.6 }
  ];
  const AO_LVL = [1.0, 0.82, 0.68, 0.55];
  function hashVar(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return 0.93 + (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000 * 0.12;
  }
  function blockColor(b, face, pal) {
    switch (b) {
      case GRASS: return face === 2 ? pal.top : face === 3 ? pal.dirt : pal.side;
      case DIRT: return pal.dirt;
      case STONE: return pal.stone;
      case SAND: return pal.sand;
      case WOOD: return [0.42, 0.3, 0.18];
      case LEAF: return pal.leaf;
      case CHEST: return pal.accent;
      case ROCK: return [0.18, 0.19, 0.22];
      case SNOW: return pal.snow;
      case PILLAR: return mix3(pal.stone, pal.accent, 0.3);
      case MARKER: return mix3(pal.accent, [1, 1, 1], 0.35);
      case DAILY: return [0.95, 0.66, 0.25];
      default: return [1, 0, 1];
    }
  }

  function buildChunk(ci, cj) {
    const key = ci * CGRID + cj;
    let ch = chunks.get(key);
    if (!ch) { ch = { vbo: null, wvbo: null, count: 0, wcount: 0 }; chunks.set(key, ch); }
    const verts = [], wverts = [];
    const x0 = ci * CS, z0 = cj * CS;
    for (let x = x0; x < x0 + CS; x++) for (let z = z0; z < z0 + CS; z++) {
      const pal = paletteAt(x, z);
      const surfH = W.heights[x * SXZ + z];
      const stripe = W.markers && W.markers[x * SXZ + z];
      for (let y = 0; y < SY; y++) {
        const b = W.blocks[bIdx(x, y, z)];
        if (b === AIR) continue;
        const isWater = b === WATER;
        for (let fi = 0; fi < 6; fi++) {
          const F = FACES[fi];
          const nb = getB(x + F.n[0], y + F.n[1], z + F.n[2]);
          if (isWater) { if (nb !== AIR) continue; }
          else if (nb !== AIR && nb !== WATER) continue;
          let glow = b === CHEST || b === DAILY ? 1 : b === MARKER ? 0.9 : b === PILLAR ? 0.45 : 0;
          // 30-second time stripes glow on the walking surface
          if (stripe && fi === 2 && y === surfH && !isWater) glow = Math.max(glow, 0.55);
          let base, varr = 1;
          if (isWater) base = pal.water;
          else { base = blockColor(b, fi, pal); varr = hashVar(x, y, z); }
          const r0 = base[0] * F.sh * varr, g0 = base[1] * F.sh * varr, b0 = base[2] * F.sh * varr;
          const ox = x + (F.n[0] > 0 ? 1 : 0), oy = y + (F.n[1] > 0 ? 1 : 0), oz = z + (F.n[2] > 0 ? 1 : 0);
          const corner = [];
          for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
            const px = ox + i * F.u[0] + j * F.v[0];
            const py = oy + i * F.u[1] + j * F.v[1];
            const pz = oz + i * F.u[2] + j * F.v[2];
            let ao = 1;
            if (!isWater) {
              const sa = i ? 1 : -1, sb = j ? 1 : -1;
              const nbx = x + F.n[0], nby = y + F.n[1], nbz = z + F.n[2];
              const s1 = isSolid(nbx + sa * F.u[0], nby + sa * F.u[1], nbz + sa * F.u[2]) ? 1 : 0;
              const s2 = isSolid(nbx + sb * F.v[0], nby + sb * F.v[1], nbz + sb * F.v[2]) ? 1 : 0;
              const sc = isSolid(nbx + sa * F.u[0] + sb * F.v[0], nby + sa * F.u[1] + sb * F.v[1], nbz + sa * F.u[2] + sb * F.v[2]) ? 1 : 0;
              ao = AO_LVL[s1 && s2 ? 3 : s1 + s2 + sc];
            }
            corner.push([px, py, pz, ao]);
          }
          const flip = corner[0][3] + corner[3][3] < corner[1][3] + corner[2][3];
          const tri = flip
            ? [corner[1], corner[0], corner[2], corner[1], corner[2], corner[3]]
            : [corner[0], corner[2], corner[3], corner[0], corner[3], corner[1]];
          const out = isWater ? wverts : verts;
          for (const c of tri) out.push(c[0], c[1], c[2], r0 * c[3], g0 * c[3], b0 * c[3], glow);
        }
      }
    }
    if (!ch.vbo) ch.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ch.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    ch.count = verts.length / 7;
    if (!ch.wvbo) ch.wvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ch.wvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wverts), gl.STATIC_DRAW);
    ch.wcount = wverts.length / 7;
    ch.dirty = false; ch.built = true;
  }
  function clearChunks() {
    if (gl) for (const ch of chunks.values()) {
      if (ch.vbo) gl.deleteBuffer(ch.vbo);
      if (ch.wvbo) gl.deleteBuffer(ch.wvbo);
    }
    chunks.clear();
  }
  function markDirtyAt(x, z) {
    const ci = Math.floor(x / CS), cj = Math.floor(z / CS);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || i >= CGRID || j < 0 || j >= CGRID) continue;
      if (di !== 0 && x % CS !== (di < 0 ? 0 : CS - 1)) continue;
      if (dj !== 0 && z % CS !== (dj < 0 ? 0 : CS - 1)) continue;
      const ch = chunks.get(i * CGRID + j);
      if (ch && ch.built) ch.dirty = true;
    }
  }
  const VIEW_CHUNKS = 7; // build radius in chunks (~112 blocks)
  function ensureChunksAround(px, pz) {
    const pci = Math.floor(px / CS), pcj = Math.floor(pz / CS);
    let budget = 3;
    for (let r = 0; r <= VIEW_CHUNKS && budget > 0; r++) {
      for (let di = -r; di <= r && budget > 0; di++) for (let dj = -r; dj <= r && budget > 0; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = pci + di, j = pcj + dj;
        if (i < 0 || i >= CGRID || j < 0 || j >= CGRID) continue;
        const key = i * CGRID + j;
        const ch = chunks.get(key);
        if (!ch || !ch.built || ch.dirty) { buildChunk(i, j); budget--; }
      }
    }
    // drop far chunks to cap memory
    for (const [key, ch] of chunks) {
      const i = Math.floor(key / CGRID), j = key % CGRID;
      if (Math.max(Math.abs(i - pci), Math.abs(j - pcj)) > VIEW_CHUNKS + 2 && ch.built) {
        if (ch.vbo) gl.deleteBuffer(ch.vbo);
        if (ch.wvbo) gl.deleteBuffer(ch.wvbo);
        chunks.delete(key);
      }
    }
  }

  /* matrices */
  function m4mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function m4persp(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f;
    o[10] = (far + near) / (near - far); o[11] = -1;
    o[14] = 2 * far * near / (near - far);
    return o;
  }
  const m4rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); };
  const m4rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const m4trans = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

  function pushQuad(out, p0, p1, p2, p3, r, g, b, glow) {
    out.push(
      p0[0], p0[1], p0[2], r, g, b, glow, p1[0], p1[1], p1[2], r, g, b, glow,
      p2[0], p2[1], p2[2], r, g, b, glow, p0[0], p0[1], p0[2], r, g, b, glow,
      p2[0], p2[1], p2[2], r, g, b, glow, p3[0], p3[1], p3[2], r, g, b, glow
    );
  }
  function pushBox(out, x, y, z, sx, sy, sz, col, glow) {
    const x1 = x + sx, y1 = y + sy, z1 = z + sz;
    const r = col[0], g = col[1], b = col[2];
    pushQuad(out, [x, y1, z1], [x1, y1, z1], [x1, y1, z], [x, y1, z], r, g, b, glow);
    pushQuad(out, [x, y, z], [x1, y, z], [x1, y, z1], [x, y, z1], r * 0.5, g * 0.5, b * 0.5, glow);
    pushQuad(out, [x1, y, z1], [x1, y, z], [x1, y1, z], [x1, y1, z1], r * 0.78, g * 0.78, b * 0.78, glow);
    pushQuad(out, [x, y, z], [x, y, z1], [x, y1, z1], [x, y1, z], r * 0.66, g * 0.66, b * 0.66, glow);
    pushQuad(out, [x, y, z1], [x1, y, z1], [x1, y1, z1], [x, y1, z1], r * 0.88, g * 0.88, b * 0.88, glow);
    pushQuad(out, [x1, y, z], [x, y, z], [x, y1, z], [x1, y1, z], r * 0.6, g * 0.6, b * 0.6, glow);
  }

  /* ═══════════ particles ═══════════ */
  const MAXP = 300;
  let parts = [];
  function spawnPart(p) {
    if (reduceMotion) return;
    if (parts.length >= MAXP) parts.shift();
    parts.push(p);
  }
  function burst(x, y, z, col, n, spread) {
    for (let i = 0; i < (n || 16); i++) {
      spawnPart({
        x, y: y + 0.4, z,
        vx: (Math.random() - 0.5) * (spread || 8), vy: 2 + Math.random() * 6, vz: (Math.random() - 0.5) * (spread || 8),
        grav: 13, life: 0.8 + Math.random() * 0.5, t: 0,
        r: col[0], g: col[1], b: col[2], a: 0.95, size: 7 + Math.random() * 7
      });
    }
  }
  function updateParticles(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dt;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      p.vy -= (p.grav || 0) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
  }

  /* ═══════════ audio: area music + sfx ═══════════ */
  const Sfx = {
    ctx: null, master: null, muted: store.get('muted', false),
    init() {
      if (this.ctx) return;
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      } catch (e) { this.ctx = null; }
    },
    resume() { if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} } },
    setMuted(m) {
      this.muted = m; store.set('muted', m);
      if (this.master) this.master.gain.value = m ? 0 : 0.5;
      Music.setMuted(m);
    },
    tone(freq, dur, type, gain, when) {
      if (!this.ctx) return;
      try {
        const t = this.ctx.currentTime + (when || 0);
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type || 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain || 0.15, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(this.master);
        o.start(t); o.stop(t + dur + 0.05);
      } catch (e) {}
    },
    dig() { this.tone(220 + Math.random() * 60, 0.08, 'square', 0.05); },
    ping(closeness) { this.tone(660 + closeness * 620, 0.07, 'sine', 0.05 + closeness * 0.06); },
    loot() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.1, i * 0.08)); vibrate([30, 30, 80]); },
    death() { this.tone(140, 0.3, 'sawtooth', 0.1); this.tone(80, 0.45, 'square', 0.08, 0.05); vibrate([40, 30, 40]); },
    teleport() { this.tone(880, 0.12, 'sine', 0.07); this.tone(1320, 0.2, 'sine', 0.05, 0.06); },
    friend() { this.tone(784, 0.15, 'triangle', 0.08); this.tone(988, 0.2, 'triangle', 0.08, 0.1); },
    click() { this.tone(660, 0.05, 'square', 0.04); }
  };

  const Music = {
    a: null, b: null, cur: null, curTrackId: null, fadeT: 0, beats: [], beatIdx: 0, envArr: null, envDur: 30,
    init() {
      if (this.a) return;
      this.a = new Audio(); this.b = new Audio();
      for (const el of [this.a, this.b]) { el.loop = true; el.preload = 'none'; el.setAttribute('playsinline', ''); el.volume = 0; }
    },
    setMuted(m) { if (this.cur) this.cur.muted = m; if (this.a) { this.a.muted = m; this.b.muted = m; } },
    /* the song whose terrain you stand on is the song you hear, starting
       roughly where you stand in its timeline */
    playSong(song, startT) {
      this.init();
      this.beatIdx = 0;
      if (song) { this.envArr = song.arr; this.envDur = song.dur; this.beats = song.beats; }
      else {
        const p = pseudoEnvelope('pseudoenv|silence');
        this.envArr = p.env; this.envDur = p.dur; this.beats = p.beats;
      }
      const url = song && song.url ? (song.url.startsWith('/') ? W.cfg.origin + song.url : song.url) : null;
      if (!url) {
        this.curTrackId = song ? song.id : null;
        if (this.cur) { try { this.cur.pause(); } catch (e) {} }
        this.cur = null; this.fading = null;
        return;
      }
      if (this.curTrackId === song.id) return;
      this.curTrackId = song.id;
      const next = this.cur === this.a ? this.b : this.a;
      try {
        next.src = url; next.muted = Sfx.muted; next.volume = 0;
        const seek = clamp(startT || 0, 0, Math.max(0, song.dur - 2));
        next.addEventListener('loadedmetadata', () => {
          try { if (next.duration && seek < next.duration - 1) next.currentTime = seek; } catch (e) {}
        }, { once: true });
        const pr = next.play();
        if (pr && pr.catch) pr.catch(() => {});
      } catch (e) {}
      this.fading = { from: this.cur, to: next, t: 0 };
      this.cur = next;
    },
    stop() {
      this.curTrackId = null;
      for (const el of [this.a, this.b]) { if (el) { try { el.pause(); } catch (e) {} } }
      this.cur = null; this.fading = null;
    },
    /* returns {level, beat} for ambience; clock is the audio element when playing */
    tick(dt, tNow) {
      if (this.fading) {
        this.fading.t += dt;
        const k = clamp(this.fading.t / 1.2, 0, 1);
        if (this.fading.from) this.fading.from.volume = (1 - k) * 0.9;
        if (this.fading.to) this.fading.to.volume = k * 0.9;
        if (k >= 1) {
          if (this.fading.from) { try { this.fading.from.pause(); } catch (e) {} }
          this.fading = null;
        }
      }
      const t = this.cur && !this.cur.paused && this.cur.duration
        ? this.cur.currentTime % this.envDur
        : tNow % this.envDur;
      let beat = 0;
      if (this.beats.length) {
        if (this.beatIdx >= this.beats.length || (this.beatIdx > 0 && this.beats[this.beatIdx - 1] > t + 0.5)) this.beatIdx = 0;
        while (this.beatIdx < this.beats.length && this.beats[this.beatIdx] <= t) { beat = 1; this.beatIdx++; }
      }
      const arr = this.envArr;
      let level = 0.4;
      if (arr && arr.length) {
        const f = clamp(t / this.envDur * arr.length, 0, arr.length - 1.001);
        const i = f | 0;
        level = lerp(arr[i], arr[Math.min(arr.length - 1, i + 1)], f - i);
      }
      return { level: clamp(level, 0, 1), beat };
    }
  };

  /* ═══════════ player & input ═══════════ */
  const P = {
    x: SXZ / 2 + 0.5, y: 30, z: SXZ / 2 + 0.5, vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: -0.12, onGround: false, inWater: false, flying: false,
    invuln: 0, tpCool: 0, areaIdx: 4
  };
  const EYE = 1.62, HALF = 0.3, PH = 1.8, SPEED = 4.6, FLY_SPEED = 10, JUMP_V = 8.2, GRAV = 22;
  const keys = {};
  const joy = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
  const look = { id: -1, lx: 0, ly: 0, moved: 0, downT: 0, sx: 0, sy: 0, alt: false, lpFired: false };
  let jumpHeld = false, upHeld = false, downHeld = false;

  function collides(px, py, pz) {
    const x0 = Math.floor(px - HALF), x1 = Math.floor(px + HALF);
    const y0 = Math.floor(py), y1 = Math.floor(py + PH - 0.001);
    const z0 = Math.floor(pz - HALF), z1 = Math.floor(pz + HALF);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (isSolid(x, y, z)) return true;
    }
    return false;
  }
  function surfaceY(x, z) {
    const xi = clamp(Math.floor(x), 0, SXZ - 1), zi = clamp(Math.floor(z), 0, SXZ - 1);
    return Math.max(W.heights[xi * SXZ + zi], SEA) + 1.02;
  }
  function updatePlayer(dt) {
    let f = 0, s = 0;
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyA || keys.ArrowLeft) s -= 1;
    if (keys.KeyD || keys.ArrowRight) s += 1;
    if (joy.active) { f += -joy.dy; s += joy.dx; }
    const mag = Math.hypot(f, s);
    if (mag > 1) { f /= mag; s /= mag; }
    const cy = Math.cos(P.yaw), sy = Math.sin(P.yaw);
    const fx = -sy, fz = -cy, rx = cy, rz = -sy;

    if (P.flying) {
      const spd = FLY_SPEED;
      P.vx = (fx * f + rx * s) * spd;
      P.vz = (fz * f + rz * s) * spd;
      let vy = 0;
      if (jumpHeld || upHeld || keys.Space) vy += 8;
      if (downHeld || keys.ShiftLeft || keys.ShiftRight) vy -= 8;
      P.vy = vy;
    } else {
      const feetB = getB(Math.floor(P.x), Math.floor(P.y + 0.4), Math.floor(P.z));
      const eyeB = getB(Math.floor(P.x), Math.floor(P.y + EYE), Math.floor(P.z));
      P.inWater = feetB === WATER || eyeB === WATER;
      const spd = SPEED * (P.inWater ? 0.62 : 1);
      P.vx = (fx * f + rx * s) * spd;
      P.vz = (fz * f + rz * s) * spd;
      if (P.inWater) {
        P.vy -= 6 * dt;
        if (P.vy < -3) P.vy = -3;
        if (jumpHeld || keys.Space) P.vy = 3.2;
      } else {
        P.vy -= GRAV * dt;
        if ((jumpHeld || keys.Space) && P.onGround) { P.vy = JUMP_V; P.onGround = false; }
      }
    }

    let nx = P.x + P.vx * dt;
    if (!collides(nx, P.y, P.z)) P.x = nx;
    else {
      if (!P.flying && P.onGround && !P.inWater && Math.abs(P.vx) > 0.5 && !collides(nx, P.y + 1.05, P.z)) P.vy = JUMP_V * 0.85;
      P.vx = 0;
    }
    let nz = P.z + P.vz * dt;
    if (!collides(P.x, P.y, nz)) P.z = nz;
    else {
      if (!P.flying && P.onGround && !P.inWater && Math.abs(P.vz) > 0.5 && !collides(P.x, P.y + 1.05, nz)) P.vy = JUMP_V * 0.85;
      P.vz = 0;
    }
    const ny = P.y + P.vy * dt;
    if (!collides(P.x, ny, P.z)) { P.y = ny; P.onGround = false; }
    else {
      if (P.vy < 0) { P.y = Math.floor(ny) + 1.001; P.onGround = true; }
      P.vy = 0;
    }
    if (P.y > SY + 20) P.y = SY + 20;
    if (P.y < -6) { P.y = surfaceY(P.x, P.z) + 2; P.vy = 0; }
    const step = Math.hypot(P.vx, P.vz) * dt;
    if (step > 0.001 && step < 2) {
      S.kmAcc = (S.kmAcc || 0) + step / 1000;
      if (S.kmAcc > 0.05) { PP.bump('km', S.kmAcc); S.kmAcc = 0; }
    }
    P.invuln = Math.max(0, P.invuln - dt);
    P.tpCool = Math.max(0, P.tpCool - dt);
  }

  function raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stx = dx > 0 ? 1 : -1, sty = dy > 0 ? 1 : -1, stz = dz > 0 ? 1 : -1;
    const dtx = dx !== 0 ? Math.abs(1 / dx) : 1e9;
    const dty = dy !== 0 ? Math.abs(1 / dy) : 1e9;
    const dtz = dz !== 0 ? Math.abs(1 / dz) : 1e9;
    let tx = dx !== 0 ? ((stx > 0 ? x + 1 - ox : ox - x) * dtx) : 1e9;
    let ty = dy !== 0 ? ((sty > 0 ? y + 1 - oy : oy - y) * dty) : 1e9;
    let tz = dz !== 0 ? ((stz > 0 ? z + 1 - oz : oz - z) * dtz) : 1e9;
    let t = 0;
    for (let i = 0; i < 400 && t <= maxDist; i++) {
      if (tx < ty && tx < tz) { x += stx; t = tx; tx += dtx; }
      else if (ty < tz) { y += sty; t = ty; ty += dty; }
      else { z += stz; t = tz; tz += dtz; }
      const b = getB(x, y, z);
      if (b !== AIR && b !== WATER) return { x, y, z, b, t };
    }
    return null;
  }
  function screenRay(px, py) {
    const w = glCv.clientWidth, h = glCv.clientHeight;
    const fov = 1.22, aspect = w / h, th = Math.tan(fov / 2);
    const ndx = (2 * px / w - 1) * th * aspect;
    const ndy = (1 - 2 * py / h) * th;
    let dx = ndx, dy = ndy, dz = -1;
    const cp = Math.cos(P.pitch), sp = Math.sin(P.pitch);
    const dy2 = dy * cp - dz * sp, dz2 = dy * sp + dz * cp;
    dy = dy2; dz = dz2;
    const cy = Math.cos(P.yaw), sy = Math.sin(P.yaw);
    const dx2 = dx * cy + dz * sy, dz3 = -dx * sy + dz * cy;
    const len = Math.hypot(dx2, dy, dz3);
    return [dx2 / len, dy / len, dz3 / len];
  }

  function digAt(px, py) {
    const dir = screenRay(px, py);
    const hit = raycast(P.x, P.y + EYE, P.z, dir[0], dir[1], dir[2], 7);
    if (!hit || hit.y <= 0) return;
    if (hit.b === CHEST) { openLoot(hit); return; }
    if (hit.b === DAILY) { echoFound(hit); return; }
    if (hit.b === ROCK || hit.b === PILLAR || hit.b === MARKER) {
      showToast(hit.b === MARKER ? 'a time marker · every one is 30 seconds of the song' :
        hit.b === PILLAR ? 'the pillar hums · it will not break' : 'too hard to dig', 1400);
      return;
    }
    W.blocks[bIdx(hit.x, hit.y, hit.z)] = AIR;
    markDirtyAt(hit.x, hit.z);
    Sfx.dig();
    vibrate(12);
    const pal = paletteAt(hit.x, hit.z);
    burst(hit.x + 0.5, hit.y, hit.z + 0.5, blockColor(hit.b === WATER ? STONE : hit.b, 2, pal), 10, 5);
  }

  function teleportAt(px, py) {
    if (P.tpCool > 0) return;
    const dir = screenRay(px, py);
    let hit = raycast(P.x, P.y + EYE, P.z, dir[0], dir[1], dir[2], 140);
    let tx, tz;
    if (hit) { tx = hit.x + 0.5; tz = hit.z + 0.5; }
    else if (dir[1] < -0.02) {
      // aim at the sea-level plane when pointing at open sky over land
      const k = (P.y + EYE - SEA) / -dir[1];
      tx = P.x + dir[0] * k; tz = P.z + dir[2] * k;
    } else { showToast('point at the ground of a nearby area', 1500); return; }
    if (tx < 1 || tx >= SXZ - 1 || tz < 1 || tz >= SXZ - 1) { showToast('that is beyond this land', 1500); return; }
    const target = areaOf(tx, tz), cur = areaOf(P.x, P.z);
    if (target === cur) { showToast('teleport reaches the areas next door', 1500); return; }
    const dc = Math.abs(target % 3 - cur % 3), dr = Math.abs(Math.floor(target / 3) - Math.floor(cur / 3));
    if (dc > 1 || dr > 1) { showToast('too far · teleport reaches the areas next door', 1600); return; }
    const pal = palAtPlayer();
    burst(P.x, P.y + 1, P.z, pal.accent, 18, 6);
    P.x = tx; P.z = tz; P.y = surfaceY(tx, tz) + 1;
    P.vx = P.vy = P.vz = 0;
    P.tpCool = 2;
    Sfx.teleport();
    burst(P.x, P.y + 1, P.z, pal.accent, 18, 6);
    showToast('teleported to ' + areaLabel(target), 1600);
  }

  /* pointer input: bottom-left = joystick, elsewhere = look/tap */
  let lpTimer = 0;
  glCv.addEventListener('pointerdown', (e) => {
    if (!S.playing) return;
    Sfx.resume();
    const w = glCv.clientWidth, h = glCv.clientHeight;
    if (e.pointerType !== 'mouse' && e.clientX < w * 0.42 && e.clientY > h * 0.45 && !joy.active) {
      joy.active = true; joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.dx = 0; joy.dy = 0;
      const jb = $('joyBase');
      jb.style.left = (e.clientX - 48) + 'px'; jb.style.top = (e.clientY - 48) + 'px'; jb.style.opacity = '0.9';
      try { glCv.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }
    if (look.id === -1) {
      look.id = e.pointerId; look.lx = e.clientX; look.ly = e.clientY;
      look.sx = e.clientX; look.sy = e.clientY; look.moved = 0; look.downT = performance.now();
      look.alt = e.altKey; look.lpFired = false;
      try { glCv.setPointerCapture(e.pointerId); } catch (err) {}
      if (e.pointerType !== 'mouse') {
        clearTimeout(lpTimer);
        lpTimer = setTimeout(() => {
          if (look.id === e.pointerId && look.moved < 14) { look.lpFired = true; teleportAt(look.sx, look.sy); }
        }, 550);
      }
    }
  });
  glCv.addEventListener('pointermove', (e) => {
    if (!S.playing) return;
    if (e.pointerId === joy.id) {
      const dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
      const m = Math.hypot(dx, dy), max = 44;
      const k = m > max ? max / m : 1;
      joy.dx = (dx * k) / max; joy.dy = (dy * k) / max;
      $('joyKnob').style.transform = 'translate(' + dx * k + 'px,' + dy * k + 'px)';
      return;
    }
    if (e.pointerId === look.id) {
      const dx = e.clientX - look.lx, dy = e.clientY - look.ly;
      look.moved += Math.abs(dx) + Math.abs(dy);
      look.lx = e.clientX; look.ly = e.clientY;
      const k = 2.6 / Math.min(glCv.clientWidth, glCv.clientHeight);
      P.yaw -= dx * k;
      P.pitch = clamp(P.pitch - dy * k, -1.45, 1.45);
    }
  });
  function pointerEnd(e) {
    if (e.pointerId === joy.id) {
      joy.active = false; joy.id = -1; joy.dx = 0; joy.dy = 0;
      $('joyBase').style.opacity = '0';
      $('joyKnob').style.transform = '';
      return;
    }
    if (e.pointerId === look.id) {
      clearTimeout(lpTimer);
      const dtMs = performance.now() - look.downT;
      if (!look.lpFired && look.moved < 12 && dtMs < 350) {
        if (look.alt) teleportAt(look.sx, look.sy);
        else digAt(look.sx, look.sy);
      }
      look.id = -1;
    }
  }
  glCv.addEventListener('pointerup', pointerEnd);
  glCv.addEventListener('pointercancel', pointerEnd);
  glCv.addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('keydown', (e) => {
    if (!S.playing) return;
    keys[e.code] = true;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.code) >= 0) e.preventDefault();
    if (e.code === 'KeyF') toggleFly();
    if (e.code === 'Escape') exitToMenu();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });

  function toggleFly() {
    P.flying = !P.flying;
    P.vy = 0;
    $('btnFly').textContent = P.flying ? '🪽 flying' : '🪽 walk';
    $('btnFly').classList.toggle('lit', P.flying);
    $('btnJump').classList.toggle('hide', P.flying);
    $('btnUp').classList.toggle('hide', !P.flying);
    $('btnDown').classList.toggle('hide', !P.flying);
    showToast(P.flying ? 'flying · space rises, shift sinks' : 'back on foot', 1400);
    Sfx.click();
  }

  /* ═══════════ monsters (glooms) ═══════════ */
  let monsters = [];
  function spawnMonsters() {
    monsters = [];
    for (const c of [1, 3, 5, 7]) {
      const fn = W.arenaFns[c];
      const mrand = seeded('glooms|' + fn.key);
      const [tc, tr] = CORNER_TILE0[c];
      for (let i = 0; i < 4; i++) {
        const x = tc * AREA + 12 + mrand() * (AREA - 24);
        const z = tr * AREA + 12 + mrand() * (AREA - 24);
        monsters.push({
          x, z, y: 0, tx: x, tz: z, corner: c,
          speed: 2.6 + mrand() * 1.2, retarget: mrand() * 4, phase: mrand() * 6.28,
          hue: mrand()
        });
      }
    }
  }
  function updateMonsters(dt, t) {
    const curArea = P.areaIdx;
    for (const m of monsters) {
      const active = AREA_CORNER[curArea] === m.corner;
      if (!active) continue;
      const [tc, tr] = CORNER_TILE0[m.corner];
      const dx = P.x - m.x, dz = P.z - m.z;
      const dp = Math.hypot(dx, dz);
      const playerInArena = areaOf(P.x, P.z) === curArea;
      if (playerInArena && dp < 15 && !P.flying) {
        m.tx = P.x; m.tz = P.z;
      } else {
        m.retarget -= dt;
        if (m.retarget <= 0) {
          m.retarget = 2.5 + Math.random() * 3;
          m.tx = tc * AREA + 10 + Math.random() * (AREA - 20);
          m.tz = tr * AREA + 10 + Math.random() * (AREA - 20);
        }
      }
      if (m.tamed) {
        // a tamed gloom pads along behind its fan
        if (playerInArena && dp > 3.2) { m.tx = P.x; m.tz = P.z; }
        else if (playerInArena) { m.tx = m.x; m.tz = m.z; }
      } else if (playerInArena && !P.flying) {
        // close-call taming: slip out of its jaws three times and it warms to you
        if (dp < 2.1 && P.invuln <= 0) m.hot = true;
        if (m.hot && dp > 7) {
          m.hot = false;
          m.dodges = (m.dodges || 0) + 1;
          if (m.dodges >= 3) {
            m.tamed = true;
            PP.bump('tamed', 1);
            burst(m.x, m.y + 1.2, m.z, [1, 0.55, 0.7], 20, 5);
            showToast('♥ you tamed a gloom · it likes you now', 3200);
            vibrate([15, 20, 15]);
          } else showToast('the gloom hesitates… (' + m.dodges + '/3)', 1600);
        }
      }
      const mdx = m.tx - m.x, mdz = m.tz - m.z;
      const md = Math.hypot(mdx, mdz);
      if (md > 0.4) {
        const chase = !m.tamed && playerInArena && dp < 15 && !P.flying;
        const sp = m.speed * (chase ? 1.5 : m.tamed ? 1.3 : 1);
        m.x += (mdx / md) * sp * dt;
        m.z += (mdz / md) * sp * dt;
        // keep them inside their arena
        m.x = clamp(m.x, tc * AREA + 2, tc * AREA + AREA - 2);
        m.z = clamp(m.z, tr * AREA + 2, tr * AREA + AREA - 2);
      }
      m.y = surfaceY(m.x, m.z) + 0.1 + Math.abs(Math.sin(t * 6 + m.phase)) * 0.35;
      if (!m.tamed && playerInArena && P.invuln <= 0 && dp < 1.35 && Math.abs((P.y + 0.9) - m.y) < 2.2) {
        killPlayer(m);
      }
    }
  }
  function killPlayer(m) {
    P.invuln = 5;
    Sfx.death();
    const el = $('crashFlash');
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    burst(P.x, P.y + 1, P.z, [1, 0.35, 0.2], 26, 9);
    // back to the inner corner of the arena, alive and intact
    const c = m.corner;
    const [tc, tr] = CORNER_TILE0[c];
    const inner = OUTER_PT[c];
    const ix = tc * AREA + (inner[0] === 0 ? AREA - 6 : 6);
    const iz = tr * AREA + (inner[1] === 0 ? AREA - 6 : 6);
    $('deathVeil').classList.add('on');
    S.live = false;
    S.pendingRespawn = { x: ix, z: iz };
  }
  $('btnRespawn').addEventListener('click', () => {
    $('deathVeil').classList.remove('on');
    if (S.pendingRespawn) {
      P.x = S.pendingRespawn.x; P.z = S.pendingRespawn.z;
      P.y = surfaceY(P.x, P.z) + 1;
      P.vx = P.vy = P.vz = 0;
      S.pendingRespawn = null;
    }
    S.live = true;
  });

  /* ═══════════ loot & radar ═══════════ */
  const RADAR_R = 30;
  const radarCv = $('radar');
  const radarCtx = radarCv.getContext('2d');
  let pingTimer = 0, radarOn = false, sweep = 0;

  function activeLootList() {
    const key = areaKeyOf(P.areaIdx);
    const list = (W.lootByArea[key] || []).slice();
    if (W.echo && areaOf(W.echo.x, W.echo.z) === P.areaIdx) list.push({ id: 'echo', x: W.echo.x, z: W.echo.z });
    return list;
  }
  function nearestLoot() {
    let best = null, bd = 1e9;
    for (const l of activeLootList()) {
      const d = Math.hypot(l.x + 0.5 - P.x, l.z + 0.5 - P.z);
      if (d < bd) { bd = d; best = l; }
    }
    return best ? { loot: best, d: bd } : null;
  }
  function updateRadar(dt) {
    const near = nearestLoot();
    const show = !!near && near.d < RADAR_R && S.live;
    if (show !== radarOn) { radarOn = show; $('radarWrap').classList.toggle('on', show); }
    if (!show) return;
    const hot = clamp(1 - near.d / RADAR_R, 0, 1);
    pingTimer -= dt;
    if (pingTimer <= 0) { Sfx.ping(hot); pingTimer = lerp(1.5, 0.14, hot); vibrate(6); }
    sweep += dt * 2.4;
    const c = radarCtx, R = 108;
    c.clearRect(0, 0, 216, 216);
    c.save();
    c.translate(R, R);
    c.fillStyle = 'rgba(20,15,30,0.72)';
    c.beginPath(); c.arc(0, 0, R - 4, 0, 6.284); c.fill();
    c.strokeStyle = 'rgba(242,163,60,0.5)';
    c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, R - 4, 0, 6.284); c.stroke();
    c.strokeStyle = 'rgba(242,163,60,0.18)';
    for (const rr of [0.33, 0.66]) { c.beginPath(); c.arc(0, 0, (R - 4) * rr, 0, 6.284); c.stroke(); }
    // sweep
    const grad = c.createConicGradient ? c.createConicGradient(sweep, 0, 0) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(242,163,60,0.3)');
      grad.addColorStop(0.12, 'rgba(242,163,60,0)');
      grad.addColorStop(1, 'rgba(242,163,60,0)');
      c.fillStyle = grad;
      c.beginPath(); c.arc(0, 0, R - 6, 0, 6.284); c.fill();
    }
    // blips: rotate so "up" is where the camera looks
    for (const l of activeLootList()) {
      const dx = l.x + 0.5 - P.x, dz = l.z + 0.5 - P.z;
      const d = Math.hypot(dx, dz);
      if (d > RADAR_R) continue;
      const ang = Math.atan2(dx, -dz) + P.yaw;
      const rr = (d / RADAR_R) * (R - 14);
      const bx = Math.sin(ang) * rr, by = -Math.cos(ang) * rr;
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 180);
      c.fillStyle = 'rgba(242,163,60,' + (0.5 + 0.5 * pulse) + ')';
      c.beginPath(); c.arc(bx, by, 5 + hot * 3, 0, 6.284); c.fill();
    }
    // center: you
    c.fillStyle = 'rgba(69,184,164,0.9)';
    c.beginPath(); c.arc(0, 0, 4, 0, 6.284); c.fill();
    c.restore();
  }

  let lootBusy = false;
  function openLoot(hit) {
    if (lootBusy) return;
    const entry = W.lootBlocks.get(hit.x + ',' + hit.z + ',' + hit.y);
    if (!entry) return;
    lootBusy = true;
    const removeChest = () => {
      W.blocks[bIdx(hit.x, hit.y, hit.z)] = AIR;
      markDirtyAt(hit.x, hit.z);
      W.lootBlocks.delete(hit.x + ',' + hit.z + ',' + hit.y);
      const key = areaKeyOf(P.areaIdx);
      if (W.lootByArea[key]) W.lootByArea[key] = W.lootByArea[key].filter((l) => l.id !== entry.id);
    };
    const done = (payload, failed, expired) => {
      lootBusy = false;
      if (failed) {
        // an expired or exhausted box vanishes for this fan too
        if (expired) removeChest();
        showToast(payload || 'that world is asleep · try again soon', 2600);
        return;
      }
      removeChest();
      Sfx.loot();
      const pal = palAtPlayer();
      burst(hit.x + 0.5, hit.y + 1, hit.z + 0.5, pal.accent, 30, 8);
      const found = store.get('found', []);
      if (found.indexOf(entry.id) < 0) {
        found.push(entry.id);
        store.set('found', found.slice(-200));
        Stats.find();
        rememberFind({ id: entry.id, t: (payload.title || 'Buried loot').slice(0, 60), w: W.cfg.name, f: payload.finder || 0, at: Date.now() });
      }
      paintLootModal(payload);
      $('lootModal').classList.add('on');
    };
    if (entry.demo) {
      done({ title: 'Practice chest', message: 'This is what fans find in a real world: a note from the artist, a link, sometimes a code.', code: null, url: null, remaining: null });
      return;
    }
    // status-aware: a 404 means the box is gone (out of claims or out of
    // time), which is different from the world being unreachable
    const ctrl = window.AbortController ? new AbortController() : null;
    const tm = setTimeout(() => { if (ctrl) ctrl.abort(); }, 8000);
    fetch(entry.origin + '/api/loot/claim', Object.assign({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lootId: entry.id, fanId: fan.id, fanName: fan.name || '' })
    }, ctrl ? { signal: ctrl.signal } : {})).then((r) => {
      clearTimeout(tm);
      return r.json().catch(() => null).then((d) => {
        if (d && d.ok && d.loot) done(d.loot);
        else done('this chest is empty now · someone got here first, or its time ran out', true, true);
      });
    }).catch(() => { clearTimeout(tm); done(null, true, false); });
  }
  let lootCtx = null; // {lootId} for the email step
  function paintLootModal(payload) {
    lootCtx = { lootId: payload.id };
    $('lootTitle').textContent = payload.title || 'Buried loot';
    $('lootMsg').textContent = payload.message || '';
    const codeEl = $('lootCode');
    if (payload.code) { codeEl.style.display = ''; codeEl.textContent = payload.code; } else codeEl.style.display = 'none';
    const openEl = $('lootOpen');
    if (payload.url && /^https?:\/\//i.test(payload.url)) { openEl.style.display = ''; openEl.href = payload.url; } else openEl.style.display = 'none';
    $('lootFinder').textContent = payload.finder ? 'you were finder #' + payload.finder + ' of this drop' : '';
    const bits = [];
    if (payload.remaining !== null && payload.remaining !== undefined) {
      bits.push(payload.remaining === 0 ? 'you got the last one' : payload.remaining + ' left for other fans');
    }
    if (payload.endsAt && payload.endsAt > Date.now()) {
      const mins = Math.round((payload.endsAt - Date.now()) / 60000);
      bits.push(mins > 120 ? 'gone in ' + Math.round(mins / 60) + ' hours' : 'gone in ' + Math.max(1, mins) + ' minutes');
    }
    $('lootRemaining').textContent = bits.join(' · ');
    const row = $('lootEmailRow');
    if (payload.emailAsk) {
      row.style.display = '';
      $('lootEmailAsk').textContent = payload.emailAsk === 'required'
        ? 'This one arrives by email. Leave yours and it is on its way.'
        : 'Want news from ' + (W.cfg.artist || 'this artist') + '? Leave your email.';
      $('lootEmailNote').textContent = 'Goes only to ' + (W.cfg.artist || 'the artist') + ', stored on their own account. Nothing else sees it.';
    } else row.style.display = 'none';
  }
  $('lootEmailGo').addEventListener('click', () => {
    if (!lootCtx) return;
    const email = $('lootEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showToast('that email does not look right', 1800); return; }
    fetchJson(W.cfg.origin + '/api/loot/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lootId: lootCtx.lootId, fanId: fan.id, fanName: fan.name || '', email, consent: true })
    }, 8000).then((d) => {
      if (d && d.ok) {
        $('lootEmailRow').style.display = 'none';
        $('lootEmail').value = '';
        if (d.loot && (d.loot.url || d.loot.code)) {
          if (d.loot.code) { $('lootCode').style.display = ''; $('lootCode').textContent = d.loot.code; }
          if (d.loot.url && /^https?:\/\//i.test(d.loot.url)) { $('lootOpen').style.display = ''; $('lootOpen').href = d.loot.url; }
        }
        showToast('done · check your inbox for anything the artist sends', 2600);
      } else showToast((d && d.error) || 'that did not go through', 2200);
    }).catch(() => showToast('the world did not answer · try again', 2200));
  });
  $('lootClose').addEventListener('click', () => $('lootModal').classList.remove('on'));

  /* ═══════════ presence & friends ═══════════ */
  const Presence = {
    ws: null, key: null, others: new Map(), beaconT: 0,
    hostFor(areaIdx) {
      const c = AREA_CORNER[areaIdx];
      if (c !== undefined) {
        const link = W.cfg.links.find((l) => l.corner === c);
        if (link && link.other.origin) {
          return link.other.id < W.cfg.worldId ? link.other.origin : W.cfg.origin;
        }
      }
      return W.cfg.origin;
    },
    join(areaIdx) {
      const key = areaKeyOf(areaIdx);
      if (this.key === key && this.ws && this.ws.readyState <= 1) return;
      this.leave();
      if (W.cfg.demo) return;
      this.key = key;
      const host = this.hostFor(areaIdx).replace(/^http/, 'ws');
      const tryConnect = (origin, isFallback) => {
        let ws;
        try {
          ws = new WebSocket(origin + '/api/presence/' + encodeURIComponent(key) +
            '?fan=' + encodeURIComponent(fan.id) + '&name=' + encodeURIComponent(fan.name || 'a fan'));
        } catch (e) { return; }
        ws.onmessage = (ev) => {
          let m = null;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (!m) return;
          if (m.t === 'roster' && Array.isArray(m.fans)) {
            for (const f of m.fans.slice(0, 40)) this.seen(f.fan, f.name, null, true);
          } else if (m.t === 'join') this.seen(m.fan, m.name, null, false);
          else if (m.t === 'leave') this.others.delete(m.fan);
          else if (m.t === 'beacon') this.seen(m.fan, m.name, m, true);
        };
        ws.onclose = () => {
          if (this.ws === ws) {
            this.ws = null;
            // the linked host may be down: fall back to our own hub once
            if (!isFallback && !ws.everOpen && origin !== W.cfg.origin.replace(/^http/, 'ws')) {
              tryConnect(W.cfg.origin.replace(/^http/, 'ws'), true);
            }
          }
        };
        ws.onopen = () => { ws.everOpen = true; };
        ws.onerror = () => {};
        this.ws = ws;
      };
      tryConnect(host, false);
    },
    seen(id, name, beacon, quiet) {
      if (!id || id === fan.id) return;
      const known = this.others.has(id);
      const o = this.others.get(id) || { name: String(name || 'a fan').slice(0, 24) };
      if (beacon) { o.x = Number(beacon.x) || 0; o.y = Number(beacon.y) || 0; o.z = Number(beacon.z) || 0; }
      o.seen = performance.now();
      this.others.set(id, o);
      if (!known && !quiet) {
        if (isFriend(id)) { Sfx.friend(); showToast('★ your friend ' + o.name + ' is here', 3200); vibrate([20, 30, 20]); }
        else showToast(o.name + ' wandered in', 2000);
      } else if (!known && quiet && isFriend(id)) {
        Sfx.friend(); showToast('★ your friend ' + o.name + ' is in this area', 3200);
      }
    },
    tick(dt) {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.beaconT -= dt;
      if (this.beaconT <= 0) {
        this.beaconT = 10;
        try { this.ws.send(JSON.stringify({ t: 'beacon', x: Math.round(P.x), y: Math.round(P.y), z: Math.round(P.z) })); } catch (e) {}
      }
    },
    leave() {
      if (this.ws) { try { this.ws.close(); } catch (e) {} }
      this.ws = null; this.key = null;
      this.others.clear();
    }
  };

  /* ═══════════ photo mode ═══════════ */
  let shotCtx = { link: '' };
  function spotLink() {
    return location.origin + '/#at=' + Math.round(P.x) + ',' + Math.round(P.z);
  }
  function captureShot() {
    try {
      const w = glCv.width, h = glCv.height;
      const barH = Math.round(h * 0.11);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h + barH;
      const c = cv.getContext('2d');
      c.fillStyle = '#171226';
      c.fillRect(0, 0, cv.width, cv.height);
      c.drawImage(glCv, 0, 0);
      const pad = Math.round(w * 0.045), base = h + barH * 0.38;
      c.fillStyle = '#f2ead8';
      c.font = '700 ' + Math.round(barH * 0.3) + 'px "Space Mono", monospace';
      c.fillText(W.cfg.name.toUpperCase().slice(0, 34), pad, base);
      const sa = songAt(P.x, P.z);
      c.fillStyle = 'rgba(242,234,216,0.65)';
      c.font = Math.round(barH * 0.22) + 'px "Space Mono", monospace';
      c.fillText(((sa && !sa.beyond) ? sa.song.title.slice(0, 26) + ' · ' + fmtTime(sa.t) + ' · ' : '') + AREA_NAMES[areaOf(P.x, P.z)], pad, base + barH * 0.28);
      c.fillStyle = '#f2a33c';
      c.fillText(spotLink().replace(/^https?:\/\//, ''), pad, base + barH * 0.54);
      openShot(cv.toDataURL('image/png'), '📷 Your shot', 'tuneland-shot.png', spotLink(),
        'Found this spot in ' + W.cfg.name + ' · walk in here: ');
    } catch (e) { showToast('the shot did not come out · try again', 1800); }
  }
  function openShot(dataUrl, eyebrow, filename, link, shareText) {
    shotCtx = { dataUrl, filename, link, shareText };
    $('shotEyebrow').textContent = eyebrow;
    $('shotImg').src = dataUrl;
    $('shotDownload').href = dataUrl;
    $('shotDownload').setAttribute('download', filename);
    $('shotModal').classList.add('on');
  }
  $('btnShot').addEventListener('click', () => { S.shotPending = true; Sfx.click(); });
  $('shotClose').addEventListener('click', () => $('shotModal').classList.remove('on'));
  $('shotCopyLink').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(shotCtx.link).then(() => {
      $('shotCopyLink').textContent = 'Copied · paste it anywhere';
      setTimeout(() => { $('shotCopyLink').textContent = 'Copy a link to this spot'; }, 2200);
    }).catch(() => {});
  });
  $('shotShare').addEventListener('click', async () => {
    try {
      const blob = await (await fetch(shotCtx.dataUrl)).blob();
      const file = new File([blob], shotCtx.filename, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: shotCtx.shareText + shotCtx.link });
        return;
      }
    } catch (e) {}
    if (navigator.share) { navigator.share({ text: shotCtx.shareText, url: shotCtx.link }).catch(() => {}); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(shotCtx.shareText + shotCtx.link).catch(() => {});
      showToast('link copied · the picture is under "save the picture"', 2600);
    }
  });

  /* ═══════════ races: a time trial in a link, ghost included ═══════════ */
  const Race = { rec: null, incoming: null, active: null };
  function pathAt(path, tSec) {
    const f = clamp(tSec * 2, 0, path.length - 1.0001);
    const i = f | 0;
    const j = Math.min(path.length - 1, i + 1);
    return [lerp(path[i][0], path[j][0], f - i), lerp(path[i][1], path[j][1], f - i)];
  }
  function startRaceRec() {
    Race.rec = { t0: performance.now(), sx: P.x, sz: P.z, path: [[P.x, P.z]], acc: 0 };
    $('btnRace').classList.add('lit');
    showToast('🏁 race started · run, then press 🏁 at the finish', 3200);
    Sfx.click();
  }
  function cancelRaceRec(msg) {
    Race.rec = null;
    $('btnRace').classList.remove('lit');
    if (msg) showToast(msg, 2200);
  }
  function finishRaceRec() {
    const r = Race.rec;
    const dist = Math.hypot(P.x - r.sx, P.z - r.sz);
    if (dist < 10) { cancelRaceRec('too short for a race · run at least a little way'); return; }
    const tMs = Math.round(performance.now() - r.t0);
    r.path.push([P.x, P.z]);
    const obj = {
      v: 1, s: [Math.round(r.sx), Math.round(r.sz)], f: [Math.round(P.x), Math.round(P.z)],
      t: tMs, n: (fan.name || 'a fan').slice(0, 24), g: encodePath(r.path)
    };
    cancelRaceRec();
    S.raceShareUrl = location.origin + '/#race=' + jsonToB64u(obj);
    $('raceTitle').textContent = (tMs / 1000).toFixed(1) + 's';
    $('raceMsg').textContent = 'You ran ' + Math.round(dist) + ' blocks. Send the link and a friend races your ghost on this exact stretch.';
    $('raceModal').classList.add('on');
  }
  $('btnRace').addEventListener('click', () => {
    if (!S.playing || !S.live) return;
    if (Race.active) { showToast('finish this race first', 1600); return; }
    if (Race.rec) finishRaceRec();
    else startRaceRec();
  });
  $('raceClose').addEventListener('click', () => $('raceModal').classList.remove('on'));
  $('raceShare').addEventListener('click', () => {
    const text = '🏁 Race my ghost in ' + W.cfg.name + ': ';
    if (navigator.share) navigator.share({ text, url: S.raceShareUrl }).catch(() => {});
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + S.raceShareUrl).then(() => {
        $('raceShare').textContent = 'Copied · send it';
        setTimeout(() => { $('raceShare').textContent = 'Share this race'; }, 2200);
      }).catch(() => {});
    }
  });
  function parseRaceHash() {
    try {
      const m = location.hash.match(/[#&]race=([A-Za-z0-9\-_]+)/);
      if (!m) return null;
      const p = b64uToJson(m[1]);
      if (!p || p.v !== 1 || !Array.isArray(p.s) || !Array.isArray(p.f) || typeof p.t !== 'number') return null;
      const path = decodePath(p.g);
      if (!path) return null;
      return {
        s: [clamp(Number(p.s[0]) || 0, 2, SXZ - 3), clamp(Number(p.s[1]) || 0, 2, SXZ - 3)],
        f: [clamp(Number(p.f[0]) || 0, 2, SXZ - 3), clamp(Number(p.f[1]) || 0, 2, SXZ - 3)],
        t: clamp(Math.round(p.t), 1000, 30 * 60e3),
        n: String(p.n || 'a fan').slice(0, 24),
        path
      };
    } catch (e) { return null; }
  }
  function beginIncomingRace(race) {
    Race.active = { race, phase: 'count', count: 3.999 };
    P.x = race.s[0] + 0.5; P.z = race.s[1] + 0.5;
    P.y = surfaceY(P.x, P.z) + 1;
    P.vx = P.vy = P.vz = 0;
    // face the finish line
    P.yaw = Math.atan2(-(race.f[0] - P.x), -(race.f[1] - P.z));
  }
  function updateRace(dt) {
    if (Race.rec) {
      Race.rec.acc += dt;
      while (Race.rec.acc >= 0.5) {
        Race.rec.acc -= 0.5;
        Race.rec.path.push([P.x, P.z]);
        if (Race.rec.path.length > 240) { cancelRaceRec('race too long · it reset'); return; }
      }
    }
    const A2 = Race.active;
    if (!A2) return;
    if (A2.phase === 'count') {
      const before = Math.ceil(A2.count);
      A2.count -= dt;
      const now2 = Math.ceil(A2.count);
      if (now2 !== before && now2 > 0) { showBanner(String(now2), null); Sfx.click(); }
      if (A2.count <= 0) {
        A2.phase = 'run';
        A2.t0 = performance.now();
        A2.myPath = [[P.x, P.z]];
        A2.acc = 0;
        showBanner('GO', 'beat ' + A2.race.n + ' to the marker');
        Sfx.teleport();
      }
      return;
    }
    A2.acc += dt;
    while (A2.acc >= 0.5) {
      A2.acc -= 0.5;
      A2.myPath.push([P.x, P.z]);
      if (A2.myPath.length > 240) A2.myPath.shift();
    }
    const elapsed = performance.now() - A2.t0;
    if (Math.hypot(P.x - (A2.race.f[0] + 0.5), P.z - (A2.race.f[1] + 0.5)) < 3.5) {
      const mine = Math.round(elapsed);
      const won = mine < A2.race.t;
      Sfx.loot();
      showBanner(won ? 'You won' : 'Their ghost won',
        (mine / 1000).toFixed(1) + 's vs ' + (A2.race.t / 1000).toFixed(1) + 's');
      const obj = {
        v: 1, s: A2.race.s, f: A2.race.f,
        t: won ? mine : A2.race.t,
        n: won ? (fan.name || 'a fan').slice(0, 24) : A2.race.n,
        g: won ? encodePath(A2.myPath) : encodePath(A2.race.path)
      };
      S.raceShareUrl = location.origin + '/#race=' + jsonToB64u(obj);
      $('raceTitle').textContent = (mine / 1000).toFixed(1) + 's' + (won ? ' · new record' : '');
      $('raceMsg').textContent = won
        ? 'You beat ' + A2.race.n + '. Share the link and dare the next one.'
        : A2.race.n + ' keeps the record at ' + (A2.race.t / 1000).toFixed(1) + 's. Share it or try again.';
      $('raceModal').classList.add('on');
      Race.active = null;
    } else if (elapsed > A2.race.t * 5 + 30000) {
      Race.active = null;
      showToast('the ghost got away · race called off', 2600);
    }
  }

  /* ═══════════ passport ═══════════ */
  function passportStats() {
    const pp = PP.get();
    const visited = store.get('visited', {});
    const log = store.get('foundLog', []);
    const done = questsDone();
    let walked = 0;
    for (const wid in done) walked += Object.keys(done[wid]).length;
    const crownList = Object.values(crowns());
    return {
      worlds: Object.keys(visited).length,
      finds: Math.max(log.length, (store.get('found', []) || []).length),
      walked, crowns: crownList,
      streak: pp.streak || 0, tamed: pp.tamed || 0, echoes: pp.echoes || 0,
      km: pp.km || 0, bestFinder: pp.bestFinder || 0, log
    };
  }
  function openPassport() {
    const st = passportStats();
    const grid = $('passGrid');
    grid.textContent = '';
    const tile = (v, label) => {
      const d = document.createElement('div');
      d.className = 'pg';
      const b = document.createElement('b');
      b.textContent = String(v);
      const s2 = document.createElement('span');
      s2.textContent = label;
      d.appendChild(b); d.appendChild(s2);
      grid.appendChild(d);
    };
    tile(st.worlds, 'worlds visited');
    tile(st.finds, 'chests found');
    tile(st.walked, 'pieces walked');
    tile(st.crowns.length, 'worlds crowned');
    tile(st.streak, 'day streak');
    tile(st.tamed, 'glooms tamed');
    tile(st.km.toFixed(1) + 'km', 'wandered');
    tile(st.bestFinder ? '#' + st.bestFinder : '·', 'best finder rank');
    $('passCrowns').textContent = st.crowns.length ? 'Crowned: ' + st.crowns.join(', ') : 'No worlds crowned yet. Walk every piece of one.';
    const finds = $('passFinds');
    finds.textContent = '';
    if (!st.log.length) {
      const p = document.createElement('div');
      p.className = 'pf';
      p.textContent = 'Nothing dug up yet. Follow the radar.';
      finds.appendChild(p);
    }
    for (const e of st.log.slice(0, 12)) {
      const p = document.createElement('div');
      p.className = 'pf';
      p.textContent = e.t + ' · ' + (e.w || '') + ' ';
      if (e.f) {
        const i = document.createElement('i');
        i.textContent = '#' + e.f;
        p.appendChild(i);
      }
      finds.appendChild(p);
    }
    $('passModal').classList.add('on');
  }
  function renderPassCard() {
    const st = passportStats();
    const cv = document.createElement('canvas');
    cv.width = 900; cv.height = 1200;
    const c = cv.getContext('2d');
    c.fillStyle = '#171226';
    c.fillRect(0, 0, 900, 1200);
    for (let i = 0; i < 40; i++) { // scattered voxel confetti
      const rr = seeded('card|' + fan.id)();
      c.fillStyle = ['#f2a33c', '#45b8a4', '#e2603f'][i % 3] + '22';
      c.fillRect((i * 137) % 860 + 20, (i * 271) % 1160 + 20, 18, 18);
    }
    c.fillStyle = '#f2a33c';
    c.font = '700 34px "Space Mono", monospace';
    c.fillText('TUNELAND PASSPORT', 60, 110);
    c.fillStyle = '#f2ead8';
    c.font = '800 72px "Bricolage Grotesque", sans-serif';
    c.fillText((fan.name || 'A wandering fan').slice(0, 20), 60, 210);
    const rows = [
      [st.worlds, 'worlds visited'], [st.finds, 'chests found'],
      [st.walked, 'pieces walked end to end'], [st.crowns.length, 'worlds crowned'],
      [st.streak, 'day echo streak'], [st.tamed, 'glooms tamed'],
      [st.km.toFixed(1) + ' km', 'wandered on foot and wing']
    ];
    rows.forEach((r, i) => {
      const y = 330 + i * 105;
      c.fillStyle = '#f2a33c';
      c.font = '700 58px "Space Mono", monospace';
      c.fillText(String(r[0]), 60, y);
      c.fillStyle = 'rgba(242,234,216,0.75)';
      c.font = '26px "Space Mono", monospace';
      c.fillText(r[1], 300, y - 8);
    });
    c.fillStyle = 'rgba(242,234,216,0.5)';
    c.font = '24px "Space Mono", monospace';
    c.fillText('wander the worlds · midhrami.com/tuneland', 60, 1140);
    openShot(cv.toDataURL('image/png'), '🎒 Your passport', 'tuneland-passport.png',
      'https://midhrami.com/tuneland/', 'My Tuneland passport so far: ');
  }
  $('btnPassport').addEventListener('click', openPassport);
  $('passClose').addEventListener('click', () => $('passModal').classList.remove('on'));
  $('passCard').addEventListener('click', () => { $('passModal').classList.remove('on'); renderPassCard(); });

  /* ═══════════ crossing into linked worlds ═══════════ */
  const neighborCache = {}; // origin -> config (in-memory for this session)
  function prefetchNeighbor(corner) {
    const link = W.cfg.links.find((l) => l.corner === corner);
    if (!link || !link.other.origin || neighborCache[link.other.origin] !== undefined) return;
    neighborCache[link.other.origin] = null; // in flight
    loadConfig(link.other.origin).then((cfg) => { neighborCache[link.other.origin] = cfg; });
  }
  function maybeCross() {
    const ai = areaOf(P.x, P.z);
    const c = AREA_CORNER[ai];
    if (c === undefined) return;
    const link = W.cfg.links.find((l) => l.corner === c);
    if (!link) return;
    prefetchNeighbor(c);
    const [tc, tr] = CORNER_TILE0[c];
    const u = P.x - tc * AREA, v = P.z - tr * AREA;
    const [ou, ov] = OUTER_PT[c];
    const dOuter = Math.hypot(u - ou, v - ov);
    if (dOuter > 40) return;
    // the fan is deep in the shared corner heading outward: swap worlds
    let ncfg = neighborCache[link.other.origin];
    if (!ncfg) {
      // neighbor asleep: synthesize enough config to keep walking (the shared
      // arena is deterministic; the rest of their land uses default colors)
      ncfg = normalizeConfig(Object.assign(demoConfig(), {
        worldId: link.other.id,
        name: link.other.name,
        artist: '',
        links: [{ id: link.id, corner: OPP_CORNER[c], other: { id: W.cfg.worldId, origin: W.cfg.origin, name: W.cfg.name } }],
        demo: false
      }), link.other.origin || W.cfg.origin);
      ncfg.asleep = true;
    }
    crossTo(ncfg, c);
  }
  function crossTo(ncfg, corner) {
    const opp = OPP_CORNER[corner];
    const [tcA, trA] = CORNER_TILE0[corner];
    const [tcB, trB] = CORNER_TILE0[opp];
    const u = P.x - tcA * AREA, v = P.z - trA * AREA;
    const keepY = P.y, keepYaw = P.yaw, keepPitch = P.pitch, keepFly = P.flying;
    Presence.leave();
    Music.stop();
    Stats.flush();
    cancelRaceRec();
    Race.active = null;
    genWorld(ncfg);
    clearChunks();
    W.lootByArea = {};
    W.lootBlocks.clear();
    spawnMonsters();
    P.x = tcB * AREA + u; P.z = trB * AREA + v;
    P.y = Math.max(keepY, surfaceY(P.x, P.z));
    P.yaw = keepYaw; P.pitch = keepPitch; P.flying = keepFly;
    P.vx = P.vy = P.vz = 0;
    P.areaIdx = -1; // force area-change handling
    S.songIdx = -999; // force the new world's song to start
    Stats.begin(ncfg.origin, ncfg.worldId);
    rememberVisit(ncfg.worldId, ncfg.name);
    $('hudWorld').textContent = ncfg.name;
    showBanner(ncfg.name, ncfg.asleep ? 'this world is asleep · loot and friends return when it wakes' : 'you crossed into ' + (ncfg.artist || 'another artist') + '\'s land');
    if (ncfg.asleep) showToast('this world is asleep right now · the land is still yours to roam', 3200);
  }

  /* ═══════════ HUD, overlays, state ═══════════ */
  const S = { playing: false, live: false, raf: 0, lastT: 0, pendingRespawn: null, envLevel: 0.4 };
  let toastTimer = 0;
  function showToast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('on');
    toastTimer = (ms || 2400) / 1000;
  }
  let bannerTimer = 0;
  function showBanner(big, small) {
    const b = $('areaBanner');
    b.textContent = '';
    b.appendChild(document.createTextNode(big));
    if (small) {
      const s = document.createElement('small');
      s.textContent = small;
      b.appendChild(s);
    }
    b.classList.add('on');
    bannerTimer = 3.2;
  }
  function areaLabel(ai) { return AREA_NAMES[ai]; }

  /* keeps the HUD, the playing song and the ambience in step with where the
     fan is standing on the song timeline; runs a few times a second */
  function updateWhere(force) {
    const ai = areaOf(P.x, P.z);
    const sa = songAt(P.x, P.z);
    let txt = AREA_NAMES[ai];
    if (sa && !sa.beyond) txt = sa.song.title + ' · ' + fmtTime(sa.t) + ' · ' + txt;
    $('hudArea').textContent = txt;
    const idx = sa ? sa.idx : -1;
    if (idx !== S.songIdx || force) {
      S.songIdx = idx;
      Music.playSong(idx >= 0 ? W.songs[idx] : null, sa ? sa.t : 0);
      if (idx >= 0 && W.songs[idx].url) showToast('now playing: ' + W.songs[idx].title, 2200);
    }
    trackQuest(sa);
  }

  /* listening quests: stand through a whole piece and its region counts as
     walked; walk them all and the world is crowned. Local + one stat ping. */
  let questAcc = null;
  function trackQuest(sa) {
    if (!sa || sa.beyond || !W.cfg || W.cfg.demo) return;
    const wid = W.cfg.worldId, sid = sa.song.id;
    const done = questsDone();
    if (done[wid] && done[wid][sid]) return;
    if (!questAcc || questAcc.wid !== wid) questAcc = { wid, secs: store.get('questAcc_' + wid, {}) };
    questAcc.secs[sid] = (questAcc.secs[sid] || 0) + 0.4;
    if ((questAcc.secs[sid] % 10) < 0.4) store.set('questAcc_' + wid, questAcc.secs);
    const goal = Math.min(sa.song.dur, 600) * 0.9;
    if (questAcc.secs[sid] >= goal) {
      const d = questsDone();
      d[wid] = d[wid] || {};
      d[wid][sid] = true;
      store.set('questsDone', d);
      store.set('questAcc_' + wid, questAcc.secs);
      Stats.complete(sid);
      Sfx.friend();
      showToast('✦ you walked all of "' + sa.song.title + '"', 3200);
      // crowned when every piece in this world is walked
      const allDone = W.songs.every((s2) => d[wid][s2.id]);
      if (allDone && !crowns()[wid]) {
        const c = crowns();
        c[wid] = W.cfg.name;
        store.set('crowns', c);
        showBanner('World crowned', 'you walked every piece of ' + W.cfg.name);
        Sfx.loot();
      }
    }
  }

  function onAreaChange(ai) {
    P.areaIdx = ai;
    showBanner(AREA_NAMES[ai], null);
    Presence.join(ai);
    loadLootForArea(ai);
    const c = AREA_CORNER[ai];
    if (c !== undefined) {
      const link = W.cfg.links.find((l) => l.corner === c);
      if (link) { prefetchNeighbor(c); showToast('linked arena · keep going to reach ' + link.other.name, 3000); }
      else showToast('an arena · watch for glooms, dig for loot', 2600);
    }
  }

  /* palette blending for sky and fog */
  let curSky = [0.09, 0.07, 0.15], curFog = [0.33, 0.28, 0.38];

  function drawScene(t, dt) {
    const pal = palAtPlayer();
    const amb = Music.tick(dt, t);
    S.envLevel += (amb.level - S.envLevel) * (1 - Math.exp(-dt * 3));
    if (amb.beat) {
      S.pulse = 1;
      if (amb.level > 0.75 && !reduceMotion) {
        const el = $('beatFlash');
        el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
      }
    }
    S.pulse = Math.max(0, (S.pulse || 0) - dt * 2.6);

    const k = 1 - Math.exp(-dt * 1.6);
    curSky = mix3(curSky, scale3(pal.sky, 0.7 + S.envLevel * 0.6), k);
    curFog = mix3(curFog, scale3(pal.fog, 0.75 + S.envLevel * 0.45), k);

    gl.clearColor(curSky[0], curSky[1], curSky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye = [P.x, P.y + EYE, P.z];
    const aspect = glCv.width / glCv.height;
    const proj = m4persp(1.22, aspect, 0.1, 220);
    const view = m4mul(m4rotX(-P.pitch), m4mul(m4rotY(-P.yaw), m4trans(-eye[0], -eye[1], -eye[2])));
    const mvp = m4mul(proj, view);

    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.u.uMVP, false, mvp);
    gl.uniform3fv(prog.u.uEye, eye);
    gl.uniform3fv(prog.u.uFog, curFog);
    gl.uniform1f(prog.u.uFogNear, 55);
    gl.uniform1f(prog.u.uFogFar, 105);
    gl.uniform3fv(prog.u.uGlowCol, pal.accent);
    gl.uniform1f(prog.u.uPulse, clamp((S.pulse || 0) + S.envLevel * 0.3, 0, 1));
    gl.uniform1f(prog.u.uFlash, 0);
    gl.uniform1f(prog.u.uAlpha, 1);

    function bindMain(vbo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(prog.a.aPos);
      gl.vertexAttribPointer(prog.a.aPos, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(prog.a.aCol);
      gl.vertexAttribPointer(prog.a.aCol, 3, gl.FLOAT, false, 28, 12);
      gl.enableVertexAttribArray(prog.a.aGlow);
      gl.vertexAttribPointer(prog.a.aGlow, 1, gl.FLOAT, false, 28, 24);
    }
    const pci = Math.floor(P.x / CS), pcj = Math.floor(P.z / CS);
    const waterChunks = [];
    for (const [key, ch] of chunks) {
      if (!ch.built || !ch.count && !ch.wcount) continue;
      const i = Math.floor(key / CGRID), j = key % CGRID;
      if (Math.max(Math.abs(i - pci), Math.abs(j - pcj)) > VIEW_CHUNKS) continue;
      if (ch.count) { bindMain(ch.vbo); gl.drawArrays(gl.TRIANGLES, 0, ch.count); }
      if (ch.wcount) waterChunks.push(ch);
    }

    /* dynamic: monsters, other fans, loot sparkle */
    const dyn = [];
    for (const m of monsters) {
      if (AREA_CORNER[P.areaIdx] !== m.corner) continue;
      const d = Math.hypot(m.x - P.x, m.z - P.z);
      if (d > 110) continue;
      const bodyC = hsl2rgb(m.hue, 0.5, 0.22);
      const sq = 1 + 0.12 * Math.sin(t * 9 + m.phase);
      pushBox(dyn, m.x - 0.55, m.y, m.z - 0.55, 1.1, 0.9 * sq, 1.1, bodyC, 0.05);
      pushBox(dyn, m.x - 0.38, m.y + 0.9 * sq, m.z - 0.38, 0.76, 0.5, 0.76, scale3(bodyC, 0.8), 0.05);
      // glowing eyes toward the player
      const ea = Math.atan2(P.x - m.x, P.z - m.z);
      const ex = Math.sin(ea) * 0.39, ez = Math.cos(ea) * 0.39;
      const eyeC = m.tamed ? [1, 0.55, 0.7] : [1, 0.3, 0.2];
      pushBox(dyn, m.x + ex - 0.22, m.y + 1.0 * sq, m.z + ez - 0.06, 0.14, 0.14, 0.14, eyeC, 1);
      pushBox(dyn, m.x + ex + 0.08, m.y + 1.0 * sq, m.z + ez - 0.06, 0.14, 0.14, 0.14, eyeC, 1);
    }
    if (Race.active && Race.active.phase === 'run') {
      const el = (performance.now() - Race.active.t0) / 1000;
      const gp = pathAt(Race.active.race.path, el);
      const gy = surfaceY(gp[0], gp[1]) + 0.3;
      pushBox(dyn, gp[0] - 0.35, gy, gp[1] - 0.35, 0.7, 1.4, 0.7, [0.89, 0.4, 0.26], 0.7);
      const fx2 = Race.active.race.f[0] + 0.5, fz2 = Race.active.race.f[1] + 0.5;
      const fy = surfaceY(fx2, fz2);
      pushBox(dyn, fx2 - 0.5, fy, fz2 - 0.5, 1, 6 + Math.sin(t * 4) * 0.5, 1, [0.29, 0.74, 0.66], 1);
    }
    const now = performance.now();
    for (const [, o] of Presence.others) {
      if (o.x === undefined || now - o.seen > 45000) continue;
      const bob = 0.3 * Math.sin(t * 2 + o.x);
      pushBox(dyn, o.x - 0.3, surfaceY(o.x, o.z) + 0.4 + bob, o.z - 0.3, 0.6, 1.2, 0.6, [0.29, 0.74, 0.66], 0.6);
    }
    if (dyn.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, prog.dynVbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dyn), gl.DYNAMIC_DRAW);
      bindMain(prog.dynVbo);
      gl.drawArrays(gl.TRIANGLES, 0, dyn.length / 7);
    }

    /* water: after opaques, blended */
    if (waterChunks.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(prog.u.uAlpha, 0.78);
      for (const ch of waterChunks) { bindMain(ch.wvbo); gl.drawArrays(gl.TRIANGLES, 0, ch.wcount); }
      gl.uniform1f(prog.u.uAlpha, 1);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    /* particles */
    if (parts.length) {
      const pv = new Float32Array(parts.length * 8);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], o = i * 8;
        const fade = 1 - p.t / p.life;
        pv[o] = p.x; pv[o + 1] = p.y; pv[o + 2] = p.z;
        pv[o + 3] = p.r; pv[o + 4] = p.g; pv[o + 5] = p.b;
        pv[o + 6] = p.a * fade; pv[o + 7] = p.size;
      }
      gl.useProgram(ptsProg.p);
      gl.uniformMatrix4fv(ptsProg.u.uMVP, false, mvp);
      gl.uniform1f(ptsProg.u.uScale, glCv.height / 22);
      gl.bindBuffer(gl.ARRAY_BUFFER, prog.ptsVbo);
      gl.bufferData(gl.ARRAY_BUFFER, pv, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(ptsProg.a.aPos);
      gl.vertexAttribPointer(ptsProg.a.aPos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(ptsProg.a.aCol);
      gl.vertexAttribPointer(ptsProg.a.aCol, 4, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(ptsProg.a.aSize);
      gl.vertexAttribPointer(ptsProg.a.aSize, 1, gl.FLOAT, false, 32, 28);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.drawArrays(gl.POINTS, 0, parts.length);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  function frame(tms) {
    S.raf = requestAnimationFrame(frame);
    const dt = clamp((tms - S.lastT) / 1000 || 0.016, 0.001, 0.05);
    S.lastT = tms;
    if (!S.playing || !W.ready || !gl) return;
    const t = tms / 1000;

    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.remove('on'); }
    if (bannerTimer > 0) { bannerTimer -= dt; if (bannerTimer <= 0) $('areaBanner').classList.remove('on'); }

    if (S.live) {
      updatePlayer(dt);
      updateMonsters(dt, t);
      updateParticles(dt);
      Presence.tick(dt);
      Stats.tick(dt);
      updateRace(dt);
      const ai = areaOf(P.x, P.z);
      if (ai !== P.areaIdx) onAreaChange(ai);
      S.hudT = (S.hudT || 0) - dt;
      if (S.hudT <= 0) { S.hudT = 0.4; updateWhere(false); }
      maybeCross();
      updateRadar(dt);
    }
    ensureChunksAround(P.x, P.z);
    drawScene(t, dt);
    if (S.shotPending) { S.shotPending = false; captureShot(); }
  }

  /* ═══════════ enter/exit ═══════════ */
  function enterWorld() {
    if (!W.cfg) return;
    fan.name = ($('fanName').value || '').trim().slice(0, 24) || fan.name || 'a fan';
    saveFan();
    Sfx.init(); Sfx.resume(); Sfx.click();
    $('loadVeil').classList.add('on');
    $('loadSub').textContent = W.cfg.name + (W.cfg.artist ? ' · ' + W.cfg.artist : '');
    $('loadStep').textContent = 'raising the mountains';
    setTimeout(() => {
      if (!initGL()) {
        $('loadVeil').classList.remove('on');
        $('nogl').classList.add('on');
        return;
      }
      genWorld(W.cfg);
      clearChunks();
      spawnMonsters();
      // spawn on the home stage, or at a #at=x,z spot from a shared link
      P.x = SXZ / 2 + 0.5; P.z = SXZ / 2 + 0.5;
      P.yaw = Math.PI * 0.25;
      const atM = location.hash.match(/at=(\d+),(\d+)/);
      if (atM) {
        P.x = clamp(Number(atM[1]), 2, SXZ - 3) + 0.5;
        P.z = clamp(Number(atM[2]), 2, SXZ - 3) + 0.5;
        P.yaw = 0;
      }
      P.y = surfaceY(P.x, P.z) + 1;
      P.pitch = -0.12;
      P.flying = false; P.areaIdx = -1;
      Stats.begin(W.cfg.origin, W.cfg.worldId);
      rememberVisit(W.cfg.worldId, W.cfg.name);
      if (S.pendingRace) { beginIncomingRace(S.pendingRace); S.pendingRace = null; }
      $('btnFly').textContent = '🪽 walk'; $('btnFly').classList.remove('lit');
      $('btnJump').classList.remove('hide'); $('btnUp').classList.add('hide'); $('btnDown').classList.add('hide');
      $('hudWorld').textContent = W.cfg.name;
      document.body.classList.add('playing');
      $('game').classList.add('on');
      sizeGL();
      ensureChunksAround(P.x, P.z);
      $('loadVeil').classList.remove('on');
      S.playing = true; S.live = true;
      S.songIdx = -999;
      cancelAnimationFrame(S.raf);
      S.lastT = performance.now();
      S.raf = requestAnimationFrame(frame);
      onAreaChange(areaOf(P.x, P.z));
      updateWhere(true);
      if (W.cfg.stale) showToast('this world is asleep · playing from the last copy your browser saw', 3600);
    }, 60);
  }
  function exitToMenu() {
    Stats.flush();
    cancelRaceRec();
    Race.active = null;
    S.playing = false; S.live = false;
    cancelAnimationFrame(S.raf); S.raf = 0;
    Presence.leave();
    Music.stop();
    $('game').classList.remove('on');
    $('lootModal').classList.remove('on');
    $('deathVeil').classList.remove('on');
    document.body.classList.remove('playing');
  }

  /* ═══════════ menu wiring + boot ═══════════ */
  function paintFriends() {
    $('friendCode').textContent = fan.id + '~' + (fan.name || 'a fan');
    const el = $('friendList');
    el.textContent = friends.length
      ? 'Your friends: ' + friends.map((f) => f.name).join(', ')
      : 'No friends added yet. You get a toast whenever a friend is in your area.';
  }
  $('fanName').value = fan.name || '';
  $('fanName').addEventListener('change', () => {
    fan.name = $('fanName').value.trim().slice(0, 24);
    saveFan(); paintFriends();
  });
  $('btnAddFriend').addEventListener('click', () => {
    if (addFriend($('friendPaste').value)) {
      $('friendPaste').value = '';
      paintFriends();
      showToastMenu('Friend added.');
    } else showToastMenu('That code did not look right. It is like: f1a2b3c4d5e6f7a8~Name');
  });
  function showToastMenu(msg) {
    const el = $('friendList');
    el.textContent = msg;
    setTimeout(paintFriends, 2600);
  }

  $('btnPlay').addEventListener('click', enterWorld);
  $('btnExit').addEventListener('click', exitToMenu);
  $('btnFly').addEventListener('click', toggleFly);
  $('btnMute').addEventListener('click', () => {
    Sfx.init();
    Sfx.setMuted(!Sfx.muted);
    $('btnMute').textContent = Sfx.muted ? '✕' : '♪';
  });
  const holdBtn = (id, set) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); });
    el.addEventListener('pointerup', () => set(false));
    el.addEventListener('pointercancel', () => set(false));
    el.addEventListener('pointerleave', () => set(false));
  };
  holdBtn('btnJump', (v) => { jumpHeld = v; });
  holdBtn('btnUp', (v) => { upHeld = v; });
  holdBtn('btnDown', (v) => { downHeld = v; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.playing) { /* keep world; audio keeps its own state */ }
  });

  // friend invite links: ?friend=<code>
  const fm = location.search.match(/[?&]friend=([^&]+)/);
  if (fm) {
    try { if (addFriend(decodeURIComponent(fm[1]))) showBanner('Friend added', 'you will be told when you are in the same area'); } catch (e) {}
  }

  const raceIn = parseRaceHash();
  if (raceIn) {
    Race.incoming = raceIn;
    $('raceCard').style.display = '';
    $('raceLine').textContent = raceIn.n + ' ran a stretch of this world in ' + (raceIn.t / 1000).toFixed(1) + 's. Their ghost is waiting at the start line.';
    $('btnRaceGo').addEventListener('click', () => {
      S.pendingRace = Race.incoming;
      enterWorld();
    });
  }

  paintFriends();
  $('btnMute').textContent = Sfx.muted ? '✕' : '♪';

  /* ── menu backdrop: slow voxel ridges in the world's own colors ── */
  function menuBackdrop(hue) {
    const cv = $('menuBg');
    if (!cv) return;
    const ctx2 = cv.getContext('2d');
    if (!ctx2) return;
    let MW = 0, MH = 0;
    function size() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      MW = innerWidth; MH = innerHeight;
      cv.width = MW * dpr; cv.height = MH * dpr;
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    addEventListener('resize', () => { size(); if (reduceMotion) draw(0); });
    size();
    const rnd = seeded('backdrop|' + (W.cfg ? W.cfg.worldId : 'x'));
    const bump = [];
    for (let i = 0; i < 96; i++) bump.push(rnd());
    function ridge(x, off, rough) {
      const u = x * 0.006 + off;
      const i = Math.floor(u), f = u - i;
      const a = bump[((i % 96) + 96) % 96], b = bump[(((i + 1) % 96) + 96) % 96];
      return lerp(a, b, f * f * (3 - 2 * f)) * rough;
    }
    const shade = (l, a) => {
      const c = hsl2rgb(hue, 0.4, l);
      return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + a + ')';
    };
    const layers = [
      { off: 0, sp: 4, base: 0.52, amp: 0.2, col: shade(0.2, 0.85), eq: 0.03 },
      { off: 40, sp: 9, base: 0.66, amp: 0.26, col: shade(0.13, 0.95), eq: 0.05 },
      { off: 90, sp: 16, base: 0.8, amp: 0.3, col: shade(0.07, 1), eq: 0.08 }
    ];
    function draw(t) {
      ctx2.clearRect(0, 0, MW, MH);
      const CELL = 14;
      for (const L of layers) {
        ctx2.fillStyle = L.col;
        for (let x = 0; x < MW + CELL; x += CELL) {
          const scroll = L.off + t * 0.00002 * L.sp;
          let y = MH * L.base - (ridge(x, scroll, 1) * L.amp * MH);
          y -= Math.max(0, Math.sin(t * 0.001 + x * 0.02) * L.eq * MH * ridge(x, scroll + 31, 1));
          y = Math.floor(y / CELL) * CELL;
          ctx2.fillRect(x, y, CELL - 1, MH - y);
        }
      }
      ctx2.fillStyle = 'rgba(242,163,60,0.06)';
      ctx2.fillRect(0, MH * 0.79, MW, 2);
    }
    if (reduceMotion) { draw(0); return; }
    (function loop(t) {
      requestAnimationFrame(loop);
      if (S.playing || document.hidden) return;
      draw(t);
    })(0);
  }

  (DEMO ? Promise.resolve(normalizeConfig(demoConfig(), OWN_ORIGIN)) : loadConfig(OWN_ORIGIN).then((cfg) => cfg || normalizeConfig(demoConfig(), OWN_ORIGIN)))
    .then((cfg) => {
      W.cfg = cfg;
      document.title = cfg.name + (cfg.artist ? ' · ' + cfg.artist : '') + ' · Tuneland';
      $('mTitle').textContent = cfg.name;
      $('mArtist').textContent = cfg.artist ? 'A world by ' + cfg.artist : '';
      $('mBio').textContent = cfg.bio || '';
      $('footWorld').textContent = cfg.name;
      // fan-facing pitch, in this world's own terms
      $('mEyebrow').textContent = cfg.tracks.length && cfg.artist
        ? 'The music of ' + cfg.artist + ', as a place'
        : 'A Tuneland world';
      $('mPitch').textContent = 'Real loot is buried in this land' +
        (cfg.artist ? ': things ' + cfg.artist + ' left for the ones who come looking. ' : '. ') +
        'Follow the radar, dig it up, and keep what you find.';
      if (cfg.tracks.length) {
        $('chipTracks').style.display = '';
        $('chipTracksText').textContent = cfg.tracks.length === 1
          ? '1 piece of music to walk'
          : cfg.tracks.length + ' pieces of music to walk';
      }
      if (cfg.links.length) {
        $('chipLinks').style.display = '';
        $('chipLinksText').textContent = cfg.links.length === 1
          ? '1 world next door'
          : cfg.links.length + ' worlds next door';
      }
      // search engines get this world's real identity
      try {
        const ld = document.createElement('script');
        ld.type = 'application/ld+json';
        ld.textContent = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'VideoGame',
          name: cfg.name,
          url: location.origin + '/',
          description: 'A free voxel world built from ' + (cfg.artist || 'an artist') + '’s work. Walk the music, dig up buried loot, and cross into linked worlds. No download, no account.',
          genre: ['Music', 'Adventure'],
          gamePlatform: ['Web browser', 'Mobile', 'Desktop'],
          isAccessibleForFree: true,
          author: cfg.artist ? { '@type': 'MusicGroup', name: cfg.artist } : undefined,
          publisher: { '@type': 'Organization', name: 'Tuneland', url: 'https://midhrami.com/tuneland/' }
        });
        document.head.appendChild(ld);
      } catch (e) {}
      const bgHue = cfg.tracks.length && cfg.tracks[0].hue !== null && cfg.tracks[0].hue !== undefined
        ? cfg.tracks[0].hue : (xmur3('hue|' + cfg.worldId)() % 1000) / 1000;
      menuBackdrop(bgHue);
      if (!cfg.demo) {
        fetchJson(cfg.origin + '/api/leaderboard', {}, 6000).then((d) => {
          if (!d || !d.ok || !Array.isArray(d.top) || !d.top.length) return;
          $('lbWrap').style.display = '';
          const ol = $('lbList');
          ol.textContent = '';
          for (const r of d.top.slice(0, 10)) {
            const li = document.createElement('li');
            const b = document.createElement('b');
            b.textContent = r.name;
            li.appendChild(b);
            li.appendChild(document.createTextNode(r.finds + (r.finds === 1 ? ' find' : ' finds')));
            ol.appendChild(li);
          }
        }).catch(() => {});
      }
      if (cfg.links.length) {
        $('neighbors').style.display = '';
        const row = $('nbRow');
        row.textContent = '';
        for (const l of cfg.links) {
          const a = document.createElement('a');
          a.href = l.other.origin || '#';
          a.rel = 'noopener';
          a.textContent = l.other.name + ' ↗';
          row.appendChild(a);
        }
      }
    });
})();
