export default async function(ctx) {
  const widgetFamily = ctx.widgetFamily || 'systemMedium';

  if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
    return simpleWidget('请使用中号或大号组件');
  }

  const cnLimitDefault = widgetFamily === 'systemLarge' ? 6 : 3;
  const globalLimitDefault = widgetFamily === 'systemLarge' ? 6 : 3;

  const cnLimit = parseInt(ctx.env?.CN_ITEMS || ctx.env?.cnItems || '', 10) || cnLimitDefault;
  const globalLimit = parseInt(ctx.env?.GLOBAL_ITEMS || ctx.env?.globalItems || '', 10) || globalLimitDefault;

  let data = { cn: [], global: [] };
  let source = 'api';

  try {
    data = await fetchBothSources(ctx);
  } catch (e) {
    console.log('Fetch both sources error:', e.message || String(e));
  }

  if (data.cn.length === 0 && data.global.length === 0) {
    const cached = ctx.storage.getJSON('appstore_both_cache');
    const cacheTime = ctx.storage.get('appstore_both_cache_time');

    if (cached && cacheTime) {
      const age = Date.now() - parseInt(cacheTime, 10);
      if (age < 24 * 60 * 60 * 1000) {
        data = cached;
        source = 'cache';
      }
    }
  }

  if (data.cn.length > 0 || data.global.length > 0) {
    ctx.storage.setJSON('appstore_both_cache', data);
    ctx.storage.set('appstore_both_cache_time', Date.now().toString());
  }

  return buildWidget({
    cn: data.cn.slice(0, cnLimit),
    global: data.global.slice(0, globalLimit),
    totalCn: data.cn.length,
    totalGlobal: data.global.length,
    source,
  });
}

async function fetchBothSources(ctx) {
  const sources = [
    {
      key: 'cn',
      label: '国内',
      url: 'https://api.zxki.cn/api/appfree',
      parse: parseZXKI,
    },
    {
      key: 'global',
      label: '国外',
      url: 'https://api.03k.org/app/free',
      parse: parseGeneric,
    },
  ];

  const result = { cn: [], global: [] };

  const tasks = sources.map(async source => {
    try {
      const resp = await ctx.http.get(source.url, { timeout: 8000 });
      const json = await resp.json();
      const apps = source.parse(json).map(app => ({
        ...app,
        region: source.label,
      }));
      result[source.key] = uniqueApps(apps);
    } catch (e) {
      console.log(`${source.label} source error:`, e.message || String(e));
    }
  });

  await Promise.allSettled(tasks);
  return result;
}

function parseZXKI(json) {
  const apps = [];

  if (json && json.apps) {
    for (const cat in json.apps) {
      const items = json.apps[cat];
      if (Array.isArray(items)) {
        items.forEach(item => {
          const app = normalizeApp(item?.name, item?.url);
          if (app) apps.push(app);
        });
      }
    }
  }

  return apps;
}

function parseGeneric(json) {
  const apps = [];
  const items = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];

  items.forEach(item => {
    const app = normalizeApp(item?.name || item?.title, item?.url || item?.link);
    if (app) apps.push(app);
  });

  return apps;
}

function normalizeApp(rawName, rawUrl) {
  let name = String(rawName || '').trim();
  if (!name) return null;

  name = name.replace(/\/\//g, ' — ');
  name = name.replace(/\s*\[.*?\]/g, '');

  const httpsIndex = name.toLowerCase().lastIndexOf('http');
  if (httpsIndex !== -1) {
    name = name.substring(0, httpsIndex).trim();
  }

  name = name.replace(/[\s—]+$/, '').trim();

  if (!name) return null;

  if (name.length > 46) {
    name = name.substring(0, 46).trim() + '...';
  }

  const searchName = name.split(' — ')[0].trim();
  let url = String(rawUrl || '').trim();

  if (!/^https?:\/\//i.test(url)) {
    url = `https://apps.apple.com/search?term=${encodeURIComponent(searchName)}`;
  }

  return {
    name,
    url,
    isFree: true,
  };
}

function uniqueApps(apps) {
  const seen = new Set();
  const out = [];

  for (const app of apps) {
    const key = app.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(app);
    }
  }

  return out;
}

function buildWidget({ cn, global, totalCn, totalGlobal, source }) {
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
        font: {
          size: 'subheadline',
          weight: 'bold',
        },
        textColor: {
          light: '#1D1D1F',
          dark: '#F5F5F7',
        },
        flex: 1,
        maxLines: 1,
        minScale: 0.75,
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          {
            type: 'image',
            src: 'sf-symbol:arrow.clockwise',
            width: 14,
            height: 14,
            color: {
              light: '#86868B',
              dark: '#8E8E93',
            },
          },
          {
            type: 'text',
            text: timeStr,
            font: {
              size: 'caption2',
            },
            textColor: {
              light: '#86868B',
              dark: '#8E8E93',
            },
          },
        ],
      },
    ],
  });

  if (cn.length === 0 && global.length === 0) {
    children.push({
      type: 'text',
      text: '暂无限免应用\n\n请检查网络或稍后再试',
      font: {
        size: 'callout',
      },
      textColor: {
        light: '#666666',
        dark: '#AAAAAA',
      },
      textAlign: 'center',
      padding: [20, 0],
    });
  } else {
    addSection(children, '🇨🇳 国内限免', cn);
    addSection(children, '🌍 国外限免', global);
  }

  return {
    type: 'widget',
    padding: [10, 12, 10, 12],
    gap: 4,
    backgroundColor: {
      light: '#FFFFFF',
      dark: '#2C2C2E',
    },
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children,
  };
}

function addSection(children, title, apps) {
  children.push({
    type: 'text',
    text: title,
    font: {
      size: 'caption1',
      weight: 'semibold',
    },
    textColor: {
      light: '#666666',
      dark: '#AAAAAA',
    },
    padding: [4, 0, 2, 0],
  });

  if (apps.length === 0) {
    children.push({
      type: 'text',
      text: '暂无数据',
      font: {
        size: 'caption1',
      },
      textColor: {
        light: '#999999',
        dark: '#888888',
      },
      padding: [2, 0, 4, 0],
    });
    return;
  }

  apps.forEach((app, index) => {
    if (index > 0) {
      children.push({
        type: 'stack',
        height: 0.5,
        backgroundColor: {
          light: '#E5E5EA',
          dark: '#3A3A3C',
        },
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
          font: {
            size: 'subheadline',
          },
          textColor: {
            light: '#1D1D1F',
            dark: '#F5F5F7',
          },
          flex: 1,
          maxLines: 1,
          minScale: 0.8,
        },
        {
          type: 'text',
          text: '限免',
          font: {
            size: 'caption2',
            weight: 'semibold',
          },
          textColor: '#34C759',
          maxLines: 1,
        },
        {
          type: 'image',
          src: 'sf-symbol:chevron.right',
          width: 11,
          height: 11,
          color: {
            light: '#86868B',
            dark: '#8E8E93',
          },
        },
      ],
    });
  });
}

function simpleWidget(message) {
  return {
    type: 'widget',
    padding: 16,
    backgroundColor: {
      light: '#FFFFFF',
      dark: '#2C2C2E',
    },
    children: [
      {
        type: 'text',
        text: message,
        font: {
          size: 'callout',
        },
        textColor: {
          light: '#1D1D1F',
          dark: '#F5F5F7',
        },
        textAlign: 'center',
      },
    ],
  };
}
