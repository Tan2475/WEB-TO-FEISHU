// shared/storage.js
// Utility for extension storage management

const StorageKeys = {
  FEISHU_APP_ID: 'FEISHU_APP_ID',
  FEISHU_APP_SECRET: 'FEISHU_APP_SECRET',
  FEISHU_DB_URL: 'FEISHU_DB_URL',
  SCRAPING_RULES: 'SCRAPING_RULES' // Array of rules
};

async function getStorageData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result);
    });
  });
}

async function setStorageData(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => {
      resolve();
    });
  });
}

// Ensure global scope availability if used broadly
if (typeof self !== 'undefined') {
  self.StorageKeys = StorageKeys;
  self.getStorageData = getStorageData;
  self.setStorageData = setStorageData;
}
