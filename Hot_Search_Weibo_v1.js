export default async function(ctx) {
  const widgetFamily = ctx.widgetFamily || 'systemMedium';
  if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
    return simpleWidget('请使用中号或大号组件');
  }

  const platform = String(ctx.env?.PLATFORM || 'weibo').trim() || 'weibo';
  const title = String(ctx.env?.TITLE || '微博热搜').trim() || '微博热搜';
  const count = parseInt(ctx.env?.ITEMS || '', 10) || (widgetFamily === 'systemLarge' ? 10 : 6);
  const policy = ctx.env?.POLICY || '国外网站';

  let items = [];
  let error = '';
  let fromCache = false;

  try {
    items = await fetchHotList(ctx, platform, policy);
  } catch (e) {
    error = shortError(e);
  }

  if (items.length === 0) {
    const cached = ctx.storage.getJSON(`hot_search_${platform}_cache`);
    const cacheTime = ctx.storage.get(`hot_search_${platform}_cache_time`);
    if (cached && cacheTime) {
      const age = Date.now() - parseInt(cacheTime, 10);
      if (age < 6 * 60 * 60 * 1000) {
        items = Array.isArray(cached) ? cached : [];
        fromCache = items.length > 0;
      }
    }
  }

  if (items.length > 0) {
    ctx.storage.setJSON(`hot_search_${platform}_cache`, items);
    ctx.storage.set(`hot_search_${platform}_cache_time`, Date.now().toString());
  }

  return buildWidget({ title, items: items.slice(0, count), error, fromCache });
}

async function fetchHotList(ctx, platform, policy) {
  const url = `https://api-hot.imsyy.top/${encodeURIComponent(platform)}/new`;
  const resp = await ctx.http.get(url, {
    timeout: 12000,
    policy,
    redirect: 'follow',
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 iPhone Egern Widget',
      'Cache-Control': 'no-cache',
    },
  });

  const status = typeof resp.status === 'number' ? resp.status : 200;
  const text = await resp.text();
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  if (!text || !text.trim()) throw new Error('空响应');

  let json;
  try { json = JSON.parse(text.trim().replace(/^\uFEFF/, '')); } catch (_) { throw new Error('非JSON响应'); }

  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.list) ? json.data.list : Array.isArray(json?.list) ? json.list : [];
  const out = [];

  list.forEach((item, index) => {
    const name = String(item.title || item.name || item.word || item.keyword || '').trim();
    if (!name) return;
    let url = String(item.url || item.mobileUrl || item.link || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      url = `https://s.weibo.com/weibo?q=${encodeURIComponent(name)}`;
    }
    const hot = String(item.hot || item.desc || item.description || item.num || '').trim();
    out.push({ title: name, hot, url, rank: index + 1 });
  });

  if (out.length === 0) throw new Error('接口返回0条');
  return uniqueItems(out);
}

function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildWidget({ title, items, error, fromCache }) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const children = [
    {
      type: 'stack', direction: 'row', alignItems: 'center', padding: [0, 0, 6, 0],
      children: [
        { type: 'text', text: `🔥 ${title}`, font: { size: 'subheadline', weight: 'bold' }, textColor: { light: '#1D1D1F', dark: '#F5F5F7' }, flex: 1, maxLines: 1 },
        { type: 'text', text: `${fromCache ? '缓存 ' : ''}${timeStr}`, font: { size: 'caption2' }, textColor: { light: '#86868B', dark: '#8E8E93' } },
      ],
    },
  ];

  if (!items || items.length === 0) {
    children.push({ type: 'text', text: `暂无热搜数据\n${error || '请稍后再试'}`, font: { size: 'callout' }, textColor: { light: '#666666', dark: '#AAAAAA' }, textAlign: 'center', padding: [18, 0], maxLines: 3 });
  } else {
    items.forEach((item) => {
      children.push({
        type: 'stack', direction: 'row', alignItems: 'center', gap: 8, url: item.url, padding: [3, 0],
        children: [
          { type: 'text', text: String(item.rank), font: { size: 'caption1', weight: 'bold' }, textColor: item.rank <= 3 ? '#FF3B30' : { light: '#86868B', dark: '#8E8E93' }, width: 18, maxLines: 1 },
          { type: 'text', text: item.title, font: { size: 'subheadline' }, textColor: { light: '#1D1D1F', dark: '#F5F5F7' }, flex: 1, maxLines: 1, minScale: 0.8 },
          { type: 'text', text: item.hot, font: { size: 'caption2' }, textColor: { light: '#999999', dark: '#888888' }, maxLines: 1, minScale: 0.7 },
        ],
      });
    });
  }

  return { type: 'widget', padding: [10, 12, 10, 12], gap: 3, backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' }, refreshAfter: new Date(Date.now() + 15 * 60 * 1000).toISOString(), children };
}

function shortError(e) {
  const msg = String(e?.message || e || '请求失败');
  return msg.length > 26 ? msg.substring(0, 26) + '...' : msg;
}

function simpleWidget(message) {
  return { type: 'widget', padding: 16, backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' }, children: [{ type: 'text', text: message, font: { size: 'callout' }, textColor: { light: '#1D1D1F', dark: '#F5F5F7' }, textAlign: 'center' }] };
}
