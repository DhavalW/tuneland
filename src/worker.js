/* Tuneland artist world Worker.
 *
 * One Worker per artist, on the artist's own Cloudflare account. It serves:
 *   - the public world API fans play against (config, loot, claims, songs,
 *     presence),
 *   - the admin API the dashboard uses (claim-token or superuser-signature
 *     authenticated),
 *   - the static game + dashboard assets for everything else.
 *
 * All state lives in D1 (auto-migrated on first use) and R2, never in the
 * repo, so the auto-update workflow can overwrite the code at any time.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS tracks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     r2_key TEXT,
     source_url TEXT,
     envelope TEXT,
     ord INTEGER,
     hue REAL,
     created_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS loot (
     id TEXT PRIMARY KEY,
     area_key TEXT NOT NULL,
     x INTEGER NOT NULL,
     z INTEGER NOT NULL,
     title TEXT,
     message TEXT,
     url TEXT,
     code TEXT,
     max_claims INTEGER DEFAULT 0,
     claims INTEGER DEFAULT 0,
     starts_at INTEGER,
     ends_at INTEGER,
     active INTEGER DEFAULT 1,
     buried_by TEXT,
     created_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_loot_area ON loot (area_key, active)`,
  `CREATE TABLE IF NOT EXISTS claims (
     loot_id TEXT NOT NULL,
     fan_id TEXT NOT NULL,
     claimed_at INTEGER,
     PRIMARY KEY (loot_id, fan_id)
   )`
];

// columns added after v1 shipped; harmless no-ops on fresh databases
const ALTERS = [
  `ALTER TABLE tracks ADD COLUMN ord INTEGER`,
  `ALTER TABLE tracks ADD COLUMN hue REAL`,
  `ALTER TABLE loot ADD COLUMN starts_at INTEGER`,
  `ALTER TABLE loot ADD COLUMN ends_at INTEGER`
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  for (const a of ALTERS) {
    try { await env.DB.prepare(a).run(); } catch (e) { /* column already there */ }
  }
  schemaReady = true;
}

/* ── small helpers ── */

const enc = new TextEncoder();

// bump when the artist agreement at midhrami.com/tuneland/agreement/ changes
const TERMS_VERSION = 1;

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, corsHeaders(), extra || {})
  });
}
function err(message, status) { return json({ ok: false, error: message }, status || 400); }

function corsHeaders() {
  // Cross-origin by design: fans on world A's page query world B's Worker,
  // and the superuser console on midhrami.com queries every world. Auth is
  // header-based (tokens + signatures), never cookies, so * is safe.
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-tl-ts, x-tl-sig',
    'access-control-max-age': '86400'
  };
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function b64uToBytes(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

async function metaGet(env, k) {
  const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return row ? row.v : null;
}
async function metaSet(env, k, v) {
  await env.DB.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).bind(k, v).run();
}
async function metaGetJson(env, k, d) {
  const v = await metaGet(env, k);
  if (v === null) return d;
  try { return JSON.parse(v); } catch (e) { return d; }
}

function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms || 8000);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
    .finally(() => clearTimeout(tm));
}

/* ── auth ── */

async function isArtist(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const hash = await metaGet(env, 'admin_token_hash');
  if (!hash) return false;
  return (await sha256Hex(auth.slice(7).trim())) === hash;
}

/* Superuser: Ed25519 signature over `${ts}|${METHOD}|${pathname}|${bodySha256Hex}`
 * with headers x-tl-ts and x-tl-sig (base64url). The public key comes from
 * the registry and is cached in D1 for an hour. */
async function superPubkey(env, forceRefresh) {
  const cached = await metaGetJson(env, 'super_pubkey', null);
  const fresh = cached && Date.now() - cached.at < 3600e3;
  if (cached && fresh && !forceRefresh) return cached.key || null;
  try {
    const r = await fetchTimeout(env.REGISTRY_BASE + '/super/pubkey', {}, 6000);
    if (r.ok) {
      const d = await r.json();
      const key = d && typeof d.pubkey === 'string' ? d.pubkey : null;
      await metaSet(env, 'super_pubkey', JSON.stringify({ key, at: Date.now() }));
      return key;
    }
  } catch (e) { /* registry unreachable: fall through to stale cache */ }
  return cached ? cached.key || null : null;
}
async function isSuper(request, env, bodyBytes) {
  const ts = request.headers.get('x-tl-ts');
  const sig = request.headers.get('x-tl-sig');
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60e3) return false;
  const pub = await superPubkey(env, false);
  if (!pub) return false;
  const path = new URL(request.url).pathname;
  const bodyHash = await sha256Hex(bodyBytes || new Uint8Array(0));
  const msg = enc.encode(ts + '|' + request.method + '|' + path + '|' + bodyHash);
  const tryVerify = async (pubB64u) => {
    try {
      const key = await crypto.subtle.importKey('raw', b64uToBytes(pubB64u), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify('Ed25519', key, b64uToBytes(sig), msg);
    } catch (e) { return false; }
  };
  if (await tryVerify(pub)) return true;
  // key may have rotated: refresh once and retry
  const pub2 = await superPubkey(env, true);
  return pub2 && pub2 !== pub ? tryVerify(pub2) : false;
}

/* Admin auth wrapper. Reads the body ONCE (needed for the signature) and
 * hands it to the route. who: 'artist' | 'super' | null */
async function requireAdmin(request, env) {
  const bodyBytes = request.method === 'GET' || request.method === 'HEAD'
    ? new Uint8Array(0)
    : new Uint8Array(await request.arrayBuffer());
  if (await isArtist(request, env)) return { who: 'artist', bodyBytes };
  if (await isSuper(request, env, bodyBytes)) return { who: 'super', bodyBytes };
  return { who: null, bodyBytes };
}
function parseJsonBody(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return null; }
}

/* ── world config ── */

const DEFAULT_PROFILE = {
  worldName: 'A new Tuneland world',
  artist: 'Unnamed artist',
  bio: '',
  layout: 'rings', // 'rings' (concentric, first song innermost) or 'lanes' (one lane per song)
  hues: [0.62, 0.55, 0.08, 0.45, 0.33, 0.72, 0.85, 0.25, 0.95], // legacy per-area hues, kept for older clients
  areaTracks: [null, null, null, null, null, null, null, null, null]
};

async function worldConfig(env, ctx) {
  const worldId = await metaGet(env, 'world_id');
  const profile = await metaGetJson(env, 'profile', DEFAULT_PROFILE);
  const tracks = await env.DB.prepare(
    'SELECT id, title, r2_key, source_url, envelope, hue FROM tracks ORDER BY (ord IS NULL), ord, created_at'
  ).all();
  const links = await metaGetJson(env, 'links_cache', { at: 0, links: [] });
  // refresh the link cache in the background when it is stale
  if (worldId && Date.now() - links.at > 10 * 60e3 && ctx) {
    ctx.waitUntil(refreshLinks(env, worldId).catch(() => {}));
  }
  return {
    ok: true,
    worldId: worldId || null,
    claimed: !!(await metaGet(env, 'admin_token_hash')),
    registered: !!(await metaGet(env, 'world_secret')),
    name: profile.worldName,
    artist: profile.artist,
    bio: profile.bio,
    layout: profile.layout || 'rings',
    hues: profile.hues,
    areaTracks: profile.areaTracks,
    tracks: (tracks.results || []).map((t) => ({
      id: t.id,
      title: t.title,
      url: t.r2_key ? '/api/songs/' + t.id : t.source_url,
      hue: typeof t.hue === 'number' ? t.hue : null,
      envelope: t.envelope ? JSON.parse(t.envelope) : null
    })),
    links: links.links || []
  };
}

async function refreshLinks(env, worldId) {
  const r = await fetchTimeout(
    env.REGISTRY_BASE + '/links?world=' + encodeURIComponent(worldId), {}, 6000);
  if (!r.ok) return;
  const d = await r.json();
  if (d && Array.isArray(d.links)) {
    await metaSet(env, 'links_cache', JSON.stringify({ at: Date.now(), links: d.links }));
  }
}

/* ── registry calls (world-secret authenticated) ── */

async function registryPost(env, path, body) {
  const r = await fetchTimeout(env.REGISTRY_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, 9000);
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}

/* ── route handlers ── */

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

  await ensureSchema(env);

  /* ---- public ---- */

  if (path === '/api/health') return json({ ok: true, t: Date.now() });

  if (path === '/api/world' && method === 'GET') {
    return json(await worldConfig(env, ctx));
  }

  if (path === '/api/loot' && method === 'GET') {
    const area = url.searchParams.get('area') || '';
    if (!area || area.length > 200) return err('bad area');
    // scarcity: a box is live only inside its time window (if set) and
    // while claims remain (if capped); either alone or both together
    const rows = await env.DB.prepare(
      `SELECT id, x, z FROM loot
       WHERE area_key = ?1 AND active = 1
         AND (max_claims = 0 OR claims < max_claims)
         AND (starts_at IS NULL OR starts_at <= ?2)
         AND (ends_at IS NULL OR ends_at > ?2)`
    ).bind(area, Date.now()).all();
    return json({ ok: true, loot: rows.results || [] });
  }

  if (path === '/api/loot/claim' && method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch (e) {}
    if (!body || typeof body.lootId !== 'string' || typeof body.fanId !== 'string' ||
        !body.lootId || !body.fanId || body.fanId.length > 64) return err('bad claim');
    const loot = await env.DB.prepare('SELECT * FROM loot WHERE id = ?').bind(body.lootId).first();
    if (!loot || !loot.active) return err('gone', 404);
    const now = Date.now();
    if (loot.starts_at && loot.starts_at > now) return err('gone', 404);
    if (loot.ends_at && loot.ends_at <= now) return err('gone', 404);
    const already = await env.DB.prepare(
      'SELECT 1 AS one FROM claims WHERE loot_id = ? AND fan_id = ?'
    ).bind(loot.id, body.fanId).first();
    if (!already) {
      if (loot.max_claims > 0 && loot.claims >= loot.max_claims) return err('gone', 404);
      // count the claim atomically; the WHERE re-checks every scarcity rule
      // so two simultaneous last-claims cannot both pass
      const res = await env.DB.prepare(
        `UPDATE loot SET claims = claims + 1
         WHERE id = ?1 AND active = 1 AND (max_claims = 0 OR claims < max_claims)
           AND (starts_at IS NULL OR starts_at <= ?2)
           AND (ends_at IS NULL OR ends_at > ?2)`
      ).bind(loot.id, now).run();
      if (!res.meta || !res.meta.changes) return err('gone', 404);
      await env.DB.prepare(
        'INSERT OR IGNORE INTO claims (loot_id, fan_id, claimed_at) VALUES (?, ?, ?)'
      ).bind(loot.id, body.fanId, now).run();
    }
    return json({
      ok: true,
      loot: {
        id: loot.id,
        title: loot.title,
        message: loot.message,
        url: loot.url,
        code: loot.code,
        remaining: loot.max_claims > 0 ? Math.max(0, loot.max_claims - loot.claims - (already ? 0 : 1)) : null,
        endsAt: loot.ends_at || null,
        repeat: !!already
      }
    });
  }

  if (path.startsWith('/api/songs/') && method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/songs/'.length));
    const track = await env.DB.prepare('SELECT r2_key, source_url FROM tracks WHERE id = ?').bind(id).first();
    if (!track) return err('not found', 404);
    if (!track.r2_key) {
      // silent terrain sources (picture/words/drawing) have no audio at all
      if (!track.source_url) return err('not found', 404);
      return Response.redirect(track.source_url, 302);
    }
    const range = request.headers.get('range');
    let obj;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const offset = Number(m[1]);
        const end = m[2] ? Number(m[2]) : undefined;
        obj = await env.SONGS.get(track.r2_key, {
          range: end !== undefined ? { offset, length: end - offset + 1 } : { offset }
        });
      }
    }
    if (!obj) obj = await env.SONGS.get(track.r2_key);
    if (!obj) return err('not found', 404);
    const headers = Object.assign({
      'content-type': obj.httpMetadata && obj.httpMetadata.contentType || 'audio/mpeg',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400'
    }, corsHeaders());
    if (obj.range) {
      const start = obj.range.offset;
      const len = obj.range.length !== undefined ? obj.range.length : obj.size - start;
      headers['content-range'] = 'bytes ' + start + '-' + (start + len - 1) + '/' + obj.size;
      return new Response(obj.body, { status: 206, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  if (path.startsWith('/api/presence/')) {
    if (request.headers.get('upgrade') !== 'websocket') return err('expected websocket', 426);
    const areaKey = decodeURIComponent(path.slice('/api/presence/'.length)).slice(0, 200);
    if (!areaKey) return err('bad area');
    const id = env.PRESENCE.idFromName(areaKey);
    return env.PRESENCE.get(id).fetch(request);
  }

  /* ---- admin ---- */

  if (path === '/api/admin/claim' && method === 'POST') {
    const existing = await metaGet(env, 'admin_token_hash');
    if (existing) return err('already claimed', 409);
    // claiming is signing up: the artist must accept the artist agreement
    // (responsibility for content and usage, indemnifying Midhrami)
    let body = null;
    try { body = await request.json(); } catch (e) {}
    if (!body || body.agree !== true) return err('the artist agreement was not accepted', 428);
    const token = randHex(32);
    await metaSet(env, 'admin_token_hash', await sha256Hex(token));
    await metaSet(env, 'terms_accepted', JSON.stringify({ at: Date.now(), version: TERMS_VERSION }));
    let worldId = await metaGet(env, 'world_id');
    if (!worldId) {
      worldId = 'w' + randHex(8);
      await metaSet(env, 'world_id', worldId);
    }
    return json({ ok: true, token, worldId });
  }

  if (path.startsWith('/api/admin/')) {
    const { who, bodyBytes } = await requireAdmin(request, env);
    if (!who) return err('unauthorized', 401);
    return handleAdmin(request, env, ctx, path, method, who, bodyBytes, url);
  }

  return err('not found', 404);
}

async function handleAdmin(request, env, ctx, path, method, who, bodyBytes, url) {
  if (path === '/api/admin/whoami') {
    const terms = await metaGetJson(env, 'terms_accepted', null);
    return json({ ok: true, who, termsAccepted: !!(terms && terms.at) });
  }

  // upgrade path: worlds claimed before the agreement existed accept it here
  if (path === '/api/admin/accept-terms' && method === 'POST') {
    const b = parseJsonBody(bodyBytes);
    if (!b || b.agree !== true) return err('the artist agreement was not accepted', 428);
    await metaSet(env, 'terms_accepted', JSON.stringify({ at: Date.now(), version: TERMS_VERSION }));
    return json({ ok: true });
  }

  if (path === '/api/admin/profile') {
    if (method === 'GET') {
      const profile = await metaGetJson(env, 'profile', DEFAULT_PROFILE);
      return json({ ok: true, profile, worldId: await metaGet(env, 'world_id') });
    }
    if (method === 'PUT') {
      const b = parseJsonBody(bodyBytes);
      if (!b) return err('bad body');
      const cur = await metaGetJson(env, 'profile', DEFAULT_PROFILE);
      const next = {
        worldName: str(b.worldName, cur.worldName, 80),
        artist: str(b.artist, cur.artist, 80),
        bio: str(b.bio, cur.bio, 400),
        layout: b.layout === 'lanes' || b.layout === 'rings' ? b.layout : (cur.layout || 'rings'),
        hues: Array.isArray(b.hues) && b.hues.length === 9
          ? b.hues.map((h) => clamp01(Number(h) || 0)) : cur.hues,
        areaTracks: Array.isArray(b.areaTracks) && b.areaTracks.length === 9
          ? b.areaTracks.map((t) => (typeof t === 'string' && t.length < 64 ? t : null)) : cur.areaTracks
      };
      await metaSet(env, 'profile', JSON.stringify(next));
      // keep the hub in sync when registered (best effort)
      const worldId = await metaGet(env, 'world_id');
      const secret = await metaGet(env, 'world_secret');
      if (worldId && secret && ctx) {
        ctx.waitUntil(registryPost(env, '/heartbeat', {
          worldId, secret, name: next.worldName, artist: next.artist
        }).catch(() => {}));
      }
      return json({ ok: true, profile: next });
    }
  }

  if (path === '/api/admin/tracks' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id, title, r2_key, source_url, hue, envelope IS NOT NULL AS analyzed, created_at FROM tracks ORDER BY (ord IS NULL), ord, created_at'
    ).all();
    return json({ ok: true, tracks: rows.results || [] });
  }

  if (path === '/api/admin/tracks' && method === 'POST') {
    // Body is either raw audio bytes (?title=...) or JSON {title, sourceUrl}
    const contentType = request.headers.get('content-type') || '';
    const id = 't' + randHex(6);
    // stable default hue from the id, so every fan colors the song the same
    const hue = (parseInt(id.slice(1, 7), 16) % 1000) / 1000;
    if (contentType.startsWith('application/json')) {
      const b = parseJsonBody(bodyBytes);
      if (!b) return err('bad body');
      // silent terrain source: creators who are not musicians send a shape
      // made in their browser (from a picture, words, or a drawn skyline);
      // nothing but the numbers is stored, and there is no audio to play
      if (b.envelope && Array.isArray(b.envelope.env)) {
        const e = b.envelope;
        if (e.env.length < 4 || e.env.length > 600) return err('bad shape');
        const envelope = {
          dur: Math.min(600, Math.max(10, Number(e.dur) || 60)),
          env: e.env.slice(0, 600).map((v) => clamp01(Number(v) || 0)),
          beats: Array.isArray(e.beats) ? e.beats.slice(0, 400).map((t) => Math.max(0, Number(t) || 0)) : []
        };
        const h2 = Number.isFinite(Number(b.hue)) ? clamp01(Number(b.hue)) : hue;
        await env.DB.prepare(
          'INSERT INTO tracks (id, title, envelope, ord, hue, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, str(b.title, 'Untitled', 120), JSON.stringify(envelope), Date.now(), h2, Date.now()).run();
        return json({ ok: true, id });
      }
      if (!str(b.sourceUrl, '', 500)) return err('bad body');
      await env.DB.prepare(
        'INSERT INTO tracks (id, title, source_url, ord, hue, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(id, str(b.title, 'Untitled', 120), str(b.sourceUrl, '', 500), Date.now(), hue, Date.now()).run();
      return json({ ok: true, id });
    }
    if (bodyBytes.byteLength < 1000) return err('empty audio');
    if (bodyBytes.byteLength > 25 * 1024 * 1024) return err('audio too large (25 MB max)', 413);
    const key = 'songs/' + id;
    await env.SONGS.put(key, bodyBytes, {
      httpMetadata: { contentType: contentType.startsWith('audio/') ? contentType : 'audio/mpeg' }
    });
    await env.DB.prepare(
      'INSERT INTO tracks (id, title, r2_key, ord, hue, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, str(url.searchParams.get('title'), 'Untitled', 120), key, Date.now(), hue, Date.now()).run();
    return json({ ok: true, id });
  }

  if (path === '/api/admin/tracks/reorder' && method === 'POST') {
    const b = parseJsonBody(bodyBytes);
    if (!b || !Array.isArray(b.ids) || b.ids.length > 100) return err('bad order');
    const stmts = [];
    for (let i = 0; i < b.ids.length; i++) {
      if (typeof b.ids[i] !== 'string') return err('bad order');
      stmts.push(env.DB.prepare('UPDATE tracks SET ord = ? WHERE id = ?').bind(i, b.ids[i]));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  const trackEnvM = path.match(/^\/api\/admin\/tracks\/([\w-]+)\/envelope$/);
  if (trackEnvM && method === 'PUT') {
    const b = parseJsonBody(bodyBytes);
    if (!b || !Array.isArray(b.env) || b.env.length > 600) return err('bad envelope');
    const envelope = {
      dur: Math.min(600, Math.max(1, Number(b.dur) || 30)),
      env: b.env.slice(0, 600).map((v) => clamp01(Number(v) || 0)),
      beats: Array.isArray(b.beats) ? b.beats.slice(0, 400).map((t) => Math.max(0, Number(t) || 0)) : []
    };
    const r = await env.DB.prepare('UPDATE tracks SET envelope = ? WHERE id = ?')
      .bind(JSON.stringify(envelope), trackEnvM[1]).run();
    if (!r.meta.changes) return err('no such track', 404);
    return json({ ok: true });
  }

  const trackPutM = path.match(/^\/api\/admin\/tracks\/([\w-]+)$/);
  if (trackPutM && method === 'PUT') {
    const b = parseJsonBody(bodyBytes);
    if (!b) return err('bad body');
    const t = await env.DB.prepare('SELECT id, title, hue FROM tracks WHERE id = ?').bind(trackPutM[1]).first();
    if (!t) return err('no such track', 404);
    const title = str(b.title, t.title, 120);
    const hue = Number.isFinite(Number(b.hue)) ? clamp01(Number(b.hue)) : t.hue;
    await env.DB.prepare('UPDATE tracks SET title = ?, hue = ? WHERE id = ?').bind(title, hue, t.id).run();
    return json({ ok: true });
  }

  const trackDelM = path.match(/^\/api\/admin\/tracks\/([\w-]+)$/);
  if (trackDelM && method === 'DELETE') {
    const t = await env.DB.prepare('SELECT r2_key FROM tracks WHERE id = ?').bind(trackDelM[1]).first();
    if (t && t.r2_key) { try { await env.SONGS.delete(t.r2_key); } catch (e) {} }
    await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(trackDelM[1]).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/loot' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM loot ORDER BY created_at DESC').all();
    return json({ ok: true, loot: rows.results || [] });
  }

  if (path === '/api/admin/loot' && method === 'POST') {
    const b = parseJsonBody(bodyBytes);
    if (!b || typeof b.areaKey !== 'string' || b.areaKey.length > 200 ||
        !Number.isFinite(Number(b.x)) || !Number.isFinite(Number(b.z))) return err('bad loot');
    if (!str(b.url, '', 500) && !str(b.code, '', 120) && !str(b.message, '', 500)) {
      return err('loot needs a link, a code or a message');
    }
    // optional time window (ms epoch); works alone or combined with a claim cap
    const toTs = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    };
    const startsAt = toTs(b.startsAt), endsAt = toTs(b.endsAt);
    if (startsAt && endsAt && endsAt <= startsAt) return err('the loot would disappear before it appears');
    const id = 'l' + randHex(6);
    await env.DB.prepare(
      `INSERT INTO loot (id, area_key, x, z, title, message, url, code, max_claims, starts_at, ends_at, buried_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, b.areaKey, Math.round(Number(b.x)), Math.round(Number(b.z)),
      str(b.title, 'Buried loot', 120), str(b.message, '', 500),
      str(b.url, '', 500), str(b.code, '', 120),
      Math.max(0, Math.min(1e6, Math.round(Number(b.maxClaims) || 0))),
      startsAt, endsAt,
      who, Date.now()
    ).run();
    return json({ ok: true, id });
  }

  const lootM = path.match(/^\/api\/admin\/loot\/([\w-]+)$/);
  if (lootM && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM loot WHERE id = ?').bind(lootM[1]).run();
    await env.DB.prepare('DELETE FROM claims WHERE loot_id = ?').bind(lootM[1]).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/register' && method === 'POST') {
    const worldId = await metaGet(env, 'world_id');
    if (!worldId) return err('claim the world first');
    const terms = await metaGetJson(env, 'terms_accepted', null);
    if (!terms || !terms.at) return err('the artist agreement was not accepted', 428);
    const profile = await metaGetJson(env, 'profile', DEFAULT_PROFILE);
    const secret = await metaGet(env, 'world_secret');
    const origin = new URL(request.url).origin;
    const { status, data } = await registryPost(env, '/register', {
      worldId, origin, secret: secret || undefined,
      name: profile.worldName, artist: profile.artist,
      termsAt: terms.at, termsVersion: terms.version || 1
    });
    if (status === 200 && data && data.ok) {
      if (data.secret) await metaSet(env, 'world_secret', data.secret);
      return json({ ok: true, registered: true });
    }
    return err(data && data.error ? data.error : 'the hub did not accept the registration (it may not be set up yet)', 502);
  }

  if (path === '/api/admin/links' && method === 'GET') {
    const worldId = await metaGet(env, 'world_id');
    const secret = await metaGet(env, 'world_secret');
    if (!worldId || !secret) return json({ ok: true, links: [], registered: false });
    const { status, data } = await registryPost(env, '/links/mine', { worldId, secret });
    if (status !== 200 || !data || !data.ok) {
      const cached = await metaGetJson(env, 'links_cache', { links: [] });
      return json({ ok: true, links: cached.links || [], stale: true, registered: true });
    }
    await metaSet(env, 'links_cache', JSON.stringify({
      at: Date.now(), links: (data.links || []).filter((l) => l.status === 'active')
    }));
    return json({ ok: true, links: data.links || [], registered: true });
  }

  if (path === '/api/admin/links/request' && method === 'POST') {
    const b = parseJsonBody(bodyBytes);
    const worldId = await metaGet(env, 'world_id');
    const secret = await metaGet(env, 'world_secret');
    if (!worldId || !secret) return err('register with the hub first');
    if (!b || typeof b.targetId !== 'string' || [1, 3, 5, 7].indexOf(Number(b.corner)) < 0) {
      return err('bad link request');
    }
    const { status, data } = await registryPost(env, '/links/request', {
      worldId, secret, targetId: b.targetId, corner: Number(b.corner)
    });
    return status === 200 && data && data.ok ? json(data) : err(data && data.error || 'link request failed', 502);
  }

  if (path === '/api/admin/links/respond' && method === 'POST') {
    const b = parseJsonBody(bodyBytes);
    const worldId = await metaGet(env, 'world_id');
    const secret = await metaGet(env, 'world_secret');
    if (!worldId || !secret) return err('register with the hub first');
    if (!b || typeof b.linkId !== 'string') return err('bad response');
    const { status, data } = await registryPost(env, '/links/respond', {
      worldId, secret, linkId: b.linkId, accept: !!b.accept
    });
    return status === 200 && data && data.ok ? json(data) : err(data && data.error || 'link response failed', 502);
  }

  if (path === '/api/admin/reset-claim' && method === 'POST' && who === 'super') {
    // superuser can hand a world back to its artist if they lose the token
    await env.DB.prepare('DELETE FROM meta WHERE k = ?').bind('admin_token_hash').run();
    return json({ ok: true });
  }

  return err('not found', 404);
}

function str(v, d, max) {
  if (typeof v !== 'string') return d;
  const s = v.trim().slice(0, max);
  return s || d;
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* ── presence Durable Object ──
 * One hub per area key. In-memory only, hibernating WebSockets, tiny
 * receive-light protocol: {t:'hello',fan,name} once, then {t:'beacon',x,y,z}
 * no more than every 8 seconds. Everything else is broadcast out. */
export class PresenceHub {
  constructor(state) {
    this.state = state;
  }
  fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const fan = (url.searchParams.get('fan') || '').slice(0, 64);
    const name = (url.searchParams.get('name') || 'a fan').slice(0, 40);
    if (!fan) return new Response('missing fan id', { status: 400 });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ fan, name, lastBeacon: 0 });
    // tell the newcomer who is here, tell the room who arrived
    const roster = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === pair[1]) continue;
      const a = ws.deserializeAttachment();
      if (a) roster.push({ fan: a.fan, name: a.name });
    }
    try { pair[1].send(JSON.stringify({ t: 'roster', fans: roster })); } catch (e) {}
    this.broadcast({ t: 'join', fan, name }, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws, message) {
    let m = null;
    try { m = JSON.parse(message); } catch (e) { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m) return;
    if (m.t === 'beacon') {
      const now = Date.now();
      if (now - a.lastBeacon < 8000) return; // receive-light: drop chatty clients
      a.lastBeacon = now;
      ws.serializeAttachment(a);
      this.broadcast({
        t: 'beacon', fan: a.fan, name: a.name,
        x: Number(m.x) || 0, y: Number(m.y) || 0, z: Number(m.z) || 0
      }, ws);
    }
  }
  webSocketClose(ws) { this.dropped(ws); }
  webSocketError(ws) { this.dropped(ws); }
  dropped(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.broadcast({ t: 'leave', fan: a.fan, name: a.name }, ws);
  }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch (e) {}
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx);
      } catch (e) {
        return err('world error: ' + (e && e.message ? e.message : 'unknown'), 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
