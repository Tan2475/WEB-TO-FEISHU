// background/background.js

importScripts('../shared/storage.js', '../shared/feishu.js');

/**
 * Blob -> dataURL。Service Worker 不提供 FileReader，这里走 ArrayBuffer + btoa 分段编码。
 */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/**
 * 截取当前视口，并按目标矩形（CSS px）裁剪后返回 dataURL。
 * captureVisibleTab 产出的位图尺寸为「视口尺寸 × devicePixelRatio」，
 * 因此裁剪坐标需要同步乘以 dpr。
 */
async function captureRegion(tabId, rect) {
  const tab = await chrome.tabs.get(tabId);
  const viewportDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  const sourceBlob = await (await fetch(viewportDataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);

  const dpr = rect.dpr || 1;
  let sx = Math.round(rect.x * dpr);
  let sy = Math.round(rect.y * dpr);
  let sw = Math.round(rect.width * dpr);
  let sh = Math.round(rect.height * dpr);

  // 边界收敛，避免坐标越界导致 drawImage 抛错
  sx = Math.min(Math.max(sx, 0), Math.max(bitmap.width - 1, 0));
  sy = Math.min(Math.max(sy, 0), Math.max(bitmap.height - 1, 0));
  sw = Math.max(1, Math.min(sw, bitmap.width - sx));
  sh = Math.max(1, Math.min(sh, bitmap.height - sy));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(croppedBlob);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'CAPTURE_REGION') {
    (async () => {
      try {
        const tabId = request.tabId || (sender.tab && sender.tab.id);
        if (!tabId) throw new Error('缺少目标标签页 ID。');
        if (!request.rect) throw new Error('缺少截图区域参数。');

        const dataUrl = await captureRegion(tabId, request.rect);
        sendResponse({ success: true, dataUrl });
      } catch (e) {
        console.error('[Scraper] 区域截图失败:', e);
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (request.action === 'PUSH_TO_FEISHU') {
    (async () => {
      try {
        const { recordData, dbUrl, screenshots } = request;

        // Retrieve settings
        const settings = await self.getStorageData([
          self.StorageKeys.FEISHU_APP_ID,
          self.StorageKeys.FEISHU_APP_SECRET
        ]);

        const appId = settings[self.StorageKeys.FEISHU_APP_ID];
        const appSecret = settings[self.StorageKeys.FEISHU_APP_SECRET];

        if (!appId || !appSecret) {
          throw new Error('Feishu API is not fully configured in Options.');
        }

        if (!dbUrl) {
          throw new Error('Feishu DB URL is required.');
        }

        const result = await self.appendToFeishu(appId, appSecret, dbUrl, recordData, screenshots || {});
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('Failed to push to Feishu:', e);
        sendResponse({ success: false, error: e.message || e.toString() });
      }
    })();
    return true; // Indicate async response
  }
});
