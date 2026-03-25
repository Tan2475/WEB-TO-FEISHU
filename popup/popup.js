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
  const targetDbUrlEl = document.getElementById('targetDbUrl');
  
  const resultIcon = document.getElementById('resultIcon');
  const resultMsg = document.getElementById('resultMsg');
  const closeBtn = document.getElementById('closeBtn');

  let currentRule = null;
  let extractedData = null;

  // 1. Check current URL and find matching rule
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    showError("无法获取当前页面URL");
    return;
  }

  const { SCRAPING_RULES } = await getStorageData([StorageKeys.SCRAPING_RULES]);
  const rules = SCRAPING_RULES || [];
  
  // Find all matched rules
  const matchedRules = rules.filter(r => r.url && tab.url.includes(r.url));

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
        ruleMetaInfo.textContent = `包含 ${r.fields.length} 个字段配置`;
        ruleMetaInfo.classList.remove('hidden');
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
    const targetDbUrlEl = document.getElementById('targetDbUrl');
    if (targetDbUrlEl) targetDbUrlEl.value = dbData[StorageKeys.FEISHU_DB_URL];
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
    chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_DATA', rule: currentRule }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script might not be injected
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        }, () => {
          if (chrome.runtime.lastError) {
            showError("无法注入脚本去刷新页面重试：" + chrome.runtime.lastError.message);
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

  function handleExtractResponse(response) {
    if (!response || response.error) {
      showError(response ? response.error : "提取失败：未知错误");
      return;
    }
    extractedData = response.data;
    renderPreview(extractedData);
    showView(previewView);
  }

  function renderPreview(data) {
    previewDataContainer.innerHTML = '';
    const table = document.createElement('table');
    table.className = "w-full text-left border-collapse";
    
    for (const [key, value] of Object.entries(data)) {
      const tr = document.createElement('tr');
      tr.className = "border-b border-gray-100 last:border-0";
      
      const tdKey = document.createElement('td');
      tdKey.className = "py-2 pr-2 font-medium text-gray-600 w-1/3 truncate";
      tdKey.textContent = key;
      tdKey.title = key;
      
      const tdVal = document.createElement('td');
      tdVal.className = "py-2 break-all text-gray-900";
      
      if (value === null || value === undefined) {
        tdVal.innerHTML = `<span class="text-gray-400 italic">未找到</span>`;
      } else {
        // Trim length for display if too long
        const displayVal = value.length > 100 ? value.substring(0, 100) + '...' : value;
        tdVal.textContent = displayVal;
      }
      
      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      table.appendChild(tr);
    }
    previewDataContainer.appendChild(table);
  }

  // 3. Confirm Push
  confirmPushBtn.addEventListener('click', async () => {
    const dbUrl = targetDbUrlEl.value.trim();
    showView(loadingView);
    chrome.runtime.sendMessage({ action: 'PUSH_TO_FEISHU', recordData: extractedData, dbUrl: dbUrl }, (response) => {
      if (!response || !response.success) {
        showError("写入飞书失败：" + (response ? response.error : '未知错误'));
      } else {
        showSuccess("成功写入飞书！");
      }
    });
  });

  // View toggles
  cancelBtn.addEventListener('click', () => {
    showView(initView);
  });

  closeBtn.addEventListener('click', () => {
    window.close();
  });

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
});
