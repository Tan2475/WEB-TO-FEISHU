// 本地浏览器夹具，仅模拟 Chrome 边界与最终写入，抓取/切页/合并均运行生产代码。
const demoRules = [
  ['概览', '#overview', '概览指标'], ['商业', '#business', '商业指标'], ['连接', '#connected', '用户指标']
].map(([name, tabSelector, field]) => ({ name, url: '127.0.0.1', tabSelector, matchField: 'ID', fields: [
  { name: 'ID', type: 'current_url' }, { name: field, type: 'text', selector: '.demo-metric' }
] }));
const demoStore = { SCRAPING_RULES: demoRules, FEISHU_DB_URL: 'https://example.feishu.cn/sheets/test?sheet=demo' };
let demoListener;
let writes = 0;
window.chrome = {
  storage: { local: { get: (_keys, cb) => cb(demoStore), set: (data, cb) => { Object.assign(demoStore, data); cb(); } } },
  runtime: {
    onMessage: { addListener: listener => { demoListener = listener; } },
    sendMessage(message, cb) {
      writes++;
      document.getElementById('write-log').textContent = JSON.stringify({ writes, record: message.recordData });
      cb({ success: true, result: { operation: 'created' } });
    }
  },
  tabs: { query: async () => [{ id: 1, url: location.href }], sendMessage: (_id, message, cb) => demoListener(message, {}, cb) }
};
for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => {
  for (const other of document.querySelectorAll('[role="tab"]')) other.setAttribute('aria-selected', String(tab === other));
  document.querySelector('.demo-metric').textContent = tab.textContent + '数据';
});
