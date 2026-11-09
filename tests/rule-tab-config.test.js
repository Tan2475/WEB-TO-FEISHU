const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ self: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/config-io.js'), 'utf8'), context);
const { buildConfigPayload, validateConfigPayload, mergeConfigRules } = context.self;
const rule = { name: '商业能力', url: 'example.com', fields: [{ name: '标题', selector: 'h1', type: 'text' }] };

test('target tab survives export, JSON import and append/replace merge', () => {
  const exported = buildConfigPayload({ rules: [{ ...rule, tabSelector: '  [role="tab"][data-key="business"]  ' }] });
  assert.equal(exported.schemaVersion, 4);
  const imported = validateConfigPayload(JSON.parse(JSON.stringify(exported)));
  assert.equal(imported.ok, true);
  assert.equal(imported.payload.rules[0].tabSelector, '[role="tab"][data-key="business"]');
  for (const strategy of ['append', 'replace']) {
    const merged = mergeConfigRules([], imported.payload.rules, strategy);
    assert.equal(merged[0].tabSelector, '[role="tab"][data-key="business"]');
  }
});

test('invalid target tab types reject the whole import instead of dropping tab selection', () => {
  for (const tabSelector of [null, false, 4, [], {}]) {
    const result = validateConfigPayload({ rules: [{ ...rule, tabSelector }] });
    assert.equal(result.ok, false, `must reject ${JSON.stringify(tabSelector)}`);
    assert.match(result.error, /页签/);
  }
});

test('empty and missing target tabs preserve legacy schema selection', () => {
  for (const tabSelector of [undefined, '', '  ']) {
    const exported = buildConfigPayload({ rules: [{ ...rule, tabSelector }] });
    assert.equal(exported.schemaVersion, 1);
    assert.equal(validateConfigPayload(exported).ok, true);
  }
  assert.equal(buildConfigPayload({ rules: [{ ...rule, matchField: '标题' }] }).schemaVersion, 2);
  const screenshot = { name: '截图', type: 'screenshot', region: { anchorSelector: '#chart', width: 10, height: 20, tabSelectors: ['#tab'] } };
  assert.equal(buildConfigPayload({ rules: [{ ...rule, fields: [screenshot] }] }).schemaVersion, 3);
});
