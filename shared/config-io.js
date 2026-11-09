// shared/config-io.js
// 配置导入导出：组装导出载荷、校验导入文件、合并规则、生成文件名。
// 全部为纯函数，不依赖 DOM，便于在 options 页复用与后续单测。

const CONFIG_SCHEMA = 'web-to-feishu-config';
const CONFIG_SCHEMA_VERSION = 5;
const CONFIG_FIELD_TYPES = ['text', 'href', 'src', 'html', 'value', 'current_url', 'screenshot'];

/**
 * 组装导出载荷。
 * includeCredentials 为 false 时完全不写入 credentials 字段，
 * 避免明文密钥被无意带出。
 */
function buildConfigPayload(options) {
  const {
    appId = '',
    appSecret = '',
    targetUrl = '',
    rules = [],
    includeCredentials = false,
    extensionVersion = ''
  } = options || {};

  const payload = {
    schema: CONFIG_SCHEMA,
    // 模块截图、规则页签、截图页签恢复、匹配字段分别要求 v5 / v4 / v3 / v2。
    schemaVersion: Array.isArray(rules) && rules.some(rule => rule.fields?.some(field => field.region?.mode === 'module'))
      ? 5 : Array.isArray(rules) && rules.some(rule => typeof rule.tabSelector === 'string' && rule.tabSelector.trim())
      ? 4 : Array.isArray(rules) && rules.some(rule => rule.fields?.some(field => field.region?.tabSelectors?.length))
        ? 3 : Array.isArray(rules) && rules.some(rule => rule.matchField) ? 2 : 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: extensionVersion || '',
    includesCredentials: !!includeCredentials,
    targetUrl: (targetUrl || '').trim() || null,
    rules: Array.isArray(rules) ? rules : []
  };

  if (includeCredentials) {
    payload.credentials = {
      appId: (appId || '').trim(),
      appSecret: (appSecret || '').trim()
    };
  }

  return payload;
}

/**
 * 生成形如 web-to-feishu-config-20261103-0941.json 的文件名。
 * 含凭证时追加 -with-credentials 后缀，便于在文件系统里一眼识别风险文件。
 */
function buildConfigFilename(payload, now) {
  const d = now instanceof Date ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const suffix = payload && payload.includesCredentials ? '-with-credentials' : '';
  return `web-to-feishu-config-${stamp}${suffix}.json`;
}

/** 区域配置是否可用：必须有大小的同时，锚点选择器或文档坐标至少有一个 */
function isRegionNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasRegionDocCoords(region) {
  return isRegionNumber(region.docX) && isRegionNumber(region.docY) && region.docX >= 0 && region.docY >= 0;
}

function isValidRegion(region) {
  if (!region || typeof region !== 'object') return false;
  if (region.tabSelectors !== undefined && (!Array.isArray(region.tabSelectors) || region.tabSelectors.length > 10 ||
      region.tabSelectors.some(selector => typeof selector !== 'string' || !selector.trim()))) return false;
  const { width, height } = region;
  if (!isRegionNumber(width) || !isRegionNumber(height) || Math.round(width) < 1 || Math.round(height) < 1) return false;
  if (region.mode === 'module') {
    return Array.isArray(region.modules) && region.modules.length > 0 && region.modules.length <= 12 && region.modules.every(m =>
      m && typeof m.selector === 'string' && m.selector.trim() && typeof m.title === 'string' && m.title.trim() && m.title.length <= 100 &&
      typeof m.tag === 'string' && /^[A-Z][A-Z0-9-]*$/.test(m.tag) && Number.isInteger(m.headingDepth) && m.headingDepth >= 1 && m.headingDepth <= 30 &&
      Array.isArray(m.classes) && m.classes.length <= 6 && m.classes.every(c => typeof c === 'string' && c.length > 0 && c.length < 128) &&
      (m.scopeSelector === undefined || typeof m.scopeSelector === 'string'));
  }
  if (region.mode !== undefined && region.mode !== 'region') return false;

  const hasAnchor = typeof region.anchorSelector === 'string' && region.anchorSelector.trim() !== '';
  const hasDocCoords = hasRegionDocCoords(region);
  return hasAnchor || hasDocCoords;
}

function normalizeRegion(region) {
  if (!isValidRegion(region)) return null;
  if (region.mode === 'module') {
    return { mode: 'module', modules: region.modules.map(m => ({ selector: m.selector.trim(), title: m.title.trim(), tag: m.tag,
      classes: [...m.classes], headingDepth: m.headingDepth, ...(m.scopeSelector ? { scopeSelector: m.scopeSelector.trim() } : {}) })),
      width: Math.round(region.width), height: Math.round(region.height),
      ...(region.tabSelectors?.length ? { tabSelectors: region.tabSelectors.map(s => s.trim()) } : {}) };
  }

  const normalized = {
    anchorSelector: typeof region.anchorSelector === 'string' ? region.anchorSelector.trim() : '',
    offsetX: isRegionNumber(region.offsetX) ? Math.round(region.offsetX) : 0,
    offsetY: isRegionNumber(region.offsetY) ? Math.round(region.offsetY) : 0,
    width: Math.round(region.width),
    height: Math.round(region.height),
    dpr: isRegionNumber(region.dpr) && region.dpr > 0 ? region.dpr : 1
  };

  // docX / docY 是锚点失效时的兜底坐标，缺失时不补默认值，避免落到页面左上角
  if (hasRegionDocCoords(region)) {
    normalized.docX = Math.round(region.docX);
    normalized.docY = Math.round(region.docY);
  }
  if (region.tabSelectors?.length) normalized.tabSelectors = region.tabSelectors.map(selector => selector.trim());

  return normalized;
}

/** 归一化单个字段，非法则返回 null */
function normalizeConfigField(rawField) {
  if (!rawField || typeof rawField !== 'object') return null;

  const name = typeof rawField.name === 'string' ? rawField.name.trim() : '';
  if (!name) return null;

  const type = CONFIG_FIELD_TYPES.includes(rawField.type) ? rawField.type : 'text';
  const selector = typeof rawField.selector === 'string' ? rawField.selector.trim() : '';

  if (type === 'screenshot') {
    const region = normalizeRegion(rawField.region);
    return region ? { name, selector: '', type, region } : null;
  }

  if (type === 'current_url') {
    return { name, selector: '', type };
  }

  // 其余类型没有选择器就是废字段
  if (!selector) return null;
  return { name, selector, type };
}

function normalizeCredentials(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const appId = typeof raw.appId === 'string' ? raw.appId.trim() : '';
  const appSecret = typeof raw.appSecret === 'string' ? raw.appSecret.trim() : '';
  if (!appId && !appSecret) return null;
  return { appId, appSecret };
}

function validateRuleMatchField(rule) {
  if (rule.matchField == null || rule.matchField === '') return '';
  if (typeof rule.matchField !== 'string') return '匹配字段必须为飞书列名。';
  const name = rule.matchField.trim();
  if (!name) return '';
  const fields = (rule.fields || []).filter(field => field.name === name);
  if (fields.length !== 1 || fields[0].type === 'screenshot') {
    return `匹配字段「${name}」必须对应一个已配置的非截图字段。`;
  }
  return '';
}

/**
 * 校验并归一化导入的配置对象。
 * 返回 { ok:true, payload, stats, warnings } 或 { ok:false, error }
 */
function validateConfigPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '文件内容不是一个 JSON 对象。' };
  }
  if (raw.schema && raw.schema !== CONFIG_SCHEMA) {
    return { ok: false, error: `这不是本扩展导出的配置文件（schema: ${raw.schema}）。` };
  }
  if (Number(raw.schemaVersion) > CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `配置版本 ${raw.schemaVersion} 高于当前扩展支持的 ${CONFIG_SCHEMA_VERSION}，请先升级扩展。`
    };
  }
  if (!Array.isArray(raw.rules)) {
    return { ok: false, error: '文件缺少 rules 数组，无法导入。' };
  }

  const warnings = [];
  const rules = [];
  let fieldCount = 0;
  let screenshotFieldCount = 0;
  let droppedFields = 0;
  let matchError = '';
  let tabError = '';

  raw.rules.forEach((rawRule, ruleIndex) => {
    const label = `第 ${ruleIndex + 1} 条规则`;

    if (!rawRule || typeof rawRule !== 'object') {
      warnings.push(`${label}格式异常，已跳过。`);
      return;
    }

    if (rawRule.tabSelector !== undefined && typeof rawRule.tabSelector !== 'string') {
      tabError = tabError || `${label}的目标页签必须为 CSS 选择器字符串。`;
      return;
    }

    const name =
      typeof rawRule.name === 'string' && rawRule.name.trim() ? rawRule.name.trim() : `导入规则 ${ruleIndex + 1}`;
    const url = typeof rawRule.url === 'string' ? rawRule.url.trim() : '';

    const fields = [];
    const rawFields = Array.isArray(rawRule.fields) ? rawRule.fields : [];
    rawFields.forEach((rawField) => {
      const field = normalizeConfigField(rawField);
      if (field) {
        fields.push(field);
        fieldCount++;
        if (field.type === 'screenshot') screenshotFieldCount++;
      } else {
        droppedFields++;
      }
    });

    if (fields.length === 0 && !url) {
      warnings.push(`规则「${name}」既没有 URL 也没有有效字段，已跳过。`);
      return;
    }

    const rule = {
      name,
      url,
      tabSelector: typeof rawRule.tabSelector === 'string' ? rawRule.tabSelector.trim() : '',
      matchField: typeof rawRule.matchField === 'string' ? rawRule.matchField.trim() : (rawRule.matchField ?? ''),
      preSelector: typeof rawRule.preSelector === 'string' ? rawRule.preSelector.trim() : '',
      preType: rawRule.preType === 'hover' || rawRule.preType === 'click' ? rawRule.preType : '',
      fields
    };
    matchError = matchError || validateRuleMatchField(rule);
    rules.push(rule);
  });

  if (tabError) return { ok: false, error: tabError };
  if (matchError) return { ok: false, error: matchError };

  if (rules.length === 0) {
    return { ok: false, error: '文件里没有可用的抓取规则。' };
  }

  if (droppedFields > 0) {
    warnings.push(`共丢弃 ${droppedFields} 个无效字段（缺名称、缺选择器，或截图区域不完整）。`);
  }

  const credentials = normalizeCredentials(raw.credentials);

  return {
    ok: true,
    payload: {
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      extensionVersion: typeof raw.extensionVersion === 'string' ? raw.extensionVersion : '',
      targetUrl: typeof raw.targetUrl === 'string' && raw.targetUrl.trim() ? raw.targetUrl.trim() : null,
      credentials,
      rules
    },
    stats: { rules: rules.length, fields: fieldCount, screenshotFields: screenshotFieldCount, droppedFields },
    warnings
  };
}

/** 规则重名时追加后缀，避免覆盖后无法区分 */
function makeUniqueRuleName(baseName, usedNames) {
  if (!usedNames.has(baseName)) return baseName;
  let candidate = `${baseName} (导入)`;
  let n = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName} (导入 ${n})`;
    n++;
  }
  return candidate;
}

/**
 * 合并规则。
 * strategy: 'replace' 用导入的完全替换；'append' 保留现有并在其后追加（重名加后缀）
 */
function mergeConfigRules(currentRules, importedRules, strategy) {
  const current = Array.isArray(currentRules) ? currentRules : [];
  const imported = Array.isArray(importedRules) ? importedRules : [];

  if (strategy === 'replace') {
    return imported.map((rule) => ({ ...rule }));
  }

  const usedNames = new Set(current.map((rule) => rule.name));
  const appended = imported.map((rule) => {
    const name = makeUniqueRuleName(rule.name, usedNames);
    usedNames.add(name);
    return { ...rule, name };
  });

  return [...current.map((rule) => ({ ...rule })), ...appended];
}

if (typeof self !== 'undefined') {
  self.CONFIG_SCHEMA = CONFIG_SCHEMA;
  self.CONFIG_SCHEMA_VERSION = CONFIG_SCHEMA_VERSION;
  self.CONFIG_FIELD_TYPES = CONFIG_FIELD_TYPES;
  self.buildConfigPayload = buildConfigPayload;
  self.buildConfigFilename = buildConfigFilename;
  self.isValidRegion = isValidRegion;
  self.validateConfigPayload = validateConfigPayload;
  self.mergeConfigRules = mergeConfigRules;
  self.validateRuleMatchField = validateRuleMatchField;
}
