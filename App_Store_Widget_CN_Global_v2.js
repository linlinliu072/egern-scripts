export default async function(ctx) {
  const widgetFamily = ctx.widgetFamily || 'systemMedium';
  if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
    return simpleWidget('请使用中号或大号组件');
  }

  const cnLimitDefault = widgetFamily === 'systemLarge' ? 6 : 3;
  const globalLimitDefault = widgetFamily === 'systemLarge' ? 6 : 3;
  const cnLimit = parseInt(ctx.env?.CN_ITEMS || ctx.env?.cnItems || '', 10) || cnLimitDefault;
  const globalLimit = parseInt(ctx.env?.GLOBAL_ITEMS || ctx.env?.globalItems || '', 10) || globalLimitDefault;
  const cnPolicy = ctx.env?.CN_POLICY || 'DIRECT';
  const globalPolicy = ctx.env?.GLOBAL_POLICY || '国外网站';

  let result = {
    cn: [],
    global: [],
    errors: { cn: '', global: '' },
    fromCache: false,
  };

  try {
    result = await fetchBothSources(ctx, cnPolicy, globalPolicy);
  } catch (e) {
    result.errors.cn = result.errors.cn || shortError(e);
    result.errors.global = result.errors.global || shortError(e);
  }

  if (result.cn.length === 0 && result.global.length === 0) {
    const cached = ctx.storage.getJSON('appstore_both_cache_v2');
    const cacheTime = ctx.storage.get('appstore_both_cache_v2_time');
    if (cached && cacheTime) {
      const age = Date.now() - parseInt(cacheTime, 10);
      if (age < 24 * 60 * 60 * 1000) {
        result.cn = Array.isArray(cached.cn) ? cached.cn : [];
        result.global = Array.isArray(cached.global) ? cached.global : [];
        result.fromCache = true;
      }
    }
  }

  if (result.cn.length > 0 || result.global.length > 0) {
    ctx.storage.setJSON('appstore_both_cache_v2', { cn: result.cn, global: result.global });
    ctx.storage.set('appstore_both_cache_v2_time', Date.now().toString());
  }

  return buildWidget({
    cn: result.cn.slice(0, cnLimit),
    global: result.global.slice(0, globalLimit),
    totalCn: result.cn.length,
    totalGlobal: result.global.length,
    errors: result.errors,
    fromCache: result.fromCache,
  });
}

async function fetchBothSources(ctx, cnPolicy, globalPolicy) {
  const result = { cn: [], global: [], errors: { cn: '', global: '' }, fromCache: false };
  const sources = [
    { key: 'cn', url: 'https://api.zxki.cn/api/appfree', policy: cnPolicy, parser: parseZXKI },
    { key: 'global', url: 'https://api.03k.org/app/free', policy: globalPolicy, parser: parseGeneric },
  ];

  await Promise.allSettled(sources.map(async source => {
    try {
      const json = await requestJSON(ctx, source.url, source.policy);
      let apps = source.parser(json);
      if (!apps || apps.length === 0) apps = deepExtractApps(json);
      result[source.key] = uniqueApps(apps);
      if (result[source.key].length === 0) result.errors[source.key] = '接口返回0条';
    } catch (e) {
      result.errors[source.key] = shortError(e);
    }
  }));

  return result;
}

async function requestJSON(ctx, url, policy) {
  const resp = await ctx.http.get(url, {
    timeout: 12000,
    policy: policy,
    redirect: 'follow',
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 iPhone Egern Widget',
    },
  });

  const status = typeof resp.status === 'number' ? resp.status : 200;
  const text = await resp.text();
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
  if (!text || !text.trim()) {
    throw new Error('空响应');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('非JSON响应');
  }
}

function parseZXKI(json) {
  const apps = [];
  if (json && json.apps && typeof json.apps === 'object') {
    for (const cat in json.apps) {
      const items = json.apps[cat];
      if (Array.isArray(items)) {
        items.forEach(item => {
          const app = normalizeApp(item?.name || item?.title, item?.url || item?.link);
          if (app) apps.push(app);
        });
      }
    }
  }
  return apps;
}

function parseGeneric(json) {
  const items = firstArray(json, ['data', 'apps', 'list', 'result', 'items', 'free']);
  const apps = [];
  if (Array.isArray(items)) {
    items.forEach(item => {
      const app = normalizeApp(item?.name || item?.title || item?.app_name || item?.trackName, item?.url || item?.link || item?.trackViewUrl || item?.appUrl);
      if (app) apps.push(app);
    });
  }
  return apps;
}

function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

function deepExtractApps(obj) {
  const apps = [];
  const visited = new Set();

  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    const name = value.name || value.title || value.app_name || value.trackName || value.track_name;
    const url = value.url || value.link || value.trackViewUrl || value.appUrl || value.app_url;
    const app = normalizeApp(name, url);
    if (app) apps.push(app);

    Object.keys(value).forEach(key => walk(value[key]));
  }

  walk(obj);
  return apps;
}

function normalizeApp(rawName, rawUrl) {
  let name = String(rawName || '').trim();
  let url = String(rawUrl || '').trim();

  if (!name && /apps\.apple\.com/i.test(url)) name = 'App Store 限免应用';
  if (!name) return null;

  name = name.replace(/\/\//g, ' — ');
  name = name.replace(/\s*\[.*?\]/g, '');
  const httpsIndex = name.toLowerCase().lastIndexOf('http');
  if (httpsIndex !== -1) name = name.substring(0, httpsIndex).trim();
  name = name.replace(/[\s—]+$/g, '').trim();
  if (!name) return null;
  if (name.length > 46) name = name.substring(0, 46).trim() + '...';

  const searchName = name.split(' — ')[0].trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://apps.apple.com/search?term=${encodeURIComponent(searchName)}`;
  }

  return { name, url, isFree: true };
}

function uniqueApps(apps) {
  const seen = new Set();
  const out = [];
  for (const app of apps || []) {
    const key = String(app.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(app);
  }
  return out;
}

function shortError(e) {
  const msg = String(e?.message || e || '请求失败');
  return msg.length > 24 ? msg.substring(0, 24) + '...' : msg;
}

function buildWidget({ cn, global, totalCn, totalGlobal, errors, fromCache }) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const children = [];

  children.push({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    padding: [0, 0, 6, 0],
    children: [
      {
        type: 'text',
        text: `🎁 iOS 限免 · 国内${totalCn} / 国外${totalGlobal}`,
        font: { size: 'subheadline', weight: 'bold' },
        textColor: { light: '#1D1D1F', dark: '#F5F5F7' },
        flex: 1,
        maxLines: 1,
        minScale: 0.75,
      },
      {
        type: 'text',
        text: `${fromCache ? '缓存 ' : ''}${timeStr}`,
        font: { size: 'caption2' },
        textColor: { light: '#86868B', dark: '#8E8E93' },
      },
    ],
  });

  if (cn.length === 0 && global.length === 0) {
    const cnErr = errors?.cn || '无数据';
    const glErr = errors?.global || '无数据';
    children.push({
      type: 'text',
      text: `接口未取到数据\n国内：${cnErr}\n国外：${glErr}`,
      font: { size: 'callout' },
      textColor: { light: '#666666', dark: '#AAAAAA' },
      textAlign: 'center',
      padding: [16, 0],
      maxLines: 4,
      minScale: 0.8,
    });
  } else {
    addSection(children, '🇨🇳 国内限免', cn);
    addSection(children, '🌍 国外限免', global);
  }

  return {
    type: 'widget',
    padding: [10, 12, 10, 12],
    gap: 4,
    backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' },
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children,
  };
}

function addSection(children, title, apps) {
  children.push({
    type: 'text',
    text: title,
    font: { size: 'caption1', weight: 'semibold' },
    textColor: { light: '#666666', dark: '#AAAAAA' },
    padding: [4, 0, 2, 0],
  });

  if (apps.length === 0) {
    children.push({
      type: 'text',
      text: '暂无数据',
      font: { size: 'caption1' },
      textColor: { light: '#999999', dark: '#888888' },
      padding: [2, 0, 4, 0],
    });
    return;
  }

  apps.forEach((app, index) => {
    if (index > 0) {
      children.push({
        type: 'stack',
        height: 0.5,
        backgroundColor: { light: '#E5E5EA', dark: '#3A3A3C' },
        margin: [3, 0],
      });
    }

    children.push({
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 8,
      url: app.url,
      padding: [3, 0],
      children: [
        {
          type: 'text',
          text: app.name,
          font: { size: 'subheadline' },
          textColor: { light: '#1D1D1F', dark: '#F5F5F7' },
          flex: 1,
          maxLines: 1,
          minScale: 0.8,
        },
        {
          type: 'text',
          text: '限免',
          font: { size: 'caption2', weight: 'semibold' },
          textColor: '#34C759',
          maxLines: 1,
        },
        {
          type: 'image',
          src: 'sf-symbol:chevron.right',
          width: 11,
          height: 11,
          color: { light: '#86868B', dark: '#8E8E93' },
        },
      ],
    });
  });
}

function simpleWidget(message) {
  return {
    type: 'widget',
    padding: 16,
    backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' },
    children: [
      {
        type: 'text',
        text: message,
        font: { size: 'callout' },
        textColor: { light: '#1D1D1F', dark: '#F5F5F7' },
        textAlign: 'center',
      },
    ],
  };
}
