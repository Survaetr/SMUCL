<div align="center">

<img src="assets/logo-mc-256.png" width="116" alt="SMUCL" />

# SMUCL

**上海海事大学 Minecraft 启动器** · Shanghai Maritime University Custom Launcher

[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.7.0-3b7dd8](#)
[![Release](https://img.shields.io/github/v/release/Survaetr/SMUCL?label=release&color=3DA639)](https://github.com/Survaetr/SMUCL/releases)

</div>

界面综合了两款启动器的信息架构与交互习惯：**SJMC Launcher** 的分区清晰、以版本为中心的管理方式，
以及常见国产启动器「一屏启动」的首页布局；视觉上做了 Minecraft 化处理——校徽被重构为像素图标，
主按钮采用草方块绿的斜角浮雕，面板使用像素描边与内高光。

![首页](docs/screenshots/home.jpg)

> 本项目为个人学习作品，与 Mojang Studios、Microsoft 及上海海事大学官方均无关联。
> 启动器仅在本地读写文件，不收集任何数据。

## 功能

| 模块 | 说明 |
| --- | --- |
| 首页 | 版本下拉、玩家名、内存滑块、一键启动；运行环境、公告与新版本提示条 |
| 版本管理 | 跨目录汇总实例，显示加载器 / 模组数 / 是否版本隔离 / 占用空间，支持启动、打开目录、复制启动命令、删除；可导入 PCL / HMCL 导出的整合包 zip（预览 → 同名自动改名 → 校验依赖库） |
| 存档 | 扫描所有目录与实例的 `saves`，解析 `level.dat` 得到世界名、版本、模式、最后游玩；支持按文件夹（实例）/ 版本 / 时间分组、定位与移至回收站 |
| 下载游戏 | 拉取 Mojang 版本清单，按正式版 / 快照 / 旧版筛选，逐行进度条安装；中断的实例显示「修复」；可在线安装 Fabric / Quilt / Forge / NeoForge 加载器（底座缺失自动补装） |
| 整合包 | 从 Modrinth / CurseForge 搜索并一键安装，自动补原版与加载器，建版本隔离实例；支持导入 / 导出本地 zip |
| 账号 | 微软正版登录（设备码流程），令牌用系统凭据加密保存；离线账户照旧可用 |
| 设置 | Java 运行时扫描与指定、内存、JVM 参数、全屏、显卡偏好（写入 Windows 图形设置）、下载源、并发数、游戏目录管理、自动检查新版本 |
| 主题 | 深色 / 浅色 / 跟随系统，标题栏右上角一键切换 |
| 在线更新 | 检查本仓库 Release，下载 `app-<version>.zip` 增量更新包并自动重启；升级后首次启动弹出更新日志 |
| 运行日志 | 底部抽屉，实时显示游戏 stdout / stderr，错误行高亮 |

### 截图

| 存档管理 | 版本管理 |
| --- | --- |
| ![存档](docs/screenshots/saves.jpg) | ![版本](docs/screenshots/versions.jpg) |

| 下载游戏 | 设置 |
| --- | --- |
| ![下载](docs/screenshots/download.jpg) | ![设置](docs/screenshots/settings.jpg) |

浅色主题（首页横幅与运行日志刻意保持深色，避免像素 Logo 失效）：

![浅色主题](docs/screenshots/home-light.jpg)

## 快速开始

### 直接运行

项目不提交构建产物，需在本地打包一次：

```bash
git clone <this-repo>
cd SMUCL
npm install
node build/package.js
```

产物在 `dist/SMUCL-win32-x64/`，双击 `SMUCL.exe` 即可，整个目录可拷贝到任意位置运行。

> 若 `npm install` 卡在 Electron 二进制下载，可先设置镜像：
> `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

### 开发模式

```bash
npm install
npm start
```

Windows 上也可双击 `启动开发版.bat`（脚本会清空可能干扰 Electron 的 `ELECTRON_RUN_AS_NODE`
与 `NODE_OPTIONS` 环境变量）。

## 项目结构

```
SMUCL/
├── main.js              主进程：窗口、IPC、安装与启动调度、版本轮询、GPU 兜底
├── preload.js           contextBridge 暴露的受控 API
├── core/
│   ├── settings.js      配置读写
│   ├── net.js           请求 / 下载 / 并发池
│   ├── mirror.js        下载源重写（BMCLAPI ↔ 官方）
│   ├── rules.js         版本 JSON 的 os / features 规则
│   ├── java.js          Java 探测与版本匹配（跨目录）
│   ├── dirs.js          启动器识别与游戏目录聚合
│   ├── version.js       远端清单、多目录实例扫描、继承合并
│   ├── saves.js         存档扫描与体积统计
│   ├── nbt.js           level.dat 的 NBT 解析
│   ├── install.js       客户端 / 依赖库 / 资源 / natives
│   └── launch.js        启动参数构建（隔离目录 + natives 复用）与进程管理
├── renderer/            index.html / styles.css / app.js（原生实现，无框架）
├── assets/              像素化 Logo、wordmark、icon
├── build/               打包、Logo 生成、自测脚本
└── docs/screenshots/    README 用截图
```

## 实现要点

- **多启动器目录发现**：解析桌面快捷方式定位启动器 exe，取其同级 `.minecraft`；已实测识别 PCL 便携版
  （exe 与游戏目录不在 `%APPDATA%` 的常见布局）。首次启动若主目录为空会自动采用。
- **版本隔离适配**：PCL / HMCL 的隔离实例把 `mods`、`config`、`saves` 放在 `versions/<id>/` 下，
  启动时 `--gameDir` 与进程工作目录都指向实例目录，并优先复用 `<id>-natives` 里已解压的本地库。
- **存档解析**：自实现 NBT 读取器（gzip + 全部 TAG 类型），只取需要的字段，不加载区块数据；
  兼容 1.21.2+ 把难度改为 `difficulty_settings.difficulty` 字符串的新结构，并剥离 `§` 格式码。
- **实时版本检查**：后台每 5 分钟拉取版本清单，最新正式版变化时推送界面并弹系统通知；
  首页提示条可一键安装。可在设置中关闭。
- **双源回退**：默认走 BMCLAPI 镜像，单文件失败自动换官方源重试；清单获取也做双源竞速。
- **增量安装**：已存在且大小一致的文件直接跳过，重复安装不会重复下载。
- **GPU 兼容兜底**：监听 `child-process-gone`，GPU 进程反复崩溃时写标记并带兼容参数自动重启，
  避免在驱动异常或安全软件拦截沙箱的机器上直接闪退。

## 已知限制

- 仅支持**离线账户**，未接入 Microsoft 正版登录，无法进入正版验证服务器。
- 下载页只列原版版本；Forge / Fabric / NeoForge 实例需先用对应安装器生成，本启动器负责运行。
- 资源未做 SHA1 校验，仅按文件大小判断完整性。
- 存档支持查看、定位、移至回收站，暂未提供打包备份与还原。
- Windows 优先（依赖 `javaw.exe`、路径分隔符），macOS / Linux 需自行适配。

## 在线更新

应用只替换自身代码（`resources/app`，约 340 KB），不重下 Electron 运行时，因此更新包能直接挂在 Release 上：

1. 启动 6 秒后请求 `releases/latest`，与本机版本号比对；
2. 有新版本则弹窗展示 Release 说明，可一键更新；
3. 下载 `app-<version>.zip` → 解压覆盖 `resources/app` → `app.relaunch()` 重启；
4. 新版首次启动比对 `lastSeenVersion`，不一致则弹出更新日志。

发版流程：改 `package.json` 版本 → 在 `renderer/changelog.js` 顶部加一条 → `node build/package.js`
→ 把 `dist/app-<version>.zip` 上传到对应 Release。

## 更新记录

**v1.7.0**

- 版本管理页每个实例新增「导出」按钮，可把实例打包成可分享的整合包 zip
- 导出时可选包含模组、配置、资源包、光影、存档、游戏设置；版本定义与说明文件始终包含
- 版本 JSON 会展开成自包含形式，接收方无需额外安装加载器实例即可启动
- 流式写 zip，内存占用与包体大小无关；不含客户端 jar 与公共库，接收方首次启动自动补齐
- 导入端改进识别：加载器改从 libraries 坐标判断，原版版本从实例名提取，不再显示为实例名
- 修复部分实例启动即闪退（classpath 重复导致 BootstrapLauncher 抛 Duplicate key）
- Java 选择收紧：不再拿跨代过多的版本硬跑，找不到匹配版本时明确提示

**v1.6.1**

- 修复部分实例启动即闪退：PCL 生成的版本 JSON 把原版与加载器的库全部内联，公共库重复出现，
  导致 `BootstrapLauncher` 抛 `Duplicate key` 并退出（无游戏日志）
- classpath 生成时按路径去重；合并继承链时按 Maven 坐标（`group:artifact[:classifier]`）去重
- Java 选择收紧：不再拿跨代过多的版本硬跑（如用 Java 25 跑需要 21 的 NeoForge），
  找不到匹配版本时直接提示需要哪个版本，而不是静默崩溃
- 首页「运行环境」不再显示"检测到的最新 Java"，改为显示**当前实例实际会用的**那个

**v1.6.0**

- 新增正版登录：微软账号设备码流程，浏览器输码即可，密码不经过启动器
- 令牌用 Electron `safeStorage`（Windows DPAPI）加密落盘，不存明文
- 登录后启动自动使用正版身份，可进入正版验证服务器；令牌过期自动续期
- 客户端 ID 可在设置里填写（Azure 免费注册、开启公共客户端流），不内置第三方 ID
- 离线账户行为不变，随时可退出登录切回

**v1.5.0**

- 新增「整合包」页：从 Modrinth 搜索并一键安装，CurseForge 需填写免费 API Key
- 安装时自动补原版与加载器，实例采用「整合包 → 加载器 → 原版」三层继承，不复制客户端
- 文件按 sha1 校验，不符自动重下；overrides 解压到实例目录
- 修复客户端 jar 只向上找一层的问题（三层继承时会找不到 jar）
- 加载器依赖增加多源回退：镜像 → 官方 → Maven Central

**v1.4.2**

- 修复点击「导入整合包」报 `The "path" argument must be of type string`：函数带参数却直接挂到 onclick，首个参数成了鼠标事件对象
- 合并社区 PR #4（[@ALexanderLee-real](https://github.com/ALexanderLee-real)）：natives 统一解压到 `<实例>/natives` 并重写 `java.library.path`，修复部分机器找不到 `lwjgl.dll` 无法启动
- natives 包按 CPU 架构过滤，避免误加载 x86 / arm64 的 DLL
- 主进程增加路径类型校验，非字符串路径返回可读提示

**v1.4.1**

- 修复首页横幅 Logo 外圈虚线环偏移、被裁切：环与徽标改为同心居中
- 徽标与环整组浮动，避免相对位移

**v1.4.0**

- 下载页新增「安装模组加载器」，支持 Fabric / Quilt / Forge / NeoForge
- Fabric / Quilt 走官方 meta 的版本 JSON，纯 HTTP 完成，不需要 Java
- Forge / NeoForge 下载官方安装器并调用本机 Java 执行（`--installClient`）
- 原版底座缺失时自动先补装，装完直接可启动
- 镜像 / 官方双源：NeoForge 官方域名屡遭 DNS 污染，默认走 BMCLAPI 镜像

**v1.3.1**

- 修复浅色主题下版本下拉列表深底深字几乎看不见的问题，下拉项现在跟随主题配色
- 修复中文输入法输入玩家名时被吞字：拼写过程中不再改写输入框，合成结束后才过滤
- 原生控件（滚动条、下拉弹层）跟随深浅主题

**v1.3.0**

- 新增「导入整合包」：支持 PCL / HMCL 导出的 zip，导入前预览版本、加载器、模组数与目标目录
- 同名实例自动改名为 `xxx-imported`，不覆盖已有版本
- 导入后校验 `libraries` 是否齐全，缺库给出提示
- CurseForge / Modrinth 清单包会被识别并说明「需要先在线安装加载器」

**v1.2.3**

- 存档页支持三种分组：按文件夹（实例）/ 按版本 / 按时间
- 新增「使用高性能显卡」：把每个版本的 `javaw.exe` 写进 `HKCU\...\DirectX\UserGpuPreferences`，关闭开关即删除值恢复默认
- 内存分配改为 256 MB 一档，上限按物理内存 75%（最高 16 GB）
- 修正浅色主题下分组标题的对比度

**v1.2.2**

- 更新检查提前到启动 2.5 秒，运行期间每 30 分钟复查
- 侧栏底部常驻「发现新版本」提示条，关于页显示检查状态
- 有更新时优先弹更新提示，不再与更新日志互相顶掉

**v1.2.1**

- 重新设计图标：木质船舵作外轮廓，校徽圆章成为轮毂中心，保留 1909
- 校徽不再是照片下采样，改为像素手绘的帆船与波浪，小尺寸也能认出
- 同步更新窗口图标、关于页与标题栏 Logo

**v1.2.0**

- 新增深色 / 浅色 / 跟随系统三种主题，标题栏右上角可一键切换
- 启动时检查 GitHub Release，可直接下载更新包并自动重启
- 每次升级后首次启动弹出更新日志
- 打包脚本额外产出 `dist/app-<version>.zip`（约 340 KB），用于增量更新
- 浅色主题下重新调校状态标签、数值文字与标题栏 Logo 的对比度

**v1.1.0**

- 新增「存档」页：NBT 解析世界名 / 版本 / 模式 / 最后游玩，展示世界真实图标
- 新增多启动器目录发现与聚合，自动采用 PCL 便携版目录；设置页可增删目录、切换主目录
- 适配版本隔离实例：`--gameDir` 指向实例目录，复用 `<id>-natives`
- 新增后台版本轮询与首页更新提示条，可一键安装最新正式版
- 新增 GPU 兼容兜底与开关

**v1.0.0** 首个版本：安装、启动、版本管理、设置、日志。

## 致谢

- [SJMC Launcher](https://github.com/UNIkeEN/SJMCL)：上海交通大学开源项目，本项目的界面分区与交互参考
- [BMCLAPI](https://bmclapi.bangbang93.com/)：国内镜像加速
- 版本元数据来自 Mojang Launcher Meta
- [Electron](https://www.electronjs.org/) 与 [adm-zip](https://github.com/cthackers/adm-zip)：运行时与解压

## 许可

[MIT](LICENSE)
