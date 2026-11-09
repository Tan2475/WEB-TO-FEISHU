const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(file, globals = {}) {
  const context = vm.createContext({ self: {}, console, ...globals });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return context;
}

function sheetClient(headers) {
  const writes = [];
  const context = load('shared/feishu.js', {
    URL, atob, btoa, Uint8Array, Blob, FormData,
    fetch: async (url, options = {}) => {
      let data;
      if (url.includes('/auth/')) data = { code: 0, tenant_access_token: 'test' };
      else if (url.includes('/values/')) data = { code: 0, data: { valueRange: { values: [headers] } } };
      else {
        writes.push({ url, body: JSON.parse(options.body) });
        data = { code: 0, data: { updates: { updatedRange: 's1!A2:C2' } } };
      }
      return { json: async () => data };
    }
  });
  return { writes, append: (record, shots = {}) => context.appendToFeishu(
    'test', 'test', 'https://example.feishu.cn/sheets/test?sheet=s1', record, shots
  ) };
}

test('unmatched text columns prevent all writes, including partially matched rows', async () => {
  for (const record of [{ 价格: '99' }, { 标题: '文章', 价格: '99' }]) {
    const client = sheetClient(['标题']);
    await assert.rejects(client.append(record), /价格/);
    assert.equal(client.writes.length, 0);
  }
});

test('unmatched screenshot columns fail before appending text', async () => {
  const client = sheetClient(['标题']);
  await assert.rejects(client.append({ 标题: '文章' }, { 截图: 'data:image/png;base64,AA==' }), /截图/);
  assert.equal(client.writes.length, 0);
});

test('empty extraction never appends a blank row', async () => {
  const client = sheetClient(['标题']);
  await assert.rejects(client.append({}), /没有可写入/);
  assert.equal(client.writes.length, 0);
});

test('screenshot-only extraction still appends and writes the image to its row', async () => {
  const client = sheetClient(['截图']);
  const result = await client.append({}, { 截图: 'data:image/png;base64,AA==' });
  assert.equal(client.writes.length, 2);
  assert.equal(client.writes[1].body.range, 's1!A2:A2');
  assert.equal(result.warnings.length, 0);
});

test('matched columns preserve order and values, including zero and false', async () => {
  const client = sheetClient(['标题', '数量', '启用']);
  const result = await client.append({ 启用: false, 数量: 0, 标题: '文章' });
  assert.deepEqual(client.writes[0].body.valueRange.values, [['文章', 0, false]]);
  assert.equal(result.warnings.length, 0);
});

for (const operation of ['get', 'set']) {
  test(`storage ${operation} rejects Chrome errors`, async () => {
    const context = load('shared/storage.js', { chrome: {
      runtime: { lastError: { message: 'storage failed' } },
      storage: { local: { [operation]: (_data, callback) => callback({}) } }
    } });
    await assert.rejects(context[operation === 'get' ? 'getStorageData' : 'setStorageData']({}), /storage failed/);
  });
}

test('storage succeeds when Chrome reports no error', async () => {
  const context = load('shared/storage.js', { chrome: {
    runtime: {}, storage: { local: {
      get: (_keys, callback) => callback({ saved: true }),
      set: (_data, callback) => callback()
    } }
  } });
  assert.equal((await context.getStorageData([])).saved, true);
  await context.setStorageData({});
});

test('import rejects fake coordinates and preserves real zero coordinates', () => {
  const context = load('shared/config-io.js');
  for (const bad of [null, '', ' ', false, true, '10', undefined, NaN, Infinity, -1]) {
    assert.equal(context.isValidRegion({ width: 50, height: 50, docX: bad, docY: bad }), false, String(bad));
    const result = context.validateConfigPayload({ rules: [{ url: 'example.com', fields: [
      { name: '截图', type: 'screenshot', region: { width: 50, height: 50, docX: bad, docY: bad } }
    ] }] });
    assert.equal(result.stats.droppedFields, 1);
  }
  assert.equal(context.isValidRegion({ width: 50, height: 50, docX: 0, docY: 0 }), true);
});

test('anchor-only regions do not acquire invalid fallback coordinates', () => {
  const context = load('shared/config-io.js');
  const region = context.normalizeRegion({ anchorSelector: '#card', width: 50, height: 50, docX: null, docY: null });
  assert.equal(region.anchorSelector, '#card');
  assert.equal(Object.hasOwn(region, 'docX'), false);
  assert.equal(Object.hasOwn(region, 'docY'), false);
});

test('imported dimensions must remain positive finite numbers after rounding', () => {
  const context = load('shared/config-io.js');
  for (const width of [null, '', true, '50', Infinity, NaN, -1, 0, 0.1]) {
    assert.equal(context.isValidRegion({ width, height: 50, docX: 0, docY: 0 }), false);
  }
  assert.equal(context.normalizeRegion({ width: 50, height: 50, docX: 0, docY: 0 }).docX, 0);
});

function contentClient({ shadow = false, lateRoot = false, revealAt = 1000 } = {}) {
  let listener, clock = 0, clicks = 0, hovers = 0, opened = false, added = false;
  const pre = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
    dispatchEvent(event) { if (event.type === 'mouseover') hovers++; },
    click() { clicks++; opened = !opened; if (!lateRoot) added = true; }
  };
  const root1 = { querySelector: s => s === '#pre' ? pre : null, querySelectorAll: () => [] };
  const root2 = { querySelector: s => opened && s === '#field' ? { innerText: '已加载' } : null, querySelectorAll: () => [] };
  const context = load('content/content.js', {
    window: { location: { href: 'https://example.com' } },
    document: {
      querySelector: s => !shadow && s === '#pre' ? pre : null,
      querySelectorAll: () => shadow ? [{ shadowRoot: root1 }, ...(added ? [{ shadowRoot: root2 }] : [])] : []
    },
    console: { log() {}, error() {} },
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } },
    Date: { now: () => clock },
    setTimeout: (callback, ms) => { clock += ms; if (lateRoot && clock >= revealAt) added = true; queueMicrotask(callback); },
    MouseEvent: class { constructor(type) { this.type = type; } }
  });
  return {
    extract: (preType = 'click') => new Promise(resolve => listener({ action: 'EXTRACT_DATA', rule: {
      preSelector: '#pre', preType, fields: [{ name: '字段', selector: '#field', type: 'text' }]
    } }, {}, resolve)),
    state: () => ({ clicks, hovers, opened }), context
  };
}

test('single click still waits for slowly loaded content without closing it', async () => {
  const client = contentClient({ shadow: true, lateRoot: true, revealAt: 3100 });
  const result = await client.extract();
  assert.equal(result.data['字段'], '已加载');
  assert.equal(client.state().clicks, 1);
});

test('missing fields never cause a second click that closes a toggle', async () => {
  const client = contentClient();
  await client.extract();
  assert.equal(client.state().clicks, 1);
  assert.equal(client.state().opened, true);
});

test('hover can still retry when fields are missing', async () => {
  const client = contentClient();
  await client.extract('hover');
  assert.equal(client.state().hovers, 2);
  assert.equal(client.state().clicks, 0);
});

for (const lateRoot of [false, true]) {
  test(`new open shadow roots are found after pre-action (delayed=${lateRoot})`, async () => {
    const client = contentClient({ shadow: true, lateRoot });
    const result = await client.extract();
    assert.equal(result.data['字段'], '已加载');
    assert.equal(result.missing.length, 0);
    assert.equal(client.state().clicks, 1);
  });
}

// 仅替代浏览器 DOM/Chrome 边界；实际页面初始化与事件处理器均运行生产代码。
function pageClient(file, { readFails = false, writeFails = true, runtimeResponse, runtimeError,
  runtimeThrow = false, rules, extractionResults = {} } = {}) {
  class Element {
    constructor() {
      this.value = '';
      this.hidden = true;
      this.dataset = {};
      this.events = {};
      this.nodes = new Map();
      this.children = [];
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
      this.content = { cloneNode: () => new Element() };
    }
    querySelector(key) {
      if (!this.nodes.has(key)) this.nodes.set(key, new Element());
      return this.nodes.get(key);
    }
    querySelectorAll() { return []; }
    addEventListener(name, callback) { this.events[name] = callback; }
    appendChild(child) { this.children.push(child); }
  }
  const document = new Element();
  document.getElementById = key => document.querySelector(key);
  document.createElement = () => new Element();
  const keys = { FEISHU_APP_ID: 'FEISHU_APP_ID', FEISHU_APP_SECRET: 'FEISHU_APP_SECRET',
    FEISHU_DB_URL: 'FEISHU_DB_URL', SCRAPING_RULES: 'SCRAPING_RULES', TEMP_REGION_OVERRIDES: 'TEMP_REGION_OVERRIDES' };
  let messages = 0;
  let saved;
  const messageListeners = [];
  const runtimeRequests = [];
  const tabRequests = [];
  const context = load('shared/config-io.js', {
    document, URL, StorageKeys: keys, setTimeout() {}, clearTimeout() {},
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { messageListeners.push(listener); } }, openOptionsPage() {},
        sendMessage(message, callback) {
          runtimeRequests.push(message);
          if (runtimeThrow) throw new Error('Extension context invalidated.');
          context.chrome.runtime.lastError = runtimeError ? { message: runtimeError } : undefined;
          callback(runtimeResponse);
          context.chrome.runtime.lastError = undefined;
        }
      },
      tabs: { query: async () => [{ id: 1, url: 'https://example.com' }],
        sendMessage(_id, message, callback) {
          messages++;
          tabRequests.push(message);
          callback?.(extractionResults[message.rule?.name] || { data: {} });
        }
      }
    },
    getStorageData: async () => {
      if (readFails) throw new Error('read failed');
      return { FEISHU_APP_ID: 'old-id', FEISHU_APP_SECRET: 'old-secret',
        SCRAPING_RULES: rules || [{ name: '测试', url: 'example.com', fields: [] }] };
    },
    setStorageData: async updates => {
      if (writeFails) throw new Error('storage failed');
      saved = updates;
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared/batch.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return { init: () => document.events.DOMContentLoaded(),
    el: key => document.getElementById(key), messages: () => messages, saved: () => saved,
    messageListeners, runtimeRequests, tabRequests };
}

test('save failure is shown without claiming success or clearing edits', async () => {
  const page = pageClient('options/options.js');
  await page.init();
  page.el('feishuAppId').value = 'edited-id';
  await assert.doesNotReject(page.el('saveGlobalBtn').events.click());
  assert.match(page.el('toastMessage').textContent, /保存失败/);
  assert.equal(page.el('feishuAppId').value, 'edited-id');
});

test('successful save still persists edits and confirms success', async () => {
  const page = pageClient('options/options.js', { writeFails: false });
  await page.init();
  page.el('feishuAppId').value = 'edited-id';
  await page.el('saveGlobalBtn').events.click();
  assert.equal(page.saved().FEISHU_APP_ID, 'edited-id');
  assert.match(page.el('toastMessage').textContent, /成功保存/);
});

test('successful replace import persists credentials before updating the form', async () => {
  const page = pageClient('options/options.js', { writeFails: false });
  await page.init();
  page.el('importFileInput').files = [{ name: 'test.json', text: async () => JSON.stringify({
    credentials: { appId: 'new-id', appSecret: 'new-secret' },
    rules: [{ url: 'example.com', fields: [{ name: 'URL', type: 'current_url' }] }]
  }) }];
  await page.el('importFileInput').events.change();
  await page.el('confirmReplaceBtn').events.click();
  assert.equal(page.saved().FEISHU_APP_ID, 'new-id');
  assert.equal(page.el('feishuAppId').value, 'new-id');
  assert.equal(page.el('importModal').hidden, true);
});

test('failed replace import leaves credentials and import dialog intact', async () => {
  const page = pageClient('options/options.js');
  await page.init();
  page.el('importFileInput').files = [{ name: 'test.json', text: async () => JSON.stringify({
    credentials: { appId: 'new-id', appSecret: 'new-secret' },
    rules: [{ url: 'example.com', fields: [{ name: 'URL', type: 'current_url' }] }]
  }) }];
  await page.el('importFileInput').events.change();
  await assert.doesNotReject(page.el('confirmReplaceBtn').events.click());
  assert.equal(page.el('feishuAppId').value, 'old-id');
  assert.equal(page.el('importModal').hidden, false);
  assert.match(page.el('toastMessage').textContent, /导入失败/);
});

for (const file of ['options/options.js', 'popup/popup.js']) {
  test(`${file} handles storage read failure`, async () => {
    const page = pageClient(file, { readFails: true });
    await assert.doesNotReject(page.init());
    const text = page.el(file.startsWith('options') ? 'toastMessage' : 'resultMsg').textContent;
    assert.match(text, /读取.*失败/);
  });
}

test('popup stops extraction if target URL cannot be saved', async () => {
  const page = pageClient('popup/popup.js');
  await page.init();
  page.el('ruleSelector').value = '0';
  page.el('targetDbUrl').value = 'https://example.feishu.cn/sheets/test';
  await assert.doesNotReject(page.el('extractBtn').events.click());
  assert.match(page.el('resultMsg').textContent, /保存失败/);
  assert.equal(page.messages(), 0);
});

// Chrome: 第一个 sendResponse 或 listener Promise 的结果会成为最终消息响应。
function dispatchRuntimeMessage(listeners, message) {
  return new Promise((resolve, reject) => {
    for (const listener of listeners) {
      try {
        const result = listener(message, {}, resolve);
        if (result && typeof result.then === 'function') {
          result.then(value => resolve(value ?? null), reject);
        }
      } catch (error) { reject(error); }
    }
  });
}

for (const action of ['PUSH_TO_FEISHU', 'CAPTURE_REGION']) {
  test(`open options page cannot steal the background response to ${action}`, async () => {
    const page = pageClient('options/options.js');
    await page.init();
    const expected = { success: true, result: { operation: 'created' } };
    const backend = (_request, _sender, sendResponse) => {
      setImmediate(() => sendResponse(expected));
      return true;
    };
    const actual = await dispatchRuntimeMessage([...page.messageListeners, backend], { action });
    assert.deepEqual(actual, expected);
  });
}

test('options listener leaves unrelated messages unclaimed', async () => {
  const page = pageClient('options/options.js');
  await page.init();
  for (const action of ['PUSH_TO_FEISHU', 'CAPTURE_REGION', 'UNRELATED']) {
    assert.equal(page.messageListeners[0]({ action }, {}, () => {}), undefined);
  }
});

test('empty background response explains uncertain write result instead of unknown error', async () => {
  const page = pageClient('popup/popup.js', { writeFails: false, runtimeResponse: null });
  await page.init();
  await page.el('confirmPushBtn').events.click();
  assert.match(page.el('resultMsg').textContent, /未收到.*后台.*结果/);
  assert.match(page.el('resultMsg').textContent, /检查目标表格/);
});

test('extension disconnect is surfaced instead of leaving write spinner pending', async () => {
  const page = pageClient('popup/popup.js', { writeFails: false, runtimeThrow: true });
  await page.init();
  await assert.doesNotReject(page.el('confirmPushBtn').events.click());
  assert.match(page.el('resultMsg').textContent, /context invalidated|连接.*断开/);
});

test('background API errors retain their original details', async () => {
  const page = pageClient('popup/popup.js', { runtimeResponse: { success: false, error: '权限不足 (code 99991672)' } });
  await page.init();
  await page.el('confirmPushBtn').events.click();
  assert.match(page.el('resultMsg').textContent, /权限不足.*99991672/);
});

test('background success still displays the actual operation', async () => {
  const page = pageClient('popup/popup.js', { runtimeResponse: { success: true, result: { operation: 'updated' } } });
  await page.init();
  await page.el('confirmPushBtn').events.click();
  assert.equal(page.el('resultMsg').textContent, '已更新匹配行');
});

test('batch popup extracts three rules in order and sends exactly one merged write after confirmation', async () => {
  const rules = ['概览', '商业', '连接'].map((name, i) => ({ name, url: 'example.com', fields: [], tabSelector: `#tab${i}`, matchField: 'ID' }));
  const page = pageClient('popup/popup.js', { writeFails: false, rules,
    extractionResults: { 概览: { data: { ID: 'one', 粉丝: '10w' } }, 商业: { data: { ID: 'one', 报价: '5000' } }, 连接: { data: { ID: 'one', 用户: '1000' } } },
    runtimeResponse: { success: true, result: { operation: 'created' } }
  });
  await page.init();
  page.el('ruleSelector').value = '__all__';
  page.el('targetDbUrl').value = 'https://example.feishu.cn/sheets/test';
  await page.el('extractBtn').events.click();
  assert.deepEqual(page.tabRequests.map(request => request.rule.tabSelector), ['#tab0', '#tab1', '#tab2']);
  assert.equal(page.runtimeRequests.length, 0);
  await page.el('confirmPushBtn').events.click();
  assert.equal(page.runtimeRequests.length, 1);
  assert.equal(page.runtimeRequests[0].recordData.用户, '1000');
  assert.equal(Object.keys(page.runtimeRequests[0].recordData).length, 4);
  assert.equal(page.runtimeRequests[0].matchField, 'ID');
});

test('batch popup stops on a failed rule and never writes partial results', async () => {
  const rules = ['概览', '商业', '连接'].map(name => ({ name, url: 'example.com', fields: [] }));
  const page = pageClient('popup/popup.js', { writeFails: false, rules,
    extractionResults: { 概览: { data: { ID: 'one' } }, 商业: { error: '目标页签未找到' } }
  });
  await page.init();
  page.el('ruleSelector').value = '__all__';
  page.el('targetDbUrl').value = 'https://example.feishu.cn/sheets/test';
  await page.el('extractBtn').events.click();
  assert.equal(page.tabRequests.length, 2);
  assert.equal(page.runtimeRequests.length, 0);
  assert.match(page.el('resultMsg').textContent, /目标页签未找到/);
});

test('batch popup skips missing fields and continues later rules before writing found values', async () => {
  const rules = ['概览', '商业', '连接'].map(name => ({ name, url: 'example.com', fields: [] }));
  const page = pageClient('popup/popup.js', { writeFails: false, rules,
    extractionResults: { 概览: { data: { ID: 'one' } }, 商业: { data: { 销售额: null }, missing: ['销售额'] },
      连接: { data: { 用户: '1000', 零值: 0, 布尔值: false } } }
  });
  await page.init();
  page.el('ruleSelector').value = '__all__';
  page.el('targetDbUrl').value = 'https://example.feishu.cn/sheets/test';
  await page.el('extractBtn').events.click();
  assert.equal(page.tabRequests.length, 3);
  assert.match(page.el('shotWarning').textContent, /商业.*销售额/);
  assert.equal(page.el('previewDataContainer').children.length, 1);
  assert.equal(page.runtimeRequests.length, 0);
  await page.el('confirmPushBtn').events.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.runtimeRequests[0].recordData)), { ID: 'one', 用户: '1000', 零值: 0, 布尔值: false });
});

test('batch popup skips an unconfigured screenshot while keeping extracted fields writable', async () => {
  const rules = [{ name: '概览', url: 'example.com', fields: [] },
    { name: '连接', url: 'example.com', fields: [{ name: '截图', type: 'screenshot' }] }];
  const page = pageClient('popup/popup.js', { writeFails: false, rules,
    extractionResults: { 概览: { data: { ID: 'one' } }, 连接: { data: { 截图: null } } }
  });
  await page.init();
  page.el('ruleSelector').value = '__all__';
  page.el('targetDbUrl').value = 'https://example.feishu.cn/sheets/test';
  await page.el('extractBtn').events.click();
  assert.match(page.el('shotWarning').textContent, /截图.*已跳过/);
  assert.equal(page.el('previewDataContainer').children.length, 1);
  assert.equal(page.runtimeRequests.length, 0);
  await page.el('confirmPushBtn').events.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.runtimeRequests[0].recordData)), { ID: 'one' });
});

test('skipping every missing field cannot create an empty record', async () => {
  const page = pageClient('popup/popup.js', { writeFails: false,
    extractionResults: { 测试: { data: { 用户: null }, missing: ['用户'] } }
  });
  await page.init();
  page.el('ruleSelector').value = '0';
  page.el('targetDbUrl').value = 'https://example.feishu.cn/sheets/test';
  await page.el('extractBtn').events.click();
  assert.match(page.el('shotWarning').textContent, /用户/);
  await page.el('confirmPushBtn').events.click();
  assert.equal(page.runtimeRequests.length, 0);
  assert.match(page.el('resultMsg').textContent, /可写入/);
});
