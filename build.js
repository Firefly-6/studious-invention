// build.js —— 抓取俄媒 RSS + Google News，解析、打供需标签、去重，写出 news.json
// 仅依赖 Node 18+ 内置 fetch / AbortController，无需安装任何 npm 包。
// 由 GitHub Actions 每 30 分钟自动运行；也可本地 `node build.js` 手动跑。

const fs = require('fs');

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
  { name: 'GoogleNews',  url: 'https://news.google.com/rss/search?q=%D1%80%D0%BE%D1%81%D1%81%D0%B8%D0%B9%D1%81%D0%BA%D0%B8%D0%B5%20%D0%BD%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D0%B8%20%D1%81%D0%BF%D1%80%D0%BE%D1%81%20%D0%B8%D0%BC%D0%BF%D0%BE%D1%80%D1%82%20%D1%86%D0%B5%D0%BD%D1%8B&hl=ru&gl=RU&ceid=RU:ru' },
];

// 俄文关键词 -> 中文供需标签（命中越多越靠前）
const KEYWORDS = [
  { re: /спрос|дефицит|нехватк|потреблен|вырос\w* спрос/i, tag: '需求↑' },
  { re: /дефицит|нехватк|сокращен|снижен|снизил|сократ/i, tag: '供给↓' },
  { re: /импорт/i, tag: '进口' },
  { re: /экспорт/i, tag: '出口' },
  { re: /поставк|логистик/i, tag: '物流' },
  { re: /цен[аы]|стоимост|подорож/i, tag: '价格' },
  { re: /производств/i, tag: '生产' },
  { re: /санкц/i, tag: '制裁' },
  { re: /рубл|курс|валют/i, tag: '汇率' },
];

function tagOf(text){
  const tags = [];
  for (const k of KEYWORDS) if (k.re.test(text)) tags.push(k.tag);
  // 去重保序
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
    const tags = tagOf(title + ' ' + summary);
    items.push({ title, link, source, pubDate: pub, summary, tags });
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
  let merged = dedupe(items);
  merged.sort((a, b) => {
    const ta = (a.tags || []).length, tb = (b.tags || []).length;
    if (tb !== ta) return tb - ta;
    const da = a.pubDate ? Date.parse(a.pubDate) : 0;
    const db = b.pubDate ? Date.parse(b.pubDate) : 0;
    return db - da;
  });
  merged = merged.slice(0, 200);
  const out = { updated: new Date().toISOString(), count: merged.length, items: merged };
  fs.writeFileSync('news.json', JSON.stringify(out, null, 2));
  console.log(`已写出 news.json，共 ${merged.length} 条`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
