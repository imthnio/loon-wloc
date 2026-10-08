# iOS 27 全程手机端改定位

适用：iOS 27 beta 6 及以后（含正式版）。全程在 iPhone 上完成，不需要电脑。

## 原理：为什么要换思路

旧方案（本仓库 Loon 插件）是改苹果定位服务器发回的数据。从 iOS 27 beta 6 起，系统只认苹果自己的证书，Loon 解不开这些数据，这条路已经走不通。换任何代理软件、改脚本都绕不过去。

新方案不碰网络数据，改为直接调用 iOS 自带的**开发者模拟定位服务**（Xcode 模拟定位用的就是它）。以前这个服务只能由电脑连接调用，现在有两点让手机自己也能用：

1. **iOS 27 新增了手机端配对**：设置 → 隐私与安全性 → 开发者模式 → 「与主机配对」，App 可以在手机上直接生成配对凭证，不用电脑。
2. **本地回环 VPN（LocalDevVPN）**：建一个指向手机自己的虚拟网卡（地址 `10.7.0.1`），App 通过它连接到手机自身的开发者服务。

## 需要的东西

| 名称 | 作用 | 获取 |
|---|---|---|
| LocalDevVPN | 本地回环 VPN | [App Store](https://apps.apple.com/us/app/localdevvpn/id6755608044)（可能需要外区 Apple ID） |
| SideInstaller | 在手机上安装 SideStore | 仅限官方：<https://sideinstaller.net/> |
| SideStore | 用你自己的 Apple ID 给 App 签名安装 | 由 SideInstaller 安装 |
| 改定位 App（二选一） | 选点、设置/恢复定位 | [Roam Control](https://github.com/seanhowarthdev/Roam-Control/releases)（功能全，有中文界面以外的引导）或 [Locus](https://github.com/ChrisMack32/Locus/releases)（开源 MIT） |

## 步骤

### 1. 装 LocalDevVPN
从 App Store 安装。打开一次，按提示添加 VPN 配置。

### 2. 装 SideInstaller → SideStore
1. Safari 打开 <https://sideinstaller.net/>，按页面提示安装 SideInstaller。
2. 先**断开 Loon**，打开 LocalDevVPN 并连接。
3. 打开 SideInstaller，登录 Apple ID，点 **Install SideStore**。
4. 如果下载 SideStore 失败（GitHub 在国内不稳定），见下方「和 Loon 的关系」里的 Clash Mi 办法。

### 3. 开启开发者模式
设置 → 隐私与安全性 → **开发者模式** → 打开，按提示重启。
（这个开关要装过 SideStore 之类的自签 App 后才会出现。）

### 4. 装改定位 App
1. 在手机 Safari 下载 Roam Control 或 Locus 的 `.ipa`（GitHub Releases 页面）。
2. 打开 SideStore → **+** → 选择刚下载的 ipa → 安装。

### 5. 手机端配对（只需一次）
以 Locus 为例（Roam Control 首次打开会有同样的引导）：
1. 打开 App → 设置 → **Pair on this iPhone** → **Start pairing**，允许「本地网络」权限。
2. 不要关 App，去 设置 → 隐私与安全性 → 开发者模式 → **与主机配对**，选择该 App。
3. 先输入锁屏密码，再输入 App 显示的 6 位配对码。

### 6. 改定位
1. 连接 LocalDevVPN（此时 Loon 会被断开，见下节）。
2. 打开改定位 App，在地图上选点或搜索地点 → 点 **Teleport / Start**。
3. 打开地图 App 验证。
4. 恢复：在 App 里点停止 / 恢复真实位置。

## 和 Loon 的关系（重要）

iOS 同一时间只能运行**一个**这类 VPN。LocalDevVPN 和 Loon 占的是同一个位置，所以**连上 LocalDevVPN 时 Loon 会断开**，反之亦然。

两种处理办法：

**办法 A：用的时候临时切换。** 改定位时开 LocalDevVPN，不需要代理。用完切回 Loon。
设好位置后可以试试切回 Loon，看定位是否保持。有些情况下会保持，有些会恢复真实位置，以你手机上的实际效果为准。

**办法 B：用 Clash Mi 代替 LocalDevVPN，代理和改定位同时用。**
[Clash Mi](https://apps.apple.com/us/app/clash-mi/id6744321968)（免费，外区商店）的内核支持「回环地址」，能同时完成代理和 `10.7.0.1` 回环两件事。做法见 [tom-snow/Sidestore-ClashMi](https://github.com/tom-snow/Sidestore-ClashMi)，核心是在覆写配置里加：

```yaml
tun:
  loopback-address:
    - 10.7.0.1
```

目前没有资料表明 Loon 也支持回环地址。如果以后 Loon 加入类似功能，就不用再切换。

## 风险与限制（请看完）

- **Apple ID 安全**：SideInstaller、SideStore 需要输入 Apple ID 密码来签名。**只从上面的官方地址下载**，有仿冒网站（例如 `sideinstaller.com` 就是假的）。建议用一个**小号 Apple ID** 来签名。
- **签名有效期**：免费 Apple ID 签的 App 7 天过期，需要在 SideStore 里刷新（刷新也需要连 LocalDevVPN）。免费账号最多同时有 3 个自签 App（包括 SideStore 本身）。
- **可能被识别**：这是系统层面的「软件模拟定位」，部分 App 能检测并拒绝（例如某些游戏、打卡软件）。旧 WLOC 方案改的是网络定位，两者的检测特征不同。
- **兼容性**：开发者已确认 iOS 27 / iPadOS 27 上模拟定位可用，但也有部分用户在 iOS 27.0 / 27.2 上遇到连接隧道失败的问题，相关 issue 还没关闭：[StikDebug #471](https://github.com/StikDebug/StikDebug/issues/471)。遇到问题可先删除配对后重新配对。
- **用完记得恢复**：模拟定位会影响所有 App，导航、紧急呼叫、查找等功能前请先恢复真实位置。

## 有电脑时的备用方案

如果手机端走不通，Mac 上可用 [`mac/ios27-location.sh`](mac/ios27-location.sh)，原理相同（调用开发者模拟定位服务），由电脑直接连接调用。
