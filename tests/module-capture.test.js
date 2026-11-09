const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function config() {
  const c = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/config-io.js'), 'utf8'), c);
  return c;
}
const region = { mode: 'module', modules: [{ selector: '.card', title: '性别分布', tag: 'SECTION', classes: ['card'], headingDepth: 1 }], width: 400, height: 300 };
test('module screenshot survives export/import without coordinate fallback', () => {
  const c = config();
  const payload = c.buildConfigPayload({ rules: [{ url: 'example.com', fields: [{ name: '画像', type: 'screenshot', region }] }] });
  assert.equal(payload.schemaVersion, 5);
  const result = c.validateConfigPayload(JSON.parse(JSON.stringify(payload)));
  assert.equal(result.ok, true);
  assert.equal(result.payload.rules[0].fields[0].region.modules[0].title, '性别分布');
  assert.equal(result.payload.rules[0].fields[0].region.docX, undefined);
});
test('malformed module descriptors cannot become coordinate screenshots', () => {
  const c = config();
  for (const modules of [[], [null], [{ selector: '.card', title: '' }], Array(13).fill(region.modules[0])]) {
    assert.equal(c.normalizeRegion({ ...region, docX: 0, docY: 0, modules }), null);
  }
});
function fixture({ duplicate = false, hidden = false, mountedAt = 0, wrapped = false, busyUntil = 0, scoped = false } = {}) {
  let clock = 0;
  const rect = { left: 80, top: 120, width: 500, height: 320 };
  const card = { tagName: 'SECTION', classList: ['card'], parentElement: null,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    getClientRects: () => [{}], scrollIntoView() {}, getAttribute: name => name === 'aria-busy' && clock < busyUntil ? 'true' : null,
    querySelectorAll: s => s.includes('heading') ? [heading] : [] };
  const heading = { textContent: '性别分布', parentElement: card, getClientRects: () => [{}] };
  if (wrapped) heading.parentElement = { tagName: 'DIV', classList: [], parentElement: card };
  const other = { ...card, querySelectorAll: s => s.includes('heading') ? [otherHeading] : [] };
  const otherHeading = { ...heading, parentElement: other };
  const doc = { querySelectorAll: s => s === '.card' ? [] : s.includes('heading') ? [heading, ...(duplicate ? [otherHeading] : [])] : [],
    documentElement: {}, body: {}, scrollingElement: {} };
  if (scoped) {
    const outside = { ...card, classList: ['card', 'variant'], getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 900, width: 1200, height: 900 }) };
    const scope = { ...outside, tagName: 'DIV', parentElement: outside, querySelectorAll: s => s.includes('heading') ? [heading] : [] };
    card.parentElement = scope;
    const originalQuery = doc.querySelectorAll;
    doc.querySelectorAll = s => s === '.scope' ? [scope] : originalQuery(s);
  }
  const queryAll = doc.querySelectorAll;
  doc.querySelectorAll = s => clock < mountedAt ? [] : queryAll(s);
  const c = vm.createContext({ window: { innerWidth: 1400, innerHeight: 1000, devicePixelRatio: 1 }, document: doc,
    getComputedStyle: el => ({ visibility: hidden && el === card ? 'hidden' : 'visible', display: 'block', overflow: 'visible' }),
    setTimeout: (fn, ms) => { clock += ms; queueMicrotask(fn); }, Date: { now: () => clock }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/module-capture.js'), 'utf8'), c);
  return { api: c.window.FeishuModuleCapture, rect };
}
test('module title relocates a changed selector and measures current size and position', async () => {
  const { api, rect } = fixture();
  rect.left = 170; rect.top = 240; rect.width = 620; rect.height = 410;
  const result = await api.prepare(region);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rect)), { x: 170, y: 240, width: 620, height: 410, dpr: 1 });
});
test('duplicate visible module titles cannot silently select the first card', async () => {
  await assert.rejects(fixture({ duplicate: true }).api.prepare(region), /多个|不唯一/);
});
test('hidden modules and modules larger than the viewport are not captured', async () => {
  await assert.rejects(fixture({ hidden: true }).api.prepare(region), /找不到/);
  const { api, rect } = fixture(); rect.width = 2000;
  await assert.rejects(api.prepare(region), /可视|视口/);
});
test('module screenshot waits for a panel mounted asynchronously after switching tabs', async () => {
  const result = await fixture({ mountedAt: 720 }).api.prepare(region);
  assert.equal(result.success, true);
});
test('module title survives an inserted heading wrapper and a removed variant class', async () => {
  const altered = { ...region, modules: [{ ...region.modules[0], classes: ['card', 'variant'] }] };
  assert.equal((await fixture({ wrapped: true }).api.prepare(altered)).success, true);
});
test('a module marked busy cannot be captured as a stable placeholder', async () => {
  await assert.rejects(fixture({ busyUntil: 9000 }).api.prepare(region), /加载/);
});
test('title fallback never climbs beyond the recorded panel scope', async () => {
  const scopedRegion = { ...region, modules: [{ ...region.modules[0], scopeSelector: '.scope', classes: ['card', 'variant'] }] };
  const result = await fixture({ scoped: true }).api.prepare(scopedRegion);
  assert.equal(result.rect.width, 500);
});
