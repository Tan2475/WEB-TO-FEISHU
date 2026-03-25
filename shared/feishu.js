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
  } catch(e) {
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

/**
 * Appends a record to Bitable or Spreadsheet based on the URL.
 */
async function appendToFeishu(appId, appSecret, feishuUrl, recordData) {
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
    // Bitable API
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${parsed.token}/tables/${parsed.tableId}/records`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields: recordData })
    });
    const data = await response.json();
    if (data.code === 0) return data.data.record;
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

    // 3. 构建将要插入的数组
    const rowValues = new Array(headers.length).fill("");
    for (const [key, val] of Object.entries(recordData)) {
      // Find index in headers
      // Note: Spreadsheets sometimes return complex objects or strings. Usually strings.
      const index = headers.findIndex(h => typeof h === 'string' ? (h.trim() === key) : (h && h[0] && h[0].text === key));
      if (index !== -1) {
        rowValues[index] = val || "";
      }
    }

    // 4. 追加行数据
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
    const appendData = await appendRes.json();
    if (appendData.code === 0) return appendData.data;
    throw new Error(`电子表格写入失败: ${appendData.msg}`);
  }
}

if (typeof self !== 'undefined') {
  self.parseFeishuUrl = parseFeishuUrl;
  self.getTenantAccessToken = getTenantAccessToken;
  self.appendToFeishu = appendToFeishu;
}
