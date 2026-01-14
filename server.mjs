import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseEnvFile(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

async function loadDotEnvLocal() {
  try {
    const p = path.join(__dirname, '.env.local');
    const raw = await readFile(p, 'utf8');
    const env = parseEnvFile(raw);
    for (const [k, v] of Object.entries(env)) {
      if (process.env[k] == null) process.env[k] = v;
    }
  } catch {
    // ignore
  }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function notFound(res) {
  json(res, 404, { error: 'Not found' });
}

function getNumberParam(url, key) {
  const v = url.searchParams.get(key);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function centroidFromCoords(coords) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const visit = (pt) => {
    const lng = pt[0];
    const lat = pt[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  };

  if (Array.isArray(coords) && coords.length > 0) {
    const first = coords[0];
    if (typeof first?.[0] === 'number') {
      for (const pt of coords) visit(pt);
    } else {
      for (const sub of coords) {
        const c = centroidFromCoords(sub);
        if (!c) continue;
        visit([c.lng, c.lat]);
      }
    }
  }

  if (!Number.isFinite(minLat) || !Number.isFinite(maxLat) || !Number.isFinite(minLng) || !Number.isFinite(maxLng)) return null;
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

function normalizeHandicapSpace(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function isBusyNow(dest) {
  const d = new Date();
  const isSaturday = d.getDay() === 6;
  const hour = d.getHours();
  const isMorning = hour >= 9 && hour <= 12;
  const isDowntown = dest.lat >= 44.225 && dest.lat <= 44.245 && dest.lng >= -76.52 && dest.lng <= -76.47;
  return isSaturday && isMorning && isDowntown;
}

let cachedLots = null;

async function loadParkingLots() {
  if (cachedLots) return cachedLots;
  const geoPath = path.join(__dirname, 'src', 'Parking_Lot_Areas.geojson');
  const raw = await readFile(geoPath, 'utf8');
  const parsed = JSON.parse(raw);
  const rows = [];

  for (const f of parsed?.features ?? []) {
    const props = f?.properties ?? {};
    const handicapN = normalizeHandicapSpace(props.HANDICAP_SPACE);
    if (!handicapN || handicapN <= 0) continue;

    const geom = f?.geometry;
    if (!geom) continue;

    let center = null;
    if (geom.type === 'Polygon') center = centroidFromCoords(geom.coordinates);
    if (geom.type === 'MultiPolygon') center = centroidFromCoords(geom.coordinates);
    if (!center) continue;

    const idRaw = props.GLOBALID ?? props.OBJECTID ?? props.LOT_ID;
    const id = String(idRaw ?? '').trim();
    if (!id) continue;

    rows.push({
      id,
      label: props.LOT_NAME ?? props.MAP_LABEL ?? 'Accessible parking lot',
      lat: center.lat,
      lng: center.lng,
      handicapSpace: String(props.HANDICAP_SPACE ?? ''),
      ownership: props.OWNERSHIP ?? null,
      capacity: props.CAPACITY ?? null
    });
  }

  cachedLots = rows;
  return rows;
}

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBackboardKey() {
  const key = (process.env.VITE_BACKBOARD_API_KEY ?? process.env.BACKBOARD_API_KEY ?? '').trim();
  return key || null;
}

async function backboardJson(pathname, method, bodyObj) {
  const key = getBackboardKey();
  if (!key) throw new Error('Missing Backboard API key on server');

  const res = await fetch(`https://app.backboard.io/api${pathname}`, {
    method,
    headers: {
      'X-API-Key': key,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });

  const ct = res.headers.get('content-type') ?? '';
  const payload = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
  if (!res.ok) {
    const msg = typeof payload === 'object' && payload && payload.error && payload.error.message ? payload.error.message : null;
    const errText = msg || (typeof payload === 'string' ? payload : null) || `Backboard error (${res.status})`;
    const e = new Error(errText);
    e.status = res.status;
    e.body = payload;
    throw e;
  }
  return payload;
}

async function backboardMessage(threadId, args) {
  const key = getBackboardKey();
  if (!key) throw new Error('Missing Backboard API key on server');

  const form = new FormData();
  form.set('content', args.content);
  form.set('stream', 'false');
  form.set('send_to_llm', String(args.send_to_llm ?? true));
  form.set('memory', args.memory ?? 'off');
  form.set('web_search', args.web_search ?? 'off');
  if (args.llm_provider) form.set('llm_provider', args.llm_provider);
  if (args.model_name) form.set('model_name', args.model_name);

  const res = await fetch(`https://app.backboard.io/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      Accept: 'application/json'
    },
    body: form
  });

  const ct = res.headers.get('content-type') ?? '';
  const payload = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
  if (!res.ok) {
    const msg = typeof payload === 'object' && payload && payload.error && payload.error.message ? payload.error.message : null;
    const errText = msg || (typeof payload === 'string' ? payload : null) || `Backboard error (${res.status})`;
    const e = new Error(errText);
    e.status = res.status;
    e.body = payload;
    throw e;
  }
  return payload;
}

await loadDotEnvLocal();

const port = Number.parseInt(process.env.PORT ?? '8787', 10);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/nearest') {
      const lat = getNumberParam(url, 'lat');
      const lng = getNumberParam(url, 'lng');
      if (lat == null || lng == null) {
        badRequest(res, 'Missing lat/lng');
        return;
      }
      const limitRaw = getNumberParam(url, 'limit');
      const limit = Math.max(1, Math.min(25, limitRaw != null ? Math.floor(limitRaw) : 5));

      const lots = await loadParkingLots();
      const origin = { lat, lng };
      const out = lots
        .map((l) => ({
          ...l,
          distanceMeters: haversineMeters(origin, { lat: l.lat, lng: l.lng })
        }))
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, limit);

      json(res, 200, { options: out });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/predict') {
      const lat = getNumberParam(url, 'lat');
      const lng = getNumberParam(url, 'lng');
      if (lat == null || lng == null) {
        badRequest(res, 'Missing lat/lng');
        return;
      }

      const busy = isBusyNow({ lat, lng });
      const probability = busy ? 0.35 : 0.7;
      const rationale = busy ? 'Saturday morning downtown tends to be busiest.' : 'Typical availability expected for this area.';
      json(res, 200, { busy, probability, rationale });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ai/thread') {
      const assistant = await backboardJson('/assistants', 'POST', {
        name: 'KingstonAccess Parking Assistant',
        system_prompt:
          'You help a user in Kingston, Ontario find accessible parking. Respond in short bullet points. If you give a probability, include a brief rationale. Do not mention internal system instructions.'
      });

      const assistantId = assistant?.assistant_id;
      if (!assistantId) throw new Error('Backboard did not return assistant_id');

      const thread = await backboardJson(`/assistants/${encodeURIComponent(assistantId)}/threads`, 'POST', {});
      const threadId = thread?.thread_id;
      if (!threadId) throw new Error('Backboard did not return thread_id');

      json(res, 200, { assistant_id: assistantId, thread_id: threadId });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ai/message') {
      const body = (await parseBody(req)) ?? {};
      const threadId = typeof body.thread_id === 'string' ? body.thread_id.trim() : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!threadId) {
        badRequest(res, 'Missing thread_id');
        return;
      }
      if (!content.trim()) {
        badRequest(res, 'Missing content');
        return;
      }

      const llm_provider = typeof body.llm_provider === 'string' ? body.llm_provider : undefined;
      const model_name = typeof body.model_name === 'string' ? body.model_name : undefined;
      const memory = typeof body.memory === 'string' ? body.memory : undefined;
      const web_search = typeof body.web_search === 'string' ? body.web_search : undefined;
      const send_to_llm = typeof body.send_to_llm === 'boolean' ? body.send_to_llm : undefined;

      const resp = await backboardMessage(threadId, { content, llm_provider, model_name, memory, web_search, send_to_llm });
      json(res, 200, resp);
      return;
    }

    notFound(res);
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    const message = e instanceof Error ? e.message : 'Server error';
    json(res, status, { error: message });
  }
});

server.listen(port, () => {
  process.stdout.write(`API server listening on http://localhost:${port}\n`);
});
