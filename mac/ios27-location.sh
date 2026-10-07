#!/usr/bin/env bash
# iOS 27+ 虚拟定位（Mac 端）
#
# iOS 27 beta 6 起 locationd 对 gs-loc.apple.com 做了证书固定，
# Loon 等代理工具无法再解密/修改 WLOC，因此改用 Apple 开发者工具链的
# DVT LocationSimulation 服务（与 Xcode「模拟位置」相同），由 pymobiledevice3 驱动。
#
# 用法：
#   ./ios27-location.sh devices                 列出 USB 连接的设备
#   ./ios27-location.sh prepare                 检查开发者模式并挂载 DDI（每次重启手机后执行一次）
#   ./ios27-location.sh set 纬度 经度 [--gcj]   设置位置并保持会话，Ctrl+C 结束
#   ./ios27-location.sh clear                   恢复真实定位
#   ./ios27-location.sh wifi-on                 允许之后通过同一 Wi-Fi 无线连接（需先 USB 执行一次）
# 所有命令都可追加 --udid <UDID> 指定设备。
#
# --gcj：传入的是高德 / 国内苹果地图坐标（GCJ-02），自动换算为 WGS84。

set -euo pipefail

PMD=()
EXTRA=()
GCJ=0

die() { printf '错误：%s\n' "$*" >&2; exit 2; }

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

resolve_pmd() {
  if command -v uvx >/dev/null 2>&1; then
    PMD=(uvx --from 'pymobiledevice3>=4.0' pymobiledevice3)
  elif command -v pymobiledevice3 >/dev/null 2>&1; then
    PMD=(pymobiledevice3)
  else
    die "未找到 uvx 或 pymobiledevice3。先运行：brew install uv"
  fi
}

parse_opts() {
  while (($# > 0)); do
    case "$1" in
      --udid) [[ $# -ge 2 && -n "$2" ]] || die "--udid 缺少参数"; EXTRA+=(--udid "$2"); shift 2 ;;
      --gcj) GCJ=1; shift ;;
      *) die "未知参数：$1" ;;
    esac
  done
}

is_number() { [[ "$1" =~ ^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]]; }

gcj_to_wgs() {
  command -v python3 >/dev/null 2>&1 || die "--gcj 需要 python3（xcode-select --install）"
  python3 -I - "$1" "$2" <<'PY'
import math, sys
lat, lon = float(sys.argv[1]), float(sys.argv[2])
def out(lat, lon): return lon < 72.004 or lon > 137.8347 or lat < 0.8293 or lat > 55.8271
def w2g(lat, lon):
    if out(lat, lon): return lat, lon
    a, ee = 6378245.0, 0.00669342162296594323
    x, y = lon - 105.0, lat - 35.0
    dlat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    dlat += (20*math.sin(6*x*math.pi) + 20*math.sin(2*x*math.pi)) * 2/3
    dlat += (20*math.sin(y*math.pi) + 40*math.sin(y/3*math.pi)) * 2/3
    dlat += (160*math.sin(y/12*math.pi) + 320*math.sin(y*math.pi/30)) * 2/3
    dlon = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    dlon += (20*math.sin(6*x*math.pi) + 20*math.sin(2*x*math.pi)) * 2/3
    dlon += (20*math.sin(x*math.pi) + 40*math.sin(x/3*math.pi)) * 2/3
    dlon += (150*math.sin(x/12*math.pi) + 300*math.sin(x/30*math.pi)) * 2/3
    rad = lat/180*math.pi
    m = 1 - ee*math.sin(rad)**2
    sm = math.sqrt(m)
    dlat = dlat*180 / ((a*(1-ee))/(m*sm)*math.pi)
    dlon = dlon*180 / (a/sm*math.cos(rad)*math.pi)
    return lat + dlat, lon + dlon
wl, wn = lat, lon
for _ in range(10):
    g = w2g(wl, wn)
    wl -= g[0] - lat
    wn -= g[1] - lon
print(f"{wl:.7f} {wn:.7f}")
PY
}

cmd="${1:-help}"; (($# > 0)) && shift

case "$cmd" in
  devices)
    resolve_pmd
    "${PMD[@]}" usbmux list
    ;;
  prepare)
    parse_opts "$@"; resolve_pmd
    echo "请确认 iPhone 已解锁、已信任此电脑，并已开启 设置 → 隐私与安全性 → 开发者模式。"
    "${PMD[@]}" amfi developer-mode-status "${EXTRA[@]+"${EXTRA[@]}"}"
    "${PMD[@]}" mounter auto-mount "${EXTRA[@]+"${EXTRA[@]}"}"
    ;;
  set)
    (($# >= 2)) || die "set 需要 纬度 经度"
    lat="$1"; lon="$2"; shift 2
    parse_opts "$@"
    is_number "$lat" || die "纬度无效：$lat"
    is_number "$lon" || die "经度无效：$lon"
    awk -v a="$lat" -v b="$lon" 'BEGIN{exit !(a>=-90 && a<=90 && b>=-180 && b<=180)}' || die "坐标超出范围"
    if ((GCJ)); then read -r lat lon < <(gcj_to_wgs "$lat" "$lon"); echo "GCJ-02 → WGS84：$lat, $lon"; fi
    resolve_pmd
    echo "设置模拟定位：$lat, $lon"
    echo "保持此窗口打开；Ctrl+C 结束后运行 ./ios27-location.sh clear 恢复真实定位。"
    exec "${PMD[@]}" developer dvt simulate-location set "${EXTRA[@]+"${EXTRA[@]}"}" -- "$lat" "$lon"
    ;;
  clear)
    parse_opts "$@"; resolve_pmd
    "${PMD[@]}" developer dvt simulate-location clear "${EXTRA[@]+"${EXTRA[@]}"}"
    echo "已恢复真实定位。"
    ;;
  wifi-on)
    parse_opts "$@"; resolve_pmd
    "${PMD[@]}" lockdown wifi-connections on "${EXTRA[@]+"${EXTRA[@]}"}"
    echo "已开启无线连接：之后 iPhone 与 Mac 在同一 Wi-Fi 下时可拔线使用。"
    ;;
  help|-h|--help) usage ;;
  *) usage >&2; die "未知命令：$cmd" ;;
esac
