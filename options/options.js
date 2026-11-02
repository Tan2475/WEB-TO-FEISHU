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

  let activePickerInput = null; // 正在等待元素拾取结果的选择器输入框
  let activeRegionTarget = null; // 正在等待区域框选结果的字段上下文
  let incompleteScreenshotCount = 0; // 本次保存中被丢弃的未框选截图字段数

  // Load existing data
  const data = await getStorageData([
    StorageKeys.FEISHU_APP_ID,
    StorageKeys.FEISHU_APP_SECRET,
    StorageKeys.SCRAPING_RULES
  ]);

  if (data[StorageKeys.FEISHU_APP_ID]) appIdEl.value = data[StorageKeys.FEISHU_APP_ID];
  if (data[StorageKeys.FEISHU_APP_SECRET]) appSecretEl.value = data[StorageKeys.FEISHU_APP_SECRET];

  const rules = data[StorageKeys.SCRAPING_RULES] || [];
  if (rules.length === 0) {
    // Add an empty default rule to guide users
    addRuleToUI({});
  } else {
    rules.forEach(r => addRuleToUI(r));
  }

  // Handle Save
  saveGlobalBtn.addEventListener('click', async () => {
    // Collect rules
    incompleteScreenshotCount = 0;
    const rulesToSave = [];
    document.querySelectorAll('.rule-block').forEach(ruleBlock => {
      const data = getRuleDataFromElement(ruleBlock);
      if (data.url || data.fields.length > 0) {
        rulesToSave.push({
          name: data.name || "未命名规则",
          url: data.url,
          preSelector: data.preSelector,
          preType: data.preType,
          fields: data.fields
        });
      }
    });

    await setStorageData({
      [StorageKeys.FEISHU_APP_ID]: appIdEl.value.trim(),
      [StorageKeys.FEISHU_APP_SECRET]: appSecretEl.value.trim(),
      [StorageKeys.SCRAPING_RULES]: rulesToSave,
      // 规则一旦重新保存，弹窗侧的临时区域覆盖即失效，避免与最新配置冲突
      [StorageKeys.TEMP_REGION_OVERRIDES]: {}
    });

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

  function getRuleDataFromElement(ruleBlock) {
    const name = ruleBlock.querySelector('.rule-name').value.trim();
    const url = ruleBlock.querySelector('.rule-url').value.trim();
    const preSelector = ruleBlock.querySelector('.rule-pre-selector').value.trim();
    const preType = ruleBlock.querySelector('.rule-pre-type').value;

    const fields = [];
    ruleBlock.querySelectorAll('.field-item').forEach(fieldItem => {
      const fieldName = fieldItem.querySelector('.field-name').value.trim();
      const type = fieldItem.querySelector('.field-type').value;
      const selector = fieldItem.querySelector('.field-selector').value.trim();
      const regionInput = fieldItem.querySelector('.field-region');

      if (type === 'screenshot') {
        const region = parseRegionValue(regionInput ? regionInput.value : '');
        if (fieldName && region) {
          // 截图字段不使用 CSS 选择器，区域配置单独保存
          fields.push({ name: fieldName, selector: '', type, region });
        } else if (fieldName) {
          incompleteScreenshotCount++;
        }
        return;
      }

      if (fieldName && (selector || type === 'current_url')) {
        fields.push({ name: fieldName, selector, type });
      }
    });
    return { name, url, preSelector, preType, fields };
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
    return `已框选 ${Math.round(region.width)} × ${Math.round(region.height)}`;
  }

  function addRuleToUI(ruleData) {
    const clone = ruleTemplate.content.cloneNode(true);
    const ruleBlock = clone.querySelector('.rule-block');
    const nameInput = clone.querySelector('.rule-name');
    const urlInput = clone.querySelector('.rule-url');
    const preSelectorInput = clone.querySelector('.rule-pre-selector');
    const preTypeSelect = clone.querySelector('.rule-pre-type');
    const addFieldBtn = clone.querySelector('.add-field-btn');
    const fieldsContainer = clone.querySelector('.fields-container');
    const delRuleBtn = clone.querySelector('.delete-rule-btn');
    const pickPreBtn = clone.querySelector('.pick-pre-btn');

    // New header and control elements
    const headerTitle = clone.querySelector('.rule-header-title');
    const ruleHeader = clone.querySelector('.rule-header');
    const ruleContent = clone.querySelector('.rule-content');
    const toggleIcon = clone.querySelector('.toggle-icon');
    const copyRuleBtn = clone.querySelector('.copy-rule-btn');

    pickPreBtn.addEventListener('click', () => {
      startPicking(preSelectorInput, urlInput.value.trim());
    });

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
    if (fieldData.type) typeSelect.value = fieldData.type;
    if (fieldData.region) regionInput.value = JSON.stringify(fieldData.region);

    const readRegion = () => parseRegionValue(regionInput.value);

    // 截图字段用只读文本回显已框选区域，普通字段则恢复为可编辑选择器输入框
    const syncRegionDisplay = () => {
      if (typeSelect.value === 'screenshot') {
        const text = describeRegion(readRegion()) || '尚未框选区域';
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
      } else if (type === 'screenshot') {
        selectorInput.disabled = true;
        selectorInput.classList.add('opacity-50', 'bg-gray-100');
        selectorInput.placeholder = '区域截图无需选择器';
        if (pickFieldBtn) {
          pickFieldBtn.classList.remove('hidden');
          pickFieldBtn.textContent = '🖼 框选区域';
          pickFieldBtn.title = '在网页上拖拽框选要截图的区域';
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

        if (typeSelect.value === 'screenshot') {
          startRegionPicking({ regionInput, selectorInput }, ruleUrl);
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
  async function startRegionPicking(targets, urlKeyword) {
    const targetTab = await findTargetTab(urlKeyword);
    if (!targetTab) return;

    activeRegionTarget = targets;

    chrome.tabs.sendMessage(targetTab.id, { action: 'START_REGION_PICK' }, (response) => {
      if (chrome.runtime.lastError) {
        // Needs injecting
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content/content.js']
        }, () => {
          chrome.tabs.sendMessage(targetTab.id, { action: 'START_REGION_PICK' });
        });
      }
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
  chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
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
      showToast('已记录截图区域，记得点击「保存全局配置」');
    }

    if (request.action === 'REGION_PICK_CANCELLED' && activeRegionTarget) {
      activeRegionTarget = null;
      await focusOptionsTab();
    }
  });

  function showToast(msg) {
    toastMessage.textContent = msg;
    toast.classList.remove('translate-y-20', 'opacity-0');
    setTimeout(() => {
      toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
  }
});
