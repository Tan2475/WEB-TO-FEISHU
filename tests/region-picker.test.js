const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function picker({ tabs = false, hiddenMetric = false, visibleAt = 0, omitInactiveSelected = false, tabRole = 'tab' } = {}) {
  const handlers = new Map();
  const overlays = [];
  const messages = [];
  function element({ parent = null, height = 200, content = 1000, width = 400, contentWidth = width,
    overflow = 'auto', overscroll = 'auto' } = {}) {
    return {
      parentElement: parent, style: {}, scrollTop: 0, scrollLeft: 0,
      clientHeight: height, scrollHeight: content, clientWidth: width, scrollWidth: contentWidth,
      css: { overflowY: overflow, overflowX: overflow, overscrollBehaviorY: overscroll,
        overscrollBehaviorX: overscroll, lineHeight: '20px' },
      scrollBy({ left = 0, top = 0 }) {
        this.scrollTop = Math.min(Math.max(this.scrollTop + top, 0), this.scrollHeight - this.clientHeight);
        this.scrollLeft = Math.min(Math.max(this.scrollLeft + left, 0), this.scrollWidth - this.clientWidth);
      },
      events: {},
      addEventListener(name, fn) { this.events[name] = fn; },
      removeEventListener(name) { delete this.events[name]; },
      remove() { this.removed = true; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 })
    };
  }
  const root = element({ height: 800, content: 3000, width: 1200 });
  let hit = root;
  let listener;
  let regionAnchor;
  let selected = 'overview';
  let clicks = 0;
  let clock = 0;
  const tabNodes = Object.fromEntries(['overview', 'connected'].map(id => [id, {
    id, nodeType: 1, getClientRects: () => [{}],
    getAttribute: name => name === 'role' ? tabRole : name === 'aria-selected'
      ? (omitInactiveSelected && selected !== id ? null : String(selected === id)) : null,
    click() { selected = id; clicks++; }
  }]));
  const doc = {
    scrollingElement: root,
    body: { appendChild(el) { overlays.push(el); }, getBoundingClientRect: root.getBoundingClientRect },
    createElement: () => element(),
    querySelectorAll: selector => selector === '.metric' && hiddenMetric ? [{ innerText: '隐藏旧页', getClientRects: () => [] }, ...(clock >= visibleAt ? [{ innerText: '用户数据', getClientRects: () => [{}] }] : [])] : !tabs ? [] : selector.startsWith('[role=') ? [tabNodes[selected]] :
      selector.startsWith('#') && tabNodes[selector.slice(1)] ? [tabNodes[selector.slice(1)]] : [],
    querySelector: selector => selector === '.metric' ? (hiddenMetric ? { innerText: '隐藏旧页', getClientRects: () => [] } : { innerText: selected === 'connected' ? '用户数据' : '概览数据' }) :
      selector === '#area' ? regionAnchor : tabs && selector.startsWith('#') ? tabNodes[selector.slice(1)] || null : null,
    elementsFromPoint: () => [...overlays.filter(el => !el.removed), hit],
    addEventListener(name, fn) { handlers.set(name, fn); },
    removeEventListener(name, fn) { if (handlers.get(name) === fn) handlers.delete(name); }
  };
  const win = { innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
    scrollTo() {} };
  const context = vm.createContext({
    window: win, document: doc, console: { log() {}, error() {} },
    getComputedStyle: el => el.css || { visibility: 'visible' },
    Node: { ELEMENT_NODE: 1 }, CSS: { escape: value => value },
    setTimeout: (fn, ms) => { clock += ms; queueMicrotask(fn); }, Date: { now: () => clock },
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } }, sendMessage: message => messages.push(message) } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content/content.js'), 'utf8'), context);
  listener({ action: 'START_REGION_PICK' }, {}, () => {});
  function event(extra = {}) {
    return { deltaX: 0, deltaY: 100, deltaMode: 0, clientX: 100, clientY: 100, button: 0,
      preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
  }
  return {
    root, win, overlays, handlers, messages, element, hit: el => { hit = el; },
    wheel: extra => { const e = event(extra); handlers.get('wheel')?.(e); return e; },
    down: extra => overlays[0].events.mousedown(event(extra)),
    up: extra => handlers.get('mouseup')(event(extra)),
    esc: () => handlers.get('keydown')(event({ key: 'Escape' })),
    chooseTab: id => { selected = id; }, tabState: () => ({ selected, clicks }),
    setAnchor: anchor => { regionAnchor = anchor; },
    prepare: region => new Promise(resolve => listener({ action: 'PREPARE_REGION', region }, {}, resolve)),
    extract: rule => new Promise(resolve => listener({ action: 'EXTRACT_DATA', rule }, {}, resolve))
  };
}

test('text extraction switches the rule target tab before reading values', async () => {
  const p = picker({ tabs: true });
  const result = await p.extract({ tabSelector: '#connected', fields: [{ name: '数据', selector: '.metric', type: 'text' }] });
  assert.equal(result.data.数据, '用户数据');
});

test('inactive Xingtu tabs without aria-selected can be activated before extraction', async () => {
  const p = picker({ tabs: true, omitInactiveSelected: true });
  const result = await p.extract({ tabSelector: '#connected', fields: [{ name: '数据', selector: '.metric', type: 'text' }] });
  assert.equal(result.error, undefined);
  assert.equal(result.data.数据, '用户数据');
  assert.equal(p.tabState().clicks, 1);
});

test('an ordinary element without tab state is rejected before it is clicked', async () => {
  const p = picker({ tabs: true, omitInactiveSelected: true, tabRole: null });
  const result = await p.extract({ tabSelector: '#connected', fields: [] });
  assert.match(result.error, /页签/);
  assert.equal(p.tabState().clicks, 0);
});

test('failed target-tab selection stops text extraction', async () => {
  const p = picker({ tabs: true });
  const result = await p.extract({ tabSelector: '#gone', fields: [{ name: '数据', selector: '.metric', type: 'text' }] });
  assert.match(result.error, /标签|页签/);
  assert.equal(result.data, undefined);
});

test('targeted extraction ignores retained hidden panels with the same field selector', async () => {
  const p = picker({ tabs: true, hiddenMetric: true });
  const result = await p.extract({ tabSelector: '#connected', fields: [{ name: '数据', selector: '.metric', type: 'text' }] });
  assert.equal(result.data.数据, '用户数据');
});

test('hidden old fields cannot end waiting before the new tab finishes mounting', async () => {
  const p = picker({ tabs: true, hiddenMetric: true, visibleAt: 700 });
  const result = await p.extract({ tabSelector: '#connected', fields: [{ name: '数据', selector: '.metric', type: 'text' }] });
  assert.equal(result.data.数据, '用户数据');
  assert.equal(result.missing.length, 0);
});

test('browse mode hides selection overlay and allows native page interaction', () => {
  const p = picker();
  const button = p.overlays.find(el => el.textContent === '操作网页');
  assert.ok(button);
  button.events.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(p.overlays[0].style.display, 'none');
  assert.equal(button.textContent, '开始框选');
  assert.equal(p.wheel().prevented, undefined);
  button.events.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(p.overlays[0].style.display, 'block');
  p.down();
  assert.equal(p.wheel().prevented, true);
});

test('selection records the active page tab for later screenshots', () => {
  const p = picker({ tabs: true });
  p.chooseTab('connected');
  p.hit(null);
  p.down({ clientX: 20, clientY: 30 });
  p.up({ clientX: 120, clientY: 130 });
  const region = p.messages.find(message => message.action === 'PICKED_REGION').region;
  assert.deepEqual(Array.from(region.tabSelectors), ['#connected']);
});

test('screenshot preparation restores the recorded tab before locating the area', async () => {
  const p = picker({ tabs: true });
  const result = await p.prepare({ docX: 20, docY: 30, width: 100, height: 100, tabSelectors: ['#connected'] });
  assert.equal(result.success, true);
  assert.equal(p.tabState().selected, 'connected');
  assert.equal(p.tabState().clicks, 1);
});

test('missing recorded tab stops capture instead of using the wrong page coordinates', async () => {
  const p = picker({ tabs: true });
  const result = await p.prepare({ docX: 20, docY: 30, width: 100, height: 100, tabSelectors: ['#gone'] });
  assert.match(result.error, /标签/);
});

test('active recorded tab is never clicked twice', async () => {
  const p = picker({ tabs: true });
  p.chooseTab('connected');
  await p.prepare({ docX: 20, docY: 30, width: 100, height: 100, tabSelectors: ['#connected'] });
  assert.equal(p.tabState().clicks, 0);
});

test('saved selection inside a long scroll container is revealed instead of centering the entire anchor', async () => {
  const p = picker({ tabs: true });
  const inner = p.element({ parent: p.root, height: 200, content: 1200 });
  inner.scrollTop = 500;
  p.setAnchor({
    parentElement: inner,
    getBoundingClientRect: () => ({ left: 0, top: -inner.scrollTop, width: 400, height: 1200 }),
    scrollIntoView() {}
  });
  const result = await p.prepare({ anchorSelector: '#area', offsetX: 0, offsetY: 18,
    width: 100, height: 100, tabSelectors: ['#connected'] });
  assert.equal(result.success, true);
  assert.equal(inner.scrollTop, 18);
  assert.equal(result.rect.y, 0);
});

test('region config round-trip preserves tabs and rejects invalid tab metadata', () => {
  const c = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared/config-io.js'), 'utf8'), c);
  const region = { docX: 20, docY: 30, width: 100, height: 100, tabSelectors: ['#connected'] };
  assert.deepEqual(Array.from(c.normalizeRegion(region).tabSelectors), ['#connected']);
  assert.equal(c.normalizeRegion({ ...region, tabSelectors: [null] }), null);
  const rules = [{ url: 'example.com', fields: [{ name: '截图', type: 'screenshot', region }] }];
  const exported = c.buildConfigPayload({ rules });
  assert.equal(exported.schemaVersion, 3);
  assert.equal(c.validateConfigPayload(exported).payload.rules[0].fields[0].region.tabSelectors[0], '#connected');
});

test('region mode allows page scrolling before dragging', () => {
  const p = picker();
  p.wheel();
  assert.equal(p.root.scrollTop, 100);
});

test('wheel scrolls the nested page container under the overlay', () => {
  const p = picker();
  const inner = p.element({ parent: p.root });
  p.hit(inner);
  p.wheel();
  assert.equal(inner.scrollTop, 100);
  assert.equal(p.root.scrollTop, 0);
});

test('nested boundary passes remaining movement to the page', () => {
  const p = picker();
  const inner = p.element({ parent: p.root });
  inner.scrollTop = 780;
  p.hit(inner);
  p.wheel();
  assert.equal(inner.scrollTop, 800);
  assert.equal(p.root.scrollTop, 80);
});

test('overscroll containment does not move the page outside the nested panel', () => {
  const p = picker();
  const inner = p.element({ parent: p.root, overscroll: 'contain' });
  inner.scrollTop = 800;
  p.hit(inner);
  p.wheel();
  assert.equal(p.root.scrollTop, 0);
});

test('a short panel with overscroll containment also keeps the page stationary', () => {
  const p = picker();
  const inner = p.element({ parent: p.root, height: 200, content: 200, overscroll: 'contain' });
  p.hit(inner);
  p.wheel();
  assert.equal(p.root.scrollTop, 0);
});

test('horizontal trackpad and shift-wheel scroll horizontally', () => {
  const p = picker();
  const inner = p.element({ parent: p.root, contentWidth: 1200 });
  p.hit(inner);
  p.wheel({ deltaX: 30, deltaY: 0 });
  p.wheel({ shiftKey: true, deltaY: 40 });
  assert.equal(inner.scrollLeft, 70);
  assert.equal(inner.scrollTop, 0);
});

test('line and page wheel units are normalized', () => {
  const p = picker();
  p.wheel({ deltaY: 2, deltaMode: 1 });
  assert.equal(p.root.scrollTop, 40);
  p.wheel({ deltaY: 1, deltaMode: 2 });
  assert.equal(p.root.scrollTop, 840);
});

test('ctrl-wheel keeps browser zoom available before dragging', () => {
  const p = picker();
  const e = p.wheel({ ctrlKey: true });
  assert.equal(e.prevented, undefined);
  assert.equal(p.root.scrollTop, 0);
});

test('only an active drag freezes scrolling', () => {
  const p = picker();
  p.wheel();
  p.down();
  assert.equal(p.wheel().prevented, true);
  assert.equal(p.root.scrollTop, 100);
});

test('Escape removes the overlay and scroll listener', () => {
  const p = picker();
  p.esc();
  assert.equal(p.handlers.has('wheel'), false);
  assert.ok(p.overlays.every(el => el.removed));
  assert.equal(p.win.__FEISHU_REGION_ACTIVE, false);
});

test('finishing selection cleans up and records coordinates after page positioning', () => {
  const p = picker();
  p.hit(null);
  p.win.scrollY = 300;
  p.down({ clientX: 20, clientY: 30 });
  p.up({ clientX: 120, clientY: 130 });
  assert.equal(p.handlers.has('wheel'), false);
  const region = p.messages.find(message => message.action === 'PICKED_REGION').region;
  assert.equal(region.docY, 330);
  assert.equal(region.width, 100);
  assert.equal(region.height, 100);
});
