// 组合抓取只负责读取与合并；最后由预览确认统一发起一次写入。
function executionMatchField(rules) {
  const fields = [...new Set(rules.map(rule => (rule.matchField || '').trim()).filter(Boolean))];
  if (fields.length > 1) throw new Error('组合规则的匹配字段不一致，请统一后再执行。');
  return fields[0] || '';
}

function mergeRuleResults(results) {
  const data = Object.create(null);
  const owners = Object.create(null);
  const empty = value => value == null || value === '';
  for (const result of results) {
    for (const [key, value] of Object.entries(result.data || {})) {
      if (Object.hasOwn(data, key) && !empty(data[key]) && !empty(value) && JSON.stringify(data[key]) !== JSON.stringify(value)) {
        throw new Error(`字段「${key}」在「${owners[key]}」与「${result.name || '未命名规则'}」中结果冲突，请调整字段名后重试。`);
      }
      if (!Object.hasOwn(data, key) || !empty(value)) {
        data[key] = value;
        owners[key] = result.name || '未命名规则';
      }
    }
  }
  return data;
}

async function executeRuleBatch(rules, extractRule) {
  const matchField = executionMatchField(rules);
  const results = [];
  for (let i = 0; i < rules.length; i++) {
    const result = await extractRule(rules[i], i);
    results.push({ name: rules[i].name, ...result });
    // 及早发现字段冲突，后续规则不再继续操作页面。
    mergeRuleResults(results);
  }
  const data = mergeRuleResults(results);
  if (matchField && (data[matchField] == null || String(data[matchField]).trim() === '')) {
    throw new Error(`匹配字段「${matchField}」未抓取到有效值，组合结果尚未写入。`);
  }
  return { data, matchField, warnings: results.flatMap(result => (result.warnings || []).map(w => `${result.name || '规则'}：${w}`)) };
}
