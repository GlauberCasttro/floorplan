// The board's layout: outside services line up in the last column, but a service that sends something
// back (a queue that delivers messages, a webhook, a storage bucket that announces new files) can't be
// pinned there, or the layout engine refuses the whole board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { SKILL } from './helpers.mjs';

const html = fs.readFileSync(path.join(SKILL, 'assets', 'viewer.html'), 'utf8');
const ELK = createRequire(import.meta.url)(path.join(SKILL, 'assets', 'vendor', 'elk.bundled.js'));

/** The viewer's lastColumn(view, isExternal), run on its own. */
function lastColumn(view, isExternal) {
  const src = html.match(/\nfunction lastColumn\([\s\S]*?\n\}\n/);
  assert.ok(src, 'viewer.html defines lastColumn()');
  const ctx = {};
  vm.runInNewContext(`${src[0]}\nthis.fn = lastColumn;`, ctx);
  return ctx.fn(view, isExternal);
}

const EXTERNAL = new Set(['n:queue', 'n:db', 'n:bucket', 'n:ai']);
const isExternal = (id) => EXTERNAL.has(id);

// A shape seen in the wild: two services talking through a queue, files landing in a bucket that tells the
// queue, and a database and an AI service that only ever receive.
const view = {
  visible: ['n:api', 'n:worker', 'n:queue', 'n:db', 'n:bucket', 'n:ai'],
  connectors: [],
  edges: [
    ['n:api', 'n:db'], ['n:api', 'n:bucket'], ['n:bucket', 'n:queue'],
    ['n:api', 'n:queue'], ['n:queue', 'n:api'], ['n:queue', 'n:worker'], ['n:worker', 'n:queue'],
    ['n:worker', 'n:bucket'], ['n:worker', 'n:ai'],
  ].map(([a, b], i) => ({ id: 'e' + i, a, b })),
};

test('outside services that only receive are pinned to the last column', () => {
  const last = lastColumn(view, isExternal);
  assert.ok(last.has('n:db'));
  assert.ok(last.has('n:ai'));
  assert.ok(!last.has('n:api'), 'only outside services are pinned');
});

test('an outside service with an arrow leaving it is left free', () => {
  const last = lastColumn(view, isExternal);
  assert.ok(!last.has('n:queue'), 'the queue delivers to the services');
  assert.ok(!last.has('n:bucket'), 'the bucket tells the queue about new files');
});

test('an arrow to an outgoing connector does not unpin a service', () => {
  const v = { visible: ['n:db'], connectors: [{ id: 'c:out', side: 'out' }], edges: [{ id: 'e0', a: 'n:db', b: 'c:out' }] };
  assert.ok(lastColumn(v, isExternal).has('n:db'));
});

/** Lays the board out the way viewer.html does, with `pinned` in the last column. */
function layout(pinned) {
  return new ELK().layout({
    id: 'g',
    children: view.visible.map((id) => ({ id, width: 220, height: 80, ...(pinned.has(id) ? { layoutOptions: { 'elk.layered.layering.layerConstraint': 'LAST' } } : {}) })),
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.a], targets: [e.b] })),
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.thoroughness': '12', 'elk.separateConnectedComponents': 'true',
    },
  });
}

test('the layout engine refuses a pinned service with an arrow leaving it (why lastColumn exists)', async () => {
  await assert.rejects(layout(new Set(EXTERNAL)), /layer constraint set to LAST/);
});

test('the board lays out when outside services send things back', async () => {
  const res = await layout(lastColumn(view, isExternal));
  assert.equal(res.children.length, view.visible.length);
});

test('the layout uses lastColumn for its outside services', () => {
  assert.match(html, /const last = lastColumn\(view, /);
  assert.match(html, /\.\.\.\(last\.has\(item\) \? \{ layoutOptions: \{ 'elk\.layered\.layering\.layerConstraint': 'LAST' \} \} : \{\}\)/);
});
