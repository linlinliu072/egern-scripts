export default async function(ctx) {
  const widgetFamily = ctx.widgetFamily || 'systemMedium';
  if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
    return simpleWidget('请使用中号或大号组件');
  }

  const cnLimitDefault = widgetFamily === 'systemLarge' ? 6 : 3;
  const globalLimitDefault = widgetFamily === 'systemLarge' ? 6 : 3;
  const cnLimit = parseInt(ctx.env?.CN_ITEMS || ctx.env?.cnItems || '', 10) || cnLimitDefault;
  const globalLimit = parseInt(ctx.env?.GLOBAL_ITEMS || ctx.env?.globalItems || '', 10) || globalLimitDefault;
  const cnPolicy = ctx.env?.CN_POLICY || '国外网站';
  const globalPolicy = ctx.env?.GLOBAL_POLICY || '国外网站';
  const globalCountry = String(ctx.env?.GLOBAL_COUNTRY || 'us').toLowerCase();

  let result = { cn: [], global: [], errors: { cn: '', global: '' }, fromCache: false, globalLabel: '国外免费榜' };

  try {
    result = await fetchAll(ctx, { cnPolicy, globalPolicy, globalCountry });
  } catch (e) {
    result.errors.cn = result.errors.cn || shortError(e);
    result.errors.global = result.errors.global || shortError(e);
  }

  if (result.cn.length === 0 && result.global.length === 0) {
    const cached = ctx.storage.getJSON('appstore_cn_global_v3_cache');
    const cacheTime = ctx.storage.get('appstore_cn_global_v3_cache_time');
    if (cached && cacheTime) {
      const age = Date.now() - parseInt(cacheTime, 10);
      if (age < 24 * 60 * 60 * 1000) {
        result.cn = Array.isArray(cached.cn) ? cached.cn : [];
        result.global = Array.isArray(cached.global) ? cached.global : [];
        result.globalLabel = cached.globalLabel || result.globalLabel;
        result.fromCache = true;
      }
    }
  }

  if (result.cn.length > 0 || result.global.length > 0) {
    ctx.storage.setJSON('appstore_cn_global_v3_cache', { cn: result.cn, global: result.global, globalLabel: result.globalLabel });
    ctx.storage.set('appstore_cn_global_v3_cache_time', Date.now().toString());
  }

  return buildWidget({
    cn: result.cn.slice(0, cnLimit),
    global: result.global.slice(0, globalLimit),
    totalCn: result.cn.length,
    totalGlobal: result.global.length,
    errors: result.errors,
    fromCache: result.fromCache,
    globalLabel: result.globalLabel,
  });
}

async function fetchAll(ctx, options) {
  const result = { cn: [], global: [], errors: { cn: '', global: '' }, fromCache: false, globalLabel: '国外免费榜' };

  const cnPolicies = uniqueValues([options.cnPolicy, '国外网站', 'DIRECT', 'iBL3ND']);
  const globalPolicies = uniqueValues([options.globalPolicy, '国外网站', '美国节点', '香港节点', 'DIRECT']);

  const cnSources = [
    { url: 'https://api.zxki.cn/api/appfree', parser: parseZXKIFromAnyText, name: 'zxki接口' },
    { url: 'https://api.zxki.cn/doc/appfree.html', parser: parseZXKIDocText, name: 'zxki文档备用' },
  ];

  const country = /^[a-z]{2}$/.test(options.globalCountry) ? options.globalCountry : 'us';
  const globalSources = [
    { url: `https://rss.applemarketingtools.com/api/v2/${country}/apps/top-free/25/apps.json`, parser: parseAppleRSS, name: `Apple ${country.toUpperCase()}` },
    { url: 'https://rss.applemarketingtools.com/api/v2/us/apps/top-free/25/apps.json', parser: parseAppleRSS, name: 'Apple US' },
    { url: 'https://rss.applemarketingtools.com/api/v2/hk/apps/top-free/25/apps.json', parser: parseAppleRSS, name: 'Apple HK' },
  ];

  const cnResult = await trySources(ctx, cnSources, cnPolicies);
  result.cn = cnResult.apps;
  result.errors.cn = cnResult.error;

  const globalResult = await trySources(ctx, globalSources, globalPolicies);
  result.global = globalResult.apps;
  result.globalLabel = globalResult.sourceName ? `国外免费榜 · ${globalResult.sourceName}` : '国外免费榜';
  result.errors.global = globalResult.error;

  return result;
}

async function trySources(ctx, sources, policies) {
  let lastError = '无数据';
  for (const source of sources) {
    for (const policy of policies) {
      try {
        const text = await requestText(ctx, source.url, policy);
        const apps = uniqueApps(source.parser(text));
        if (apps.length > 0) {
          return { apps, error: '', sourceName: source.name };
        }
        lastError = `${source.name}: 0条`;
      } catch (e) {
        lastError = `${source.name}: ${shortError(e)}`;
      }
    }
  }
  return { apps: [], error: lastError, sourceName: '' };
}

async function requestText(ctx, url, policy) {
  const resp = await ctx.http.get(url, {
    timeout: 15000,
    policy,
    redirect: 'follow',
    headers: {
      'Accept': 'application/json,text/plain,text/html,*/*',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 EgernWidget/1.0',
      'Cache-Control': 'no-cache',
    },
  });

  const status = typeof resp.status === 'number' ? resp.status : 200;
  const text = await resp.text();
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  if (!text || !text.trim()) throw new Error('空响应');
  return text.trim();
}

function parseZXKIFromAnyText(text) {
  const json = parseLooseJSON(text);
  return parseZXKIJSON(json);
}

function parseZXKIDocText(text) {
  const decoded = decodeHtml(text);
  const match = decoded.match(/\{\s*"apps"\s*:\s*\{[\s\S]*?"last_updated"\s*:\s*"[^"]+"\s*\}/);
  if (!match) return [];
  const json = parseLooseJSON(match[0]);
  return parseZXKIJSON(json);
}

function parseZXKIJSON(json) {
  const apps = [];
  if (json && json.apps && typeof json.apps === 'object') {
    for (const cat in json.apps) {
      const items = json.apps[cat];
      if (Array.isArray(items)) {
        items.forEach(item => {
          const app = normalizeApp(item?.name || item?.title, item?.url || item?.link, '限免');
          if (app) apps.push(app);
        });
      }
    }
  }
  if (apps.length === 0) return deepExtractApps(json, '限免');
  return apps;
}

function parseAppleRSS(text) {
  const json = parseLooseJSON(text);
  const results = json?.feed?.results || json?.feed?.entry || [];
  const apps = [];
  if (Array.isArray(results)) {
    results.forEach(item => {
      const app = normalizeApp(
        item?.name || item?.title || item?.['im:name']?.label,
        item?.url || item?.link || item?.id,
        '免费'
      );
      if (app) apps.push(app);
    });
  }
  return apps;
}

function parseLooseJSON(text) {
  let body = String(text || '').trim().replace(/^\uFEFF/, '');
  try { return JSON.parse(body); } catch (_) {}

  body = decodeHtml(body);
  try { return JSON.parse(body); } catch (_) {}

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const maybe = body.slice(start, end + 1);
    return JSON.parse(maybe);
  }
  throw new Error('非JSON响应');
}

function deepExtractApps(obj, tag) {
  const apps = [];
  const visited = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    const name = value.name || value.title || value.app_name || value.trackName || value.track_name;
    const url = value.url || value.link || value.trackViewUrl || value.appUrl || value.app_url;
    const app = normalizeApp(name, url, tag);
    if (app) apps.push(app);
    Object.keys(value).forEach(key => walk(value[key]));
  }
  walk(obj);
  return apps;
}

function normalizeApp(rawName, rawUrl, tag) {
  let name = String(rawName || '').trim();
  let url = String(rawUrl || '').trim();
  if (!name && /apps\.apple\.com/i.test(url)) name = 'App Store 应用';
  if (!name) return null;

  name = decodeHtml(name);
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
  if (!/^https?:\/\//i.test(url)) url = 'https://apps.apple.com/';

  return { name, url, tag: tag || '免费' };
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

function uniqueValues(values) {
  const out = [];
  values.forEach(value => {
    value = String(value || '').trim();
    if (value && !out.includes(value)) out.push(value);
  });
  return out;
}

function decodeHtml(input) {
  return String(input || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

function shortError(e) {
  const msg = String(e?.message || e || '请求失败');
  return msg.length > 28 ? msg.substring(0, 28) + '...' : msg;
}

function buildWidget({ cn, global, totalCn, totalGlobal, errors, fromCache, globalLabel }) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const children = [];

  children.push({
    type: 'stack', direction: 'row', alignItems: 'center', padding: [0, 0, 6, 0],
    children: [
      { type: 'text', text: `🎁 iOS 限免/免费 · 国内${totalCn} / 国外${totalGlobal}`, font: { size: 'subheadline', weight: 'bold' }, textColor: { light: '#1D1D1F', dark: '#F5F5F7' }, flex: 1, maxLines: 1, minScale: 0.7 },
      { type: 'text', text: `${fromCache ? '缓存 ' : ''}${timeStr}`, font: { size: 'caption2' }, textColor: { light: '#86868B', dark: '#8E8E93' } },
    ],
  });

  if (cn.length === 0 && global.length === 0) {
    children.push({
      type: 'text',
      text: `接口未取到数据\n国内：${errors?.cn || '无数据'}\n国外：${errors?.global || '无数据'}`,
      font: { size: 'callout' },
      textColor: { light: '#666666', dark: '#AAAAAA' },
      textAlign: 'center',
      padding: [16, 0],
      maxLines: 4,
      minScale: 0.8,
    });
  } else {
    addSection(children, '🇨🇳 国内限免', cn);
    addSection(children, `🌍 ${globalLabel || '国外免费榜'}`, global);
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
  children.push({ type: 'text', text: title, font: { size: 'caption1', weight: 'semibold' }, textColor: { light: '#666666', dark: '#AAAAAA' }, padding: [4, 0, 2, 0], maxLines: 1, minScale: 0.8 });

  if (apps.length === 0) {
    children.push({ type: 'text', text: '暂无数据', font: { size: 'caption1' }, textColor: { light: '#999999', dark: '#888888' }, padding: [2, 0, 4, 0] });
    return;
  }

  apps.forEach((app, index) => {
    if (index > 0) children.push({ type: 'stack', height: 0.5, backgroundColor: { light: '#E5E5EA', dark: '#3A3A3C' }, margin: [3, 0] });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center', gap: 8, url: app.url, padding: [3, 0],
      children: [
        { type: 'text', text: app.name, font: { size: 'subheadline' }, textColor: { light: '#1D1D1F', dark: '#F5F5F7' }, flex: 1, maxLines: 1, minScale: 0.8 },
        { type: 'text', text: app.tag || '免费', font: { size: 'caption2', weight: 'semibold' }, textColor: '#34C759', maxLines: 1 },
        { type: 'text', text: '›', font: { size: 'subheadline', weight: 'bold' }, textColor: { light: '#86868B', dark: '#8E8E93' } },
      ],
    });
  });
}

function simpleWidget(message) {
  return { type: 'widget', padding: 16, backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' }, children: [{ type: 'text', text: message, font: { size: 'callout' }, textColor: { light: '#1D1D1F', dark: '#F5F5F7' }, textAlign: 'center' }] };
}
