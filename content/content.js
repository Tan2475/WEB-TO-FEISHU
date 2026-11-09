// content.js

if (!window.__FEISHU_SCRAPER_INJECTED) {
  window.__FEISHU_SCRAPER_INJECTED = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 为元素生成尽量稳定的 CSS 选择器。
   * 顺序：唯一 id → 唯一 data-* 属性 → 最短的唯一「标签+类名」路径。
   *
   * 刻意避免整条 body 起算的 :nth-child 长路径。悬停卡片这类浮层是动态挂到
   * body 末尾的 portal，拾取时和抓取时的挂载位置/兄弟节点数经常不同，序号一旦
   * 偏移选择器就失效，表现为「能选中却抓不到」。
   */
  const STABLE_DATA_ATTRS = [
    'data-testid', 'data-test-id', 'data-test', 'data-e2e', 'data-qa',
    'data-cy', 'data-spm', 'data-id', 'data-name'
  ];

  // css-in-js / css-modules 生成的类名，每次构建都会变
  const GENERATED_NAME_RE = /^(css|jsx|sc|emotion|svelte)-/i;

  function looksGenerated(name) {
    if (!name) return true;
    if (GENERATED_NAME_RE.test(name)) return true;
    if (/^\d/.test(name)) return true;
    // 纯 hash：a1b2c3、9c8b7a（要求含数字，避免误伤 face/cafe 这类正常词）
    if (/^[0-9a-f]{4,}$/i.test(name) && /\d/.test(name)) return true;
    // 尾部长随机串：btn-a1b2c3d4e5
    if (/[-_][0-9a-f]{6,}$/i.test(name)) return true;
    return false;
  }

  function isStableToken(value) {
    if (!value || typeof value !== 'string' || value.length > 64) return false;
    if (/^\d+$/.test(value)) return false;
    if (looksGenerated(value)) return false;
    return true;
  }

  function stableClasses(el) {
    return Array.from(el.classList || [])
      .filter((c) => c && !c.includes(':') && !looksGenerated(c))
      .filter((c) => !/^(hover|active|focus|selected|open|show|visible|is-)/.test(c))
      .slice(0, 3);
  }

  function nthOfType(el) {
    let index = 1;
    let sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) index++;
    }
    return index;
  }

  function countMatches(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch (e) {
      return -1;
    }
  }

  function selectorFragment(el, withNth) {
    let sel = el.tagName.toLowerCase();
    const classes = stableClasses(el);
    if (classes.length) sel += '.' + classes.map((c) => CSS.escape(c)).join('.');
    if (withNth) sel += `:nth-of-type(${nthOfType(el)})`;
    return sel;
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';

    // 1. 唯一 id
    if (el.id && isStableToken(el.id)) {
      const byId = '#' + CSS.escape(el.id);
      if (countMatches(byId) === 1) return byId;
    }

    // 2. 唯一的 data-* 属性（测试钩子类属性通常比 class 稳定得多）
    for (const attr of STABLE_DATA_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && isStableToken(value) && value.length <= 48 && !value.includes('"')) {
        const byData = `${el.tagName.toLowerCase()}[${attr}="${value}"]`;
        if (countMatches(byData) === 1) return byData;
      }
    }

    // 3. 由近及远，取最短的唯一路径
    const chain = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      chain.unshift(node);
      node = node.parentNode;
    }

    for (let start = chain.length - 1; start >= 0; start--) {
      const slice = chain.slice(start);
      const path = slice.map((n) => selectorFragment(n, false)).join(' > ');
      if (countMatches(path) === 1) return path;
    }

    // 4. 仍不唯一（列表页很常见）：从末段起逐层给祖先补 :nth-of-type，取最短的唯一组合。
    //    注意必须连祖先一起补——只给末段补会退化成「所有条目的第一个」，直接选错元素。
    for (let start = chain.length - 1; start >= 0; start--) {
      const slice = chain.slice(start);
      const path = slice.map((n) => selectorFragment(n, true)).join(' > ');
      if (countMatches(path) === 1) return path;
    }

    // 5. 兜底：整条链路都带 :nth-of-type，保证至少能定位回同一个节点
    return chain.map((n) => selectorFragment(n, true)).join(' > ');
  }

  function queryInRoot(root, selector) {
    try {
      return root.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function safeQuery(selector) {
    if (!selector) return null;
    return queryInRoot(document, selector);
  }

  /**
   * 普通查询失败时，惰性穿透 open shadow root 再找一次。
   * 遍历成本随页面节点数增长，因此结果按阶段缓存；等待超时与最终提取时刷新，
   * 既能发现动态新增的根节点，也避免每个字段都反复全量扫描。
   */
  let shadowRootCache = null;

  function getShadowRoots() {
    if (shadowRootCache) return shadowRootCache;

    const roots = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          collect(el.shadowRoot);
        }
      }
    };
    try {
      collect(document);
    } catch (e) {
      // 页面结构异常时退化为「不支持 shadow DOM」，不影响常规查询
    }
    shadowRootCache = roots;
    return roots;
  }

  function resetShadowRootCache() {
    shadowRootCache = null;
  }

  function deepQuery(selector) {
    const direct = safeQuery(selector);
    if (direct) return direct;

    for (const root of getShadowRoots()) {
      const hit = queryInRoot(root, selector);
      if (hit) return hit;
    }
    return null;
  }

  // ==== 预交互事件序列 ====
  function eventPoint(el) {
    const rect = el.getBoundingClientRect();
    return {
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
  }

  function buildBaseEvent(el, extra) {
    const point = eventPoint(el);
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      ...point,
      screenX: point.clientX,
      screenY: point.clientY,
      ...extra
    };
  }

  function firePointerOrMouse(el, type, base, usePointer) {
    try {
      if (usePointer && window.PointerEvent) {
        el.dispatchEvent(new PointerEvent(type, {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: 0
        }));
      } else {
        el.dispatchEvent(new MouseEvent(type, base));
      }
    } catch (e) {
      // 个别站点对合成事件抛错，忽略即可，后续事件继续
    }
  }

  /**
   * 悬停触发器。
   * 光发 mouseover 对现代组件库经常无效：有的只监听 pointerenter/pointerover，
   * 有的靠 mousemove 的坐标做 hover-intent 延迟判定，这里按真实指针的时序补齐。
   */
  function dispatchHoverSequence(el) {
    const base = buildBaseEvent(el, {
      detail: 0,
      button: 0,
      buttons: 0,
      relatedTarget: null
    });

    firePointerOrMouse(el, 'pointerover', base, true);
    firePointerOrMouse(el, 'pointerenter', base, true);
    firePointerOrMouse(el, 'mouseover', base, false);
    firePointerOrMouse(el, 'mouseenter', base, false);
    firePointerOrMouse(el, 'pointermove', base, true);
    firePointerOrMouse(el, 'mousemove', base, false);
  }

  /** 点击触发器：补齐按下/抬起，最后仍走 el.click() 兼容依赖原生行为的节点 */
  function dispatchClickSequence(el) {
    const downBase = buildBaseEvent(el, {
      detail: 1,
      button: 0,
      buttons: 1,
      relatedTarget: null
    });
    // 抬起时按键已释放，buttons 必须归零，否则部分组件库会判定为拖拽
    const upBase = { ...downBase, buttons: 0 };

    firePointerOrMouse(el, 'pointerdown', downBase, true);
    firePointerOrMouse(el, 'mousedown', downBase, false);
    firePointerOrMouse(el, 'pointerup', upBase, true);
    firePointerOrMouse(el, 'mouseup', upBase, false);

    try {
      el.click();
    } catch (e) {
      // 忽略
    }
  }

  function runPreAction(preEl, preType) {
    if (!preEl) return;
    if (preType === 'click') dispatchClickSequence(preEl);
    else dispatchHoverSequence(preEl);
  }

  async function activateRuleTab(selector) {
    if (!selector) return;
    if (typeof selector !== 'string') throw new Error('目标页签配置无效。');
    const target = deepQuery(selector);
    const tab = target?.closest?.('[role="tab"]') || target;
    // 星图等 Element UI 页面会直接省略未选中页签的 aria-selected。
    if (!tab || (tab.getAttribute('role') !== 'tab' && tab.getAttribute('aria-selected') === null)) {
      throw new Error('找不到目标页签，请重新拾取页签。');
    }
    if (tab.getAttribute('aria-selected') !== 'true') {
      tab.click();
      const deadline = Date.now() + 5000;
      while (tab.getAttribute('aria-selected') !== 'true') {
        if (Date.now() >= deadline) throw new Error('切换目标页签超时，已停止抓取。');
        await sleep(100);
      }
      await sleep(400);
    }
    const deadline = Date.now() + 5000;
    while (Array.from(document.querySelectorAll('[aria-busy="true"], .el-loading-mask'))
      .some(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)) {
      if (Date.now() >= deadline) throw new Error('目标页签仍在加载，已停止抓取。');
      await sleep(100);
    }
    resetShadowRootCache();
  }

  function queryVisibleField(selector, accept = () => true) {
    const visible = el => el && (!el.getClientRects || (el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible')) && accept(el);
    const first = deepQuery(selector);
    if (visible(first)) return first;
    for (const root of [document, ...getShadowRoots()]) {
      try {
        const hit = Array.from(root.querySelectorAll(selector)).find(visible);
        if (hit) return hit;
      } catch (_) { return null; }
    }
    return null;
  }

  function findPreActionTarget(selector, type) {
    return queryVisibleField(selector, el => el.isConnected !== false &&
      (type !== 'click' || !el.closest?.(':disabled, [aria-disabled="true"], [inert]')));
  }

  async function waitForPreActionTarget(selector, type) {
    const deadline = Date.now() + 3000;
    for (;;) {
      resetShadowRootCache();
      const target = findPreActionTarget(selector, type);
      if (target || Date.now() >= deadline) return target;
      await sleep(200);
    }
  }

  function readFieldValue(el, type) {
    switch (type) {
      case 'href': return el.href || el.getAttribute('href');
      case 'src': return el.src || el.getAttribute('src');
      case 'html': return el.innerHTML;
      case 'value': return el.value;
      default: return (el.innerText || el.textContent)?.trim() || null;
    }
  }

  const hasFieldValue = value => value != null && (typeof value !== 'string' || value.trim() !== '');

  async function waitForFields(fields, timeout, visibleOnly, requireValue) {
    if (!fields.length) return [];

    const deadline = Date.now() + timeout;
    const findMissing = query => fields.filter(field => {
      const el = query(field.selector);
      return !el || (requireValue && !hasFieldValue(readFieldValue(el, field.type)));
    });
    const query = visibleOnly ? queryVisibleField : requireValue ? deepQuery : safeQuery;
    for (;;) {
      const missing = findMissing(query);
      if (missing.length === 0) return [];
      if (Date.now() >= deadline) {
        // 等待期间可能新增 Web Component，不能沿用预交互前的根节点列表。
        resetShadowRootCache();
        return findMissing(visibleOnly ? queryVisibleField : deepQuery);
      }
      await sleep(100);
    }
  }

  /**
   * 把保存的区域配置换算为「文档坐标」下的矩形。
   * 优先以锚点元素为基准（可抵抗页面滚动与局部布局漂移），
   * 锚点失效时退回保存的绝对文档坐标。
   */
  function locateRegion(region) {
    const width = Math.max(1, Math.round(region.width || 0));
    const height = Math.max(1, Math.round(region.height || 0));

    const anchor = safeQuery(region.anchorSelector);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      return {
        x: r.left + window.scrollX + (region.offsetX || 0),
        y: r.top + window.scrollY + (region.offsetY || 0),
        width,
        height,
        anchored: true
      };
    }

    if (typeof region.docX === 'number' && typeof region.docY === 'number') {
      return { x: region.docX, y: region.docY, width, height, anchored: false };
    }

    return null;
  }

  // ==== 元素拾取器（原有逻辑，复用 buildSelector） ====
  function startElementPick(sendResponse) {
    if (window.__FEISHU_PICKER_ACTIVE) {
      // Already picking on this page: respond so the caller does not treat
      // this as a missing content script and try to re-inject.
      sendResponse({ success: false, error: 'Picker is already active on this page.' });
      return;
    }
    window.__FEISHU_PICKER_ACTIVE = true;

    const highlightOverlay = document.createElement('div');
    highlightOverlay.style.cssText =
      'position:fixed; pointer-events:none; z-index:9999999; background:rgba(147, 51, 234, 0.3); border:2px solid #9333ea; transition:all 0.05s linear; border-radius:3px; box-shadow: 0 0 10px rgba(147,51,234,0.5);';
    document.body.appendChild(highlightOverlay);

    const onOver = (e) => {
      const rect = e.target.getBoundingClientRect();
      highlightOverlay.style.top = rect.top + 'px';
      highlightOverlay.style.left = rect.left + 'px';
      highlightOverlay.style.width = rect.width + 'px';
      highlightOverlay.style.height = rect.height + 'px';
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('click', onClick, true);
      if (highlightOverlay.parentNode) highlightOverlay.parentNode.removeChild(highlightOverlay);
      window.__FEISHU_PICKER_ACTIVE = false;

      chrome.runtime.sendMessage({ action: 'PICKED_SELECTOR', selector: buildSelector(e.target) });
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);

    // Acknowledge synchronously so the sender's callback receives a real
    // response (no chrome.runtime.lastError). The picked selector is sent
    // later via PICKED_SELECTOR once the user clicks an element.
    sendResponse({ success: true, started: true });
  }

  // ==== 区域框选器 ====
  function showPageNotice(text) {
    const notice = document.createElement('div');
    notice.textContent = text;
    notice.style.cssText =
      'position:fixed; top:20px; right:20px; z-index:2147483647; background:#059669; color:#fff; font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; padding:12px 18px; border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,0.24); max-width:320px;';
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 3200);
  }

  /**
   * 将弹窗发起的「临时重新框选」结果写入本地存储，
   * 供下次打开弹窗时覆盖规则中的区域，不改动已保存的规则本身。
   */
  async function persistRegionOverride(payload, region) {
    try {
      const stored = await chrome.storage.local.get(['TEMP_REGION_OVERRIDES']);
      const overrides = stored.TEMP_REGION_OVERRIDES || {};
      const bucket = overrides[payload.ruleKey] || {};
      bucket[payload.fieldName] = region;
      overrides[payload.ruleKey] = bucket;
      await chrome.storage.local.set({ TEMP_REGION_OVERRIDES: overrides });
      showPageNotice('截图区域已更新，请重新打开扩展图标继续抓取');
    } catch (e) {
      console.warn('[Scraper] 保存临时截图区域失败:', e);
    }
  }

  function startRegionPick(request, sendResponse) {
    if (window.__FEISHU_REGION_ACTIVE) {
      sendResponse({ success: false, error: '区域框选已在进行中。' });
      return;
    }
    window.__FEISHU_REGION_ACTIVE = true;
    const payload = request.payload || null;

    // 透明层负责捕获鼠标事件；选框用超大 box-shadow 挖出高亮区域。
    const shade = document.createElement('div');
    shade.style.cssText =
      'position:fixed; inset:0; z-index:2147483646; cursor:crosshair; background:transparent;';

    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed; z-index:2147483647; display:none; pointer-events:none; border:2px solid #9333ea; border-radius:2px; background:rgba(147,51,234,0.10); box-shadow:0 0 0 99999px rgba(17,24,39,0.35);';

    const sizeTag = document.createElement('div');
    sizeTag.style.cssText =
      'position:fixed; z-index:2147483647; display:none; pointer-events:none; background:#9333ea; color:#fff; font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif; padding:4px 8px; border-radius:4px; white-space:nowrap;';

    const tip = document.createElement('div');
    tip.textContent = '滚动定位 · 拖拽框选 · Esc 取消';
    tip.style.cssText =
      'position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:2147483647; pointer-events:none; background:#111827; color:#fff; font:13px/1 -apple-system,BlinkMacSystemFont,sans-serif; padding:10px 16px; border-radius:999px; box-shadow:0 8px 24px rgba(0,0,0,0.24);';

    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.textContent = '操作网页';
    modeButton.style.cssText = 'position:fixed; top:16px; right:24px; z-index:2147483647; pointer-events:auto; cursor:pointer; background:#fff; color:#111827; border:1px solid #d1d5db; border-radius:8px; padding:10px 16px; font:13px/1 -apple-system,BlinkMacSystemFont,sans-serif; box-shadow:0 4px 16px rgba(0,0,0,.12);';

    document.body.appendChild(shade);
    document.body.appendChild(box);
    document.body.appendChild(sizeTag);
    document.body.appendChild(tip);
    document.body.appendChild(modeButton);

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let current = null;
    let browsing = false;

    function toggleMode(e) {
      e.preventDefault();
      e.stopPropagation();
      if (dragging) return;
      browsing = !browsing;
      shade.style.display = browsing ? 'none' : 'block';
      modeButton.textContent = browsing ? '开始框选' : '操作网页';
      tip.textContent = browsing ? '切换页面后，点击「开始框选」' : '滚动定位 · 拖拽框选 · Esc 取消';
    }
    modeButton.addEventListener('click', toggleMode);

    const clampX = (v) => Math.min(Math.max(v, 0), window.innerWidth);
    const clampY = (v) => Math.min(Math.max(v, 0), window.innerHeight);

    function updateBox(x1, y1, x2, y2) {
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      current = { left, top, width, height };

      box.style.display = 'block';
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';

      sizeTag.style.display = 'block';
      sizeTag.textContent = `${Math.round(width)} × ${Math.round(height)}`;
      const tagTop = top > 28 ? top - 26 : top + height + 6;
      sizeTag.style.left = left + 'px';
      sizeTag.style.top = tagTop + 'px';
    }

    function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('wheel', onWheel, { passive: false, capture: true });
      shade.removeEventListener('mousedown', onMouseDown);
      shade.remove();
      box.remove();
      sizeTag.remove();
      tip.remove();
      modeButton.removeEventListener('click', toggleMode);
      modeButton.remove();
      window.__FEISHU_REGION_ACTIVE = false;
    }

    // 遮罩会接收滚轮事件，因此未拖选时把位移交给鼠标下方真正的滚动容器。
    // 仅拖选期间锁定滚动，避免起止坐标落在不同滚动位置上。
    function onWheel(e) {
      if (browsing) return;
      if (!dragging && e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (dragging) return;

      const target = document.elementsFromPoint(e.clientX, e.clientY)
        .find(el => el !== shade && el !== box && el !== sizeTag && el !== tip && el !== modeButton);
      const root = document.scrollingElement;
      const chain = [];
      const seen = new Set();
      let node = target;
      while (node && node !== root && !seen.has(node)) {
        seen.add(node);
        chain.push(node);
        node = node.parentElement || node.getRootNode?.().host;
      }
      if (root) chain.push(root);

      const lineHeight = target ? parseFloat(getComputedStyle(target).lineHeight) || 16 : 16;
      const factorX = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? window.innerWidth : 1;
      const factorY = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? window.innerHeight : 1;
      let dx = e.deltaX * factorX;
      let dy = e.deltaY * factorY;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }

      for (const el of chain) {
        if (!dx && !dy) break;
        const style = getComputedStyle(el);
        const scrollable = (axis) => /^(auto|scroll|overlay)$/.test(style[`overflow${axis}`]) ||
          (el === root && !/^(hidden|clip)$/.test(style[`overflow${axis}`]));
        const canX = el.scrollWidth > el.clientWidth && scrollable('X');
        const canY = el.scrollHeight > el.clientHeight && scrollable('Y');
        const beforeX = el.scrollLeft;
        const beforeY = el.scrollTop;
        if ((canX && dx) || (canY && dy)) {
          el.scrollBy({ left: canX ? dx : 0, top: canY ? dy : 0, behavior: 'instant' });
          dx -= el.scrollLeft - beforeX;
          dy -= el.scrollTop - beforeY;
        }
        // 尊重侧栏、弹窗等容器的滚动边界，不把剩余位移泄漏到外层页面。
        if (scrollable('X') && /^(contain|none)$/.test(style.overscrollBehaviorX)) dx = 0;
        if (scrollable('Y') && /^(contain|none)$/.test(style.overscrollBehaviorY)) dy = 0;
      }
    }

    function cancel(reason) {
      cleanup();
      chrome.runtime.sendMessage({ action: 'REGION_PICK_CANCELLED', reason: reason || 'cancelled' });
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel('esc');
      }
    }

    function onMouseDown(e) {
      if (browsing || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      modeButton.disabled = true;
      tip.textContent = '松开鼠标完成 · Esc 取消';
      startX = clampX(e.clientX);
      startY = clampY(e.clientY);
      updateBox(startX, startY, startX, startY);
    }

    function onMouseMove(e) {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      updateBox(startX, startY, clampX(e.clientX), clampY(e.clientY));
    }

    function onMouseUp(e) {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = false;
      updateBox(startX, startY, clampX(e.clientX), clampY(e.clientY));

      const sel = current;
      if (!sel || sel.width < 8 || sel.height < 8) {
        cancel('too-small');
        return;
      }

      // 隐藏覆盖层后再做命中测试，找出选框中心下方真正承载内容的元素作为锚点。
      shade.style.visibility = 'hidden';
      box.style.visibility = 'hidden';
      sizeTag.style.visibility = 'hidden';
      tip.style.visibility = 'hidden';
      modeButton.style.visibility = 'hidden';

      const centerX = sel.left + sel.width / 2;
      const centerY = sel.top + sel.height / 2;
      const stack = document
        .elementsFromPoint(centerX, centerY)
        .filter((el) => el !== shade && el !== box && el !== sizeTag && el !== tip && el !== modeButton);
      const anchorEl = stack[0] || document.body;

      let region;
      try {
        const anchorRect = anchorEl.getBoundingClientRect();
        region = {
          anchorSelector: anchorEl === document.body ? '' : buildSelector(anchorEl),
          offsetX: Math.round(sel.left - anchorRect.left),
          offsetY: Math.round(sel.top - anchorRect.top),
          width: Math.round(sel.width),
          height: Math.round(sel.height),
          // 兜底：锚点失效时使用的绝对文档坐标
          docX: Math.round(sel.left + window.scrollX),
          docY: Math.round(sel.top + window.scrollY),
          dpr: window.devicePixelRatio || 1
        };
        // 保存当前可见标签状态，后续截图可先恢复对应内容页。
        const tabSelectors = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
          .filter(el => el.getClientRects().length > 0)
          .map(buildSelector).filter(Boolean);
        if (tabSelectors.length > 10) throw new Error('页面标签过多，无法记录截图位置。');
        if (tabSelectors.length) region.tabSelectors = tabSelectors;
      } catch (err) {
        cleanup();
        chrome.runtime.sendMessage({ action: 'REGION_PICK_CANCELLED', reason: 'measure-failed' });
        return;
      }

      cleanup();

      if (payload && payload.ruleKey && payload.fieldName) {
        persistRegionOverride(payload, region);
      }

      chrome.runtime.sendMessage({ action: 'PICKED_REGION', region });
    }

    shade.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });

    sendResponse({ success: true, started: true });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_MODULE_PICK') {
      try {
        if (!window.FeishuModuleCapture) throw new Error('请重新加载扩展并刷新网页。');
        window.FeishuModuleCapture.start({ selectorFor: buildSelector,
          onPicked: region => {
            if (request.payload?.ruleKey && request.payload?.fieldName) persistRegionOverride(request.payload, region);
            chrome.runtime.sendMessage({ action: 'PICKED_REGION', region });
          }, onCancel: () => chrome.runtime.sendMessage({ action: 'REGION_PICK_CANCELLED' }) });
        sendResponse({ success: true, started: true });
      } catch (e) { sendResponse({ error: e.message }); }
      return;
    }
    if (request.action === 'START_PICKING') {
      startElementPick(sendResponse);
      return;
    }

    if (request.action === 'START_REGION_PICK') {
      startRegionPick(request, sendResponse);
      return;
    }

    if (request.action === 'PREPARE_REGION') {
      (async () => {
        try {
          const region = request.region;
          if (!region) {
            sendResponse({ error: '缺少区域配置。' });
            return;
          }

          if (region.tabSelectors !== undefined) {
            if (!Array.isArray(region.tabSelectors) || region.tabSelectors.length > 10 ||
                region.tabSelectors.some(selector => typeof selector !== 'string' || !selector.trim())) {
              throw new Error('截图标签配置无效，请重新框选。');
            }
            for (const selector of region.tabSelectors) {
              const tab = deepQuery(selector);
              if (!tab) throw new Error('找不到截图对应的页面标签，请重新框选。');
              if (tab.getAttribute('aria-selected') === 'true') continue;
              tab.click();
              const deadline = Date.now() + 3000;
              while (deepQuery(selector)?.getAttribute('aria-selected') !== 'true') {
                if (Date.now() >= deadline) throw new Error('切换截图页面标签超时，请重新框选。');
                await sleep(100);
                resetShadowRootCache();
              }
            }
            // 标签切换可能异步挂载内容，必须等锚点可见，不能回退到另一页的旧坐标。
            if (region.tabSelectors.length && region.anchorSelector) {
              const deadline = Date.now() + 3000;
              while (true) {
                const anchor = safeQuery(region.anchorSelector);
                if (anchor && anchor.getBoundingClientRect().width > 0 && anchor.getBoundingClientRect().height > 0) break;
                if (Date.now() >= deadline) throw new Error('截图页面内容未就绪，请重新框选。');
                await sleep(100);
              }
            }
          }

          if (region.mode === 'module') {
            if (!window.FeishuModuleCapture) throw new Error('请重新加载扩展并刷新网页。');
            sendResponse(await window.FeishuModuleCapture.prepare(region));
            return;
          }

          let located = locateRegion(region);
          if (!located) {
            sendResponse({ error: '无法定位截图区域：锚点元素已失效且缺少兜底坐标。' });
            return;
          }

          // 先滚动让目标区域进入视口。锚点存在时用 scrollIntoView，
          // 可兼容内部滚动容器；否则按文档坐标居中滚动。
          const anchor = safeQuery(region.anchorSelector);
          if (anchor) {
            anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            // 锚点可能是一整个长容器，应露出选区而不是强行把锚点中心滚入视口。
            const root = document.scrollingElement;
            for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              const bounds = parent === root
                ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
                : parent.getBoundingClientRect();
              const pos = locateRegion(region);
              if (!pos) break;
              const x = pos.x - window.scrollX;
              const y = pos.y - window.scrollY;
              const left = bounds.left + (parent.clientLeft || 0);
              const top = bounds.top + (parent.clientTop || 0);
              const width = parent === root ? window.innerWidth : parent.clientWidth;
              const height = parent === root ? window.innerHeight : parent.clientHeight;
              const dx = x < left ? x - left : x + pos.width > left + width ? x + Math.min(pos.width, width) - left - width : 0;
              const dy = y < top ? y - top : y + pos.height > top + height ? y + Math.min(pos.height, height) - top - height : 0;
              const canX = parent.scrollWidth > parent.clientWidth && (parent === root || /^(auto|scroll|overlay)$/.test(style.overflowX));
              const canY = parent.scrollHeight > parent.clientHeight && (parent === root || /^(auto|scroll|overlay)$/.test(style.overflowY));
              if ((canX && dx) || (canY && dy)) parent.scrollBy({ left: canX ? dx : 0, top: canY ? dy : 0, behavior: 'instant' });
            }
          } else {
            const cx = located.x + located.width / 2;
            const cy = located.y + located.height / 2;
            window.scrollTo({
              left: Math.max(0, Math.round(cx - window.innerWidth / 2)),
              top: Math.max(0, Math.round(cy - window.innerHeight / 2)),
              behavior: 'instant'
            });
          }

          // 等待滚动与懒加载渲染稳定
          await sleep(400);

          // 滚动后重新定位，避免布局位移导致偏差
          located = locateRegion(region) || located;

          const vx = located.x - window.scrollX;
          const vy = located.y - window.scrollY;
          const left = Math.max(0, Math.round(vx));
          const top = Math.max(0, Math.round(vy));
          const right = Math.min(window.innerWidth, Math.round(vx + located.width));
          const bottom = Math.min(window.innerHeight, Math.round(vy + located.height));

          if (right - left < 5 || bottom - top < 5) {
            sendResponse({ error: '目标区域不在当前视口内，无法截图。' });
            return;
          }

          const truncated = right - left < located.width || bottom - top < located.height;

          sendResponse({
            success: true,
            rect: {
              x: left,
              y: top,
              width: right - left,
              height: bottom - top,
              dpr: window.devicePixelRatio || 1
            },
            warning: truncated ? '区域超出可视范围，已截取视口内部分' : null
          });
        } catch (e) {
          sendResponse({ error: e.message || '定位截图区域失败。' });
        }
      })();

      // Return true to indicate we will send response asynchronously
      return true;
    }

    if (request.action === 'EXTRACT_DATA') {
      (async () => {
        try {
          const rule = request.rule;
          if (!rule || !rule.fields) {
            sendResponse({ error: 'No extraction rules provided.' });
            return;
          }

          await activateRuleTab(rule.tabSelector);

          const selectorFields = rule.fields.filter(f => f.type !== 'screenshot' && f.type !== 'current_url' && f.selector);
          const visibleOnly = !!rule.tabSelector;

          // 本次提取的 DOM 可能已变化，shadow root 缓存重新采集
          resetShadowRootCache();

          // 1. 预交互：把「悬停/点击才出现」的节点先唤醒
          let preActed = false;
          let preActionWarning;
          if (rule.preSelector && rule.preType) {
            const preEl = await waitForPreActionTarget(rule.preSelector, rule.preType);
            if (preEl) {
              console.log(`[Scraper] Pre-action: ${rule.preType} on ${rule.preSelector}`);
              runPreAction(preEl, rule.preType);
              preActed = true;
              await sleep(500);
              resetShadowRootCache();
            } else {
              preActionWarning = '预交互元素未就绪，已跳过预交互。';
            }
          }

          // 2. 等字段真正出现，而不是死等固定时长
          // 点击取消补触发后，仍保留原来两轮等待的总时长，兼容慢加载弹层。
          const waitTimeout = preActed ? (rule.preType === 'click' ? 3300 : 1800) : 1200;
          const missing = await waitForFields(selectorFields, waitTimeout, visibleOnly, preActed);

          // 3. 悬停可补触发一次；点击型开关重复点击可能关闭刚打开的弹层。
          if (missing.length > 0 && preActed && rule.preType === 'hover') {
            console.log(`[Scraper] Retry pre-action, still missing ${missing.length} field(s)`);
            const preEl = findPreActionTarget(rule.preSelector, rule.preType);
            if (preEl) {
              runPreAction(preEl, rule.preType);
              await sleep(300);
              await waitForFields(missing, 1200, visibleOnly, true);
            }
          }

          // 4. Extract Data
          resetShadowRootCache();
          const extractedData = {};
          const missingFields = [];

          rule.fields.forEach((field) => {
            // 截图字段由弹窗侧单独走「定位 + 捕获」流程，此处仅占位
            if (field.type === 'screenshot') {
              extractedData[field.name] = null;
              return;
            }

            let value = null;

            if (field.type === 'current_url') {
              value = window.location.href;
            } else if (field.selector) {
              const el = visibleOnly ? queryVisibleField(field.selector) : deepQuery(field.selector);
              if (el) {
                value = readFieldValue(el, field.type);
                if (preActed && !hasFieldValue(value)) {
                  value = null;
                  missingFields.push(field.name);
                }
              } else {
                missingFields.push(field.name);
              }
            } else {
              missingFields.push(field.name);
            }

            extractedData[field.name] = value;
          });

          console.log('[Scraper] Extracted Data:', extractedData, 'missing:', missingFields);
          sendResponse({ success: true, data: extractedData, missing: missingFields, preActionWarning });
        } catch (e) {
          console.error('[Scraper] Extraction Error:', e);
          sendResponse({ error: e.message || 'Unknown Error' });
        }
      })();

      // Return true to indicate we will send response asynchronously
      return true;
    }
  });
}
