// popup.js

document.addEventListener('DOMContentLoaded', async () => {
  const initView = document.getElementById('initView');
  const previewView = document.getElementById('previewView');
  const loadingView = document.getElementById('loadingView');
  const resultView = document.getElementById('resultView');

  const ruleSelector = document.getElementById('ruleSelector');
  const ruleMetaInfo = document.getElementById('ruleMetaInfo');
  const extractBtn = document.getElementById('extractBtn');
  const openOptionsBtn = document.getElementById('openOptionsBtn');

  const cancelBtn = document.getElementById('cancelBtn');
  const confirmPushBtn = document.getElementById('confirmPushBtn');
  const previewDataContainer = document.getElementById('previewDataContainer');
  const shotWarning = document.getElementById('shotWarning');
  const targetDbUrlEl = document.getElementById('targetDbUrl');

  const shotPanel = document.getElementById('shotPanel');
  const shotFieldList = document.getElementById('shotFieldList');
  const shotHint = document.getElementById('shotHint');
  const clearOverridesBtn = document.getElementById('clearOverridesBtn');

  const resultIcon = document.getElementById('resultIcon');
  const resultMsg = document.getElementById('resultMsg');
  const closeBtn = document.getElementById('closeBtn');
  const loadingText = loadingView.querySelector('p');

  let currentRule = null;
  let extractedData = null;
  let previewWarnings = [];

  const isImageDataUrl = (value) => typeof value === 'string' && value.startsWith('data:image/');

  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: '等待页面响应超时，请刷新网页后重试。' }),
        message.action === 'PREPARE_REGION' ? 45000 : 15000);
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message, transportError: true });
        } else {
          resolve(response);
        }
      });
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else if (!response || typeof response.success !== 'boolean') {
            resolve({
              success: false,
              error: message.action === 'PUSH_TO_FEISHU'
                ? '未收到后台写入结果，请先检查目标表格是否已写入，再重新加载扩展。'
                : '未收到后台截图结果，请重新加载扩展后重试。'
            });
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        resolve({ success: false, error: e.message || '扩展连接已断开，请重新加载扩展。' });
      }
    });
  }

  // 1. Check current URL and find matching rule
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    showError("无法获取当前页面URL");
    return;
  }

  let settings;
  try {
    settings = await getStorageData([
      StorageKeys.SCRAPING_RULES,
      StorageKeys.TEMP_REGION_OVERRIDES,
      StorageKeys.FEISHU_DB_URL
    ]);
  } catch (e) {
    showError('读取配置失败：' + e.message);
    return;
  }
  const { SCRAPING_RULES, TEMP_REGION_OVERRIDES } = settings;
  const rules = SCRAPING_RULES || [];
  const regionOverrides = TEMP_REGION_OVERRIDES || {};

  const ruleKeyOf = (rule) => `${rule.name || ''}|${rule.url || ''}`;

  // 把弹窗内「重新框选」产生的临时区域覆盖到规则副本上，不改动已保存的规则
  const applyRegionOverrides = (rule) => {
    const bucket = regionOverrides[ruleKeyOf(rule)] || {};
    if (!rule.fields || Object.keys(bucket).length === 0) return rule;
    const fields = rule.fields.map((f) =>
      f.type === 'screenshot' && bucket[f.name] ? { ...f, region: bucket[f.name], __overridden: true } : f
    );
    return { ...rule, fields };
  };

  // Find all matched rules
  const matchedRules = rules
    .filter(r => r.url && tab.url.includes(r.url))
    .map(applyRegionOverrides);

  // Populate select
  ruleSelector.innerHTML = '';
  if (matchedRules.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `❌ 未匹配 (当前: ${new URL(tab.url).hostname})`;
    ruleSelector.appendChild(opt);
    ruleSelector.disabled = true;
  } else {
    matchedRules.forEach((r, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = r.name ? `${r.name}` : `规则 ${idx + 1} (${r.url})`;
      ruleSelector.appendChild(opt);
    });
    if (matchedRules.length > 1) {
      const option = document.createElement('option');
      option.value = '__all__';
      option.textContent = `全部匹配规则（${matchedRules.length}）`;
      ruleSelector.appendChild(option);
    }
    ruleSelector.disabled = false;
    extractBtn.classList.remove('pointer-events-none', 'opacity-50');

    // Show meta logic
    const updateMeta = () => {
      if (ruleSelector.value === '__all__') {
        ruleMetaInfo.textContent = `依次执行 ${matchedRules.length} 条规则，合并后统一写入`;
        ruleMetaInfo.classList.remove('hidden');
        shotPanel.classList.add('hidden');
        return;
      }
      const r = matchedRules[ruleSelector.value];
      if (r) {
        const shotCount = (r.fields || []).filter(f => f.type === 'screenshot').length;
        ruleMetaInfo.textContent = shotCount > 0
          ? `包含 ${r.fields.length} 个字段配置（其中 ${shotCount} 个区域截图）`
          : `包含 ${r.fields.length} 个字段配置`;
        if (r.matchField) ruleMetaInfo.textContent += ` · 按「${r.matchField}」匹配更新`;
        ruleMetaInfo.classList.remove('hidden');
        renderShotPanel(r);
      }
    };
    ruleSelector.addEventListener('change', updateMeta);
    updateMeta();
  }

  // Handle Options opening
  openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Load last used DB URL if available to save time
  if (settings[StorageKeys.FEISHU_DB_URL]) {
    if (targetDbUrlEl) targetDbUrlEl.value = settings[StorageKeys.FEISHU_DB_URL];
  }

  // 截图字段面板：展示当前区域尺寸，并提供本次临时重选入口
  function renderShotPanel(rule) {
    const shotFields = (rule.fields || []).filter(f => f.type === 'screenshot');
    if (shotFields.length === 0) {
      shotPanel.classList.add('hidden');
      return;
    }
    shotPanel.classList.remove('hidden');
    shotFieldList.innerHTML = '';

    shotFields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 text-xs';

      const nameEl = document.createElement('div');
      nameEl.className = 'min-w-0 flex-1 truncate text-gray-600';
      nameEl.textContent = field.name;
      nameEl.title = field.name;

      const metaEl = document.createElement('span');
      const size = field.region
        ? field.region.mode === 'module' ? `${field.region.modules.length} 个模块` : `${Math.round(field.region.width)}×${Math.round(field.region.height)}`
        : '未框选';
      metaEl.className = 'shrink-0 text-[10px] ' + (field.__overridden ? 'text-blue-600 font-medium' : 'text-gray-400');
      metaEl.textContent = field.__overridden ? `${size} · 本次重选` : size;

      const btn = document.createElement('button');
      btn.className = 'shrink-0 text-[10px] text-purple-600 border border-purple-200 hover:bg-purple-50 rounded px-2 py-1 transition';
      btn.textContent = '重选';
      btn.title = '在网页上重新框选该字段的截图区域（仅本次生效，不改动已保存的规则）';
      btn.addEventListener('click', () => repickRegion(rule, field));

      row.append(nameEl, metaEl, btn);
      shotFieldList.appendChild(row);
    });

    clearOverridesBtn.classList.toggle('hidden', !shotFields.some(f => f.__overridden));
  }

  clearOverridesBtn.addEventListener('click', async () => {
    const key = ruleKeyOf(matchedRules[ruleSelector.value] || {});
    const next = { ...regionOverrides };
    delete next[key];
    try {
      await setStorageData({ [StorageKeys.TEMP_REGION_OVERRIDES]: next });
    } catch (e) {
      showError('保存失败：' + e.message);
      return;
    }
    location.reload();
  });

  async function repickRegion(rule, field) {
    const moduleMode = field.region?.mode === 'module';
    shotHint.textContent = moduleMode ? '请在网页选择模块，完成后重新打开此窗口。' : '请在网页拖拽框选，完成后重新打开此窗口。';
    shotHint.classList.remove('hidden');

    const message = {
      action: moduleMode ? 'START_MODULE_PICK' : 'START_REGION_PICK',
      payload: { ruleKey: ruleKeyOf(rule), fieldName: field.name }
    };

    let response = await sendTabMessage(tab.id, message);
    if (response && response.error) {
      // 内容脚本尚未注入时按需注入并重试
      await new Promise((resolve) => {
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content/module-capture.js', 'content/content.js'] },
          () => resolve()
        );
      });
      response = await sendTabMessage(tab.id, message);
    }

    if (response && response.error) {
      shotHint.className = 'text-[10px] text-red-500 leading-relaxed';
      shotHint.textContent = '无法启动框选：' + response.error;
      shotHint.classList.remove('hidden');
    } else {
      shotHint.className = 'text-[10px] text-amber-600 leading-relaxed';
    }
  }

  // 2. Click Extract -> Message Content Script -> Show Preview
  extractBtn.addEventListener('click', async () => {
    const selectedIdx = ruleSelector.value;
    if (selectedIdx !== '__all__' && (selectedIdx === '' || !matchedRules[selectedIdx])) return;

    const dbUrl = targetDbUrlEl.value.trim();
    if (!dbUrl) {
      alert("请先填写目标飞书表格链接！");
      return;
    }
    try {
      await setStorageData({ [StorageKeys.FEISHU_DB_URL]: dbUrl });
    } catch (e) {
      showError('保存失败：' + e.message);
      return;
    }

    currentRule = matchedRules[selectedIdx];
    showView(loadingView);
    setLoadingText('正在抓取页面数据...');

    try {
      const rulesToRun = selectedIdx === '__all__' ? matchedRules : [currentRule];
      const merged = await executeRuleBatch(rulesToRun, async (rule, index) => {
        currentRule = rule;
        setLoadingText(`正在抓取 ${index + 1}/${rulesToRun.length}：${rule.name || '规则'}`);
        let response = await sendTabMessage(tab.id, { action: 'EXTRACT_DATA', rule });
        if (response?.transportError) {
          await new Promise((resolve, reject) => {
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/module-capture.js', 'content/content.js'] }, () => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve();
            });
          });
          response = await sendTabMessage(tab.id, { action: 'EXTRACT_DATA', rule });
        }
        return await handleExtractResponse(response, rule);
      });
      currentRule = { matchField: merged.matchField };
      extractedData = merged.data;
      previewWarnings = merged.warnings;
      renderPreview(extractedData);
      renderShotWarning();
      showView(previewView);
    } catch (e) {
      extractedData = null;
      showError('抓取失败：' + e.message);
    }
  });

  async function handleExtractResponse(response, rule) {
    if (!response || response.error) {
      throw new Error(response?.error || '未收到页面提取结果，请刷新网页后重试。');
    }
    extractedData = response.data || {};
    previewWarnings = [];

    // 文本字段没命中元素时明确说出来，否则用户只看到「未找到」无从排查
    if (Array.isArray(response.missing) && response.missing.length > 0) {
      previewWarnings.push(
        `未找到，已跳过：${response.missing.join('、')}`
      );
    }

    // 截图字段需要先滚动定位再逐张捕获，与文本字段分开处理
    try {
      await captureScreenshotFields(tab.id, rule);
    } catch (e) {
      console.error('[Scraper] 截图流程异常:', e);
      previewWarnings.push(`截图流程异常：${e.message || e}`);
    }

    return { data: extractedData, warnings: [...previewWarnings] };
  }

  async function captureScreenshotFields(tabId, rule) {
    const shotFields = (rule.fields || []).filter(f => f.type === 'screenshot');
    if (shotFields.length === 0) return;

    const ready = [];
    for (const field of shotFields) {
      if (field.region && field.region.width && field.region.height) {
        ready.push(field);
      } else {
        previewWarnings.push(`「${field.name}」未配置截图区域，已跳过`);
      }
    }

    for (let i = 0; i < ready.length; i++) {
      const field = ready[i];
      setLoadingText(`正在截取区域 ${i + 1}/${ready.length}：${field.name}`);

      const prepared = await sendTabMessage(tabId, { action: 'PREPARE_REGION', region: field.region });
      if (!prepared || prepared.error) {
        previewWarnings.push(`「${field.name}」${prepared ? prepared.error : '定位区域失败'}`);
        continue;
      }
      if (prepared.warning) {
        previewWarnings.push(`「${field.name}」${prepared.warning}`);
      }

      const shot = await sendRuntimeMessage({ action: 'CAPTURE_REGION', tabId, rect: prepared.rect });
      if (shot && shot.success && shot.dataUrl) {
        extractedData[field.name] = shot.dataUrl;
      } else {
        previewWarnings.push(`「${field.name}」截图失败：${shot ? (shot.error || '未知错误') : '无响应'}`);
      }
    }
  }

  function renderPreview(data) {
    previewDataContainer.innerHTML = '';
    const table = document.createElement('table');
    table.className = "w-full text-left border-collapse";

    for (const [key, value] of Object.entries(data)) {
      const tr = document.createElement('tr');
      tr.className = "border-b border-gray-100 last:border-0";

      const tdKey = document.createElement('td');
      tdKey.className = "py-2 pr-2 font-medium text-gray-600 w-1/3 truncate align-top";
      tdKey.textContent = key;
      tdKey.title = key;

      const tdVal = document.createElement('td');
      tdVal.className = "py-2 break-all text-gray-900";

      if (value === null || value === undefined) {
        tdVal.innerHTML = `<span class="text-gray-400 italic">未找到</span>`;
      } else if (isImageDataUrl(value)) {
        const img = document.createElement('img');
        img.src = value;
        img.className = 'max-w-full rounded border border-gray-200 block';
        img.alt = key;
        tdVal.appendChild(img);
        const meta = document.createElement('div');
        meta.className = 'text-[10px] text-gray-400 mt-1';
        meta.textContent = '区域截图';
        tdVal.appendChild(meta);
      } else {
        // Trim length for display if too long
        const text = String(value);
        tdVal.textContent = text.length > 100 ? text.substring(0, 100) + '...' : text;
      }

      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      table.appendChild(tr);
    }
    previewDataContainer.appendChild(table);
  }

  function renderShotWarning() {
    if (previewWarnings.length === 0) {
      shotWarning.classList.add('hidden');
      shotWarning.textContent = '';
      return;
    }
    shotWarning.classList.remove('hidden');
    shotWarning.textContent = previewWarnings.join('；');
  }

  // 3. Confirm Push
  confirmPushBtn.addEventListener('click', async () => {
    if (extractedData && !Object.values(extractedData).some(value => value != null)) {
      showError('未抓取到可写入的数据。');
      return;
    }
    const dbUrl = targetDbUrlEl.value.trim();
    showView(loadingView);
    setLoadingText('正在写入飞书...');

    // 文本字段与截图字段分开传递，后端按表类型走不同的图片写入通道
    const recordData = {};
    const screenshots = {};
    for (const [key, value] of Object.entries(extractedData || {})) {
      if (value == null) continue;
      if (isImageDataUrl(value)) {
        screenshots[key] = value;
      } else {
        recordData[key] = value;
      }
    }

    const response = await sendRuntimeMessage({
      action: 'PUSH_TO_FEISHU',
      recordData,
      screenshots,
      matchField: currentRule?.matchField || '',
      dbUrl
    });

    if (!response || !response.success) {
      showError("写入飞书失败：" + (response?.error || '后台未返回错误详情，请先检查目标表格是否已写入。'));
      return;
    }

    const warnings = (response.result && response.result.warnings) || [];
    const imageCount = Object.keys(screenshots).length;
    const operation = response.result?.operation === 'updated' ? '已更新匹配行' : '已新增一行';
    let msg = imageCount > 0 ? `${operation}（含 ${imageCount} 张截图）` : operation;
    if (warnings.length > 0) {
      msg += ' 但：' + warnings.join('；');
    }
    warnings.length > 0 ? showWarn(msg) : showSuccess(msg);
  });

  // View toggles
  cancelBtn.addEventListener('click', () => {
    showView(initView);
  });

  closeBtn.addEventListener('click', () => {
    window.close();
  });

  function setLoadingText(text) {
    if (loadingText) loadingText.textContent = text || '正在处理中...';
  }

  function showView(viewEl) {
    [initView, previewView, loadingView, resultView].forEach(v => v.classList.add('hidden'));
    viewEl.classList.remove('hidden');
  }

  function showError(msg) {
    showView(resultView);
    resultIcon.innerHTML = `<div class="w-12 h-12 mx-auto bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-3"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></div>`;
    resultMsg.className = "text-sm text-red-600 font-medium px-4 break-words";
    resultMsg.textContent = msg;
  }

  function showSuccess(msg) {
    showView(resultView);
    resultIcon.innerHTML = `<div class="w-12 h-12 mx-auto bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-3"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></div>`;
    resultMsg.className = "text-sm text-green-600 font-medium px-4";
    resultMsg.textContent = msg;
  }

  function showWarn(msg) {
    showView(resultView);
    resultIcon.innerHTML = `<div class="w-12 h-12 mx-auto bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-3"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path></svg></div>`;
    resultMsg.className = "text-sm text-amber-600 font-medium px-4 break-words";
    resultMsg.textContent = msg;
  }
});
