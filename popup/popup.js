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
  let shotWarnings = [];

  const isImageDataUrl = (value) => typeof value === 'string' && value.startsWith('data:image/');

  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // 1. Check current URL and find matching rule
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    showError("无法获取当前页面URL");
    return;
  }

  const { SCRAPING_RULES, TEMP_REGION_OVERRIDES } = await getStorageData([
    StorageKeys.SCRAPING_RULES,
    StorageKeys.TEMP_REGION_OVERRIDES
  ]);
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
    ruleSelector.disabled = false;
    extractBtn.classList.remove('pointer-events-none', 'opacity-50');

    // Show meta logic
    const updateMeta = () => {
      const r = matchedRules[ruleSelector.value];
      if (r) {
        const shotCount = (r.fields || []).filter(f => f.type === 'screenshot').length;
        ruleMetaInfo.textContent = shotCount > 0
          ? `包含 ${r.fields.length} 个字段配置（其中 ${shotCount} 个区域截图）`
          : `包含 ${r.fields.length} 个字段配置`;
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
  const dbData = await getStorageData([StorageKeys.FEISHU_DB_URL]);
  if (dbData[StorageKeys.FEISHU_DB_URL]) {
    if (targetDbUrlEl) targetDbUrlEl.value = dbData[StorageKeys.FEISHU_DB_URL];
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
        ? `${Math.round(field.region.width)}×${Math.round(field.region.height)}`
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
    await setStorageData({ [StorageKeys.TEMP_REGION_OVERRIDES]: next });
    location.reload();
  });

  async function repickRegion(rule, field) {
    shotHint.textContent = '已进入框选模式，请在网页上拖拽选择区域；框选完成后重新打开本窗口继续。';
    shotHint.classList.remove('hidden');

    const message = {
      action: 'START_REGION_PICK',
      payload: { ruleKey: ruleKeyOf(rule), fieldName: field.name }
    };

    let response = await sendTabMessage(tab.id, message);
    if (response && response.error) {
      // 内容脚本尚未注入时按需注入并重试
      await new Promise((resolve) => {
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content/content.js'] },
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
    if (selectedIdx === '' || !matchedRules[selectedIdx]) return;

    const dbUrl = targetDbUrlEl.value.trim();
    if (!dbUrl) {
      alert("请先填写目标飞书表格链接！");
      return;
    }
    await setStorageData({ [StorageKeys.FEISHU_DB_URL]: dbUrl });

    currentRule = matchedRules[selectedIdx];
    showView(loadingView);
    setLoadingText('正在抓取页面数据...');

    chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_DATA', rule: currentRule }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script might not be injected
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        }, () => {
          if (chrome.runtime.lastError) {
            showError("无法注入脚本：请刷新页面后重试。" + chrome.runtime.lastError.message);
            return;
          }
          // Retry
          let didRespond = false;
          chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_DATA', rule: currentRule }, (res) => {
            if (chrome.runtime.lastError) console.warn("Retry error:", chrome.runtime.lastError);
            didRespond = true;
            handleExtractResponse(res);
          });

          // Fallback timeout in case port crashes completely due to orphaned scripts
          setTimeout(() => {
            if (!didRespond) {
              showError("等待解析数据超时。可能是拓展更新后上下文断开，请【刷新当前网页】后再试！");
            }
          }, currentRule.preSelector ? 2500 : 1500);
        });
      } else {
        handleExtractResponse(response);
      }
    });
  });

  async function handleExtractResponse(response) {
    if (!response || response.error) {
      showError(response ? response.error : "提取失败：未知错误");
      return;
    }
    extractedData = response.data || {};
    shotWarnings = [];

    // 截图字段需要先滚动定位再逐张捕获，与文本字段分开处理
    try {
      await captureScreenshotFields(tab.id, currentRule);
    } catch (e) {
      console.error('[Scraper] 截图流程异常:', e);
      shotWarnings.push(`截图流程异常：${e.message || e}`);
    }

    renderPreview(extractedData);
    renderShotWarning();
    showView(previewView);
  }

  async function captureScreenshotFields(tabId, rule) {
    const shotFields = (rule.fields || []).filter(f => f.type === 'screenshot');
    if (shotFields.length === 0) return;

    const ready = [];
    for (const field of shotFields) {
      if (field.region && field.region.width && field.region.height) {
        ready.push(field);
      } else {
        shotWarnings.push(`「${field.name}」未配置截图区域，已跳过`);
      }
    }

    for (let i = 0; i < ready.length; i++) {
      const field = ready[i];
      setLoadingText(`正在截取区域 ${i + 1}/${ready.length}：${field.name}`);

      const prepared = await sendTabMessage(tabId, { action: 'PREPARE_REGION', region: field.region });
      if (!prepared || prepared.error) {
        shotWarnings.push(`「${field.name}」${prepared ? prepared.error : '定位区域失败'}`);
        continue;
      }
      if (prepared.warning) {
        shotWarnings.push(`「${field.name}」${prepared.warning}`);
      }

      const shot = await sendRuntimeMessage({ action: 'CAPTURE_REGION', tabId, rect: prepared.rect });
      if (shot && shot.success && shot.dataUrl) {
        extractedData[field.name] = shot.dataUrl;
      } else {
        shotWarnings.push(`「${field.name}」截图失败：${shot ? (shot.error || '未知错误') : '无响应'}`);
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
    if (shotWarnings.length === 0) {
      shotWarning.classList.add('hidden');
      shotWarning.textContent = '';
      return;
    }
    shotWarning.classList.remove('hidden');
    shotWarning.textContent = shotWarnings.join('；');
  }

  // 3. Confirm Push
  confirmPushBtn.addEventListener('click', async () => {
    const dbUrl = targetDbUrlEl.value.trim();
    showView(loadingView);
    setLoadingText('正在写入飞书...');

    // 文本字段与截图字段分开传递，后端按表类型走不同的图片写入通道
    const recordData = {};
    const screenshots = {};
    for (const [key, value] of Object.entries(extractedData || {})) {
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
      dbUrl
    });

    if (!response || !response.success) {
      showError("写入飞书失败：" + (response ? response.error : '未知错误'));
      return;
    }

    const warnings = (response.result && response.result.warnings) || [];
    const imageCount = Object.keys(screenshots).length;
    let msg = imageCount > 0 ? `成功写入飞书（含 ${imageCount} 张截图）！` : '成功写入飞书！';
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
