#!/usr/bin/env node
/**
 * build-ee-api-index.mjs
 *
 * 抓取 Google Earth Engine 官方 API 文档 (https://developers.google.com/earth-engine/apidocs)，
 * 构建类/方法名单并写入 lib/ee-api-index.json，供扩展内确定性校验（检测 ee.* 函数幻觉）使用。
 *
 * 运行：node tools/build-ee-api-index.mjs     （Node >= 18，零 npm 依赖，仅使用 node: 内置模块）
 *
 * 实际页面结构说明（2026-08 探测结果，devsite 服务端渲染，无需 JS 执行）：
 *   1. 索引页 /earth-engine/apidocs 的左侧导航 (devsite-nav) 包含完整树：
 *        每个分组标题形如 <div class="devsite-nav-title devsite-nav-title-no-path">…ee.ImageCollection…</div>，
 *        其后紧跟的 <ul class="devsite-nav-section"> 中第一个链接指向类概览页（ee-imagecollection），
 *        其余链接逐个指向该类的方法页，锚文本即原始大小写方法名（如 addBands、aggregate_array、
 *        Algorithms 下的 "Landsat.simpleCloudScore" 等带点路径）。
 *   2. 类概览页（如 /earth-engine/apidocs/ee-imagecollection）正文只包含构造器签名，
 *      不重复列出方法清单；因此方法名以索引页导航为权威来源，类概览页用于逐类抓取验证
 *      （HTTP 200 且标题匹配），并作为补充来源合并正文中出现的同类方法页链接。
 *   3. 方法详情页（如 /earth-engine/apidocs/ee-image-addbands）含 "Usage/Returns" 签名表，
 *      本脚本不逐方法抓取（1400+ 页），礼貌抓取原则下无必要。
 *
 * 兜底类名表（仅当索引页解析结果 < 10 个类时启用）：
 *   Algorithms, Array, Blob, Classifier, Clusterer, ConfusionMatrix, Date, DateRange,
 *   Dictionary, ErrorMargin, Feature, FeatureCollection, Filter, Geometry, Image,
 *   ImageCollection, Join, Kernel, List, Model, Number, PixelType, Projection, Reducer,
 *   String, Terrain, data, apply, call, initialize, reset
 *
 * 礼貌抓取：请求间隔 >= 300ms、并发 <= 4、失败重试 1 次、单页超时 30s、
 * User-Agent 明示工具用途、启动时检查 robots.txt。
 *
 * 网络说明：Node 全局 fetch 不走系统代理，本脚本自带零依赖 HTTP(S) 客户端：
 *   优先读取 HTTPS_PROXY/HTTP_PROXY 环境变量；在 Windows 上无环境变量时自动读取
 *   系统 IE 代理（HKCU Internet Settings ProxyServer），通过 CONNECT 隧道抓取。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://developers.google.com/earth-engine/apidocs';
const ROBOTS_URL = 'https://developers.google.com/robots.txt';
const USER_AGENT =
  'gee-ee-api-index-builder/1.0 (offline API-name index generator for GEE AI Assistant; ' +
  'low-volume polite crawler, 1 request per 300ms)';
const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'lib',
  'ee-api-index.json'
);

const MIN_INTERVAL_MS = 300; // 请求间隔下限
const CONCURRENCY = 4; // 并发上限
const TIMEOUT_MS = 30_000; // 单页超时
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 1; // 失败重试 1 次

/* ------------------------------------------------------------------ */
/* 零依赖 HTTP 客户端（支持 CONNECT 代理隧道）                            */
/* ------------------------------------------------------------------ */

function envProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  );
}

/** Windows 下读取系统 IE 代理（注册表），其他平台返回空。 */
function windowsSystemProxy() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve('');
        const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(stdout || '');
        if (!m) return resolve('');
        const server = m[1];
        resolve(/^https?:\/\//i.test(server) ? server : `http://${server}`);
      }
    );
  });
}

let proxyCache;
async function resolveProxy() {
  if (proxyCache !== undefined) return proxyCache;
  proxyCache = envProxy() || (await windowsSystemProxy());
  return proxyCache;
}

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`TCP connect timeout: ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function upgradeTls(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => {
      tlsSocket.destroy(new Error(`TLS handshake timeout: ${servername}`));
    }, timeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 通过 CONNECT 隧道建立到 target:443 的 TCP 连接。 */
async function connectViaProxy(proxyUrl, targetHost, timeoutMs) {
  const p = new URL(proxyUrl);
  const socket = await connectTcp(p.hostname, Number(p.port) || 80, timeoutMs);
  await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy(new Error('CONNECT timeout'));
      reject(new Error('CONNECT timeout'));
    }, timeoutMs);
    socket.on('data', function onData(chunk) {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      if (!/\s2\d\d\s/.test(` ${statusLine} `) && !/ 200/.test(statusLine)) {
        socket.destroy();
        return reject(new Error(`CONNECT failed: ${statusLine}`));
      }
      // 隧道已建立，丢弃响应头字节
      resolve();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(
      `CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n` +
        `Proxy-Connection: keep-alive\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`
    );
  });
  return socket;
}

function decodeChunked(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const j = buf.indexOf('\r\n', i);
    if (j < 0) break;
    const size = parseInt(buf.slice(i, j).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size < 0) break;
    i = j + 2;
    if (size === 0) break;
    parts.push(buf.slice(i, i + size));
    i += size + 2;
  }
  return Buffer.concat(parts);
}

function decodeBody(headers, buf) {
  const enc = String(headers['transfer-encoding'] || '').toLowerCase();
  let body = enc.includes('chunked') ? decodeChunked(buf) : buf;
  const ce = String(headers['content-encoding'] || '').toLowerCase();
  if (ce.includes('br')) body = zlib.brotliDecompressSync(body);
  else if (ce.includes('gzip')) body = zlib.gunzipSync(body);
  else if (ce.includes('deflate')) body = zlib.inflateSync(body);
  return body.toString('utf8');
}

/** 单次 HTTP(S) GET（HTTP/1.1，Connection: close），返回 {status, headers, text, finalUrl}。 */
async function rawGet(url, { timeoutMs = TIMEOUT_MS, proxy = '', redirects = 0 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error(`仅支持 https: ${url}`);

  let tcpSocket;
  if (proxy) {
    tcpSocket = await connectViaProxy(proxy, target.hostname, timeoutMs);
  } else {
    tcpSocket = await connectTcp(target.hostname, 443, timeoutMs);
  }
  const socket = await upgradeTls(tcpSocket, target.hostname, timeoutMs);

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy(new Error(`读取超时 (${timeoutMs}ms): ${url}`));
      reject(new Error(`读取超时 (${timeoutMs}ms): ${url}`));
    }, timeoutMs);
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const raw = Buffer.concat(chunks);
        const headEnd = raw.indexOf('\r\n\r\n');
        if (headEnd < 0) throw new Error('响应缺少头部');
        const headText = raw.slice(0, headEnd).toString('latin1');
        const lines = headText.split('\r\n');
        const status = Number(lines[0].split(' ')[1]);
        const headers = {};
        for (const line of lines.slice(1)) {
          const k = line.indexOf(':');
          if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
        }
        const text = decodeBody(headers, raw.slice(headEnd + 4));
        resolve({ status, headers, text });
      } catch (err) {
        reject(err);
      }
    });
    socket.write(
      `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
        `Host: ${target.hostname}\r\n` +
        `User-Agent: ${USER_AGENT}\r\n` +
        `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n` +
        `Accept-Language: en\r\n` +
        `Accept-Encoding: gzip, deflate, br\r\n` +
        `Connection: close\r\n\r\n`
    );
  });
  socket.destroy();

  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`重定向次数过多: ${url}`);
    const next = new URL(response.headers.location, url).toString();
    return rawGet(next, { timeoutMs, proxy, redirects: redirects + 1 });
  }
  return { ...response, finalUrl: url };
}

/* ------------------------------------------------------------------ */
/* 礼貌调度：全局最小间隔 + 并发池 + 重试                                 */
/* ------------------------------------------------------------------ */

let lastRequestAt = 0;
async function politeGet(url, label) {
  const proxy = await resolveProxy();
  const attempts = MAX_RETRIES + 1;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    try {
      const res = await rawGet(url, { proxy });
      return res;
    } catch (err) {
      lastErr = err;
      process.stderr.write(
        `[warn] ${label} 第 ${attempt}/${attempts} 次抓取失败: ${err.message}\n`
      );
    }
  }
  throw lastErr;
}

async function runPool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */
/* 解析逻辑                                                            */
/* ------------------------------------------------------------------ */

const GROUP_TITLE_RE =
  /<div class="devsite-nav-title devsite-nav-title-no-path"[^>]*>\s*<span class="devsite-nav-text"[^>]*>([^<]+)<\/span>/g;
const NAV_LINK_RE =
  /<a\s[^>]*href="\/earth-engine\/apidocs\/([^"]+)"[^>]*>\s*<span class="devsite-nav-text"[^>]*>([^<]*)<\/span>\s*<\/a>/g;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 从索引页 HTML 解析类清单：
 * 返回 [{ title, className, overviewSlug, methods: [name,...] }]
 */
function parseIndexNav(html) {
  const titles = [];
  for (const m of html.matchAll(GROUP_TITLE_RE)) {
    const title = decodeEntities(m[1]).trim();
    titles.push({ title, start: m.index, end: m.index + m[0].length });
  }
  const classes = [];
  for (let i = 0; i < titles.length; i += 1) {
    const { title, end } = titles[i];
    // 仅保留 JS API 命名空间分组：ee.*、Export.*、ui.*
    if (!/^(ee|Export|ui)\./.test(title)) continue;
    const sliceEnd = i + 1 < titles.length ? titles[i + 1].start : html.length;
    const slice = html.slice(end, sliceEnd);
    const links = [];
    for (const lm of slice.matchAll(NAV_LINK_RE)) {
      links.push({ slug: lm[1], label: decodeEntities(lm[2]).trim() });
    }
    const overview = links.find((l) => l.label === title);
    const methods = links
      .filter((l) => l !== overview)
      .map((l) => l.label)
      .filter((name) => /^[A-Za-z_][\w.]*$/.test(name));
    classes.push({
      title,
      className: title.startsWith('ee.') ? title.slice(3) : title,
      overviewSlug: overview ? overview.slug : null,
      methods,
    });
  }
  return classes;
}

/**
 * 从类概览页正文补充解析方法名（概览页一般只含构造器，这里仅合并正文中
 * 出现的同类方法页链接；拿不到时返回空数组，不中断整体）。
 */
function parseClassPageMethods(html, overviewSlug) {
  if (!overviewSlug) return [];
  const names = new Set();
  const prefix = `${overviewSlug}-`;
  const re = new RegExp(
    `<a\\s[^>]*href="/earth-engine/apidocs/${prefix}([^"]+)"[^>]*>\\s*<span class="devsite-nav-text"[^>]*>([^<]*)</span>`,
    'g'
  );
  for (const m of html.matchAll(re)) {
    const label = decodeEntities(m[2]).trim();
    if (/^[A-Za-z_][\w.]*$/.test(label)) names.add(label);
  }
  return [...names];
}

/** 兜底类名表（索引页解析失败时启用，概览页 slug 按 ee-<小写类名> 猜测）。 */
const FALLBACK_CLASSES = [
  'Algorithms', 'Array', 'Blob', 'Classifier', 'Clusterer', 'ConfusionMatrix',
  'Date', 'DateRange', 'Dictionary', 'ErrorMargin', 'Feature', 'FeatureCollection',
  'Filter', 'Geometry', 'Image', 'ImageCollection', 'Join', 'Kernel', 'List',
  'Model', 'Number', 'PixelType', 'Projection', 'Reducer', 'String', 'Terrain',
  'data', 'apply', 'call', 'initialize', 'reset',
];

/** 极简 robots.txt 检查：若存在针对 /earth-engine/apidocs 的 Disallow 则拒绝抓取。 */
async function checkRobots() {
  try {
    const res = await rawGet(ROBOTS_URL, { proxy: await resolveProxy(), timeoutMs: 15_000 });
    if (res.status !== 200) {
      process.stderr.write(`[warn] robots.txt 状态 ${res.status}，跳过检查\n`);
      return;
    }
    const blocked = res.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^disallow:/i.test(l))
      .map((l) => l.replace(/^disallow:\s*/i, ''))
      .filter(Boolean);
    for (const rule of blocked) {
      if ('/earth-engine/apidocs'.startsWith(rule)) {
        throw new Error(`robots.txt 禁止抓取: Disallow: ${rule}`);
      }
    }
    process.stderr.write('[info] robots.txt 检查通过\n');
  } catch (err) {
    if (/robots\.txt 禁止/.test(err.message)) throw err;
    process.stderr.write(`[warn] robots.txt 检查失败（${err.message}），继续执行\n`);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  await checkRobots();

  process.stderr.write(`[info] 抓取索引页: ${BASE_URL}\n`);
  const indexRes = await politeGet(BASE_URL, '索引页');
  if (indexRes.status !== 200) {
    throw new Error(`索引页抓取失败: HTTP ${indexRes.status}`);
  }

  let classes = parseIndexNav(indexRes.text);
  let usedFallback = false;
  if (classes.length < 10) {
    usedFallback = true;
    process.stderr.write(
      `[warn] 索引页仅解析到 ${classes.length} 个类，启用已知类名兜底表（${FALLBACK_CLASSES.length} 个）\n`
    );
    classes = FALLBACK_CLASSES.map((name) => ({
      title: `ee.${name}`,
      className: name,
      overviewSlug: `ee-${name.toLowerCase()}`,
      methods: [],
    }));
  }
  process.stderr.write(`[info] 解析到 ${classes.length} 个类分组\n`);

  // 逐类抓取概览页：验证类页可达，并补充正文中出现的方法链接
  const failed = [];
  const verified = new Set();
  await runPool(classes, CONCURRENCY, async (cls) => {
    if (!cls.overviewSlug) return;
    const url = `${BASE_URL}/${cls.overviewSlug}`;
    try {
      const res = await politeGet(url, `类页 ${cls.title}`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      verified.add(cls.title);
      const extra = parseClassPageMethods(res.text, cls.overviewSlug);
      cls.methods = [...new Set([...cls.methods, ...extra])];
    } catch (err) {
      failed.push(`${cls.title} (${err.message})`);
      process.stderr.write(`[warn] 类页抓取失败: ${cls.title} -> ${err.message}\n`);
    }
  });

  // 组装产物：类名去 ee. 前缀，方法去重排序，类键按字母序
  const classesOut = {};
  const sortedClasses = [...classes].sort((a, b) =>
    a.className.toLowerCase() < b.className.toLowerCase()
      ? -1
      : a.className.toLowerCase() > b.className.toLowerCase()
        ? 1
        : 0
  );
  let totalMethods = 0;
  const emptyClasses = [];
  for (const cls of sortedClasses) {
    if (classesOut[cls.className]) continue; // 同名分组去重
    const methods = [...new Set(cls.methods)].sort();
    classesOut[cls.className] = { methods };
    totalMethods += methods.length;
    if (methods.length === 0) emptyClasses.push(cls.className);
  }

  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceUrl: 'https://developers.google.com/earth-engine/apidocs',
    classes: classesOut,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const json = `${JSON.stringify(out, null, 2)}\n`;
  fs.writeFileSync(OUT_PATH, json, 'utf8');

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('== ee-api-index 构建统计 ==');
  console.log(`类数量        : ${Object.keys(classesOut).length}`);
  console.log(`方法总数      : ${totalMethods}`);
  console.log(`已验证类页数  : ${verified.size}`);
  console.log(`失败类清单    : ${failed.length ? failed.join(', ') : '(无)'}`);
  console.log(`空方法类      : ${emptyClasses.length ? emptyClasses.join(', ') : '(无)'}`);
  console.log(`兜底类名表    : ${usedFallback ? '已启用' : '未启用'}`);
  console.log(`耗时          : ${seconds}s`);
  console.log(`产物          : ${path.resolve(OUT_PATH)} (${(json.length / 1024).toFixed(1)} KB)`);

  if (Object.keys(classesOut).length === 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[error] ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
