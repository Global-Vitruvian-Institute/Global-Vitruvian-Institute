/**
 * The pebble pile's pure half: the deterministic simulation and the small
 * geometry helpers. No DOM is involved, so a settle can be replayed exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PEBBLES,
  PEBBLE_RADIUS,
  PEBBLE_SIM,
  activityCountLabel,
  clearCollectionLayoutCache,
  collectionFingerprint,
  collectionLayoutCacheStats,
  createLayoutCache,
  createPebbleSimulation,
  finishPebbleSimulation,
  hashId,
  heapSlots,
  pebblePath,
  pebblePathArea,
  pebbleRadius,
  pebbleSeed,
  pebbleShape,
  settlePebbles,
  stepPebbleSimulation,
} from '../reader/public/activity-collection.js';

const VESSEL = { width: 600, height: 180 };
/** A narrow phone-width vessel: the tight case for a full pile. */
const MOBILE = { width: 320, height: 180 };

function items(count, { colorKey = 'physical', prefix = 'id' } = {}) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, colorKey }));
}

function positions(sim) {
  return sim.pebbles.map((pebble) => [pebble.id, pebble.x, pebble.y, pebble.r]);
}

test('activityCountLabel is exact and compact', () => {
  assert.equal(activityCountLabel(0), '0 activities');
  assert.equal(activityCountLabel(1), '1 activity');
  assert.equal(activityCountLabel(2), '2 activities');
  assert.equal(activityCountLabel(160), '160 activities');
  assert.equal(activityCountLabel(-3), '0 activities');
  assert.equal(activityCountLabel('4'), '4 activities');
});

test('a pebble seed is stable per id and independent of the set', () => {
  assert.equal(hashId('Movement'), hashId('Movement'));
  assert.equal(pebbleSeed('Movement'), pebbleSeed('Movement'));
  assert.notEqual(pebbleSeed('Movement'), pebbleSeed('Breath'));
  assert.equal(typeof pebbleSeed('Movement'), 'number');
  assert.ok(Number.isInteger(pebbleSeed('Movement')));
});

test('pebble shapes are deterministic and equal-area (unit radius)', () => {
  const a = pebbleShape('Movement');
  const b = pebbleShape('Movement');
  assert.deepEqual(a, b);
  assert.equal(a.length, 9);
  for (const point of a) {
    assert.ok(point.radius >= 0.82 && point.radius <= 1, 'a shape stays inside the unit circle');
  }
  assert.notDeepEqual(pebbleShape('Movement'), pebbleShape('Breath'));
});

test('every pebble encloses the same area; only the rotation is seeded', () => {
  const ids = ['Movement', 'Breath', 'Money check-in', 'Orientation#what-brought-you-here', 'a', 'b'];
  const areas = ids.map((id) => pebblePathArea(id));
  for (const area of areas) {
    assert.ok(Math.abs(area - areas[0]) < 1e-9, 'the drawn path area is identical for every id');
  }
  assert.ok(areas[0] > 2 && areas[0] < 3.2, 'a unit pebble is roughly a circle of area pi');
  // The silhouette is shared; the id only turns it.
  assert.deepEqual(
    pebbleShape('Movement').map((point) => point.radius),
    pebbleShape('Breath').map((point) => point.radius),
  );
  assert.notDeepEqual(
    pebbleShape('Movement').map((point) => point.angle),
    pebbleShape('Breath').map((point) => point.angle),
  );
});

test('pebblePath is a closed, smoothed path that differs by id', () => {
  const path = pebblePath('Movement');
  assert.match(path, /^M /);
  assert.match(path, / Q /);
  assert.ok(path.endsWith(' Z'));
  assert.equal(path, pebblePath('Movement'));
  assert.notEqual(path, pebblePath('Breath'));
});

test('the pebble radius is fixed by the vessel, not by how many were saved', () => {
  // The same vessel draws the same token for one activity and for a full pile.
  const radii = [0, 1, 20, 160].map((count) => pebbleRadius(count, VESSEL.width, VESSEL.height));
  assert.equal(new Set(radii).size, 1);
  assert.equal(radii[0], PEBBLE_RADIUS.base);

  // A narrower vessel gets a smaller token, still independent of count.
  assert.equal(pebbleRadius(1, MOBILE.width, MOBILE.height), pebbleRadius(160, MOBILE.width, MOBILE.height));
  assert.ok(pebbleRadius(160, MOBILE.width, MOBILE.height) < radii[0]);

  // Clamped on both ends, and always positive.
  assert.ok(pebbleRadius(160, 4000, 4000) <= PEBBLE_RADIUS.max);
  assert.ok(pebbleRadius(160, 60, 60) > 0);
  assert.ok(pebbleRadius(0, 0, 0) > 0);
});

test('a fuller collection holds more pebble, so the pile visibly grows', () => {
  const pileArea = (count) => settlePebbles(items(count), VESSEL).pebbles
    .reduce((sum, pebble) => sum + Math.PI * pebble.r * pebble.r, 0);
  const one = pileArea(1);
  const twenty = pileArea(20);
  const full = pileArea(MAX_PEBBLES);
  // The token never shrinks, so area is strictly proportional to the count.
  assert.ok(twenty > one * 19.9);
  assert.ok(full > twenty * 7.99);
  assert.ok(full < twenty * 8.01);
  const single = settlePebbles(items(1), VESSEL).pebbles[0];
  const many = settlePebbles(items(MAX_PEBBLES), VESSEL).pebbles;
  for (const pebble of many) assert.equal(pebble.r, single.r);
});

test('spawn slots form a centered mound, not a wall-to-wall line', () => {
  const slots = heapSlots(120, VESSEL.width, VESSEL.height, 8);
  assert.equal(slots.length, 120);
  const xs = slots.map((slot) => slot.x);
  const ys = slots.map((slot) => slot.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  assert.ok(spanY > 8 * 4, 'the mound is many rows tall');
  assert.ok(spanX < VESSEL.width - 8 * 2, 'the mound does not touch both walls');
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - VESSEL.width / 2) < 8, 'the mound is centered');
  // Slots are placed, never stacked on one another.
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const gap = Math.hypot(slots[j].x - slots[i].x, slots[j].y - slots[i].y);
      assert.ok(gap > 16 - 1e-6, `slots ${i}/${j} overlap by ${(16 - gap).toFixed(2)}`);
    }
  }
  assert.deepEqual(heapSlots(0, VESSEL.width, VESSEL.height, 8), []);
});

test('the pile is one equal-area pebble per unique record id', () => {
  const sim = createPebbleSimulation([
    { id: 'a', colorKey: 'physical' },
    { id: 'a', colorKey: 'physical' },
    { id: 'b', colorKey: 'neutral' },
  ], VESSEL);
  assert.equal(sim.total, 2);
  assert.equal(sim.rendered, 2);
  assert.equal(sim.hiddenCount, 0);
  for (const pebble of sim.pebbles) assert.equal(pebble.r, sim.radius);
  assert.equal(sim.pebbles.find((p) => p.id === 'b').colorKey, 'neutral');
});

test('records without an id get distinct slots instead of collapsing', () => {
  const sim = createPebbleSimulation([{ colorKey: 'physical' }, { colorKey: 'physical' }], VESSEL);
  assert.equal(sim.total, 2);
  assert.equal(new Set(sim.pebbles.map((p) => p.id)).size, 2);
});

test('the rendered pile is capped and reports the hidden remainder', () => {
  const sim = settlePebbles(items(200), { ...VESSEL, maxPebbles: 160 });
  assert.equal(sim.total, 200);
  assert.equal(sim.rendered, 160);
  assert.equal(sim.hiddenCount, 40);
  assert.equal(sim.pebbles.length, 160);
  // The cap defaults to the exported constant.
  const defaults = settlePebbles(items(MAX_PEBBLES + 5), VESSEL);
  assert.equal(defaults.rendered, MAX_PEBBLES);
  assert.equal(defaults.hiddenCount, 5);
});

test('an empty collection draws nothing and is already settled', () => {
  const sim = settlePebbles([], VESSEL);
  assert.deepEqual(sim.pebbles, []);
  assert.equal(sim.total, 0);
  assert.equal(sim.rendered, 0);
  assert.equal(sim.hiddenCount, 0);
  assert.equal(sim.done, true);
  assert.equal(sim.settled, true);
});

test('a settle is deterministic and bounded', () => {
  const input = items(40);
  const first = settlePebbles(input, VESSEL);
  const second = settlePebbles(input, VESSEL);
  assert.deepEqual(positions(first), positions(second));
  assert.ok(first.frames <= PEBBLE_SIM.maxSteps);
  assert.ok(first.done);
  assert.equal(first.bounded, first.frames >= PEBBLE_SIM.maxSteps);
});

test('every settled pebble stays inside the vessel', () => {
  for (const count of [1, 5, 40, 160]) {
    const sim = settlePebbles(items(count), VESSEL);
    for (const pebble of sim.pebbles) {
      assert.ok(pebble.x >= pebble.r - 1e-6, `${count}: x inside the left wall`);
      assert.ok(pebble.x <= VESSEL.width - pebble.r + 1e-6, `${count}: x inside the right wall`);
      assert.ok(pebble.y >= pebble.r - 1e-6, `${count}: y inside the ceiling`);
      assert.ok(pebble.y <= VESSEL.height - pebble.r + 1e-6, `${count}: y inside the floor`);
    }
  }
});

test('a full mobile pile settles in bounds without spreading over the floor', () => {
  const sim = settlePebbles(items(MAX_PEBBLES), MOBILE);
  assert.equal(sim.rendered, MAX_PEBBLES);
  assert.equal(sim.settled, true);
  assert.equal(sim.bounded, false);
  for (const pebble of sim.pebbles) {
    assert.ok(pebble.x >= pebble.r - 1e-6 && pebble.x <= MOBILE.width - pebble.r + 1e-6, 'inside the walls');
    assert.ok(pebble.y >= pebble.r - 1e-6 && pebble.y <= MOBILE.height - pebble.r + 1e-6, 'inside the floor');
  }
  for (let i = 0; i < sim.pebbles.length; i += 1) {
    for (let j = i + 1; j < sim.pebbles.length; j += 1) {
      const a = sim.pebbles[i];
      const b = sim.pebbles[j];
      const gap = Math.hypot(b.x - a.x, b.y - a.y) - (a.r + b.r);
      assert.ok(gap > -0.5, `pebbles ${a.id}/${b.id} overlap by ${(-gap).toFixed(2)}`);
    }
  }
});

test('the settled pile reads as a centered heap of several rows', () => {
  const sim = settlePebbles(items(120), VESSEL);
  const xs = sim.pebbles.map((pebble) => pebble.x);
  const ys = sim.pebbles.map((pebble) => pebble.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  assert.ok(spanY > sim.radius * 4, 'the pile is more than a couple of rows tall');
  assert.ok(spanX < VESSEL.width - sim.radius * 2, 'the heap does not spread wall to wall');
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - VESSEL.width / 2) < sim.radius * 2, 'centered');
});

test('settled pebbles do not sit on top of one another', () => {
  const sim = settlePebbles(items(40), VESSEL);
  for (let i = 0; i < sim.pebbles.length; i += 1) {
    for (let j = i + 1; j < sim.pebbles.length; j += 1) {
      const a = sim.pebbles[i];
      const b = sim.pebbles[j];
      const gap = Math.hypot(b.x - a.x, b.y - a.y) - (a.r + b.r);
      assert.ok(gap > -1.5, `pebbles ${a.id}/${b.id} overlap by ${(-gap).toFixed(2)}`);
    }
  }
});

test('stepping in chunks matches stepping one at a time', () => {
  const input = items(30);
  const single = createPebbleSimulation(input, VESSEL);
  const chunked = createPebbleSimulation(input, VESSEL);
  while (!single.done) stepPebbleSimulation(single, { steps: 1 });
  while (!chunked.done) stepPebbleSimulation(chunked, { steps: 13 });
  assert.equal(chunked.frames, single.frames);
  assert.deepEqual(positions(chunked), positions(single));
});

test('the instant (reduced-motion) result equals an animated settle', () => {
  const input = items(25);
  const animated = createPebbleSimulation(input, VESSEL);
  finishPebbleSimulation(animated);
  const instant = settlePebbles(input, VESSEL);
  assert.deepEqual(positions(instant), positions(animated));
  assert.equal(instant.settled, true);
});

test('an existing pile keeps its pebbles when a new one is added', () => {
  const before = settlePebbles(items(10), VESSEL);
  const initialPositions = before.pebbles.map((p) => ({ id: p.id, x: p.x, y: p.y, vx: 0, vy: 0 }));
  const grown = createPebbleSimulation(
    [...items(10), { id: 'id-10', colorKey: 'neutral' }],
    { ...VESSEL, initialPositions },
  );
  for (const pebble of grown.pebbles) {
    if (pebble.id === 'id-10') continue;
    const previous = initialPositions.find((p) => p.id === pebble.id);
    assert.equal(pebble.x, previous.x);
    assert.equal(pebble.y, previous.y);
  }
});

test('the layout cache can be cleared without touching the DOM', () => {
  assert.equal(typeof clearCollectionLayoutCache, 'function');
  assert.doesNotThrow(() => clearCollectionLayoutCache());
  const stats = collectionLayoutCacheStats();
  assert.equal(stats.scopes, 0);
  assert.equal(stats.pebbles, 0);
});

test('the layout fingerprint canonicalises the set and tracks metadata', () => {
  const base = [
    { id: 'a', colorKey: 'physical', subjectId: 'physical' },
    { id: 'b', colorKey: 'neutral', subjectId: 'general' },
  ];
  // A pin or a reorder does not replay the pile.
  assert.equal(collectionFingerprint(base), collectionFingerprint([...base].reverse()));
  // A catalog change does not leave a stale fill behind.
  assert.notEqual(
    collectionFingerprint(base),
    collectionFingerprint([{ ...base[0], colorKey: 'mental' }, base[1]]),
  );
  assert.notEqual(
    collectionFingerprint(base),
    collectionFingerprint([{ ...base[0], subjectId: 'mental' }, base[1]]),
  );
  assert.notEqual(collectionFingerprint(base), collectionFingerprint([base[0]]));
  // Only the rendered cap is keyed, so the hidden remainder cannot churn it.
  const many = items(MAX_PEBBLES + 5);
  const visible = many.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_PEBBLES);
  assert.equal(collectionFingerprint(many), collectionFingerprint(visible));
});

test('a capped fingerprint uses the same stable subset after a reorder', () => {
  const records = items(180);
  assert.equal(collectionFingerprint(records), collectionFingerprint(records.slice().reverse()));
});

test('the shared layout cache is bounded by scopes and pebbles', () => {
  const cache = createLayoutCache({ maxScopes: 3, maxPebbles: 400 });
  for (let scope = 0; scope < 12; scope += 1) {
    cache.set(`scope-${scope}`, { pebbles: Array.from({ length: MAX_PEBBLES }, () => ({})) });
  }
  const stats = cache.stats();
  assert.ok(stats.scopes >= 1 && stats.scopes <= 3, `scopes bounded, got ${stats.scopes}`);
  assert.ok(stats.pebbles <= 400, `pebbles bounded, got ${stats.pebbles}`);
  // Recency is refreshed, so a scope that is still looked at survives.
  assert.ok(cache.get('scope-11'));
  cache.set('new', { pebbles: [] });
  assert.ok(cache.get('scope-11'));
  assert.ok(cache.stats().scopes <= 3);
});
