// content.js

if (!window.__FEISHU_SCRAPER_INJECTED) {
  window.__FEISHU_SCRAPER_INJECTED = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_PICKING') {
      if (window.__FEISHU_PICKER_ACTIVE) return;
      window.__FEISHU_PICKER_ACTIVE = true;
      
      const highlightOverlay = document.createElement('div');
      highlightOverlay.style.cssText = 'position:fixed; pointer-events:none; z-index:9999999; background:rgba(147, 51, 234, 0.3); border:2px solid #9333ea; transition:all 0.05s linear; border-radius:3px; box-shadow: 0 0 10px rgba(147,51,234,0.5);';
      document.body.appendChild(highlightOverlay);

      const onOver = (e) => {
        const rect = e.target.getBoundingClientRect();
        highlightOverlay.style.top = rect.top + 'px';
        highlightOverlay.style.left = rect.left + 'px';
        highlightOverlay.style.width = rect.width + 'px';
        highlightOverlay.style.height = rect.height + 'px';
      };

      const getSelector = (el) => {
        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE && el.tagName.toLowerCase() !== 'html') {
          let sel = el.tagName.toLowerCase();
          if (el.id && !/^\d/.test(el.id)) { // basic check for valid css id
            sel += '#' + el.id;
            path.unshift(sel);
            break;
          } else {
            let sib = el, nth = 1;
            while (sib = sib.previousElementSibling) nth++;
            // Try to add classes for robustness
            let classes = Array.from(el.classList).filter(c => !c.includes(':') && !['hover', 'active', 'focus'].includes(c)).join('.');
            if (classes) sel += '.' + classes;
            sel += `:nth-child(${nth})`;
          }
          path.unshift(sel);
          el = el.parentNode;
        }
        return path.join(' > ');
      };

      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        document.removeEventListener('mouseover', onOver, true);
        document.removeEventListener('click', onClick, true);
        if (highlightOverlay.parentNode) highlightOverlay.parentNode.removeChild(highlightOverlay);
        window.__FEISHU_PICKER_ACTIVE = false;

        const selector = getSelector(e.target);
        chrome.runtime.sendMessage({ action: 'PICKED_SELECTOR', selector: selector });
      };

      document.addEventListener('mouseover', onOver, true);
      document.addEventListener('click', onClick, true);
      return;
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
                preEl.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, cancelable: true, view: window}));
                preEl.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true, cancelable: true, view: window}));
              } else if (rule.preType === 'click') {
                preEl.click();
              }
              // Wait 800ms to allow DOM to render or network requests to finish
              await new Promise(r => setTimeout(r, 800));
            } else {
              console.log(`[Scraper] Pre-action element not found: ${rule.preSelector}`);
            }
          }

          // 2. Extract Data
          const extractedData = {};
          rule.fields.forEach(field => {
            let value = null;
            
            if (field.type === 'current_url') {
              value = window.location.href;
            } else if (field.selector) {
              const el = document.querySelector(field.selector);
              if (el) {
                switch(field.type) {
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
