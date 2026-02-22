# 自动更新设计

## 背景

当前每次更新都需要手动编译、压缩、通过微信发给客户，客户还需要手动替换文件并执行 `xattr -cr` 解除 macOS Gatekeeper 拦截。

## 目标

- push tag 后自动编译发布
- 客户启动程序时自动检测并更新，无需手动操作
- macOS 隔离属性自动处理，客户完全无感

## 设计

### 1. 版本管理

- `package.json` 中加 `version` 字段（如 `"1.0.0"`）
- 代码中通过 `require("./package.json").version` 或常量读取
- 遵循 semver，每次发版递增版本号
- 发版方式：`git tag v1.0.1 && git push --tags`

### 2. GitHub Actions CI/CD

文件：`.github/workflows/release.yml`

触发条件：push tag `v*`

步骤：
1. 安装 Bun
2. `bun install`
3. 编译三个平台（Windows x64、macOS arm64、Linux x64）
4. 创建 GitHub Release，上传编译产物
5. Release body 自动包含 tag 对应的 commit message

产物命名：
- `dida-feishu-macos`
- `dida-feishu.exe`
- `dida-feishu-linux`

### 3. 程序内自动更新模块

新建 `updater.ts`，导出 `checkForUpdate()` 函数。

#### 检查更新流程

```
启动程序
  → GET https://api.github.com/repos/bili-jing/dida_feishu/releases/latest
  → 对比 remote tag vs 本地 version
  → 无新版本 → 正常启动
  → 有新版本 → 提示用户确认
    → 确认 → 下载对应平台的 asset
    → 写入临时文件 → chmod +x → xattr -cr (macOS)
    → 替换当前二进制（重命名旧文件为 .old，新文件放到原路径）
    → 提示"更新完成，请重新启动"
    → 退出程序
  → 网络不可用/超时(3s) → 静默跳过
```

#### 平台检测

```ts
const platform = process.platform; // "darwin" | "win32" | "linux"
const assetName = platform === "win32"
  ? "dida-feishu.exe"
  : platform === "darwin"
    ? "dida-feishu-macos"
    : "dida-feishu-linux";
```

#### macOS 隔离属性处理

下载新二进制后自动执行：
```ts
import { $ } from "bun";
await $`xattr -cr ${newBinaryPath}`.quiet();
await $`chmod +x ${newBinaryPath}`.quiet();
```

这样客户完全不需要手动处理 Gatekeeper 问题。

#### Windows 自替换

Windows 不允许覆盖运行中的 exe，但允许重命名：
```ts
// 1. 重命名当前程序
rename(currentPath, currentPath + ".old");
// 2. 新文件放到原路径
rename(tempPath, currentPath);
// 3. 下次启动时清理 .old
```

#### 错误处理

- API 请求超时 3 秒 → 跳过
- 下载失败 → 提示错误，不影响正常使用
- 替换失败 → 回滚（把 .old 改回来）
- 所有更新错误都 catch 住，绝不影响主程序

### 4. 集成点

在 `index.ts` 的 `main()` 函数最前面调用：

```ts
import { checkForUpdate } from "./updater.ts";

async function main() {
  await checkForUpdate(); // 检查更新，失败静默跳过
  // ... 现有逻辑
}
```

### 5. 新的工作流

之前：改代码 → `bun run build` → 压缩 → 微信发给客户 → 客户替换 → `xattr -cr`
之后：改代码 → `git tag v1.0.1 && git push --tags` → 完成（客户下次启动自动更新）

## 文件变更

- 新增 `updater.ts` — 自动更新模块
- 新增 `.github/workflows/release.yml` — CI/CD 配置
- 修改 `package.json` — 加 `version` 字段
- 修改 `index.ts` — 启动时调用 `checkForUpdate()`

## 注意事项

- GitHub API 有 rate limit（未认证 60 次/小时），对 1-5 个客户完全够用
- 首次使用需要客户手动安装一次（之后就自动了）
- 如果 GitHub 不可访问，静默跳过，不影响使用
