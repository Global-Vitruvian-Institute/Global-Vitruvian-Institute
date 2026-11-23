/**
 * activity-collection.js — the saved-activity pile.
 *
 * One pebble per unique saved activity, settled into a shallow vessel by a
 * small deterministic physics step (gravity, circle collision, friction). The
 * motion is the only playful part: it is never a score, a completion meter or
 * a volume reward. Review status and pins are ignored, and an unrecognised
 * activity is a neutral pebble exactly like any other.
 *
 * A pebble is a fixed-size token for its vessel: the radius depends only on the
 * measured width and height, never on how many activities were saved, so a
 * fuller collection reads as *more pebbles piling up*, not as the same amount of
 * stone spread thinner. Pebbles spawn in a centered, seeded mound and are then
 * settled by collision, so they stack like a small heap instead of lining up
 * across the floor.
 *
 * The simulation is separated from the DOM so it can be reasoned about and
 * tested in Node:
 *
 *   const sim = createPebbleSimulation(items, { width, height });
 *   finishPebbleSimulation(sim);          // settles in bounded steps
 *   sim.pebbles;                          // deterministic positions
 *
 * `createActivityCollection` is the browser half. It measures the vessel after
 * it is attached, animates one brief settle, caches the settled geometry per
 * scope (ids and numbers only — never a reflection or a title), and does not
 * animate again for the same set of ids. The cache is keyed by a canonical
 * fingerprint, so a pin or a reorder does not replay the pile, and a catalog
 * change does not leave stale fills behind. Reduced motion and a hidden
 * document both jump straight to the settled result.
 */
import {
  ACTIVITY_FORMATS,
  FORMAT_IDS,
  GENERAL_SUBJECT,
  SUBJECTS,
  SUBJECT_IDS,
  UNCLASSIFIED_FORMAT,
  summarizeActivities,
} from './activity-catalog.js';

/** Most pebbles drawn at once. The legend and total stay exact regardless. */
export const MAX_PEBBLES = 160;

/**
 * Fixed token size. `base` is the radius in a `referenceArea` vessel (600x180),
 * and the radius scales with the square root of the vessel area so a narrow
 * phone gets smaller tokens than a wide page. `min`/`max` bound the size, and
 * `packing` is the conservative areal density a heap of equal circles reaches,
 * which is what keeps a full pile of `MAX_PEBBLES` inside the vessel.
 *
 * None of this reads `count`: two activities and a hundred and sixty draw the
 * same token, so the pile grows in pebbles, not in scale.
 */
export const PEBBLE_RADIUS = Object.freeze({
  base: 8,
  referenceArea: 600 * 180,
  min: 3.5,
  max: 11,
  packing: 0.62,
});

/** Tuning for the pile. Every number is fixed, so a settle is reproducible. */
export const PEBBLE_SIM = Object.freeze({
  dt: 1 / 120,
  maxSteps: 360,
  minSteps: 30,
  stepsPerFrame: 4,
  gravityScale: 1.6,
  restitution: 0.1,
  pairFriction: 0.4,
  floorFriction: 0.92,
  airDrag: 0.9995,
  restSpeed: 6,
  iterations: 4,
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const NEUTRAL_COLOR_KEY = 'neutral';
const SAFE_COLOR_KEYS = new Set([...SUBJECT_IDS, NEUTRAL_COLOR_KEY]);

/* ------------------------------------------------------------- geometry --- */

/** FNV-1a over the id, so a pebble's shape and start are stable per id. */
export function hashId(value) {
  const text = String(value ?? '');
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function pebbleSeed(id) {
  return hashId(id);
}

/** A tiny deterministic PRNG (mulberry32). No shared state between pebbles. */
function randomFrom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The common organic silhouette, in unit space (radius 1). Every id shares the
 * same radii, so every pebble encloses exactly the same area; the id only seeds
 * a rotation, which is what keeps each activity's pebble recognisable without
 * changing its size. A rotation is area-preserving, so this is true equal area
 * for the drawn path as well as the control points.
 */
function baseShapeRadius(index, count) {
  const t = count > 0 ? index / count : 0;
  // A fixed, gentle wobble: three lobes plus a finer ripple. The result stays
  // inside [0.84, 0.98], so a pebble never grows past its token radius.
  return 0.91
    + 0.05 * Math.sin(t * Math.PI * 2 * 3)
    + 0.02 * Math.cos(t * Math.PI * 2 * 5 + 1.1);
}

/**
 * The radial silhouette of a pebble in unit space (radius 1). Seeded by the id,
 * so the same activity always looks the same, and equal-area for every id.
 */
export function pebbleShape(id, points = 9) {
  const count = Math.max(5, Math.floor(points));
  const rotation = (pebbleSeed(id) / 4294967296) * Math.PI * 2;
  const shape = [];
  for (let index = 0; index < count; index += 1) {
    shape.push({
      angle: (index / count) * Math.PI * 2 + rotation,
      radius: baseShapeRadius(index, count),
    });
  }
  return shape;
}

function shapeNodes(id, points = 9) {
  return pebbleShape(id, points).map((point) => ({
    x: Math.cos(point.angle) * point.radius,
    y: Math.sin(point.angle) * point.radius,
  }));
}

function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** A closed, gently smoothed path for one pebble, in unit space. */
export function pebblePath(id, points = 9) {
  const nodes = shapeNodes(id, points);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const count = nodes.length;
  const start = mid(nodes[count - 1], nodes[0]);
  let path = `M ${round(start.x)} ${round(start.y)}`;
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    const next = nodes[(index + 1) % count];
    const middle = mid(node, next);
    path += ` Q ${round(node.x)} ${round(node.y)} ${round(middle.x)} ${round(middle.y)}`;
  }
  return `${path} Z`;
}

/**
 * The area enclosed by the drawn (smoothed) path, in unit-radius units. The
 * shape is the same for every id up to a rotation, so this is identical for
 * every pebble; it exists so the equal-area claim can be checked against the
 * path that is actually painted rather than against the control points alone.
 */
export function pebblePathArea(id, points = 9, samples = 24) {
  const nodes = shapeNodes(id, points);
  const count = nodes.length;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const per = Math.max(4, Math.floor(samples));
  const outline = [];
  for (let index = 0; index < count; index += 1) {
    const start = mid(nodes[(index + count - 1) % count], nodes[index]);
    const control = nodes[index];
    const end = mid(nodes[index], nodes[(index + 1) % count]);
    for (let step = 0; step < per; step += 1) {
      const t = step / per;
      const u = 1 - t;
      outline.push({
        x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
      });
    }
  }
  let area = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index];
    const b = outline[(index + 1) % outline.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * One fixed radius for the whole pile. It depends only on the vessel's measured
 * area, never on the number of pebbles, a subject, a status or a count of
 * words — the `count` argument is accepted for call-site compatibility and is
 * deliberately ignored. The result is bounded by `PEBBLE_RADIUS.min`/`max` and,
 * for a very small vessel, by the radius at which `MAX_PEBBLES` can still pack.
 */
export function pebbleRadius(count, width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const scaled = PEBBLE_RADIUS.base * Math.sqrt((w * h) / PEBBLE_RADIUS.referenceArea);
  const preferred = clamp(scaled, PEBBLE_RADIUS.min, PEBBLE_RADIUS.max);
  const fit = Math.sqrt((w * h * PEBBLE_RADIUS.packing) / (MAX_PEBBLES * Math.PI));
  return Math.max(0.5, Math.min(preferred, fit));
}

/**
 * Deterministic spawn slots for a centered mound of `count` pebbles: a rounded
 * heap that is widest at the floor and tapers toward the crown, with spaced
 * rows so neighbours are never placed on top of one another. Physics then does
 * the last bit of settling. Slots are returned bottom row first.
 */
export function heapSlots(count, width, height, radius) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (!total) return [];
  const r = Math.max(0.5, Number(radius) || 0.5);
  const w = Math.max(2 * r, Number(width) || 2 * r);
  const h = Math.max(2 * r, Number(height) || 2 * r);
  const rowGap = r * 1.76;
  const colGap = r * 2.02;
  const maxRows = Math.max(1, Math.floor((h - 2 * r) / rowGap) + 1);
  const rowCapacity = Math.max(1, Math.floor((w - 2 * r - colGap / 2) / colGap) + 1);

  // A small pile is low and wide; a full one grows taller. Never taller than
  // the vessel allows, and never wider than a row can hold.
  let rows = Math.max(1, Math.min(maxRows, Math.ceil(Math.sqrt(total / 2))));
  let counts = moundCounts(total, rows);
  while (rows < maxRows && Math.max(...counts) > rowCapacity) {
    rows += 1;
    counts = moundCounts(total, rows);
  }

  const slots = [];
  for (let row = 0; row < counts.length; row += 1) {
    const rowCount = counts[row];
    const y = h - r - row * rowGap;
    // Keep every row on one hexagonal lattice, even when row lengths change.
    const stagger = (row % 2) * colGap / 2;
    for (let column = 0; column < rowCount; column += 1) {
      const x = w / 2 + (column - Math.floor(rowCount / 2)) * colGap + stagger;
      slots.push({ x, y });
    }
  }
  const xs = slots.map((slot) => slot.x);
  const offset = w / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
  for (const slot of slots) slot.x += offset;
  return slots;
}

/** How many pebbles each row of a `rows`-tall mound holds, bottom row first. */
function moundCounts(total, rows) {
  const weights = [];
  let sum = 0;
  for (let row = 0; row < rows; row += 1) {
    const weight = Math.sqrt(rows - row);
    weights.push(weight);
    sum += weight;
  }
  const counts = weights.map((weight) => Math.max(1, Math.round((total * weight) / sum)));
  let drift = total - counts.reduce((a, b) => a + b, 0);
  for (let index = 0; drift !== 0 && index < counts.length * 2; index += 1) {
    const row = index % counts.length;
    if (drift > 0) {
      counts[row] += 1;
      drift -= 1;
    } else if (counts[row] > 1) {
      counts[row] -= 1;
      drift += 1;
    }
  }
  return counts;
}

/* ----------------------------------------------------------- simulation --- */

function dedupeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  list.forEach((item, index) => {
    const raw = item?.id;
    const id = (typeof raw === 'string' && raw.length) || (typeof raw === 'number' && Number.isFinite(raw))
      ? String(raw)
      : `__item-${index}`;
    if (seen.has(id)) return;
    seen.add(id);
    const colorKey = typeof item?.colorKey === 'string' && item.colorKey ? item.colorKey : 'neutral';
    out.push({ id, colorKey, subjectId: item?.subjectId ?? 'general' });
  });
  return out;
}

function positionMap(initialPositions) {
  const map = new Map();
  if (!initialPositions) return map;
  if (typeof initialPositions.get === 'function') {
    for (const [id, value] of initialPositions) {
      if (value && typeof value === 'object') map.set(String(id), value);
    }
    return map;
  }
  for (const value of initialPositions) {
    if (value && typeof value === 'object' && value.id != null) map.set(String(value.id), value);
  }
  return map;
}

/**
 * Build a pile from `items` ({ id, colorKey, subjectId }). Nothing moves until
 * `stepPebbleSimulation` is called; `initialPositions` lets an existing pile
 * keep its shape when a new activity is added.
 */
export function createPebbleSimulation(items, options = {}) {
  const {
    width = 320,
    height = 180,
    maxPebbles = MAX_PEBBLES,
    initialPositions = null,
    dt = PEBBLE_SIM.dt,
    gravityScale = PEBBLE_SIM.gravityScale,
    restitution = PEBBLE_SIM.restitution,
    pairFriction = PEBBLE_SIM.pairFriction,
    floorFriction = PEBBLE_SIM.floorFriction,
    airDrag = PEBBLE_SIM.airDrag,
    restSpeed = PEBBLE_SIM.restSpeed,
    iterations = PEBBLE_SIM.iterations,
    maxSteps = PEBBLE_SIM.maxSteps,
    minSteps = PEBBLE_SIM.minSteps,
  } = options;

  const deduped = dedupeItems(items);
  const total = deduped.length;
  const cap = Math.max(0, Math.floor(maxPebbles));
  const rendered = deduped.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(0, cap);
  const hiddenCount = total - rendered.length;

  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const radius = pebbleRadius(rendered.length, w, h);
  const previous = positionMap(initialPositions);

  const ordered = rendered.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // New pebbles start in a centered mound inside the vessel rather than above
  // it, so nothing is ever teleported through a wall. Their own ids seed a
  // small jitter on top of the slot, and physics does the last of the settling.
  const slots = heapSlots(ordered.length, w, h, radius);
  const pebbles = ordered.map((item, index) => {
    const next = randomFrom(pebbleSeed(item.id));
    const was = previous.get(item.id) ?? null;
    const slot = slots[index] ?? { x: w / 2, y: h - radius };
    const x = was
      ? clamp(Number(was.x) || 0, radius, Math.max(radius, w - radius))
      : clamp(slot.x + (next() - 0.5) * radius * 0.12, radius, Math.max(radius, w - radius));
    const y = was
      ? clamp(Number(was.y) || 0, radius, Math.max(radius, h - radius))
      : clamp(slot.y + (next() - 0.5) * radius * 0.12, radius, Math.max(radius, h - radius));
    return {
      id: item.id,
      colorKey: item.colorKey,
      subjectId: item.subjectId,
      r: radius,
      x,
      y,
      vx: was ? Number(was.vx) || 0 : (next() - 0.5) * 8,
      vy: was ? Number(was.vy) || 0 : 0,
      supported: false,
    };
  });

  return {
    pebbles,
    width: w,
    height: h,
    radius,
    total,
    rendered: pebbles.length,
    hiddenCount,
    dt,
    gravityScale,
    restitution,
    pairFriction,
    floorFriction,
    airDrag,
    restSpeed,
    iterations,
    maxSteps,
    minSteps,
    frames: 0,
    done: pebbles.length === 0,
    settled: pebbles.length === 0,
    bounded: false,
  };
}

function resolveWalls(sim) {
  const {
    pebbles, width, height, restitution, floorFriction,
  } = sim;
  for (const pebble of pebbles) {
    if (pebble.x - pebble.r < 0) {
      pebble.x = pebble.r;
      if (pebble.vx < 0) pebble.vx = -pebble.vx * restitution;
    } else if (pebble.x + pebble.r > width) {
      pebble.x = width - pebble.r;
      if (pebble.vx > 0) pebble.vx = -pebble.vx * restitution;
    }
    if (pebble.y - pebble.r < 0) {
      pebble.y = pebble.r;
      if (pebble.vy < 0) pebble.vy = -pebble.vy * restitution;
    } else if (pebble.y + pebble.r > height) {
      pebble.y = height - pebble.r;
      pebble.supported = true;
      if (pebble.vy > 0) pebble.vy = -pebble.vy * restitution;
      pebble.vx *= floorFriction;
    }
  }
}

function resolvePairs(sim) {
  const { pebbles, restitution, pairFriction } = sim;
  for (let i = 0; i < pebbles.length; i += 1) {
    const a = pebbles[i];
    for (let j = i + 1; j < pebbles.length; j += 1) {
      const b = pebbles[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const minimum = a.r + b.r;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= minimum * minimum) continue;
      let distance = Math.sqrt(distanceSq);
      if (distance === 0) {
        dx = 1;
        dy = 0;
        distance = 1e-6;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      // Only a contact with something below counts as support. A neighbour to
      // the side never freezes a falling pebble in mid-air.
      if (ny > 0.1) a.supported = true;
      if (ny < -0.1) b.supported = true;
      const overlap = minimum - distance;
      const sum = a.r + b.r;
      const aPush = (b.r / sum) * overlap;
      const bPush = (a.r / sum) * overlap;
      a.x -= nx * aPush;
      a.y -= ny * aPush;
      b.x += nx * bPush;
      b.y += ny * bPush;

      const relativeX = b.vx - a.vx;
      const relativeY = b.vy - a.vy;
      const normalSpeed = relativeX * nx + relativeY * ny;
      if (normalSpeed > 0) continue;

      const invA = 1 / (a.r * a.r);
      const invB = 1 / (b.r * b.r);
      const invSum = invA + invB;
      const impulse = (-(1 + restitution) * normalSpeed) / invSum;
      a.vx -= nx * impulse * invA;
      a.vy -= ny * impulse * invA;
      b.vx += nx * impulse * invB;
      b.vy += ny * impulse * invB;

      const tx = -ny;
      const ty = nx;
      const tangential = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
      const friction = (-tangential * pairFriction) / invSum;
      a.vx -= tx * friction * invA;
      a.vy -= ty * friction * invA;
      b.vx += tx * friction * invB;
      b.vy += ty * friction * invB;
    }
  }
}

function clampToBounds(sim) {
  for (const pebble of sim.pebbles) {
    pebble.x = clamp(pebble.x, pebble.r, Math.max(pebble.r, sim.width - pebble.r));
    pebble.y = clamp(pebble.y, pebble.r, Math.max(pebble.r, sim.height - pebble.r));
  }
}

function stepOnce(sim) {
  const {
    pebbles, height, dt, gravityScale,
  } = sim;
  const gravity = gravityScale * height;
  for (const pebble of pebbles) {
    pebble.supported = false;
    pebble.vy += gravity * dt;
    pebble.vx *= sim.airDrag;
    pebble.vy *= sim.airDrag;
    pebble.x += pebble.vx * dt;
    pebble.y += pebble.vy * dt;
  }
  for (let iteration = 0; iteration < sim.iterations; iteration += 1) {
    resolveWalls(sim);
    resolvePairs(sim);
  }
  clampToBounds(sim);

  // Static friction: a pebble that is supported from below and barely moving
  // is put to sleep instead of jittering forever. A pebble still falling has no
  // support and is never frozen mid-air.
  const sleepSpeed = sim.restSpeed * 0.75;
  for (const pebble of pebbles) {
    if (pebble.supported && Math.hypot(pebble.vx, pebble.vy) < sleepSpeed) {
      pebble.vx = 0;
      pebble.vy = 0;
    }
  }

  if (sim.frames + 1 >= sim.minSteps) {
    let fastest = 0;
    for (const pebble of pebbles) {
      const speed = Math.hypot(pebble.vx, pebble.vy);
      if (speed > fastest) fastest = speed;
    }
    if (fastest < sim.restSpeed) {
      sim.done = true;
      sim.settled = true;
    }
  }
}

/** Advance a pile by `steps` fixed physics steps. Bounded and deterministic. */
export function stepPebbleSimulation(sim, { steps = 1 } = {}) {
  if (!sim || sim.done) return sim;
  const count = Math.max(1, Math.floor(steps));
  for (let index = 0; index < count && !sim.done; index += 1) {
    stepOnce(sim);
    sim.frames += 1;
    if (sim.frames >= sim.maxSteps) {
      sim.done = true;
      sim.bounded = true;
    }
  }
  return sim;
}

/** Run a pile to rest (or to its frame cap) without animating. */
export function finishPebbleSimulation(sim) {
  if (!sim) return sim;
  let guard = 0;
  while (!sim.done && guard <= sim.maxSteps) {
    stepPebbleSimulation(sim, { steps: 1 });
    guard += 1;
  }
  return sim;
}

/** The instant, settled result. This is what reduced motion shows. */
export function settlePebbles(items, options = {}) {
  return finishPebbleSimulation(createPebbleSimulation(items, options));
}

/* ------------------------------------------------------------ component --- */

let uidCounter = 0;

/**
 * A bounded, least-recently-used store of settled piles. Each scope keeps one
 * pile, and the store drops the oldest scopes once it holds too many piles or
 * too many pebbles in total, so browsing every account in a session cannot grow
 * this without limit.
 */
export function createLayoutCache({ maxScopes = 8, maxPebbles = 1200 } = {}) {
  const scopeLimit = Math.max(1, Math.floor(maxScopes) || 1);
  const pebbleLimit = Math.max(1, Math.floor(maxPebbles) || 1);
  const entries = new Map();

  function pebbleCount() {
    let total = 0;
    for (const entry of entries.values()) total += entry?.pebbles?.length ?? 0;
    return total;
  }

  function evict() {
    while (entries.size > scopeLimit || pebbleCount() > pebbleLimit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    get(scopeId) {
      const key = String(scopeId);
      const entry = entries.get(key);
      if (!entry) return null;
      // Refresh recency: a scope that is looked at stays cached.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(scopeId, entry) {
      const key = String(scopeId);
      entries.delete(key);
      entries.set(key, entry);
      evict();
    },
    clear() {
      entries.clear();
    },
    stats() {
      return { scopes: entries.size, pebbles: pebbleCount() };
    },
  };
}

/**
 * Settled geometry per scope. Only ids, colours and numbers are kept, so a
 * signed-in account can never inherit another account's words from this cache.
 */
const layoutCache = createLayoutCache();

/** Drop every cached pile. Intended for tests and for a full sign-out. */
export function clearCollectionLayoutCache() {
  layoutCache.clear();
}

/** How much geometry the shared cache is holding. Read-only, for tests. */
export function collectionLayoutCacheStats() {
  return layoutCache.stats();
}

/**
 * A canonical key for one rendered pile: the sorted set of `(id, colour,
 * subject)` triples, not the order they arrived in. A pin or a reorder leaves
 * the set alone and so hits the cache instead of replaying the settle; a changed
 * colour or subject, or a different set, misses it so nothing stale is drawn.
 */
export function collectionFingerprint(items, maxPebbles = MAX_PEBBLES) {
  const cap = Math.max(0, Math.floor(Number(maxPebbles) || 0));
  const list = Array.isArray(items)
    ? items.slice().sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? ''))).slice(0, cap)
    : [];
  return list
    .map((item, index) => {
      const id = item?.id != null ? String(item.id) : `__item-${index}`;
      const colorKey = typeof item?.colorKey === 'string' && item.colorKey ? item.colorKey : NEUTRAL_COLOR_KEY;
      const subjectId = item?.subjectId != null ? String(item.subjectId) : GENERAL_SUBJECT.id;
      return `${id}\u0000${colorKey}\u0000${subjectId}`;
    })
    .sort()
    .join('\u0001');
}

/** `3 activities`, `1 activity`. The number is exact and compact. */
export function activityCountLabel(total) {
  const value = Math.max(0, Math.floor(Number(total) || 0));
  return `${value} ${value === 1 ? 'activity' : 'activities'}`;
}

function svgElement(doc, tag) {
  return doc.createElementNS(SVG_NS, tag);
}

function subjectSwatch(doc, subjectId) {
  const colorKey = SUBJECTS[subjectId]?.colorKey ?? NEUTRAL_COLOR_KEY;
  const node = svgElement(doc, 'path');
  node.setAttribute('class', `activity-collection-shape activity-collection-shape-${colorKey}`);
  node.setAttribute('d', pebblePath(subjectId));
  node.setAttribute('transform', 'translate(8 8) scale(5.5)');
  return node;
}

function buildLegend(doc, summary) {
  const list = doc.createElement('ul');
  list.className = 'activity-collection-legend';
  const subjects = [...SUBJECT_IDS.map((id) => SUBJECTS[id]), GENERAL_SUBJECT];
  for (const subject of subjects) {
    const value = summary.bySubject[subject.id] ?? 0;
    const item = doc.createElement('li');
    item.className = 'activity-collection-legend-item';
    item.dataset.subject = subject.id;
    item.dataset.count = String(value);

    const swatch = svgElement(doc, 'svg');
    swatch.setAttribute('class', 'activity-collection-swatch');
    swatch.setAttribute('viewBox', '0 0 16 16');
    swatch.setAttribute('width', '14');
    swatch.setAttribute('height', '14');
    swatch.setAttribute('aria-hidden', 'true');
    swatch.setAttribute('focusable', 'false');
    swatch.append(subjectSwatch(doc, subject.id));

    const label = doc.createElement('span');
    label.className = 'activity-collection-legend-label';
    label.textContent = subject.label;

    const count = doc.createElement('span');
    count.className = 'activity-collection-legend-count';
    count.textContent = String(value);

    item.append(swatch, label, count);
    list.append(item);
  }
  return list;
}

function buildFormatLegend(doc, summary) {
  const list = doc.createElement('ul');
  list.className = 'activity-collection-formats';
  const formats = [...FORMAT_IDS.map((id) => ACTIVITY_FORMATS[id]), UNCLASSIFIED_FORMAT];
  let any = false;
  for (const format of formats) {
    const value = summary.byFormat[format.id] ?? 0;
    if (!value) continue;
    any = true;
    const item = doc.createElement('li');
    item.className = 'activity-collection-format';
    item.dataset.format = format.id;
    item.textContent = `${format.label} ${value}`;
    list.append(item);
  }
  list.hidden = !any;
  return list;
}

/**
 * Create the collection section for `records`.
 *
 * Returns `{ element, update, dispose }`. `element` is a `<section
 * class="activity-collection">`; `update(records)` re-renders the counts and
 * lets a changed pile settle again; `dispose()` cancels the animation frame,
 * disconnects the observer and removes the visibility listener.
 */
export function createActivityCollection(records = [], options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('createActivityCollection needs a document.');
  }
  const win = options.window ?? doc.defaultView ?? globalThis.window ?? null;
  const scopeId = String(options.scopeId ?? 'guest');
  const maxPebbles = Number.isFinite(options.maxPebbles) ? options.maxPebbles : MAX_PEBBLES;
  const vesselHeight = Number.isFinite(options.vesselHeight) ? options.vesselHeight : 180;
  const requestFrame = options.requestAnimationFrame ?? win?.requestAnimationFrame?.bind(win) ?? null;
  const cancelFrame = options.cancelAnimationFrame ?? win?.cancelAnimationFrame?.bind(win) ?? null;
  const ResizeObs = options.ResizeObserver ?? globalThis.ResizeObserver ?? null;
  const reducedQuery = options.reducedMotionQuery ?? win?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  const forceReducedMotion = typeof options.reducedMotion === 'boolean' ? options.reducedMotion : null;

  let summary = summarizeActivities(records);
  let items = summary.items.map((item, index) => ({
    id: item.id ?? `__item-${index}`,
    colorKey: item.colorKey,
    subjectId: item.subjectId,
  }));
  let sim = null;
  let frameId = 0;
  let disposed = false;

  const uid = `activity-collection-${(uidCounter += 1)}`;
  const section = doc.createElement('section');
  section.className = 'activity-collection';
  section.dataset.scopeId = scopeId;
  section.setAttribute('aria-labelledby', `${uid}-title`);
  section.style.setProperty('--activity-collection-height', `${vesselHeight}px`);

  const title = doc.createElement('h2');
  title.className = 'activity-collection-title';
  title.id = `${uid}-title`;
  title.textContent = 'Your collection';

  const count = doc.createElement('p');
  count.className = 'activity-collection-count';

  const vessel = doc.createElement('div');
  vessel.className = 'activity-collection-vessel';

  const svg = svgElement(doc, 'svg');
  svg.setAttribute('class', 'activity-collection-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const empty = doc.createElement('p');
  empty.className = 'activity-collection-empty';
  empty.textContent = 'No saved activities yet.';

  vessel.append(svg, empty);

  let legend = buildLegend(doc, summary);
  const more = doc.createElement('p');
  more.className = 'activity-collection-more';
  more.hidden = true;
  let formats = buildFormatLegend(doc, summary);

  const foot = doc.createElement('footer');
  foot.className = 'activity-collection-foot';
  foot.append(more, formats);

  section.append(title, count, vessel, legend, foot);

  let pathNodes = new Map();

  function refreshText() {
    count.dataset.count = String(summary.total);
    count.textContent = activityCountLabel(summary.total);
    empty.hidden = summary.total > 0;
    const nextLegend = buildLegend(doc, summary);
    legend.replaceWith(nextLegend);
    legend = nextLegend;
    const nextFormats = buildFormatLegend(doc, summary);
    formats.replaceWith(nextFormats);
    formats = nextFormats;
  }

  function safeColorKey(value) {
    return SAFE_COLOR_KEYS.has(value) ? value : 'neutral';
  }

  function setViewBox(width, height) {
    svg.setAttribute('viewBox', `0 0 ${round(width, 2)} ${round(height, 2)}`);
  }

  function buildPebbleNodes(source) {
    pathNodes = new Map();
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const pebble of source.pebbles) {
      const node = svgElement(doc, 'path');
      node.setAttribute('class', `activity-collection-pebble activity-collection-pebble-${safeColorKey(pebble.colorKey)}`);
      node.setAttribute('d', pebblePath(pebble.id));
      node.setAttribute('transform', `translate(${round(pebble.x, 2)} ${round(pebble.y, 2)}) scale(${round(pebble.r, 3)})`);
      pathNodes.set(pebble.id, node);
      svg.append(node);
    }
  }

  function paint() {
    if (!sim) return;
    for (const pebble of sim.pebbles) {
      const node = pathNodes.get(pebble.id);
      if (!node) continue;
      node.setAttribute('transform', `translate(${round(pebble.x, 2)} ${round(pebble.y, 2)}) scale(${round(pebble.r, 3)})`);
    }
    more.hidden = sim.hiddenCount <= 0;
    more.textContent = sim.hiddenCount > 0 ? `+${sim.hiddenCount} more` : '';
  }

  function cacheLayout() {
    if (!sim) return;
    layoutCache.set(scopeId, {
      fingerprint: collectionFingerprint(items, maxPebbles),
      width: sim.width,
      height: sim.height,
      pebbles: sim.pebbles.map((pebble) => ({
        id: pebble.id, colorKey: pebble.colorKey, subjectId: pebble.subjectId, r: pebble.r, x: pebble.x, y: pebble.y,
      })),
      hiddenCount: sim.hiddenCount,
    });
  }

  function measure() {
    const rect = typeof vessel.getBoundingClientRect === 'function' ? vessel.getBoundingClientRect() : null;
    const width = Math.round(rect?.width || vessel.clientWidth || 0);
    const height = Math.round(rect?.height || vessel.clientHeight || 0);
    return { width, height };
  }

  function isHidden() {
    return doc.visibilityState === 'hidden';
  }

  function prefersReducedMotion() {
    if (forceReducedMotion !== null) return forceReducedMotion;
    return Boolean(reducedQuery?.matches);
  }

  function cancelPendingFrame() {
    if (!frameId) return;
    if (cancelFrame) cancelFrame(frameId);
    frameId = 0;
  }

  function scheduleFrame() {
    if (frameId || disposed || !sim || sim.done) return;
    if (typeof requestFrame !== 'function') {
      finishPebbleSimulation(sim);
      paint();
      cacheLayout();
      return;
    }
    frameId = requestFrame(onFrame);
  }

  function onFrame() {
    frameId = 0;
    if (disposed || !sim || sim.done) return;
    // A detached or hidden pile is not animated; it is finished the moment it
    // is looked at again.
    if (isHidden() || !section.isConnected) return;
    stepPebbleSimulation(sim, { steps: PEBBLE_SIM.stepsPerFrame });
    paint();
    if (sim.done) {
      cacheLayout();
      return;
    }
    scheduleFrame();
  }

  function applyLayout(animate) {
    if (disposed) return;
    const { width, height } = measure();
    if (!width || !height) return;
    const cached = layoutCache.get(scopeId);
    const fingerprint = collectionFingerprint(items, maxPebbles);
    if (cached && cached.fingerprint === fingerprint && cached.width === width && cached.height === height) {
      // The pile itself is replayed from the cache, but the fills are taken from
      // the current items so a catalog update can never leave a stale colour.
      const current = new Map(items.map((item) => [String(item.id), item]));
      sim = {
        pebbles: cached.pebbles.map((pebble) => {
          const item = current.get(pebble.id);
          return {
            ...pebble,
            colorKey: safeColorKey(item?.colorKey ?? pebble.colorKey),
            subjectId: item?.subjectId ?? pebble.subjectId,
            vx: 0,
            vy: 0,
          };
        }),
        width, height, radius: cached.pebbles[0]?.r ?? pebbleRadius(cached.pebbles.length, width, height),
        total: summary.total, rendered: cached.pebbles.length,
        hiddenCount: Math.max(0, summary.total - cached.pebbles.length),
        done: true, settled: true, bounded: false, frames: 0, maxSteps: 0, minSteps: 0,
      };
      setViewBox(width, height);
      buildPebbleNodes(sim);
      paint();
      return;
    }

    sim = createPebbleSimulation(items, {
      width, height, maxPebbles, initialPositions: cached?.pebbles ?? null,
    });
    setViewBox(width, height);
    buildPebbleNodes(sim);
    paint();

    if (!animate || prefersReducedMotion() || isHidden() || !section.isConnected) {
      finishPebbleSimulation(sim);
      paint();
      cacheLayout();
      return;
    }
    scheduleFrame();
  }

  function onResize() {
    if (disposed) return;
    const { width, height } = measure();
    if (!width || !height) return;
    if (sim && sim.width === width && sim.height === height) return;
    cancelPendingFrame();
    applyLayout(true);
  }

  function onVisibility() {
    if (disposed) return;
    if (isHidden()) {
      cancelPendingFrame();
      return;
    }
    if (!sim || sim.done) return;
    if (prefersReducedMotion()) {
      finishPebbleSimulation(sim);
      paint();
      cacheLayout();
      return;
    }
    scheduleFrame();
  }

  function onMotionChange() {
    if (disposed || !sim || sim.done) return;
    if (prefersReducedMotion()) {
      cancelPendingFrame();
      finishPebbleSimulation(sim);
      paint();
      cacheLayout();
    } else {
      scheduleFrame();
    }
  }

  refreshText();

  let observer = null;
  if (typeof ResizeObs === 'function') {
    observer = new ResizeObs(onResize);
    observer.observe(vessel);
  }
  doc.addEventListener?.('visibilitychange', onVisibility);
  reducedQuery?.addEventListener?.('change', onMotionChange);

  // Measure immediately in case the caller attaches before the observer fires.
  applyLayout(true);
  if (!observer && !sim && typeof requestFrame === 'function') {
    // No ResizeObserver: try once more after the caller has had a chance to
    // attach the section, then let the caller call `update` on a real resize.
    frameId = requestFrame(() => {
      frameId = 0;
      if (disposed) return;
      applyLayout(true);
    });
  }

  function update(nextRecords = []) {
    if (disposed) return;
    summary = summarizeActivities(nextRecords);
    items = summary.items.map((item, index) => ({
      id: item.id ?? `__item-${index}`,
      colorKey: item.colorKey,
      subjectId: item.subjectId,
    }));
    refreshText();
    cancelPendingFrame();
    applyLayout(true);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelPendingFrame();
    observer?.disconnect();
    observer = null;
    doc.removeEventListener?.('visibilitychange', onVisibility);
    reducedQuery?.removeEventListener?.('change', onMotionChange);
    pathNodes.clear();
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  return {
    element: section,
    update,
    dispose,
    get summary() {
      return summary;
    },
  };
}
