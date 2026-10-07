# Loon WLOC 定位修改

修改 Apple 网络定位服务（WiFi / 基站，`gs-loc.apple.com/clls/wloc`）返回的坐标，实现 iOS 虚拟定位。只适配 **Loon**。

思路参考 [Yu9191/wloc](https://github.com/gitcharlesch/Yu9191-wloc)，脚本为 Loon 重新编写：无打包依赖、单文件可读，使用 JavaScriptCore 测试。

## 先看系统版本

| iOS 版本 | 方案 |
|---|---|
| iOS 15 ~ iOS 27 beta 5 | **Loon 插件**（`loon/` 目录） |
| iOS 27 beta 6 及以后（含正式版） | **Mac 脚本**（`mac/ios27-location.sh`），Loon 插件**无效且要关闭** |

**为什么 iOS 27 不行：** 从 iOS 27 beta 6 起，`locationd` 对 Apple 定位域名做了证书固定（certificate pinning），只接受 Apple 自己的 CA。Loon 的 MITM 证书即使“完全信任”也会在 TLS 握手时被拒绝，脚本根本拿不到 `/clls/wloc` 响应。这是系统层面的限制，换域名、换正则、改脚本、换代理软件都绕不过去；继续开着插件反而会让系统网络定位失败。

因此 iOS 27+ 改用 Apple 开发者工具链自带的 **DVT LocationSimulation**（和 Xcode「模拟位置」是同一个服务），它不走网络，不受证书固定影响。代价是需要一台 Mac，并开启开发者模式。

---

## 方案一：Loon 插件（iOS 27 beta 5 及更早）

### 安装

本仓库是私有仓库，Loon 无法直接订阅私有仓库的 raw 链接（需要 GitHub 令牌），所以用本地文件方式安装：

1. 下载 `loon/` 目录里的三个文件：`wloc.plugin`、`wloc.js`、`wloc-settings.js`
   （Mac 上：`gh repo clone imthnio/loon-wloc`，然后通过 iCloud 云盘传到手机）
2. 在 iPhone「文件」App 中，把三个文件放进 **iCloud 云盘 → Loon** 文件夹的同一个目录里
3. Loon → 配置 → 插件 → 添加本地插件 `wloc.plugin`（插件内 `script-path` 为相对路径，三个文件必须放在一起）
4. 打开 MITM，安装并信任 Loon 证书（设置 → 通用 → 关于本机 → 证书信任设置）

> 如果以后把仓库改为公开，也可以直接订阅
> `https://raw.githubusercontent.com/imthnio/loon-wloc/main/loon/wloc.plugin`，
> 但需先把插件里的 `script-path` 改成对应的完整 raw 链接。

### 设置位置

代理开启状态下，用 Safari 打开（这些请求会被 Loon 拦截，不会发到 Apple）：

```
https://gs-loc.apple.com/wloc-settings/save?lat=纬度&lon=经度
```

| 参数 | 说明 |
|---|---|
| `lat` / `lon` | 纬度 / 经度（必填） |
| `coord=gcj02` | 坐标来自高德、或中国大陆的苹果地图时加上，自动换算为 WGS84 |
| `acc` | 精度（米），默认 25 |
| `r` | 随机扰动半径（米），每次定位在目标附近随机偏移，默认 0 |
| `name` | 备注，会出现在通知里 |

其他：

- 查看当前坐标：`https://gs-loc.apple.com/wloc-settings/query`
- 清除并恢复真实定位：`https://gs-loc.apple.com/wloc-settings/clear`

**快捷指令：** 新建快捷指令 →「获取 URL 内容」→ 填入上面的链接（把经纬度换成「询问每次运行」的变量）即可一键切换。

也可以直接在插件参数里填写经纬度。优先级：网页/快捷指令保存的坐标 > 插件参数 > 不修改（真实定位）。

### 生效

- iOS 15 ~ 18：一般切换后几分钟内生效。
- iOS 26+：`locationd` 会长时间缓存定位结果，**需要重启手机**才会重新请求。推荐顺序：保存坐标 → 关闭定位服务 → 重启 → 开启 Loon（确认 VPN 图标）→ 打开定位服务 → 关闭 WiFi 后打开地图验证。

### 限制

- 只改网络定位，不改 GPS。室外 GPS 信号强时系统会以 GPS 为准，室内效果最好。
- Loon 日志中搜索 `[wloc]` 可看到每次修改了多少条 WiFi / 基站记录。

---

## 方案二：Mac 脚本（iOS 27 beta 6+ / 正式版）

### 准备（一次）

1. Mac 安装 uv：`brew install uv`（脚本会自动通过 `uvx` 运行 [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)）
2. iPhone 用数据线连 Mac，解锁并点「信任此电脑」
3. iPhone：设置 → 隐私与安全性 → **开发者模式** → 打开并按提示重启
   （若看不到该开关，先在 Mac 上执行一次 `prepare`，菜单会出现）
4. **关闭 Loon 的 WLOC 插件**

### 使用

```bash
cd mac
./ios27-location.sh prepare                       # 每次手机重启后执行一次
./ios27-location.sh set 31.2304 121.4737          # WGS84 坐标；保持窗口打开
./ios27-location.sh set 39.909187 116.397451 --gcj  # 高德 / 国内苹果地图坐标
./ios27-location.sh clear                         # 恢复真实定位
```

`set` 会一直运行，按 `Ctrl+C` 结束；结束后运行 `clear`。如有多台设备，加 `--udid <UDID>`（用 `devices` 查看）。

**无线使用：** 用数据线执行一次 `./ios27-location.sh wifi-on`，之后 iPhone 与 Mac 在同一 WiFi 下即可拔线运行 `set`。

### 限制

- 需要 Mac 保持运行；模拟会话断开后定位可能恢复。
- 这是“软件模拟定位”，部分 App 会通过 `isSimulatedBySoftware` 识别并拒绝。

---

## 文件

```
loon/wloc.plugin         Loon 插件
loon/wloc.js             响应脚本：解析 protobuf，替换 WiFi/基站坐标
loon/wloc-settings.js    设置脚本：保存 / 查询 / 清除坐标，GCJ-02 → WGS84
mac/ios27-location.sh    iOS 27+ Mac 端方案
```

## 许可证

AGPL-3.0（沿用上游项目许可证）。仅供个人学习研究使用。
