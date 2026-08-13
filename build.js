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

// 俄文 -> 中文（Google 翻译公共端点，免 key；CI 在境外可访问，失败时保留原文）
async function translateRU(text, timeoutMs = 8000){
  if (!text) return text;
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
  for (let attempt = 0; attempt < 2; attempt++){
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const zh = (j[0] || []).map(seg => seg[0]).filter(Boolean).join('');
      if (zh) return zh;
      throw new Error('empty');
    } catch (e) {
      if (attempt === 1) return text;   // 兜底：保留俄文原文
    } finally {
      clearTimeout(t);
    }
  }
  return text;
}

// 并发翻译标题（写入 titleZh），失败保留原文
async function translateTitles(items, concurrency = 5){
  let i = 0;
  async function worker(){
    while (i < items.length){
      const idx = i++;
      items[idx].titleZh = await translateRU(items[idx].title);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
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
  console.log('翻译标题（俄->中）中…');
  await translateTitles(merged);
  const out = { updated: new Date().toISOString(), count: merged.length, items: merged };
  fs.writeFileSync('news.json', JSON.stringify(out, null, 2));
  console.log(`已写出 news.json，共 ${merged.length} 条`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
