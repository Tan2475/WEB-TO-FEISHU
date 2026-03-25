// background/background.js

importScripts('../shared/storage.js', '../shared/feishu.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PUSH_TO_FEISHU') {
    (async () => {
      try {
        const { recordData, dbUrl } = request;
        
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

        const result = await self.appendToFeishu(appId, appSecret, dbUrl, recordData);
        sendResponse({ success: true, result });
      } catch (e) {
        console.error('Failed to push to Feishu:', e);
        sendResponse({ success: false, error: e.message || e.toString() });
      }
    })();
    return true; // Indicate async response
  }
});
