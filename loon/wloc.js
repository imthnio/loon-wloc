/*
 * Loon WLOC 定位修改 - 响应脚本
 *
 * 拦截 Apple 网络定位服务 /clls/wloc 的响应，把 protobuf 里每个
 * WiFi / 基站条目的坐标替换为目标坐标。
 *
 * 坐标来源优先级：持久化存储(wloc_settings) > 插件参数 > 不修改(透传)
 *
 * 响应结构（逆向所得）：
 *   [8 字节头][2 字节大端长度 N][N 字节 protobuf][尾部]
 *   protobuf:
 *     field 2  (WiFi 条目) { 1: "aa:bb:cc:dd:ee:ff", 2: Location }
 *     field 22 / 24 (基站) { ..., 5: Location }
 *   Location { 1: 纬度*1e8 (int64), 2: 经度*1e8 (int64), 3: 精度(米) }
 */

const STORE_KEY = 'wloc_settings';
const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
let logLevel = LOG_LEVELS.info;

function log(level, msg) {
  if (LOG_LEVELS[level] <= logLevel) console.log(`[wloc][${level}] ${msg}`);
}

// ---------- 配置 ----------

function num(v) {
  if (v === undefined || v === null) return NaN;
  const s = String(v).trim().replace(',', '.');
  return s === '' ? NaN : Number(s);
}

function readArgument() {
  const a = typeof $argument !== 'undefined' ? $argument : null;
  if (!a) return {};
  if (typeof a === 'object') return a;
  // 兼容旧版 Loon 的字符串形式 "k=v&k=v"
  const out = {};
  String(a).split('&').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

function readStore() {
  try {
    const raw = $persistentStore.read(STORE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

function loadConfig() {
  const arg = readArgument();
  const store = readStore();
  if (arg.logLevel && arg.logLevel in LOG_LEVELS) logLevel = LOG_LEVELS[arg.logLevel];

  const cfg = {
    enabled: !(arg.enabled === false || arg.enabled === 'false'),
    longitude: num(arg.longitude),
    latitude: num(arg.latitude),
    accuracy: num(arg.accuracy),
    randomRadius: num(arg.randomRadius),
    source: 'argument',
  };
  if (store && Number.isFinite(num(store.longitude)) && Number.isFinite(num(store.latitude))) {
    cfg.longitude = num(store.longitude);
    cfg.latitude = num(store.latitude);
    if (Number.isFinite(num(store.accuracy))) cfg.accuracy = num(store.accuracy);
    if (Number.isFinite(num(store.randomRadius))) cfg.randomRadius = num(store.randomRadius);
    cfg.source = 'store';
  }
  if (!Number.isFinite(cfg.accuracy) || cfg.accuracy <= 0) cfg.accuracy = 25;
  if (!Number.isFinite(cfg.randomRadius) || cfg.randomRadius < 0) cfg.randomRadius = 0;
  cfg.valid = Number.isFinite(cfg.longitude) && Number.isFinite(cfg.latitude) &&
    Math.abs(cfg.latitude) <= 90 && Math.abs(cfg.longitude) <= 180;
  return cfg;
}

// 在目标点周围 radius 米内均匀随机取点
function jitter(lat, lon, radius) {
  if (!(radius > 0)) return { lat, lon };
  const R = 6378137;
  const d = Math.sqrt(Math.random()) * radius / R;
  const brg = Math.random() * 2 * Math.PI;
  const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * 180 / Math.PI, lon: ((l2 * 180 / Math.PI + 540) % 360) - 180 };
}

// ---------- protobuf ----------

function readVarint(buf, pos) {
  let value = 0, mul = 1, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    if (shift < 53) value += (b & 0x7f) * mul; // 只用于 tag / 长度，高位无需精确
    if (!(b & 0x80)) return [value, pos];
    mul *= 128;
    shift += 7;
    if (shift >= 70) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

// 编码 int64 varint，负数按 64 位补码输出 10 字节
function encodeVarint(n) {
  n = Math.round(n);
  const out = [];
  if (n >= 0) {
    while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
    out.push(n);
    return out;
  }
  let hi = Math.floor(n / 4294967296);
  let lo = n - hi * 4294967296; // 0 .. 2^32-1
  hi = hi >>> 0;
  for (let i = 0; i < 10; i++) {
    const b = lo & 0x7f;
    lo = ((lo >>> 7) | ((hi & 0x7f) << 25)) >>> 0;
    hi = hi >>> 7;
    if (i === 9) { out.push(b & 0x01); break; }
    out.push(b | 0x80);
  }
  return out;
}

function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const no = Math.floor(tag / 8), wt = tag & 7;
    if (no === 0) throw new Error('field 0');
    let value;
    if (wt === 0) { const r = readVarint(buf, pos); value = r[0]; pos = r[1]; }
    else if (wt === 1) { value = buf.slice(pos, pos + 8); pos += 8; }
    else if (wt === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      if (pos + len > buf.length) throw new Error('length overflow');
      value = buf.slice(pos, pos + len); pos += len;
    } else if (wt === 5) { value = buf.slice(pos, pos + 4); pos += 4; }
    else throw new Error('wire type ' + wt);
    if (pos > buf.length) throw new Error('truncated');
    fields.push({ no, wt, value, raw: buf.slice(start, pos) });
  }
  return fields;
}

function concat(parts) {
  const out = [];
  for (const p of parts) for (let i = 0; i < p.length; i++) out.push(p[i] & 0xff);
  return out;
}

function encodeField(no, wt, value) {
  const tag = encodeVarint(no * 8 + wt);
  if (wt === 0) return concat([tag, encodeVarint(value)]);
  if (wt === 2) return concat([tag, encodeVarint(value.length), value]);
  throw new Error('cannot encode wire type ' + wt);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Location 消息：替换 1/2/3 字段
function patchLocation(buf, t, stats) {
  const fields = parseFields(buf);
  const has = n => fields.some(f => f.no === n && f.wt === 0);
  if (!has(1) || !has(2)) return buf;
  const out = fields.map(f => {
    if (f.wt !== 0) return f.raw;
    if (f.no === 1) return encodeField(1, 0, t.lat * 1e8);
    if (f.no === 2) return encodeField(2, 0, t.lon * 1e8);
    if (f.no === 3) return encodeField(3, 0, t.accuracy);
    return f.raw;
  });
  stats.locations++;
  return concat(out);
}

// 替换子消息 childNo（Location）
function patchChild(buf, childNo, t, stats) {
  const out = parseFields(buf).map(f => {
    if (f.no !== childNo || f.wt !== 2) return f.raw;
    try { return encodeField(f.no, 2, patchLocation(f.value, t, stats)); }
    catch (e) { stats.skipped++; return f.raw; }
  });
  return concat(out);
}

const MAC_RE = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/;

function isWifiEntry(buf) {
  try {
    const f = parseFields(buf).find(x => x.no === 1 && x.wt === 2);
    return !!f && MAC_RE.test(String.fromCharCode.apply(null, Array.from(f.value)));
  } catch (e) { return false; }
}

function patchPayload(buf, t, stats) {
  const out = parseFields(buf).map(f => {
    if (f.wt !== 2) return f.raw;
    if (f.no === 2 && isWifiEntry(f.value)) { stats.wifi++; return encodeField(2, 2, patchChild(f.value, 2, t, stats)); }
    if (f.no === 22 || f.no === 24) {
      try { stats.cell++; return encodeField(f.no, 2, patchChild(f.value, 5, t, stats)); }
      catch (e) { stats.skipped++; return f.raw; }
    }
    return f.raw;
  });
  return concat(out);
}

// 先按 [8 字节头][2 字节长度] 帧格式找，找不到再整体扫描
function patchBody(body, t) {
  const tryFrame = base => {
    const stats = { wifi: 0, cell: 0, locations: 0, skipped: 0 };
    const len = (body[base + 8] << 8) | body[base + 9];
    if (len <= 0 || base + 10 + len > body.length) return null;
    const payload = body.slice(base + 10, base + 10 + len);
    const patched = patchPayload(payload, t, stats);
    if (!stats.locations || sameBytes(payload, patched) || patched.length > 0xffff) return null;
    return {
      data: concat([body.slice(0, base + 8), [patched.length >> 8, patched.length & 0xff], patched, body.slice(base + 10 + len)]),
      stats, mode: 'frame@' + base,
    };
  };
  const limit = Math.min(96, body.length - 10);
  for (let base = 0; base <= limit; base++) {
    try { const r = tryFrame(base); if (r) return r; } catch (e) { /* 继续尝试 */ }
  }
  for (let off = 0; off <= Math.min(256, body.length - 1); off++) {
    const stats = { wifi: 0, cell: 0, locations: 0, skipped: 0 };
    try {
      const payload = body.slice(off);
      const patched = patchPayload(payload, t, stats);
      if (stats.locations && !sameBytes(payload, patched)) {
        return { data: concat([body.slice(0, off), patched]), stats, mode: 'raw@' + off };
      }
    } catch (e) { /* 继续尝试 */ }
  }
  throw new Error('未找到可修改的 WLOC 数据');
}

function toBytes(body) {
  if (!body) return [];
  if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  if (typeof body === 'string') return Array.from(body, c => c.charCodeAt(0) & 0xff);
  return Array.from(body);
}

// ---------- 入口 ----------

function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) { log('info', '插件开关已关闭，透传'); return {}; }
  if (!cfg.valid) { log('info', '未设置坐标，透传（真实定位）'); return {}; }

  const body = toBytes($response.body);
  if (body.length < 10) { log('warn', `响应过短(${body.length})，跳过`); return {}; }
  if (body[0] === 0x1f && body[1] === 0x8b) { log('warn', '响应为 gzip 压缩，Loon 未解压，跳过'); return {}; }

  const p = jitter(cfg.latitude, cfg.longitude, cfg.randomRadius);
  const target = { lat: p.lat, lon: p.lon, accuracy: Math.round(cfg.accuracy) };
  const { data, stats, mode } = patchBody(body, target);

  const headers = Object.assign({}, $response.headers);
  Object.keys(headers).forEach(k => {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'content-length') delete headers[k];
  });
  headers['Content-Length'] = String(data.length);

  log('info', `已修改 → ${target.lat.toFixed(6)},${target.lon.toFixed(6)} 来源=${cfg.source} ` +
    `wifi=${stats.wifi} cell=${stats.cell} 坐标=${stats.locations} 跳过=${stats.skipped} (${mode})`);
  return { status: 200, headers, body: new Uint8Array(data) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { encodeVarint, readVarint, parseFields, patchBody, jitter, loadConfig };
} else {
  let result = {};
  try { result = main(); } catch (e) { log('error', e && e.message ? e.message : String(e)); result = {}; }
  $done(result);
}
