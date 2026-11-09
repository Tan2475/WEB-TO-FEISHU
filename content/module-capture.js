// 模块截图：只按当前 DOM 定位与测量，不回退到历史像素坐标。
(() => {
  if (window.FeishuModuleCapture) return;
  const headings = 'h1,h2,h3,h4,h5,h6,[role="heading"],[class*="title"],[class*="heading"]';
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const visible = el => el && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const query = (root, selector) => { try { return Array.from(root.querySelectorAll(selector)); } catch (_) { return []; } };
  function missing(message) { const error = new Error(message); error.code = 'MODULE_MISSING'; return error; }
  function titles(el) {
    return query(el, headings).filter(h => visible(h) && clean(h.textContent).length > 0 && clean(h.textContent).length <= 100);
  }
  function eligible(el) {
    if (!el || el === document.body || el === document.documentElement || !visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 70 && titles(el).length > 0;
  }
  function candidate(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (eligible(node)) return node;
    }
    return null;
  }
  function describe(el, selectorFor) {
    const heading = titles(el)[0];
    if (!heading) throw new Error('请选择带标题的模块。');
    let depth = 0;
    for (let n = heading; n && n !== el; n = n.parentElement) depth++;
    const scope = el.closest('[role="tabpanel"]');
    return { selector: selectorFor(el), title: clean(heading.textContent), tag: el.tagName,
      classes: Array.from(el.classList).filter(c => !/^(is-|active|selected|css-|jsx-)/.test(c)).slice(0, 6),
      headingDepth: depth, ...(scope ? { scopeSelector: selectorFor(scope) } : {}) };
  }
  function resolve(descriptor) {
    const scope = descriptor.scopeSelector ? query(document, descriptor.scopeSelector).filter(visible) : [document];
    if (scope.length > 1) throw new Error(`模块「${descriptor.title}」所在页面不唯一。`);
    if (!scope.length) throw missing(`找不到模块「${descriptor.title}」所在页面。`);
    const root = scope[0];
    const valid = el => visible(el) && el.tagName === descriptor.tag && titles(el).some(h => clean(h.textContent) === descriptor.title);
    const direct = query(root, descriptor.selector).filter(valid);
    if (direct.length === 1) return direct[0];
    const matches = new Set();
    for (const heading of query(root, headings).filter(h => visible(h) && clean(h.textContent) === descriptor.title)) {
      let best = null, score = -1;
      for (let node = heading.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.tagName === descriptor.tag && eligible(node) && valid(node)) {
          const shared = (descriptor.classes || []).filter(c => Array.from(node.classList).includes(c)).length;
          // 从标题向上找最近的匹配容器；样式特征优先，层级变化不再直接使定位失效。
          if (shared > score) { best = node; score = shared; }
        }
        if (node === root) break;
      }
      if (best) matches.add(best);
    }
    if (matches.size > 1) throw new Error(`找到多个「${descriptor.title}」模块，请重新选择范围。`);
    if (!matches.size) throw missing(`找不到模块「${descriptor.title}」，已跳过。`);
    return [...matches][0];
  }
  function bounds(nodes) {
    const rects = nodes.map(n => n.getBoundingClientRect());
    const x = Math.min(...rects.map(r => r.left));
    const y = Math.min(...rects.map(r => r.top));
    return { x, y, width: Math.max(...rects.map(r => r.right)) - x, height: Math.max(...rects.map(r => r.bottom)) - y };
  }
  async function prepare(region) {
    if (!Array.isArray(region.modules) || !region.modules.length || region.modules.length > 12) throw new Error('模块截图配置无效，请重新选择。');
    const deadline = Date.now() + 6000;
    let previous = '', stable = 0, nodes, box;
    while (true) {
      try { nodes = region.modules.map(resolve); }
      catch (e) {
        if (e.code !== 'MODULE_MISSING' || Date.now() >= deadline) throw e;
        stable = 0; previous = ''; await sleep(120); continue;
      }
      for (const node of nodes) node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      box = bounds(nodes);
      const pending = nodes.some(node => node.getAttribute('aria-busy') === 'true' || query(node, '[aria-busy="true"],.el-loading-mask,img').some(el =>
        visible(el) && (el.tagName !== 'IMG' || !el.complete)));
      const signature = JSON.stringify(Object.values(box).map(n => Math.round(n)));
      stable = !pending && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 5) break;
      if (Date.now() >= deadline) throw new Error('模块仍在加载，请稍后重试。');
      await sleep(120);
    }
    if (box.x < -1 || box.y < -1 || box.x + box.width > window.innerWidth + 1 || box.y + box.height > window.innerHeight + 1) {
      throw new Error('模块超出可视范围，请缩小选择范围或调小网页缩放比例。');
    }
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent), p = parent.getBoundingClientRect();
        if ((/auto|scroll|hidden|clip/.test(style.overflowY) && (r.top < p.top - 1 || r.bottom > p.bottom + 1)) ||
            (/auto|scroll|hidden|clip/.test(style.overflowX) && (r.left < p.left - 1 || r.right > p.right + 1))) {
          throw new Error('模块被滚动区域裁剪，请缩小选择范围。');
        }
      }
    }
    if (box.width < 8 || box.height < 8) throw new Error('模块尺寸无效。');
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    return { success: true, rect: { x, y, width: Math.ceil(box.x + box.width) - x,
      height: Math.ceil(box.y + box.height) - y, dpr: window.devicePixelRatio || 1 }, warning: null };
  }

  function start({ selectorFor, onPicked, onCancel }) {
    if (window.__FEISHU_PICKER_ACTIVE) throw new Error('请先完成当前选择。');
    window.__FEISHU_PICKER_ACTIVE = true;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181b;color-scheme:light}
      *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:0;transition:background .15s}button:focus-visible{outline:3px solid #c4b5fd;outline-offset:2px}button:disabled{opacity:.4;cursor:default}
      .bar{pointer-events:auto;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);width:620px;border:1px solid #e4e4e7;border-radius:18px;background:#fff;box-shadow:0 16px 64px #18181b26;overflow:hidden}
      .top{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #f0f0f3}.title{font-weight:650;display:flex;gap:9px;align-items:center}.icon{color:#7c3aed;display:inline-flex}.status{font-size:12px;color:#71717a;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .actions{display:flex;align-items:center;gap:8px;padding:12px 14px;flex-wrap:wrap}.spacer{flex:1}.quiet{background:#f4f4f5;color:#3f3f46;border-radius:9px;padding:8px 11px}.quiet:hover{background:#e9e9ed}.primary{background:#7c3aed;color:white;border-radius:9px;padding:8px 18px;font-weight:600}.primary:hover{background:#6d28d9}.cancel{background:transparent;color:#71717a;padding:8px}
      .outline{position:fixed;pointer-events:none;border:2px solid #8b5cf6;background:#8b5cf610;border-radius:12px}.selected{border-color:#7c3aed;background:#7c3aed18}.label{position:absolute;top:6px;left:8px;background:#7c3aed;color:white;border-radius:6px;padding:3px 8px;font-size:12px;max-width:90%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.hover{border-style:dashed;background:transparent}
    </style><div class="marks"></div><div class="bar" role="dialog" aria-label="选择截图模块"><div class="top"><div class="title"><span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 9h18M9 9v12"/></svg></span>选择截图模块</div><span class="status" aria-live="polite">点击卡片，多选后完成</span></div><div class="actions"><button class="quiet" data-action="browse">操作网页</button><button class="quiet" data-action="larger" title="扩大到上层容器">扩大范围</button><button class="quiet" data-action="smaller" title="返回上一个范围">缩小范围</button><span class="spacer"></span><button class="cancel" data-action="cancel">取消</button><button class="primary" data-action="done" disabled>完成</button></div></div>`;
    document.documentElement.appendChild(host);
    const marks = shadow.querySelector('.marks'), status = shadow.querySelector('.status');
    const button = action => shadow.querySelector(`[data-action="${action}"]`);
    let hovered = null, history = [], selected = [], browsing = false;
    const ownEvent = e => e.composedPath().includes(host);
    function paint() {
      marks.replaceChildren();
      for (const [node, label, isSelected] of [...selected.map((n, i) => [n, `${i + 1} · ${titles(n)[0]?.textContent || '模块'}`, true]),
        ...(hovered && !browsing && !selected.includes(hovered) ? [[hovered, clean(titles(hovered)[0]?.textContent), false]] : [])]) {
        if (!node.isConnected) continue;
        const r = node.getBoundingClientRect();
        const box = document.createElement('div'); box.className = `outline ${isSelected ? 'selected' : 'hover'}`;
        Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        const tag = document.createElement('span'); tag.className = 'label'; tag.textContent = label;
        box.appendChild(tag); marks.appendChild(box);
      }
      button('done').disabled = !selected.length;
      button('done').textContent = selected.length ? `完成 (${selected.length})` : '完成';
      button('larger').disabled = !hovered || browsing;
      button('smaller').disabled = !history.length || browsing;
    }
    function move(e) {
      if (browsing || ownEvent(e)) return;
      const next = candidate(e.target);
      if (next !== hovered && !(history.length && hovered?.contains(e.target))) { hovered = next; history = []; paint(); }
    }
    function click(e) {
      if (browsing || ownEvent(e)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!hovered) return;
      if (selected.includes(hovered)) selected = selected.filter(n => n !== hovered);
      else {
        if (selected.length >= 12) { status.textContent = '最多选择 12 个模块'; return; }
        selected = selected.filter(n => !n.contains(hovered) && !hovered.contains(n)); selected.push(hovered);
      }
      status.textContent = selected.length ? `已选择 ${selected.length} 个模块` : '点击卡片，多选后完成'; paint();
    }
    function cleanup() {
      host.remove(); window.__FEISHU_PICKER_ACTIVE = false;
      document.removeEventListener('pointermove', move, true); document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true); document.removeEventListener('scroll', paint, true); window.removeEventListener('resize', paint);
    }
    function finish() {
      if (!selected.length) return;
      try {
        const modules = selected.map(n => describe(n, selectorFor));
        const box = bounds(selected);
        const tabSelectors = query(document, '[role="tab"][aria-selected="true"]').filter(visible).map(selectorFor);
        if (tabSelectors.length > 10) throw new Error('页面标签过多，请缩小范围。');
        cleanup(); onPicked({ mode: 'module', modules, width: Math.round(box.width), height: Math.round(box.height),
          ...(tabSelectors.length ? { tabSelectors } : {}) });
      } catch (e) { status.textContent = e.message; }
    }
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); onCancel(); }
      if (e.key === 'Enter' && !browsing && !ownEvent(e)) { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
    }
    button('browse').onclick = () => { browsing = !browsing; hovered = null; history = [];
      button('browse').textContent = browsing ? '选择模块' : '操作网页'; status.textContent = browsing ? '可切换标签或调整页面' : `已选择 ${selected.length} 个模块`; paint(); };
    button('larger').onclick = () => {
      const parent = candidate(hovered?.parentElement);
      if (parent) {
        history.push({ node: hovered, selected: [...selected] });
        if (selected.includes(hovered)) selected = [...selected.filter(n => !parent.contains(n)), parent];
        hovered = parent; status.textContent = `已选择 ${selected.length} 个模块`; paint();
      }
    };
    button('smaller').onclick = () => { if (history.length) { const previous = history.pop(); hovered = previous.node; selected = previous.selected;
      status.textContent = `已选择 ${selected.length} 个模块`; paint(); } };
    button('cancel').onclick = () => { cleanup(); onCancel(); }; button('done').onclick = finish;
    document.addEventListener('pointermove', move, true); document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true); document.addEventListener('scroll', paint, true); window.addEventListener('resize', paint);
    paint();
  }
  window.FeishuModuleCapture = { start, prepare, resolve };
})();
