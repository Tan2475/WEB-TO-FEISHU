const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(file, globals = {}) {
  const context = vm.createContext({ self: {}, console, URL, atob, btoa, Uint8Array, Blob, FormData, ...globals });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return context;
}

function client({ type = 'sheets', rows = [['key']], pages = [], rowCount = 10, failRead = false,
  headers = ['ID', '标题', '备注', '截图'] } = {}) {
  const requests = [], writes = [];
  const context = load('shared/feishu.js', { fetch: async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    const request = { url, method, body };
    requests.push(request);
    let data;
    if (url.includes('/auth/')) data = { tenant_access_token: 'mock' };
    else if (url.includes('/sheets/query')) data = { sheets: [{ sheet_id: 's1', grid_properties: { row_count: rowCount } }] };
    else if (method === 'GET' && url.includes('/values/')) {
      const range = decodeURIComponent(url.split('/values/')[1]);
      if (range.endsWith('A1:Z1')) data = { valueRange: { values: [headers] } };
      else {
        if (failRead) return { json: async () => ({ code: 1, msg: '读取失败' }) };
        const start = Number(/!A(\d+)/.exec(range)[1]);
        data = { valueRange: { values: rows.slice(start - 2, start - 2 + 5000) } };
      }
    } else if (method === 'GET' && url.includes('/records')) {
      if (failRead) return { json: async () => ({ code: 1, msg: '读取失败' }) };
      const page = Number(new URL(url).searchParams.get('page_token') || 0);
      data = { items: pages[page] || [], has_more: page + 1 < pages.length, page_token: String(page + 1) };
    } else if (url.includes('/upload_all')) data = { file_token: 'image-token' };
    else {
      writes.push(request);
      data = url.includes('/records') ? { record: { record_id: 'rec1' } } : { updates: { updatedRange: 's1!A8:D8' } };
    }
    return { json: async () => ({ code: 0, data, tenant_access_token: 'mock' }) };
  } });
  return { requests, writes, run: (record = { ID: 'key', 标题: '新标题' }, shots = {}, matchField = 'ID') =>
    context.appendToFeishu('mock', 'mock', `https://example.feishu.cn/${type}/token?sheet=s1&table=tbl1`, record, shots, matchField) };
}

test('sheet match updates only provided non-null cells in the existing row', async () => {
  const c = client({ rows: [['other'], ['key']] });
  const result = await c.run({ ID: 'key', 标题: '新标题', 备注: null });
  assert.equal(result.operation, 'updated');
  assert.equal(result.rowNumber, 3);
  assert.equal(c.writes.length, 1);
  assert.ok(c.writes[0].url.endsWith('/values_batch_update'));
  assert.deepEqual(c.writes[0].body.valueRanges, [
    { range: 's1!B3:B3', values: [['新标题']] }
  ]);
});

test('sheet no match appends a new row', async () => {
  const c = client({ rows: [['different']] });
  const result = await c.run();
  assert.equal(result.operation, 'created');
  assert.ok(c.writes[0].url.endsWith('/values_append'));
});

test('sheet scan continues beyond the first 5000 rows', async () => {
  const rows = Array.from({ length: 5001 }, () => []);
  rows[5000] = ['key'];
  const c = client({ rows, rowCount: 5002 });
  const result = await c.run();
  assert.equal(result.rowNumber, 5002);
  assert.equal(result.operation, 'updated');
});

test('sheet duplicates prevent all writes', async () => {
  const c = client({ rows: [['key'], ['key']] });
  await assert.rejects(c.run(), /多行|多条/);
  assert.equal(c.writes.length, 0);
});

test('ambiguous matching column names prevent all sheet writes', async () => {
  const c = client({ headers: ['ID', 'ID', '标题'] });
  await assert.rejects(c.run(), /匹配.*重复|匹配.*唯一/);
  assert.equal(c.writes.length, 0);
});

test('sheet match uses full trimmed values and supports rich text links', async () => {
  const c = client({ rows: [['key-extra'], [[{ type: 'url', text: '显示文字', link: ' key ' }]]] });
  const result = await c.run();
  assert.equal(result.rowNumber, 3);
});

test('rich text matching preserves spaces between fragments', async () => {
  const c = client({ rows: [[[{ text: 'hello ' }, { text: 'world' }]]] });
  assert.equal((await c.run({ ID: 'hello world', 标题: '新标题' })).operation, 'updated');
});

test('bitable email keys match either visible email text or the mailto URL', async () => {
  for (const value of ['a@b.com', 'mailto:a@b.com']) {
    const c = client({ type: 'base', pages: [[{ record_id: 'target', fields: {
      ID: [{ type: 'url', text: 'a@b.com', link: 'mailto:a@b.com' }]
    } }]] });
    assert.equal((await c.run({ ID: value, 标题: '新标题' })).operation, 'updated');
  }
});

test('bitable formula results can match without rewriting the computed key', async () => {
  const c = client({ type: 'base', pages: [[{ record_id: 'target', fields: {
    ID: { type: 1, ui_type: 'Text', value: [{ text: 'key' }] }
  } }]] });
  assert.equal((await c.run()).operation, 'updated');
});

test('unsupported existing key values cannot silently trigger insertion', async () => {
  const c = client({ type: 'base', pages: [[{ record_id: 'target', fields: { ID: { file_token: 'image' } } }]] });
  await assert.rejects(c.run(), /匹配.*类型|类型.*匹配/);
  assert.equal(c.writes.length, 0);
});

test('multi-select arrays cannot be concatenated into a match for the wrong row', async () => {
  const c = client({ type: 'base', pages: [[{ record_id: 'target', fields: { ID: ['foo', 'bar'] } }]] });
  await assert.rejects(c.run({ ID: 'foobar', 标题: '新标题' }), /匹配.*类型|类型.*匹配/);
  assert.equal(c.writes.length, 0);
});

test('matched key is never rewritten, including hyperlink and formula keys', async () => {
  for (const type of ['sheets', 'base']) {
    const c = client({ type, pages: [[{ record_id: 'target', fields: { ID: { link: 'key', text: '链接' } } }]] });
    await c.run();
    if (type === 'sheets') {
      assert.ok(c.writes[0].body.valueRanges.every(range => !range.range.includes('!A')));
    } else {
      assert.equal(Object.hasOwn(c.writes[0].body.fields, 'ID'), false);
    }
  }
});

test('a match with only the key field does not send an empty update', async () => {
  for (const type of ['sheets', 'base']) {
    const c = client({ type, pages: [[{ record_id: 'target', fields: { ID: 'key' } }]] });
    assert.equal((await c.run({ ID: 'key' })).operation, 'updated');
    assert.equal(c.writes.length, 0);
  }
});

test('screenshot uses the matched row without blanking any other column', async () => {
  const c = client();
  await c.run({ ID: 'key', 截图: null }, { 截图: 'data:image/png;base64,AA==' });
  assert.equal(c.writes.length, 1);
  assert.equal(c.writes[0].body.range, 's1!D2:D2');
});

for (const type of ['sheets', 'base']) {
  test(`${type}: empty or invalid match value rejects without writing`, async () => {
    for (const value of [null, undefined, '', ' ', {}, [], 'data:image/png;base64,AA==']) {
      const c = client({ type });
      await assert.rejects(c.run({ ID: value }), /匹配/);
      assert.equal(c.writes.length, 0);
    }
  });
  test(`${type}: read failure cannot fall back to append`, async () => {
    const c = client({ type, failRead: true });
    await assert.rejects(c.run(), /读取|查找|匹配/);
    assert.equal(c.writes.length, 0);
  });
  test(`${type}: no match field keeps direct append without lookup`, async () => {
    const c = client({ type });
    const result = await c.run(undefined, {}, '');
    assert.equal(result.operation, 'created');
    assert.equal(c.requests.filter(r => r.method === 'GET' && r.url.includes('/records')).length, 0);
    assert.equal(c.requests.filter(r => r.url.includes('/sheets/query')).length, 0);
  });
}

test('bitable finds a record on a later page and updates only extracted values', async () => {
  const c = client({ type: 'base', pages: [
    [{ record_id: 'other', fields: { ID: 'other' } }],
    [{ record_id: 'target', fields: { ID: [{ text: 'key' }], 备注: '保留' } }]
  ] });
  const result = await c.run({ ID: 'key', 标题: '新标题', 备注: null });
  assert.equal(result.operation, 'updated');
  assert.equal(c.writes[0].method, 'PUT');
  assert.ok(c.writes[0].url.endsWith('/records/target'));
  assert.deepEqual(c.writes[0].body.fields, { 标题: '新标题' });
});

test('bitable no match creates a record', async () => {
  const c = client({ type: 'base', pages: [[]] });
  const result = await c.run();
  assert.equal(result.operation, 'created');
  assert.equal(c.writes[0].method, 'POST');
});

test('bitable duplicate matches across pages refuse mutation', async () => {
  const c = client({ type: 'base', pages: [
    [{ record_id: 'one', fields: { ID: 'key' } }], [{ record_id: 'two', fields: { ID: 'key' } }]
  ] });
  await assert.rejects(c.run(), /多行|多条/);
  assert.equal(c.writes.length, 0);
});

test('match values zero and false are valid keys', async () => {
  for (const value of [0, false]) {
    const c = client({ rows: [[value]] });
    assert.equal((await c.run({ ID: value })).operation, 'updated');
  }
});

test('configuration import/export preserves match field and accepts old rules', () => {
  const c = load('shared/config-io.js');
  const rules = [{ name: '测试', url: 'example.com', matchField: 'ID', fields: [{ name: 'ID', type: 'current_url' }] }];
  const payload = c.buildConfigPayload({ rules });
  assert.equal(c.validateConfigPayload(payload).payload.rules[0].matchField, 'ID');
  assert.equal(c.validateConfigPayload({ rules: [{ ...rules[0], matchField: undefined }] }).ok, true);
});

test('configuration refuses invalid match fields instead of silently using append mode', () => {
  const c = load('shared/config-io.js');
  for (const matchField of ['不存在', 123]) {
    const result = c.validateConfigPayload({ rules: [{ url: 'example.com', matchField,
      fields: [{ name: 'ID', type: 'current_url' }] }] });
    assert.equal(result.ok, false);
  }
});
