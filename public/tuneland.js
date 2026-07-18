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

  /* ═══════════ world config ═══════════ */
  const OWN_ORIGIN = location.origin;
  const DEMO = /[?&#]demo/.test(location.href);

  function demoConfig() {
    return {
      ok: true, worldId: 'wdemo0000demo', name: 'Tuneland demo world', artist: 'The Tuneland makers',
      bio: 'A world with no artist yet. Wander, dig, meet the glooms.',
      hues: [0.62, 0.55, 0.08, 0.45, 0.33, 0.72, 0.85, 0.25, 0.95],
      areaTracks: [null, null, null, null, null, null, null, null, null],
      tracks: [], links: [], demo: true
    };
  }
  function normalizeConfig(d, origin) {
    if (!d || !d.ok || !d.worldId) return null;
    return {
      worldId: String(d.worldId), origin,
      name: String(d.name || 'A Tuneland world').slice(0, 80),
      artist: String(d.artist || '').slice(0, 80),
      bio: String(d.bio || '').slice(0, 400),
      hues: Array.isArray(d.hues) && d.hues.length === 9 ? d.hues.map((h) => clamp(Number(h) || 0, 0, 1)) : demoConfig().hues,
      areaTracks: Array.isArray(d.areaTracks) && d.areaTracks.length === 9 ? d.areaTracks : demoConfig().areaTracks,
      tracks: Array.isArray(d.tracks) ? d.tracks.slice(0, 24).map((t) => ({
        id: String(t.id || ''), title: String(t.title || 'Untitled').slice(0, 120),
        url: typeof t.url === 'string' ? t.url : null,
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
  const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, SAND = 4, WATER = 5, WOOD = 6, LEAF = 7, CHEST = 8, ROCK = 9, SNOW = 10, PILLAR = 11;

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
    blocks: null, heights: null,
    n2: null,           // world-seed noise
    arenaFns: {},       // corner number -> {n2, key}
    palettes: [],       // per area
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

  function buildPalettes(cfg) {
    W.palettes = cfg.hues.map((hue, i) => {
      const arena = isCornerArea(i);
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
    });
  }

  function terrainFns(cfg) {
    W.n2 = makeNoise2D(seeded('world|' + cfg.worldId));
    W.arenaFns = {};
    for (const c of [1, 3, 5, 7]) {
      const key = linkKeyFor(cfg, c) || ('arena|' + cfg.worldId + '.' + c);
      W.arenaFns[c] = { key, n2: makeNoise2D(seeded(key)) };
    }
  }

  function ownHeight(x, z) {
    const n = W.n2(x / 34, z / 34) + 0.5 * W.n2(x / 13, z / 13) + 0.25 * W.n2(x / 6, z / 6);
    let h = 4 + (n / 1.75) * 22;
    // the home stage sits a little proud of the fields
    const dx = (x - SXZ / 2) / (SXZ / 2), dz = (z - SXZ / 2) / (SXZ / 2);
    const dc = Math.sqrt(dx * dx + dz * dz);
    h += Math.max(0, 1 - dc * 2.2) * 5;
    // shoreline: the grid is an island in a void sea
    const edge = Math.min(x, z, SXZ - 1 - x, SXZ - 1 - z);
    h = lerp(1, h, clamp(edge / 18, 0, 1));
    return h;
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
    const base = ownHeight(x, z);
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
    buildPalettes(cfg);
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
    W.ready = true;
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
        const y = Math.max(2, h - 2);
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
      const pal = W.palettes[areaOf(x, z)];
      for (let y = 0; y < SY; y++) {
        const b = W.blocks[bIdx(x, y, z)];
        if (b === AIR) continue;
        const isWater = b === WATER;
        for (let fi = 0; fi < 6; fi++) {
          const F = FACES[fi];
          const nb = getB(x + F.n[0], y + F.n[1], z + F.n[2]);
          if (isWater) { if (nb !== AIR) continue; }
          else if (nb !== AIR && nb !== WATER) continue;
          const glow = b === CHEST ? 1 : b === PILLAR ? 0.45 : 0;
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
    playArea(ai) {
      this.init();
      const cfg = W.cfg;
      const tid = cfg.areaTracks[ai];
      const track = tid ? cfg.tracks.find((t) => t.id === tid) : null;
      if (!track || !track.url) { this.setEnvelope(null, areaKeyOf(ai)); return; } // ambient silence, pseudo envelope
      if (this.curTrackId === track.id) return;
      this.curTrackId = track.id;
      this.setEnvelope(track.envelope, areaKeyOf(ai));
      const next = this.cur === this.a ? this.b : this.a;
      const url = track.url.startsWith('/') ? cfg.origin + track.url : track.url;
      try {
        next.src = url; next.muted = Sfx.muted; next.volume = 0;
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
    setEnvelope(envelope, seedKey) {
      this.beatIdx = 0;
      if (envelope && Array.isArray(envelope.env) && envelope.env.length) {
        this.envArr = envelope.env; this.envDur = envelope.dur || 30;
        this.beats = Array.isArray(envelope.beats) ? envelope.beats : [];
      } else {
        // deterministic pseudo-envelope so the world still breathes
        const rand = seeded('pseudoenv|' + seedKey);
        const n = 300; this.envArr = new Array(n); this.envDur = 30;
        for (let i = 0; i < n; i++) this.envArr[i] = 0.3 + 0.3 * Math.sin(i / 18 + rand() * 6) + rand() * 0.1;
        const bpm = 92 + Math.floor(rand() * 40);
        this.beats = [];
        for (let t = 0.5; t < 30; t += 60 / bpm) this.beats.push(t);
      }
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
    if (hit.b === ROCK || hit.b === PILLAR) { showToast(hit.b === PILLAR ? 'the pillar hums · it will not break' : 'too hard to dig', 1200); return; }
    W.blocks[bIdx(hit.x, hit.y, hit.z)] = AIR;
    markDirtyAt(hit.x, hit.z);
    Sfx.dig();
    vibrate(12);
    const pal = W.palettes[areaOf(hit.x, hit.z)];
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
    const pal = W.palettes[cur];
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
      const mdx = m.tx - m.x, mdz = m.tz - m.z;
      const md = Math.hypot(mdx, mdz);
      if (md > 0.4) {
        const chase = playerInArena && dp < 15 && !P.flying;
        const sp = m.speed * (chase ? 1.5 : 1);
        m.x += (mdx / md) * sp * dt;
        m.z += (mdz / md) * sp * dt;
        // keep them inside their arena
        m.x = clamp(m.x, tc * AREA + 2, tc * AREA + AREA - 2);
        m.z = clamp(m.z, tr * AREA + 2, tr * AREA + AREA - 2);
      }
      m.y = surfaceY(m.x, m.z) + 0.1 + Math.abs(Math.sin(t * 6 + m.phase)) * 0.35;
      if (playerInArena && P.invuln <= 0 && dp < 1.35 && Math.abs((P.y + 0.9) - m.y) < 2.2) {
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
    return W.lootByArea[key] || [];
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
    c.fillStyle = 'rgba(6,12,20,0.72)';
    c.beginPath(); c.arc(0, 0, R - 4, 0, 6.284); c.fill();
    c.strokeStyle = 'rgba(198,242,78,0.5)';
    c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, R - 4, 0, 6.284); c.stroke();
    c.strokeStyle = 'rgba(198,242,78,0.18)';
    for (const rr of [0.33, 0.66]) { c.beginPath(); c.arc(0, 0, (R - 4) * rr, 0, 6.284); c.stroke(); }
    // sweep
    const grad = c.createConicGradient ? c.createConicGradient(sweep, 0, 0) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(198,242,78,0.3)');
      grad.addColorStop(0.12, 'rgba(198,242,78,0)');
      grad.addColorStop(1, 'rgba(198,242,78,0)');
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
      c.fillStyle = 'rgba(198,242,78,' + (0.5 + 0.5 * pulse) + ')';
      c.beginPath(); c.arc(bx, by, 5 + hot * 3, 0, 6.284); c.fill();
    }
    // center: you
    c.fillStyle = 'rgba(94,225,242,0.9)';
    c.beginPath(); c.arc(0, 0, 4, 0, 6.284); c.fill();
    c.restore();
  }

  let lootBusy = false;
  function openLoot(hit) {
    if (lootBusy) return;
    const entry = W.lootBlocks.get(hit.x + ',' + hit.z + ',' + hit.y);
    if (!entry) return;
    lootBusy = true;
    const done = (payload, failed) => {
      lootBusy = false;
      if (failed) { showToast(payload || 'that world is asleep · try again soon', 2600); return; }
      // remove the chest locally
      W.blocks[bIdx(hit.x, hit.y, hit.z)] = AIR;
      markDirtyAt(hit.x, hit.z);
      W.lootBlocks.delete(hit.x + ',' + hit.z + ',' + hit.y);
      const key = areaKeyOf(P.areaIdx);
      if (W.lootByArea[key]) W.lootByArea[key] = W.lootByArea[key].filter((l) => l.id !== entry.id);
      Sfx.loot();
      const pal = W.palettes[P.areaIdx];
      burst(hit.x + 0.5, hit.y + 1, hit.z + 0.5, pal.accent, 30, 8);
      const found = store.get('found', []);
      if (found.indexOf(entry.id) < 0) { found.push(entry.id); store.set('found', found.slice(-200)); }
      $('lootTitle').textContent = payload.title || 'Buried loot';
      $('lootMsg').textContent = payload.message || '';
      const codeEl = $('lootCode');
      if (payload.code) { codeEl.style.display = ''; codeEl.textContent = payload.code; } else codeEl.style.display = 'none';
      const openEl = $('lootOpen');
      if (payload.url && /^https?:\/\//i.test(payload.url)) { openEl.style.display = ''; openEl.href = payload.url; } else openEl.style.display = 'none';
      $('lootRemaining').textContent =
        payload.remaining === null || payload.remaining === undefined ? '' :
        payload.remaining === 0 ? 'you got the last one' : payload.remaining + ' left for other fans';
      $('lootModal').classList.add('on');
    };
    if (entry.demo) {
      done({ title: 'Practice chest', message: 'This is what fans find in a real world: a note from the artist, a link, sometimes a code.', code: null, url: null, remaining: null });
      return;
    }
    fetchJson(entry.origin + '/api/loot/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lootId: entry.id, fanId: fan.id })
    }, 8000).then((d) => {
      if (d && d.ok && d.loot) done(d.loot);
      else done('this chest is already empty', true);
    }).catch(() => done(null, true));
  }
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
  function areaLabel(ai) {
    const tid = W.cfg.areaTracks[ai];
    const track = tid ? W.cfg.tracks.find((t) => t.id === tid) : null;
    return track ? AREA_NAMES[ai] + ' · ' + track.title : AREA_NAMES[ai];
  }

  function onAreaChange(ai) {
    P.areaIdx = ai;
    $('hudArea').textContent = areaLabel(ai);
    showBanner(AREA_NAMES[ai], W.cfg.areaTracks[ai] ? 'now playing: ' + areaLabel(ai).split(' · ')[1] : null);
    Music.playArea(ai);
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
  let curSky = [0.06, 0.1, 0.16], curFog = [0.3, 0.35, 0.42];

  function drawScene(t, dt) {
    const pal = W.palettes[clamp(P.areaIdx, 0, 8)];
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
      pushBox(dyn, m.x + ex - 0.22, m.y + 1.0 * sq, m.z + ez - 0.06, 0.14, 0.14, 0.14, [1, 0.3, 0.2], 1);
      pushBox(dyn, m.x + ex + 0.08, m.y + 1.0 * sq, m.z + ez - 0.06, 0.14, 0.14, 0.14, [1, 0.3, 0.2], 1);
    }
    const now = performance.now();
    for (const [, o] of Presence.others) {
      if (o.x === undefined || now - o.seen > 45000) continue;
      const bob = 0.3 * Math.sin(t * 2 + o.x);
      pushBox(dyn, o.x - 0.3, surfaceY(o.x, o.z) + 0.4 + bob, o.z - 0.3, 0.6, 1.2, 0.6, [0.37, 0.88, 0.95], 0.6);
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
      const ai = areaOf(P.x, P.z);
      if (ai !== P.areaIdx) onAreaChange(ai);
      maybeCross();
      updateRadar(dt);
    }
    ensureChunksAround(P.x, P.z);
    drawScene(t, dt);
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
      // spawn on the home stage
      P.x = SXZ / 2 + 0.5; P.z = SXZ / 2 + 0.5;
      P.y = surfaceY(P.x, P.z) + 1;
      P.yaw = Math.PI * 0.25; P.pitch = -0.12;
      P.flying = false; P.areaIdx = -1;
      $('btnFly').textContent = '🪽 walk'; $('btnFly').classList.remove('lit');
      $('btnJump').classList.remove('hide'); $('btnUp').classList.add('hide'); $('btnDown').classList.add('hide');
      $('hudWorld').textContent = W.cfg.name;
      document.body.classList.add('playing');
      $('game').classList.add('on');
      sizeGL();
      ensureChunksAround(P.x, P.z);
      $('loadVeil').classList.remove('on');
      S.playing = true; S.live = true;
      cancelAnimationFrame(S.raf);
      S.lastT = performance.now();
      S.raf = requestAnimationFrame(frame);
      onAreaChange(areaOf(P.x, P.z));
      if (W.cfg.stale) showToast('this world is asleep · playing from the last copy your browser saw', 3600);
    }, 60);
  }
  function exitToMenu() {
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

  paintFriends();
  $('btnMute').textContent = Sfx.muted ? '✕' : '♪';

  (DEMO ? Promise.resolve(normalizeConfig(demoConfig(), OWN_ORIGIN)) : loadConfig(OWN_ORIGIN).then((cfg) => cfg || normalizeConfig(demoConfig(), OWN_ORIGIN)))
    .then((cfg) => {
      W.cfg = cfg;
      document.title = cfg.name + (cfg.artist ? ' · ' + cfg.artist : '') + ' · Tuneland';
      $('mTitle').textContent = cfg.name;
      $('mArtist').textContent = cfg.artist ? 'A world by ' + cfg.artist : '';
      $('mBio').textContent = cfg.bio || '';
      $('footWorld').textContent = cfg.name;
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
