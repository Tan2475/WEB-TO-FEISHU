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

  let activePickerInput = null; // Stores reference to the input being picked for

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
    const rulesToSave = [];
    document.querySelectorAll('.rule-block').forEach(ruleBlock => {
      const name = ruleBlock.querySelector('.rule-name').value.trim();
      const url = ruleBlock.querySelector('.rule-url').value.trim();
      const preSelector = ruleBlock.querySelector('.rule-pre-selector').value.trim();
      const preType = ruleBlock.querySelector('.rule-pre-type').value;
      
      const fields = [];
      ruleBlock.querySelectorAll('.field-item').forEach(fieldItem => {
        const name = fieldItem.querySelector('.field-name').value.trim();
        const selector = fieldItem.querySelector('.field-selector').value.trim();
        const type = fieldItem.querySelector('.field-type').value;
        if (name && (selector || type === 'current_url')) {
          fields.push({ name, selector, type });
        }
      });
      if (url || fields.length > 0) {
        rulesToSave.push({ name: name || "未命名规则", url, preSelector, preType, fields });
      }
    });

    await setStorageData({
      [StorageKeys.FEISHU_APP_ID]: appIdEl.value.trim(),
      [StorageKeys.FEISHU_APP_SECRET]: appSecretEl.value.trim(),
      [StorageKeys.SCRAPING_RULES]: rulesToSave
    });

    showToast('配置与规则已成功保存！');
  });

  // Handle Add Rule
  addRuleBtn.addEventListener('click', () => {
    addRuleToUI({});
  });

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

    addFieldBtn.addEventListener('click', () => {
      addFieldToRuleUI(fieldsContainer, {});
    });

    delRuleBtn.addEventListener('click', () => {
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

    if (fieldData.name) nameInput.value = fieldData.name;
    if (fieldData.selector) selectorInput.value = fieldData.selector;
    if (fieldData.type) typeSelect.value = fieldData.type;

    const pickFieldBtn = clone.querySelector('.pick-field-btn');

    // Toggle selector input state if 'current_url' is selected
    const updateSelectorState = () => {
      if (typeSelect.value === 'current_url') {
        selectorInput.disabled = true;
        selectorInput.classList.add('opacity-50', 'bg-gray-100');
        selectorInput.placeholder = '当前页面URL无需选择器';
        if (pickFieldBtn) pickFieldBtn.classList.add('hidden');
      } else {
        selectorInput.disabled = false;
        selectorInput.classList.remove('opacity-50', 'bg-gray-100');
        selectorInput.placeholder = 'CSS选择器 (例如: a.profile-link)';
        if (pickFieldBtn) pickFieldBtn.classList.remove('hidden');
      }
    };
    typeSelect.addEventListener('change', updateSelectorState);
    updateSelectorState();

    delFieldBtn.addEventListener('click', () => {
      fieldItem.remove();
    });

    if (pickFieldBtn) {
      pickFieldBtn.addEventListener('click', () => {
        const ruleBlock = fieldItem.closest('.rule-block');
        const ruleUrl = ruleBlock ? ruleBlock.querySelector('.rule-url').value.trim() : '';
        startPicking(selectorInput, ruleUrl);
      });
    }

    container.appendChild(clone);
  }

  // ==== Element Picker Logic ====
  async function startPicking(inputEl, urlKeyword) {
    if (!urlKeyword) {
      alert("请先在此规则的第一行填写『匹配 URL 关键字』（例如: .com）, 一便扩展为您在一堆标签页中寻找要拾取的目标网页！");
      return;
    }

    // Find tab
    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find(t => t.url && t.url.includes(urlKeyword) && !t.url.includes(chrome.runtime.id));

    if (!targetTab) {
      alert(`未找到任何包含 "${urlKeyword}" 的已经打开的网页。\n请先在一个新的标签页中打开需要抓取的目标网站！`);
      return;
    }

    activePickerInput = inputEl;

    // Bring tab to front
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });

    // Send picking message
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

  // Listen for picker response
  chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (request.action === 'PICKED_SELECTOR' && activePickerInput) {
      const targetInput = activePickerInput;
      targetInput.value = request.selector;
      targetInput.classList.add('ring-2', 'ring-green-400');
      setTimeout(() => targetInput.classList.remove('ring-2', 'ring-green-400'), 1500);
      
      // Auto switch back to options
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab) {
        chrome.tabs.update(currentTab.id, { active: true });
      } else {
        // Find options tab if getCurrent fails in some contexts
        const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('options/options.html') });
        if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { active: true });
      }
      activePickerInput = null;
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
