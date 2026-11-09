const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function batch() {
  const c = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared/batch.js'), 'utf8'), c);
  return c;
}
test('three rule results merge into one record and preserve shared keys', () => {
  const c = batch();
  const result = c.mergeRuleResults([
    { name: '概览', data: { ID: '达人1', 粉丝: '10w' } },
    { name: '商业', data: { ID: '达人1', 报价: '5000' } },
    { name: '连接', data: { ID: '达人1', 用户: '1000' } }
  ]);
  assert.equal(result.ID, '达人1');
  assert.equal(Object.keys(result).length, 4);
});
test('missing values never replace data extracted by another rule', () => {
  const c = batch();
  const result = c.mergeRuleResults([{ data: { 数量: 0, 启用: false, 标题: 'test' } }, { data: { 数量: null, 标题: '' } }]);
  assert.equal(result.数量, 0);
  assert.equal(result.启用, false);
  assert.equal(result.标题, 'test');
});
test('conflicting nonempty fields block merge and identify the field', () => {
  const c = batch();
  assert.throws(() => c.mergeRuleResults([{ name: '概览', data: { ID: 'one' } }, { name: '连接', data: { ID: 'two' } }]), /ID.*冲突|冲突.*ID/);
});
test('different match fields are rejected before any extraction starts', () => {
  const c = batch();
  assert.throws(() => c.executionMatchField([{ matchField: 'ID' }, { matchField: 'URL' }]), /匹配字段/);
  assert.equal(c.executionMatchField([{ matchField: 'ID' }, {}]), 'ID');
  assert.equal(c.executionMatchField([{}, {}]), '');
});
