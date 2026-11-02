// content.js

if (!window.__FEISHU_SCRAPER_INJECTED) {
  window.__FEISHU_SCRAPER_INJECTED = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 为元素生成尽量稳定且精准的 CSS 选择器。
   * 优先使用 id 作为锚点，其次逐层拼接 tag + class + nth-child。
   */
  function buildSelector(el) {
    const path = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() !== 'html') {
      let sel = node.tagName.toLowerCase();
      if (node.id && !/^\d/.test(node.id)) {
        sel += '#' + node.id;
        path.unshift(sel);
        break;
      }
      let sib = node;
      let nth = 1;
      while ((sib = sib.previousElementSibling)) nth++;
      const classes = Array.from(node.classList)
        .filter((c) => !c.includes(':') && !['hover', 'active', 'focus'].includes(c))
        .join('.');
      if (classes) sel += '.' + classes;
      sel += `:nth-child(${nth})`;
      path.unshift(sel);
      node = node.parentNode;
    }
    return path.join(' > ');
  }

  function safeQuery(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
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
    tip.textContent = '拖拽框选要截图的区域 · Esc 取消';
    tip.style.cssText =
      'position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:2147483647; pointer-events:none; background:#111827; color:#fff; font:13px/1 -apple-system,BlinkMacSystemFont,sans-serif; padding:10px 16px; border-radius:999px; box-shadow:0 8px 24px rgba(0,0,0,0.24);';

    document.body.appendChild(shade);
    document.body.appendChild(box);
    document.body.appendChild(sizeTag);
    document.body.appendChild(tip);

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let current = null;

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
      window.__FEISHU_REGION_ACTIVE = false;
    }

    // 框选过程中禁止滚轮滚动，否则起止坐标会落在不同滚动位置上，导致区域错位
    function onWheel(e) {
      e.preventDefault();
      e.stopPropagation();
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
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
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

      const centerX = sel.left + sel.width / 2;
      const centerY = sel.top + sel.height / 2;
      const stack = document
        .elementsFromPoint(centerX, centerY)
        .filter((el) => el !== shade && el !== box && el !== sizeTag && el !== tip);
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

          let located = locateRegion(region);
          if (!located) {
            sendResponse({ error: '无法定位截图区域：锚点元素已失效且缺少兜底坐标。' });
            return;
          }

          // 先滚动让目标区域进入视口。锚点存在时用 scrollIntoView，
          // 可兼容内部滚动容器；否则按文档坐标居中滚动。
          const anchor = safeQuery(region.anchorSelector);
          if (anchor) {
            anchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
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

          // 1. Execute Pre-Action (Hover or Click) to reveal hidden DOM
          if (rule.preSelector && rule.preType) {
            const preEl = document.querySelector(rule.preSelector);
            if (preEl) {
              console.log(`[Scraper] Executing Pre-action: ${rule.preType} on ${rule.preSelector}`);
              if (rule.preType === 'hover') {
                preEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
                preEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
              } else if (rule.preType === 'click') {
                preEl.click();
              }
              // Wait 800ms to allow DOM to render or network requests to finish
              await new Promise((r) => setTimeout(r, 800));
            } else {
              console.log(`[Scraper] Pre-action element not found: ${rule.preSelector}`);
            }
          }

          // 2. Extract Data
          const extractedData = {};
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
              const el = document.querySelector(field.selector);
              if (el) {
                switch (field.type) {
                  case 'text':
                    value = el.innerText || el.textContent;
                    value = value ? value.trim() : null;
                    break;
                  case 'href':
                    value = el.href || el.getAttribute('href');
                    break;
                  case 'src':
                    value = el.src || el.getAttribute('src');
                    break;
                  case 'html':
                    value = el.innerHTML;
                    break;
                  case 'value':
                    value = el.value;
                    break;
                  default:
                    value = el.innerText || el.textContent;
                    value = value ? value.trim() : null;
                }
              }
            }
            extractedData[field.name] = value;
          });

          console.log('[Scraper] Extracted Data:', extractedData);
          sendResponse({ success: true, data: extractedData });
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
