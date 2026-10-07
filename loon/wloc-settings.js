/*
 * Loon WLOC 定位修改 - 设置脚本
 *
 * 拦截 https://gs-loc.apple.com/wloc-settings/<动作>，不会发往 Apple。
 *   /wloc-settings/save?lat=22.54&lon=113.94[&acc=25][&r=0][&coord=gcj02]
 *   /wloc-settings/clear     清除坐标，恢复真实定位
 *   /wloc-settings/query     查看当前坐标
 * 也兼容 ?action=save|clear|query 写法。
 * coord=gcj02 表示传入的是高德/国内苹果地图坐标，会自动换算为 WGS84。
 */

const STORE_KEY = 'wloc_settings';
const url = $request.url || '';

function getQuery(u) {
  const q = {};
  const s = (u.split('?')[1] || '').split('#')[0];
  s.split('&').forEach(kv => {
    if (!kv) return;
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? '' : kv.slice(i + 1);
    try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { q[k] = v; }
  });
  return q;
}

function num(v) {
  if (v === undefined || v === null || String(v).trim() === '') return NaN;
  return Number(String(v).trim().replace(',', '.'));
}

// GCJ-02 → WGS84（迭代逆解，误差 < 0.5 米）
function outOfChina(lat, lon) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function wgsToGcj(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  const a = 6378245.0, ee = 0.00669342162296594323;
  const x = lon - 105.0, y = lat - 35.0;
  let dLat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  dLat += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  dLat += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  let dLon = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLon += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  dLon += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  dLon += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lon + dLon];
}
function gcjToWgs(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let wLat = lat, wLon = lon;
  for (let i = 0; i < 10; i++) {
    const g = wgsToGcj(wLat, wLon);
    wLat -= g[0] - lat;
    wLon -= g[1] - lon;
  }
  return [wLat, wLon];
}

function readStore() {
  try { return JSON.parse($persistentStore.read(STORE_KEY) || 'null'); } catch (e) { return null; }
}

function notify(title, body) {
  try { $notification.post('WLOC 定位修改', title, body || ''); } catch (e) { /* ignore */ }
}

function handle() {
  const q = getQuery(url);
  const pathAction = (url.split('?')[0].match(/\/wloc-settings\/(\w+)/) || [])[1];
  const action = (q.action || pathAction || 'save').toLowerCase();

  if (action === 'query' || action === 'status') {
    const s = readStore();
    return s ? { success: true, ...s } : { success: false, error: '未设置坐标（真实定位）' };
  }

  if (action === 'clear') {
    $persistentStore.write('', STORE_KEY);
    notify('已清除虚拟定位', 'iOS 26+ 建议重启设备使其生效');
    return { success: true, message: '已清除，下次定位将使用真实位置' };
  }

  let lat = num(q.lat !== undefined ? q.lat : q.latitude);
  let lon = num(q.lon !== undefined ? q.lon : (q.lng !== undefined ? q.lng : q.longitude));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { success: false, error: '缺少或无效的 lat / lon 参数' };
  }
  const coord = String(q.coord || 'wgs84').toLowerCase();
  if (coord === 'gcj02' || coord === 'gcj') [lat, lon] = gcjToWgs(lat, lon);
  lat = Number(lat.toFixed(7));
  lon = Number(lon.toFixed(7));

  const acc = num(q.acc !== undefined ? q.acc : q.accuracy);
  const r = num(q.r !== undefined ? q.r : q.randomRadius);
  const data = {
    latitude: lat,
    longitude: lon,
    accuracy: Number.isFinite(acc) && acc > 0 ? Math.round(acc) : 25,
    randomRadius: Number.isFinite(r) && r >= 0 ? r : 0,
    name: q.name || '',
    updatedAt: new Date().toISOString(),
  };
  const ok = $persistentStore.write(JSON.stringify(data), STORE_KEY);
  if (!ok) return { success: false, error: '写入持久化存储失败' };
  notify('已设置虚拟定位', `${data.name ? data.name + ' ' : ''}${lat}, ${lon}（iOS 26+ 建议重启设备）`);
  return { success: true, ...data };
}

let result;
try { result = handle(); } catch (e) { result = { success: false, error: String(e && e.message || e) }; }
console.log('[wloc-settings] ' + JSON.stringify(result));

$done({
  response: {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(result, null, 2),
  },
});
