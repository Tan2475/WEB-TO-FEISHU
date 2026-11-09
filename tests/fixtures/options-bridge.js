// 只用于本地配置界面预览，不读取或写入扩展的实际配置。
window.chrome = { runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: '1.2.1' }) },
  storage: { local: { get: (_keys, cb) => cb({ SCRAPING_RULES: [{ name: '粉丝画像', url: 'www.xingtu.cn', fields: [
    { name: '性别与年龄分布', type: 'screenshot', region: { mode: 'module', modules: [
      { selector: '#gender', title: '性别分布', tag: 'SECTION', classes: ['card'], headingDepth: 1 },
      { selector: '#age', title: '年龄分布', tag: 'SECTION', classes: ['card'], headingDepth: 1 }
    ], width: 1185, height: 314 } }
  ] }] }), set: (data, cb) => { document.documentElement.dataset.savedRules = JSON.stringify(data.SCRAPING_RULES); cb(); } } } };
