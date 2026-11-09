// options.js

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const appIdEl = document.getElementById('feishuAppId');
  const appSecretEl = document.getElementById('feishuAppSecret');
  const saveGlobalBtn = document.getElementById('saveGlobalBtn');
  const addRuleBtn = document.getElementById('addRuleBtn');
  const rulesContainer = document.getElementById('rulesContainer');
  const ruleTemplate = document.getElementById('ruleTemplate');
  const fieldTemplate = document.getElementById('fieldTemplate');
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  let toastTimer;

  // 导入导出相关元素
  const exportConfigBtn = document.getElementById('exportConfigBtn');
  const importConfigBtn = document.getElementById('importConfigBtn');
  const exportModal = document.getElementById('exportModal');
  const importModal = document.getElementById('importModal');
  const importFileInput = document.getElementById('importFileInput');
  const includeCredentialsEl = document.getElementById('includeCredentials');
  const exportCredentialRow = document.getElementById('exportCredentialRow');
  const exportCredentialDesc = document.getElementById('exportCredentialDesc');
  const exportSummaryEl = document.getElementById('exportSummary');
  const exportFilenameHintEl = document.getElementById('exportFilenameHint');
  const importMetaEl = document.getElementById('importMeta');
  const importWarningsEl = document.getElementById('importWarnings');
  const confirmExportBtn = document.getElementById('confirmExportBtn');
  const confirmAppendBtn = document.getElementById('confirmAppendBtn');
  const confirmReplaceBtn = document.getElementById('confirmReplaceBtn');

  let pendingImport = null; // 已校验通过、等待用户选择合并策略的导入结果

  let activePickerInput = null; // 正在等待元素拾取结果的选择器输入框
  let activeRegionTarget = null; // 正在等待区域框选结果的字段上下文
  let incompleteScreenshotCount = 0; // 本次保存中被丢弃的未框选截图字段数

  // Load existing data
  let data;
  try {
    data = await getStorageData([
      StorageKeys.FEISHU_APP_ID,
      StorageKeys.FEISHU_APP_SECRET,
      StorageKeys.FEISHU_DB_URL,
      StorageKeys.SCRAPING_RULES
    ]);
  } catch (e) {
    showToast('读取配置失败：' + e.message, true);
    return;
  }

  if (data[StorageKeys.FEISHU_APP_ID]) appIdEl.value = data[StorageKeys.FEISHU_APP_ID];
  if (data[StorageKeys.FEISHU_APP_SECRET]) appSecretEl.value = data[StorageKeys.FEISHU_APP_SECRET];

  const rules = data[StorageKeys.SCRAPING_RULES] || [];
  renderRules(rules);

  // Handle Save
  saveGlobalBtn.addEventListener('click', async () => {
    incompleteScreenshotCount = 0;
    const rulesToSave = collectRulesFromUI();
    const matchError = rulesToSave.map(validateRuleMatchField).find(Boolean);
    if (matchError) {
      showToast(matchError, true);
      return;
    }

    try {
      await setStorageData({
        [StorageKeys.FEISHU_APP_ID]: appIdEl.value.trim(),
        [StorageKeys.FEISHU_APP_SECRET]: appSecretEl.value.trim(),
        [StorageKeys.SCRAPING_RULES]: rulesToSave,
        // 规则一旦重新保存，弹窗侧的临时区域覆盖即失效，避免与最新配置冲突
        [StorageKeys.TEMP_REGION_OVERRIDES]: {}
      });
    } catch (e) {
      showToast('保存失败：' + e.message, true);
      return;
    }

    if (incompleteScreenshotCount > 0) {
      showToast(`已保存，但有 ${incompleteScreenshotCount} 个截图字段未框选区域，暂不会执行`);
    } else {
      showToast('配置与规则已成功保存！');
    }
  });

  // Handle Add Rule
  addRuleBtn.addEventListener('click', () => {
    addRuleToUI({});
  });

  // ==== 规则容器渲染 ====
  function renderRules(ruleList) {
    rulesContainer.textContent = '';
    const list = Array.isArray(ruleList) ? ruleList : [];
    if (list.length === 0) {
      // 无规则时留一个空块，避免页面空白无从下手
      addRuleToUI({});
      return;
    }
    list.forEach(r => addRuleToUI(r));
  }

  // ==== 从当前表单收集规则（导出与保存共用） ====
  function collectRulesFromUI() {
    const collected = [];
    document.querySelectorAll('.rule-block').forEach(ruleBlock => {
      const data = getRuleDataFromElement(ruleBlock);
      if (data.url || data.fields.length > 0) {
        collected.push({
          name: data.name || '未命名规则',
          url: data.url,
          tabSelector: data.tabSelector,
          preSelector: data.preSelector,
          preType: data.preType,
          matchField: data.matchField,
          fields: data.fields
        });
      }
    });
    return collected;
  }

  function getRuleDataFromElement(ruleBlock) {
    const name = ruleBlock.querySelector('.rule-name').value.trim();
    const url = ruleBlock.querySelector('.rule-url').value.trim();
    const tabSelector = ruleBlock.querySelector('.rule-tab-selector').value.trim();
    const preSelector = ruleBlock.querySelector('.rule-pre-selector').value.trim();
    const preType = ruleBlock.querySelector('.rule-pre-type').value;
    const matchField = ruleBlock.querySelector('.rule-match-field').value.trim();

    const fields = [];
    ruleBlock.querySelectorAll('.field-item').forEach(fieldItem => {
      const fieldName = fieldItem.querySelector('.field-name').value.trim();
      const type = fieldItem.querySelector('.field-type').value;
      const selector = fieldItem.querySelector('.field-selector').value.trim();
      const regionInput = fieldItem.querySelector('.field-region');

      if (type === 'screenshot' || type === 'module_screenshot') {
        const region = parseRegionValue(regionInput ? regionInput.value : '');
        if (fieldName && region && (region.mode === 'module') === (type === 'module_screenshot')) {
          // 截图字段不使用 CSS 选择器，区域配置单独保存
          fields.push({ name: fieldName, selector: '', type: 'screenshot', region });
        } else if (fieldName) {
          incompleteScreenshotCount++;
        }
        return;
      }

      if (fieldName && (selector || type === 'current_url')) {
        fields.push({ name: fieldName, selector, type });
      }
    });
    return { name, url, tabSelector, preSelector, preType, matchField, fields };
  }

  function parseRegionValue(raw) {
    if (!raw) return null;
    try {
      const region = JSON.parse(raw);
      if (!region || !region.width || !region.height) return null;
      return region;
    } catch (e) {
      return null;
    }
  }

  function describeRegion(region) {
    if (!region) return '';
    if (region.mode === 'module') return region.modules.map(m => m.title).join(' + ');
    return `已框选 ${Math.round(region.width)} × ${Math.round(region.height)}`;
  }

  function addRuleToUI(ruleData) {
    const clone = ruleTemplate.content.cloneNode(true);
    const ruleBlock = clone.querySelector('.rule-block');
    const nameInput = clone.querySelector('.rule-name');
    const urlInput = clone.querySelector('.rule-url');
    const tabSelectorInput = clone.querySelector('.rule-tab-selector');
    const preSelectorInput = clone.querySelector('.rule-pre-selector');
    const preTypeSelect = clone.querySelector('.rule-pre-type');
    const matchFieldInput = clone.querySelector('.rule-match-field');
    const addFieldBtn = clone.querySelector('.add-field-btn');
    const fieldsContainer = clone.querySelector('.fields-container');
    const delRuleBtn = clone.querySelector('.delete-rule-btn');
    const pickPreBtn = clone.querySelector('.pick-pre-btn');
    const pickTabBtn = clone.querySelector('.pick-tab-btn');

    // New header and control elements
    const headerTitle = clone.querySelector('.rule-header-title');
    const ruleHeader = clone.querySelector('.rule-header');
    const ruleContent = clone.querySelector('.rule-content');
    const toggleIcon = clone.querySelector('.toggle-icon');
    const copyRuleBtn = clone.querySelector('.copy-rule-btn');

    pickPreBtn.addEventListener('click', () => {
      startPicking(preSelectorInput, urlInput.value.trim());
    });
    pickTabBtn.addEventListener('click', () => {
      startPicking(tabSelectorInput, urlInput.value.trim());
    });
    tabSelectorInput.value = ruleData.tabSelector || '';

    if (ruleData.name) {
      nameInput.value = ruleData.name;
    }
    if (ruleData.url) {
      urlInput.value = ruleData.url;
    }
    if (ruleData.preSelector) {
      preSelectorInput.value = ruleData.preSelector;
    }
    if (ruleData.preType) {
      preTypeSelect.value = ruleData.preType;
    }
    matchFieldInput.value = ruleData.matchField || '';

    if (ruleData.fields && ruleData.fields.length > 0) {
      ruleData.fields.forEach(f => addFieldToRuleUI(fieldsContainer, f));
    } else {
      addFieldToRuleUI(fieldsContainer, {});
    }

    // Dynamic Header Title
    function updateHeader() {
      const n = nameInput.value.trim() || '新规则';
      const u = urlInput.value.trim();
      headerTitle.textContent = u ? `${n} (${u})` : n;
    }
    nameInput.addEventListener('input', updateHeader);
    urlInput.addEventListener('input', updateHeader);
    updateHeader(); // Initial call

    // Collapse/Expand functionality
    ruleHeader.addEventListener('click', () => {
      ruleContent.classList.toggle('hidden');
      if (ruleContent.classList.contains('hidden')) {
        toggleIcon.classList.remove('rotate-180');
      } else {
        toggleIcon.classList.add('rotate-180');
      }
    });

    // Copy functionality
    copyRuleBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent header toggle
      const currentData = getRuleDataFromElement(ruleBlock);
      currentData.name = currentData.name ? currentData.name + ' (副本)' : '新规则 (副本)';
      addRuleToUI(currentData);
      showToast('已复制规则：' + currentData.name);
    });

    addFieldBtn.addEventListener('click', () => {
      addFieldToRuleUI(fieldsContainer, {});
    });

    delRuleBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent header toggle
      ruleBlock.remove();
    });

    rulesContainer.appendChild(clone);
  }

  function addFieldToRuleUI(container, fieldData) {
    const clone = fieldTemplate.content.cloneNode(true);
    const fieldItem = clone.querySelector('.field-item');
    const nameInput = clone.querySelector('.field-name');
    const selectorInput = clone.querySelector('.field-selector');
    const typeSelect = clone.querySelector('.field-type');
    const delFieldBtn = clone.querySelector('.delete-field-btn');
    const regionInput = clone.querySelector('.field-region');
    const pickFieldBtn = clone.querySelector('.pick-field-btn');

    if (fieldData.name) nameInput.value = fieldData.name;
    if (fieldData.selector) selectorInput.value = fieldData.selector;
    if (fieldData.type) typeSelect.value = fieldData.region?.mode === 'module' ? 'module_screenshot' : fieldData.type;
    if (fieldData.region) regionInput.value = JSON.stringify(fieldData.region);

    const readRegion = () => parseRegionValue(regionInput.value);

    // 截图字段用只读文本回显已框选区域，普通字段则恢复为可编辑选择器输入框
    const syncRegionDisplay = () => {
      if (typeSelect.value === 'screenshot' || typeSelect.value === 'module_screenshot') {
        const region = readRegion();
        const sameMode = region && (region.mode === 'module') === (typeSelect.value === 'module_screenshot');
        const text = (sameMode ? describeRegion(region) : '') || (typeSelect.value === 'module_screenshot' ? '尚未选择模块' : '尚未框选区域');
        selectorInput.value = text;
        selectorInput.dataset.regionText = text;
      } else if (selectorInput.dataset.regionText && selectorInput.value === selectorInput.dataset.regionText) {
        selectorInput.value = '';
        delete selectorInput.dataset.regionText;
      }
    };

    // Toggle selector input state according to the selected field type
    const updateSelectorState = () => {
      const type = typeSelect.value;

      if (type === 'current_url') {
        selectorInput.disabled = true;
        selectorInput.classList.add('opacity-50', 'bg-gray-100');
        selectorInput.placeholder = '当前页面URL无需选择器';
        if (pickFieldBtn) pickFieldBtn.classList.add('hidden');
      } else if (type === 'screenshot' || type === 'module_screenshot') {
        selectorInput.disabled = true;
        selectorInput.classList.add('opacity-50', 'bg-gray-100');
        selectorInput.placeholder = '区域截图无需选择器';
        if (pickFieldBtn) {
          pickFieldBtn.classList.remove('hidden');
          pickFieldBtn.textContent = type === 'module_screenshot' ? '选择模块' : '框选区域';
          pickFieldBtn.title = type === 'module_screenshot' ? '在网页上选择截图模块' : '在网页上拖拽框选要截图的区域';
        }
      } else {
        selectorInput.disabled = false;
        selectorInput.classList.remove('opacity-50', 'bg-gray-100');
        selectorInput.placeholder = 'CSS选择器 (例如: a.profile-link)';
        if (pickFieldBtn) {
          pickFieldBtn.classList.remove('hidden');
          pickFieldBtn.textContent = '🎯 拾取';
          pickFieldBtn.title = '在网页上点击选取目标元素';
        }
      }
    };

    typeSelect.addEventListener('change', () => {
      updateSelectorState();
      syncRegionDisplay();
    });
    updateSelectorState();
    syncRegionDisplay();

    delFieldBtn.addEventListener('click', () => {
      fieldItem.remove();
    });

    if (pickFieldBtn) {
      pickFieldBtn.addEventListener('click', () => {
        const ruleBlock = fieldItem.closest('.rule-block');
        const ruleUrl = ruleBlock ? ruleBlock.querySelector('.rule-url').value.trim() : '';

        if (typeSelect.value === 'screenshot' || typeSelect.value === 'module_screenshot') {
          startRegionPicking({ regionInput, selectorInput }, ruleUrl, typeSelect.value === 'module_screenshot');
        } else {
          startPicking(selectorInput, ruleUrl);
        }
      });
    }

    container.appendChild(clone);
  }

  // ==== 目标标签页查找 ====
  async function findTargetTab(urlKeyword) {
    if (!urlKeyword) {
      alert("请先在此规则的第一行填写『匹配 URL 关键字』（例如: .com）, 以便扩展为您在一堆标签页中寻找要操作的目标网页！");
      return null;
    }

    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find(t => t.url && t.url.includes(urlKeyword) && !t.url.includes(chrome.runtime.id));

    if (!targetTab) {
      alert(`未找到任何包含 "${urlKeyword}" 的已经打开的网页。\n请先在一个新的标签页中打开需要抓取的目标网站！`);
      return null;
    }

    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });
    return targetTab;
  }

  // ==== Element Picker Logic ====
  async function startPicking(inputEl, urlKeyword) {
    const targetTab = await findTargetTab(urlKeyword);
    if (!targetTab) return;

    activePickerInput = inputEl;

    chrome.tabs.sendMessage(targetTab.id, { action: 'START_PICKING' }, (response) => {
      if (chrome.runtime.lastError) {
        // Needs injecting
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content/content.js']
        }, () => {
          chrome.tabs.sendMessage(targetTab.id, { action: 'START_PICKING' });
        });
      }
    });
  }

  // ==== Region Picker Logic ====
  async function startRegionPicking(targets, urlKeyword, moduleMode = false) {
    const targetTab = await findTargetTab(urlKeyword);
    if (!targetTab) return;

    activeRegionTarget = targets;

    const message = { action: moduleMode ? 'START_MODULE_PICK' : 'START_REGION_PICK' };
    chrome.tabs.sendMessage(targetTab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        // Needs injecting
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content/module-capture.js', 'content/content.js']
        }, () => {
          chrome.tabs.sendMessage(targetTab.id, message, result => {
            if (chrome.runtime.lastError || result?.error) showToast(result?.error || chrome.runtime.lastError.message, true);
          });
        });
      } else if (response?.error) showToast(response.error, true);
    });
  }

  async function focusOptionsTab() {
    const currentTab = await chrome.tabs.getCurrent();
    if (currentTab) {
      chrome.tabs.update(currentTab.id, { active: true });
    } else {
      // Find options tab if getCurrent fails in some contexts
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('options/options.html') });
      if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { active: true });
    }
  }

  // Listen for picker responses
  // 普通监听器不能返回无关的 Promise，否则空响应会抢走后台写入/截图结果。
  chrome.runtime.onMessage.addListener((request) => {
    if (!['PICKED_SELECTOR', 'PICKED_REGION', 'REGION_PICK_CANCELLED'].includes(request.action)) return;
    handlePickerResponse(request).catch(e => {
      console.error('[Scraper] 处理拾取结果失败:', e);
      showToast('处理拾取结果失败：' + e.message, true);
    });
  });

  async function handlePickerResponse(request) {
    if (request.action === 'PICKED_SELECTOR' && activePickerInput) {
      const targetInput = activePickerInput;
      targetInput.value = request.selector;
      targetInput.classList.add('ring-2', 'ring-green-400');
      setTimeout(() => targetInput.classList.remove('ring-2', 'ring-green-400'), 1500);

      await focusOptionsTab();
      activePickerInput = null;
    }

    if (request.action === 'PICKED_REGION' && activeRegionTarget) {
      const { regionInput, selectorInput } = activeRegionTarget;
      const region = request.region;

      regionInput.value = JSON.stringify(region);
      const text = describeRegion(region);
      selectorInput.value = text;
      selectorInput.dataset.regionText = text;
      selectorInput.classList.add('ring-2', 'ring-green-400');
      setTimeout(() => selectorInput.classList.remove('ring-2', 'ring-green-400'), 1500);

      await focusOptionsTab();
      activeRegionTarget = null;
      showToast('已记录截图选择，请保存配置');
    }

    if (request.action === 'REGION_PICK_CANCELLED' && activeRegionTarget) {
      activeRegionTarget = null;
      await focusOptionsTab();
    }
  }

  // ==== 配置导出 / 导入 ====
  exportConfigBtn.addEventListener('click', () => {
    const currentRules = collectRulesFromUI();
    const fieldTotal = currentRules.reduce((sum, r) => sum + r.fields.length, 0);
    exportSummaryEl.textContent =
      `将导出 ${currentRules.length} 条规则、共 ${fieldTotal} 个字段。数据取自当前页面，包含尚未保存的修改。`;

    const hasCredentials = !!(appIdEl.value.trim() && appSecretEl.value.trim());
    includeCredentialsEl.checked = false;
    if (hasCredentials) {
      exportCredentialRow.classList.remove('is-disabled');
      includeCredentialsEl.disabled = false;
      exportCredentialDesc.textContent =
        '勾选后文件内会写入 App ID / App Secret 明文，等同于密码，请勿外发或提交到代码仓库。';
    } else {
      exportCredentialRow.classList.add('is-disabled');
      includeCredentialsEl.disabled = true;
      exportCredentialDesc.textContent = '当前未填写 App ID / App Secret，无法导出凭证。';
    }

    updateExportFilenameHint();
    exportModal.hidden = false;
  });

  includeCredentialsEl.addEventListener('change', updateExportFilenameHint);

  function updateExportFilenameHint() {
    const preview = buildConfigPayload({ includeCredentials: includeCredentialsEl.checked });
    exportFilenameHintEl.textContent = `文件名：${buildConfigFilename(preview)}`;
  }

  confirmExportBtn.addEventListener('click', () => {
    const payload = buildConfigPayload({
      appId: appIdEl.value,
      appSecret: appSecretEl.value,
      targetUrl: data[StorageKeys.FEISHU_DB_URL] || '',
      rules: collectRulesFromUI(),
      includeCredentials: includeCredentialsEl.checked,
      extensionVersion: chrome.runtime.getManifest().version
    });

    downloadJsonFile(payload, buildConfigFilename(payload));
    closeOverlay(exportModal);
    showToast(`已导出 ${payload.rules.length} 条规则${payload.includesCredentials ? '（含凭证）' : ''}`);
  });

  function downloadJsonFile(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立即 revoke 可能导致部分浏览器中断下载，留出缓冲
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  importConfigBtn.addEventListener('click', () => {
    importFileInput.value = '';
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files && importFileInput.files[0];
    if (!file) return;

    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch (e) {
      alert(`无法解析该文件，内容不是合法 JSON：\n${e.message}`);
      return;
    }

    const result = validateConfigPayload(raw);
    if (!result.ok) {
      alert(`导入失败：${result.error}`);
      return;
    }

    pendingImport = { filename: file.name, ...result };
    renderImportModal();
    importModal.hidden = false;
  });

  function renderImportModal() {
    if (!pendingImport) return;
    const { filename, payload, stats, warnings } = pendingImport;
    const currentRules = collectRulesFromUI();

    let exportedAtText = '未知';
    if (payload.exportedAt) {
      const parsed = new Date(payload.exportedAt);
      if (!Number.isNaN(parsed.getTime())) exportedAtText = parsed.toLocaleString('zh-CN');
    }

    const lines = [
      `文件：${filename}`,
      `导出时间：${exportedAtText}`,
      `来源扩展版本：${payload.extensionVersion || '未知'}`,
      `包含：${stats.rules} 条规则 / ${stats.fields} 个字段（其中截图字段 ${stats.screenshotFields} 个）`,
      `凭证：${payload.credentials ? '含 App ID 与 App Secret，覆盖导入时会一并写入' : '不含凭证'}`,
      `当前页面已有：${currentRules.length} 条规则`
    ];

    importMetaEl.textContent = '';
    lines.forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      importMetaEl.appendChild(div);
    });

    if (warnings && warnings.length > 0) {
      importWarningsEl.textContent = '';
      const head = document.createElement('div');
      head.textContent = '以下内容被调整：';
      importWarningsEl.appendChild(head);
      warnings.forEach((w) => {
        const div = document.createElement('div');
        div.textContent = `· ${w}`;
        importWarningsEl.appendChild(div);
      });
      importWarningsEl.hidden = false;
    } else {
      importWarningsEl.hidden = true;
    }
  }

  confirmAppendBtn.addEventListener('click', () => applyPendingImport('append'));
  confirmReplaceBtn.addEventListener('click', () => applyPendingImport('replace'));

  async function applyPendingImport(strategy) {
    if (!pendingImport) return;

    const { payload } = pendingImport;
    const mergedRules = mergeConfigRules(collectRulesFromUI(), payload.rules, strategy);
    const matchError = mergedRules.map(validateRuleMatchField).find(Boolean);
    if (matchError) {
      showToast(matchError, true);
      return;
    }

    const updates = {
      [StorageKeys.SCRAPING_RULES]: mergedRules,
      // 规则整体变更后，旧的临时区域覆盖不再适用
      [StorageKeys.TEMP_REGION_OVERRIDES]: {}
    };

    if (strategy === 'replace' && payload.credentials) {
      updates[StorageKeys.FEISHU_APP_ID] = payload.credentials.appId;
      updates[StorageKeys.FEISHU_APP_SECRET] = payload.credentials.appSecret;

      if (payload.targetUrl) {
        updates[StorageKeys.FEISHU_DB_URL] = payload.targetUrl;
      }
    }

    try {
      await setStorageData(updates);
    } catch (e) {
      showToast('导入失败：' + e.message, true);
      return;
    }
    // 持久化成功后才更新表单与导出使用的快照，失败时保留导入内容供重试。
    Object.assign(data, updates);
    if (strategy === 'replace' && payload.credentials) {
      appIdEl.value = payload.credentials.appId;
      appSecretEl.value = payload.credentials.appSecret;
    }
    renderRules(mergedRules);

    const importedCount = payload.rules.length;
    pendingImport = null;
    closeOverlay(importModal);

    showToast(
      strategy === 'replace'
        ? `已覆盖为 ${importedCount} 条规则${payload.credentials ? '，凭证已同步' : ''}`
        : `已追加 ${importedCount} 条规则，当前共 ${mergedRules.length} 条`
    );
  }

  function closeOverlay(overlay) {
    if (!overlay) return;
    overlay.hidden = true;
    if (overlay === importModal) pendingImport = null;
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeOverlay(document.getElementById(btn.dataset.close)));
  });

  [exportModal, importModal].forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlay(overlay);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!exportModal.hidden) closeOverlay(exportModal);
    if (!importModal.hidden) closeOverlay(importModal);
  });

  function showToast(msg, isError = false) {
    toastMessage.textContent = msg;
    toast.querySelector('svg').classList.toggle('hidden', isError);
    toastMessage.classList.toggle('text-red-300', isError);
    toast.classList.remove('translate-y-20', 'opacity-0');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
  }
});
