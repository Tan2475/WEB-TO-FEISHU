// shared/feishu.js

/**
 * Extracts AppToken and TableId/SheetId from a Feishu URL.
 * Bitable Example: https://[domain]/base/[appToken]?table=[tableId]&...
 * Sheets Example: https://[domain]/sheets/[appToken]?sheet=[sheetId]&...
 * Wiki Example: https://[domain]/wiki/[wikiToken]?table=[tableId]&...
 */
function parseFeishuUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Check if it's bitable (base or wiki)
    const baseIndex = pathParts.findIndex(p => p === 'base' || p === 'bitable');
    if (baseIndex >= 0 && baseIndex + 1 < pathParts.length) {
      return {
        type: 'bitable',
        token: pathParts[baseIndex + 1],
        tableId: urlObj.searchParams.get('table')
      };
    }

    // Check if it's spreadsheet
    const sheetsIndex = pathParts.findIndex(p => p === 'sheets');
    if (sheetsIndex >= 0 && sheetsIndex + 1 < pathParts.length) {
      return {
        type: 'sheet',
        token: pathParts[sheetsIndex + 1],
        sheetId: urlObj.searchParams.get('sheet')
      };
    }

    // Check if it's wiki
    const wikiIndex = pathParts.findIndex(p => p === 'wiki');
    if (wikiIndex >= 0 && wikiIndex + 1 < pathParts.length) {
      return {
        type: 'wiki',
        token: pathParts[wikiIndex + 1],
        tableHint: urlObj.searchParams.get('table'),
        sheetHint: urlObj.searchParams.get('sheet')
      };
    }

    return { type: 'unknown', token: null, tableId: null };
  } catch (e) {
    return { type: 'unknown', token: null, tableId: null };
  }
}

/**
 * Fetches tenant_access_token from Feishu Open API
 */
async function getTenantAccessToken(appId, appSecret) {
  const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });
  const data = await response.json();
  if (data.code === 0) {
    return data.tenant_access_token;
  } else {
    throw new Error(`Auth Error: ${data.msg}`);
  }
}

// ==== 图片素材处理 ====

/**
 * 拆分 dataURL，返回 MIME 与 base64 载荷。
 */
function splitDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;

  const mime = match[1] || 'image/png';
  const payload = match[3];
  const base64 = match[2] ? payload : btoa(decodeURIComponent(payload));

  return { mime, base64, ext: mimeToExt(mime) };
}

function mimeToExt(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/webp': 'webp'
  };
  return map[mime] || 'png';
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 生成安全的素材文件名：飞书会校验文件名合规性，
 * 因此过滤掉可能触发校验失败的符号，保留中英文与数字。
 */
function buildMediaName(fieldName, ext) {
  const safe = String(fieldName || 'screenshot')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]/g, '')
    .slice(0, 40) || 'screenshot';
  return `${safe}_${Date.now()}.${ext}`;
}

/**
 * 上传图片到多维表格素材库，返回 file_token。
 */
async function uploadBitableImage(accessToken, appToken, image, fieldName) {
  const bytes = base64ToBytes(image.base64);
  const fileName = buildMediaName(fieldName, image.ext);

  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_image');
  form.append('parent_node', appToken);
  form.append('size', String(bytes.length));
  form.append('file', new Blob([bytes], { type: image.mime }), fileName);

  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: form
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`上传图片素材失败: ${data.msg} (code ${data.code})`);
  }
  return data.data.file_token;
}

/**
 * 向电子表格单个单元格写入图片。
 * 文档声明 image 为二进制数组，但实践中以 base64 字符串传参亦可成功，
 * 因此这里做双路兼容：先试 base64，失败再退回字节数组。
 */
async function writeSheetImage(accessToken, spreadsheetToken, range, image, fieldName) {
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_image`;
  const fileName = buildMediaName(fieldName, image.ext);

  const payloads = [image.base64, Array.from(base64ToBytes(image.base64))];
  let lastError = '';

  for (const payload of payloads) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ range, image: payload, name: fileName })
    });
    const data = await res.json();
    if (data.code === 0) return;
    lastError = `${data.msg} (code ${data.code})`;
  }

  throw new Error(`写入图片失败: ${lastError}`);
}

/**
 * 列索引（0 基）转 Excel 列字母：0 -> A, 25 -> Z, 26 -> AA
 */
function columnLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/**
 * 从 values_append 的返回中解析出本次写入的行号。
 */
function resolveAppendedRow(appendData) {
  const updates = appendData && appendData.updates;

  // 优先使用 updatedRange，形如 "sheetId!A8:P8"，起始行即本次新增行
  const updatedRange = updates && updates.updatedRange;
  if (typeof updatedRange === 'string') {
    const match = /!([A-Za-z]+)(\d+)/.exec(updatedRange);
    if (match) return parseInt(match[2], 10);
  }

  // 兜底使用 tableRange，形如 "sheetId!A1:P7"，取结束行
  const tableRange = appendData && appendData.tableRange;
  if (typeof tableRange === 'string') {
    const endMatch = /![A-Za-z]+\d*:[A-Za-z]+(\d+)/.exec(tableRange);
    if (endMatch) return parseInt(endMatch[1], 10);
    const startMatch = /!([A-Za-z]+)(\d+)/.exec(tableRange);
    if (startMatch) return parseInt(startMatch[2], 10);
  }

  return null;
}

/**
 * Appends a record to Bitable or Spreadsheet based on the URL.
 * @param {Object} screenshots - { 字段名: dataURL }，区域截图字段
 */
async function appendToFeishu(appId, appSecret, feishuUrl, recordData, screenshots = {}, matchField = '') {
  const warnings = [];
  if (typeof matchField !== 'string') throw new Error('匹配字段配置无效。');
  matchField = matchField.trim();
  const matchValue = matchField ? comparableFieldValue(recordData[matchField]) : null;
  if (matchField && (matchValue === null || matchValue === '' || screenshots[matchField] ||
      (typeof recordData[matchField] === 'string' && recordData[matchField].startsWith('data:image/')))) {
    throw new Error(`匹配字段「${matchField}」未提取到有效值，数据尚未写入。`);
  }
  let parsed = parseFeishuUrl(feishuUrl);
  if (parsed.type === 'unknown' || !parsed.token) {
    throw new Error('无效的飞书表格链接，无法识别为多维表格(base)或电子表格(sheets)或知识库(wiki)。');
  }

  const accessToken = await getTenantAccessToken(appId, appSecret);

  // If wiki, fetch the actual underlying token and type
  if (parsed.type === 'wiki') {
    const wikiRes = await fetch(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${parsed.token}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const wikiData = await wikiRes.json();
    if (wikiData.code !== 0) throw new Error(`解析 Wiki 链接失败: ${wikiData.msg}`);

    const objType = wikiData.data.node.obj_type;
    const objToken = wikiData.data.node.obj_token;

    if (objType === 'bitable') {
      parsed = { type: 'bitable', token: objToken, tableId: parsed.tableHint };
    } else if (objType === 'sheet') {
      parsed = { type: 'sheet', token: objToken, sheetId: parsed.sheetHint };
    } else {
      throw new Error(`不支持的知识库节点类型: ${objType}`);
    }
  }

  if (parsed.type === 'bitable') {
    if (!parsed.tableId) throw new Error('多维表格URL缺少 table 参数。');

    const recordsUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${parsed.token}/tables/${parsed.tableId}/records`;
    const recordId = matchField ? await findBitableRecord(accessToken, recordsUrl, matchField, matchValue) : null;

    // 截图字段：先上传素材换取 file_token，再组装为附件字段值
    // 匹配列只用于定位，不改写原有超链接、公式等类型的值。
    const fields = Object.fromEntries(Object.entries(recordData)
      .filter(([name, value]) => !recordId || (value != null && name !== matchField)));
    for (const [name, dataUrl] of Object.entries(screenshots)) {
      const image = splitDataUrl(dataUrl);
      if (!image) {
        warnings.push(`字段「${name}」截图数据无效，已跳过。`);
        continue;
      }
      const fileToken = await uploadBitableImage(accessToken, parsed.token, image, name);
      fields[name] = [{ file_token: fileToken }];
    }

    if (recordId && Object.keys(fields).length === 0) {
      return { record_id: recordId, warnings, operation: 'updated' };
    }
    const url = recordId ? `${recordsUrl}/${encodeURIComponent(recordId)}` : recordsUrl;
    const response = await fetch(url, {
      method: recordId ? 'PUT' : 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
    const data = await response.json();
    if (data.code === 0) {
      return { ...data.data.record, warnings, operation: recordId ? 'updated' : 'created' };
    }
    throw new Error(`Bitable API 写入失败: ${data.msg}`);
  }
  else if (parsed.type === 'sheet') {
    // 电子表格 API (Spreadsheet)
    // 1. 获取工作表信息。如果没有 sheetId，获取第一个 sheet 的 ID。
    let targetSheetId = parsed.sheetId;
    if (!targetSheetId) {
      const metaUrl = `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${parsed.token}/sheets/query`;
      const metaRes = await fetch(metaUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      const metaData = await metaRes.json();
      if (metaData.code !== 0) throw new Error(`获取电子表格信息失败: ${metaData.msg}`);

      const sheetsList = metaData.data.sheets;
      if (!sheetsList || sheetsList.length === 0) {
        throw new Error("无法读取该表格：未能获取到分表(Sheet)列表。");
      }
      targetSheetId = sheetsList[0].sheet_id;
    }

    // 2. 读取第一行作为表头映射
    if (!targetSheetId) throw new Error("无法获取SheetId");
    const getRangeUrl = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${parsed.token}/values/${targetSheetId}!A1:Z1`;
    const headerRes = await fetch(getRangeUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    const headerData = await headerRes.json();
    if (headerData.code !== 0) throw new Error(`读取表头失败: ${headerData.msg}`);

    // headerData.data.valueRange.values 是个二维数组
    const headers = (headerData.data && headerData.data.valueRange && headerData.data.valueRange.values && headerData.data.valueRange.values[0]) || [];

    if (headers.length === 0) {
      throw new Error(`电子表格必须以第1行作为表头字段名，当前第1行为空。`);
    }

    const headerText = (h) => (typeof h === 'string' ? h.trim() : (h && h[0] && h[0].text ? String(h[0].text).trim() : ''));
    const headerIndexOf = (key) => headers.findIndex(h => headerText(h) === key);
    if (matchField && headers.filter(h => headerText(h) === matchField).length !== 1) {
      throw new Error(`匹配字段「${matchField}」必须对应唯一表头，请检查列名是否重复或缺失。`);
    }

    // 在追加行之前校验全部列名，避免部分数据被静默丢弃，或留下无法补图的空行。
    const fieldNames = [...new Set([...Object.keys(recordData), ...Object.keys(screenshots || {})])];
    const unmatched = fieldNames.filter(name => headerIndexOf(name) === -1);
    if (unmatched.length > 0) {
      throw new Error(`以下字段未匹配电子表格表头：${unmatched.join('、')}。请检查列名，数据尚未写入。`);
    }
    if (fieldNames.length === 0) {
      throw new Error('没有可写入的字段，数据尚未写入。');
    }

    // 3. 构建将要插入的数组
    const rowValues = new Array(headers.length).fill("");
    for (const [key, val] of Object.entries(recordData)) {
      const index = headerIndexOf(key);
      if (index !== -1) {
        rowValues[index] = val ?? "";
      }
    }

    // 匹配模式只更新本次成功提取的单元格，不用整行空值覆盖未配置的列。
    const matchedRow = matchField ? await findSheetRow(accessToken, parsed.token, targetSheetId,
      headerIndexOf(matchField), matchValue) : null;
    let writeData;
    if (matchedRow) {
      const valueRanges = Object.entries(recordData)
        .filter(([name, value]) => value != null && name !== matchField)
        .map(([name, value]) => {
          const cell = `${columnLetter(headerIndexOf(name))}${matchedRow}`;
          return { range: `${targetSheetId}!${cell}:${cell}`, values: [[value]] };
        });
      writeData = { code: 0, data: {} };
      if (valueRanges.length > 0) {
        const response = await fetch(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${parsed.token}/values_batch_update`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueRanges })
        });
        writeData = await response.json();
      }
    } else {
      // 4. 没有匹配行时追加数据
      const appendUrl = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${parsed.token}/values_append`;
      const appendRes = await fetch(appendUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          valueRange: {
            range: `${targetSheetId}!A:Z`,
            values: [rowValues]
          }
        })
      });
      writeData = await appendRes.json();
    }
    if (writeData.code !== 0) throw new Error(`电子表格写入失败: ${writeData.msg}`);

    // 5. 截图字段：定位刚追加的行，逐个单元格写入图片
    const screenshotEntries = Object.entries(screenshots || {}).filter(([, v]) => !!v);
    if (screenshotEntries.length > 0) {
      const rowNumber = matchedRow || resolveAppendedRow(writeData.data);
      if (!rowNumber) {
        warnings.push('截图已生成，但无法解析新增行号，图片未写入表格。');
      } else {
        for (const [name, dataUrl] of screenshotEntries) {
          const index = headerIndexOf(name);
          if (index === -1) {
            warnings.push(`列「${name}」不在表头中，对应截图未写入。`);
            continue;
          }
          const image = splitDataUrl(dataUrl);
          if (!image) {
            warnings.push(`字段「${name}」截图数据无效，已跳过。`);
            continue;
          }
          const cell = `${columnLetter(index)}${rowNumber}`;
          try {
            await writeSheetImage(accessToken, parsed.token, `${targetSheetId}!${cell}:${cell}`, image, name);
          } catch (e) {
            warnings.push(`字段「${name}」写入图片失败：${e.message}`);
          }
        }
      }
    }

    return { ...writeData.data, warnings, operation: matchedRow ? 'updated' : 'created',
      rowNumber: matchedRow || resolveAppendedRow(writeData.data) };
  }
}

// API 的文本可能是字符串、数字、链接对象或富文本片段。
function comparableFieldValue(value, trim = true, emailText = false) {
  if (value == null) return null;
  let text;
  if (typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) text = String(value);
  else if (Array.isArray(value)) {
    // 多选等原始值数组不能当作富文本拼接，否则 ['foo','bar'] 会误匹配 'foobar'。
    if (value.some(part => !part || typeof part !== 'object' || Array.isArray(part))) return null;
    const parts = value.map(part => comparableFieldValue(part, false, emailText));
    if (parts.some(part => part === null)) return null;
    text = parts.join('');
  } else if (typeof value === 'object' && Object.hasOwn(value, 'value')) {
    return comparableFieldValue(value.value, trim, emailText);
  } else if (typeof value === 'object' && typeof value.link === 'string') {
    text = emailText && value.link.startsWith('mailto:') && typeof value.text === 'string' ? value.text : value.link;
  }
  else if (typeof value === 'object' && typeof value.text === 'string') text = value.text;
  else return null;
  return trim ? text.trim() : text;
}

function matchesFieldValue(value, expected) {
  if (value == null) return false;
  if (!Array.isArray(value) && typeof value === 'object' && Object.hasOwn(value, 'value')) {
    return matchesFieldValue(value.value, expected);
  }
  const actual = comparableFieldValue(value);
  if (actual === null) throw new Error('匹配字段的值类型不支持，请使用文本、数字或链接字段。');
  return actual === expected || comparableFieldValue(value, true, true) === expected;
}

async function findBitableRecord(accessToken, recordsUrl, fieldName, matchValue) {
  let recordId = null;
  let pageToken = '';
  const seen = new Set();
  do {
    const url = new URL(recordsUrl);
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const result = await response.json();
    if (result.code !== 0 || !Array.isArray(result.data?.items)) {
      throw new Error(`查找匹配记录失败：${result.msg || '响应数据无效'}`);
    }
    for (const record of result.data.items) {
      if (!matchesFieldValue(record.fields?.[fieldName], matchValue)) continue;
      if (recordId) throw new Error(`匹配字段「${fieldName}」存在多条相同值记录，请先处理重复数据。`);
      if (!record.record_id) throw new Error('匹配记录缺少记录 ID，数据尚未写入。');
      recordId = record.record_id;
    }
    if (!result.data.has_more) break;
    pageToken = result.data.page_token;
    if (!pageToken || seen.has(pageToken)) throw new Error('查找匹配记录分页异常，数据尚未写入。');
    seen.add(pageToken);
  } while (true);
  return recordId;
}

async function findSheetRow(accessToken, token, sheetId, columnIndex, matchValue) {
  if (columnIndex < 0) throw new Error('匹配字段不在电子表格表头中。');
  const headers = { Authorization: `Bearer ${accessToken}` };
  const response = await fetch(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`, { headers });
  const metadata = await response.json();
  if (metadata.code !== 0) throw new Error(`读取匹配工作表失败：${metadata.msg}`);
  const sheet = metadata.data?.sheets?.find(item => item.sheet_id === sheetId);
  const rowCount = sheet?.grid_properties?.row_count;
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new Error('无法读取匹配工作表行数，数据尚未写入。');
  const column = columnLetter(columnIndex);
  let matchedRow = null;
  for (let start = 2; start <= rowCount; start += 5000) {
    const range = `${sheetId}!${column}${start}:${column}${Math.min(start + 4999, rowCount)}`;
    const result = await (await fetch(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${token}/values/${range}?valueRenderOption=UnformattedValue`, { headers })).json();
    if (result.code !== 0 || !result.data?.valueRange) throw new Error(`读取匹配列失败：${result.msg || '响应数据无效'}`);
    const rows = result.data.valueRange.values || [];
    if (!Array.isArray(rows)) throw new Error('读取匹配列失败：响应数据无效。');
    rows.forEach((row, index) => {
      if (!matchesFieldValue(row?.[0], matchValue)) return;
      if (matchedRow) throw new Error('匹配字段存在多行相同值，请先处理重复数据。');
      matchedRow = start + index;
    });
  }
  return matchedRow;
}

if (typeof self !== 'undefined') {
  self.parseFeishuUrl = parseFeishuUrl;
  self.getTenantAccessToken = getTenantAccessToken;
  self.appendToFeishu = appendToFeishu;
}
