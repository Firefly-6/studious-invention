// build.js —— 抓取俄媒 RSS，解析、打供需标签、翻译标题、去重，写出 news.json
// 仅依赖 Node 18+ 内置 fetch / AbortController，无需安装任何 npm 包。
// 由 GitHub Actions 每 5 分钟自动运行；也可本地 `node build.js` 手动跑。

const fs = require('fs');
const CACHE_FILE = 'title_cache.json';

const SOURCES = [
  { name: 'Lenta',       url: 'https://lenta.ru/rss' },
  { name: 'RBC',         url: 'https://www.rbc.ru/rss/news' },
  { name: 'TASS',        url: 'https://tass.ru/rss/v2/news' },
  { name: 'Interfax',    url: 'https://www.interfax.ru/rss/news.xml' },
  { name: 'Kommersant',  url: 'https://www.kommersant.ru/rss/news' },
  { name: 'Vedomosti',   url: 'https://www.vedomosti.ru/rss/news' },
  { name: 'RIA',         url: 'https://ria.ru/export/rss2/index.xml' },
  { name: 'Izvestia',    url: 'https://iz.ru/rss' },
  { name: 'ForbesRussia',url: 'https://www.forbes.ru/rss/news' },
];

// ===== 只保留以下主题的新闻，其余全部丢弃 =====
// 目标主题：需求 / 供给 / OZON / Wildberries / 中俄贸易 / 平台（其它 marketplace）
const CHINA_RE = /китай|КНР|китайск/i;
const TRADE_RE = /торговл|экспорт|импорт|поставк|товарооборот|рынок|эконом|бизнес|производств|завод|фабрик|инвестиц|логистик|таможн|юань|валют|курс/i;

const KEEP_RULES = [
  // 需求：消费、热销、零售、短缺、订单——对卖家=机会信号
  { tag: '需求↑', re: /спрос|дефицит|нехватк|потреблен|потребител|покупат|закупк|заказ|продаж|популярн|востребован|товар|ритейл|розниц|онлайн-торговл|электронн.{0,6}торговл/i },
  // 供给：产能、生产、进出口、工厂、减产
  { tag: '供给↓', re: /поставк|производств|импорт|экспорт|предложен|завод|фабрик|сокращен|снижен|снизил|сократ|перебои|выпуск|мощност/i },
  // OZON
  { tag: 'OZON', re: /ozon|озон/i },
  // Wildberries
  { tag: 'Wildberries', re: /wildberries|вайлдберриз|вайлдберрис/i },
  // 中俄贸易：同时出现「中国」与「贸易/经济」语境才算，避免泛中国政治新闻
  { tag: '中俄贸易', test: (t) => CHINA_RE.test(t) && TRADE_RE.test(t) },
  // 平台：其它 marketplace（Яндекс.Маркет / AliExpress / Мегамаркет 等）
  { tag: '平台', re: /маркетплейс|маркетплэйс|яндекс.?маркет|aliexpress|мегамаркет|сбермегамаркет|lamoda/i },
];

// 补充标签：不作为保留条件，只在已保留的新闻上追加，方便前端二次筛选
const EXTRA_TAGS = [
  { re: /цен[аы]|стоимост|подорож|подешев/i, tag: '价格' },
  { re: /логистик|доставк|транспорт|таможн/i, tag: '物流' },
  { re: /санкц/i, tag: '制裁' },
  { re: /рубл|курс|валют/i, tag: '汇率' },
];

// 返回该条新闻命中的标签；返回空数组 = 与目标主题无关，将被丢弃
function keepTags(text){
  const tags = [];
  for (const k of KEEP_RULES){
    const hit = k.re ? k.re.test(text) : (k.test ? k.test(text) : false);
    if (hit) tags.push(k.tag);
  }
  if (!tags.length) return [];           // 未命中任何目标主题 -> 丢弃
  for (const e of EXTRA_TAGS) if (e.re.test(text)) tags.push(e.tag);
  return tags.filter((t, i) => tags.indexOf(t) === i);
}

async function fetchText(url, timeoutMs = 15000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// 持久化翻译缓存：已翻译过的标题不再重复请求 API，降低限流/封号风险
function loadCache(){
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveCache(cache){
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.log('[warn] 无法写入翻译缓存', e.message);
  }
}

// 俄文 -> 中文（优先 Google 公共端点；失败时用 MyMemory 兜底；失败保留原文）
async function translateRU(text, cache, timeoutMs = 15000){
  if (!text) return text;
  const key = text.trim();
  if (cache[key]) return cache[key];

  const encoded = encodeURIComponent(key);
  const googleUrl = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=zh-CN&dt=t&q=' + encoded;

  // Google 主接口：5 次重试 + 指数退避，降低限流影响
  for (let attempt = 0; attempt < 5; attempt++){
    if (attempt > 0){
      const delay = 500 * Math.pow(2, attempt - 1);
      console.log(`[翻译重试] 第 ${attempt + 1} 次，等待 ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(googleUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 429){
        console.log('[翻译 429] 触发限流，继续重试...');
        continue;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const zh = (j[0] || []).map(seg => seg[0]).filter(Boolean).join('');
      if (zh){
        cache[key] = zh;
        return zh;
      }
      throw new Error('empty');
    } catch (e) {
      if (attempt === 4) break;
    } finally {
      clearTimeout(t);
    }
  }

  // 兜底：MyMemory（免费额度有限，仅主接口失败时使用）
  try {
    const mmUrl = 'https://api.mymemory.translated.net/get?q=' + encoded + '&langpair=ru|zh-CN';
    const r = await fetch(mmUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok){
      const j = await r.json();
      if (j.responseStatus === 200 && j.responseData && j.responseData.translatedText){
        const zh = j.responseData.translatedText;
        if (zh && zh !== key){
          cache[key] = zh;
          return zh;
        }
      }
    }
  } catch (e) {}

  console.log('[翻译失败，保留原文]', key.slice(0, 60));
  cache[key] = key; // 避免同一标题反复请求浪费配额
  return key;
}

// 并发翻译标题（写入 titleZh），失败保留原文
async function translateTitles(items, cache, concurrency = 2){
  let done = 0;
  let i = 0;
  async function worker(){
    while (i < items.length){
      const idx = i++;
      const title = items[idx].title;
      const zh = await translateRU(title, cache);
      items[idx].titleZh = zh;
      if (zh !== title) done++;
      // 请求间隔，降低被限流概率
      await new Promise(r => setTimeout(r, 150));
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  console.log(`[翻译统计] 成功 ${done}/${items.length}，保留原文 ${items.length - done}`);
}

function decodeEntities(s){
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function stripTags(s){
  return decodeEntities((s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function pick(block, tag, alt){
  const m = block.match(new RegExp('<' + tag + '[\\s\\S]*?>([\\s\\S]*?)<\\/' + tag + '>', 'i')) ||
            (alt ? block.match(new RegExp('<' + alt + '[\\s\\S]*?>([\\s\\S]*?)<\\/' + alt + '>', 'i')) : null);
  return m ? stripTags(m[1]) : '';
}

function parseFeed(xml, source){
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const items = [];
  for (const b of blocks){
    let link = pick(b, 'link');
    if (!link){ const lm = b.match(/<link[^>]*href="([^"]+)"/i); if (lm) link = lm[1]; }
    const title = pick(b, 'title');
    if (!title) continue;
    const pub = pick(b, 'pubDate', 'published') || pick(b, 'dc:date', 'updated');
    let summary = pick(b, 'description', 'summary') || '';
    summary = summary.slice(0, 220);
    items.push({ title, link, source, pubDate: pub, summary, tags: [] });
  }
  return items;
}

async function gather(){
  const all = [];
  for (const s of SOURCES){
    try {
      const xml = await fetchText(s.url);
      const items = parseFeed(xml, s.name);
      all.push(...items);
      console.log(`[ok]   ${s.name}: ${items.length} 条`);
    } catch (e) {
      console.log(`[skip] ${s.name}: ${e.message}`);
    }
  }
  return all;
}

function dedupe(items){
  const seen = new Set();
  const out = [];
  for (const it of items){
    const key = (it.link || '').trim() || (it.title || '').trim();
    if (!key) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function main(){
  const items = await gather();
  const merged = dedupe(items);

  // 只保留目标主题（需求/供给/OZON/Wildberries/中俄贸易/平台），其余丢弃
  const kept = [];
  for (const it of merged){
    const text = (it.title || '') + ' ' + (it.summary || '');
    const tags = keepTags(text);
    if (!tags.length) continue;
    it.tags = tags;
    kept.push(it);
  }
  console.log(`[筛选] 原始 ${merged.length} 条 -> 命中目标主题 ${kept.length} 条`);

  kept.sort((a, b) => {
    const ta = (a.tags || []).length, tb = (b.tags || []).length;
    if (tb !== ta) return tb - ta;
    const da = a.pubDate ? Date.parse(a.pubDate) : 0;
    const db = b.pubDate ? Date.parse(b.pubDate) : 0;
    return db - da;
  });
  const final = kept.slice(0, 120);

  const cache = loadCache();
  console.log('翻译标题（俄->中）中…');
  await translateTitles(final, cache);

  const out = { updated: new Date().toISOString(), count: final.length, items: final };
  fs.writeFileSync('news.json', JSON.stringify(out, null, 2));
  saveCache(cache);
  console.log(`已写出 news.json，共 ${final.length} 条`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
