# Auto-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic self-update capability so clients get new versions without manual file transfers.

**Architecture:** On startup, check GitHub Releases API for newer version. If found, download platform-specific binary, replace current executable (with macOS quarantine handling), prompt restart. CI via GitHub Actions builds and publishes releases on tag push.

**Tech Stack:** Bun (fetch, $, Bun.file, Bun.write), GitHub Releases API, GitHub Actions, @clack/prompts for UI

---

### Task 1: Version constant and package.json version

**Files:**
- Modify: `package.json` (add `version` field)
- Create: `version.ts`

**Step 1: Add version to package.json**

In `package.json`, add `"version": "1.0.0"` at the top level:

```json
{
  "name": "dida_feishu",
  "version": "1.0.0",
  "module": "index.ts",
  ...
}
```

**Step 2: Create version.ts**

Create `version.ts` that exports the version string. Use a simple constant (Bun's compile embeds the source, so this works):

```ts
export const APP_VERSION = "1.0.0";
```

We use a constant instead of reading package.json at runtime because `bun build --compile` bundles everything — a simple string constant is the most reliable approach.

**Step 3: Commit**

```bash
git add package.json version.ts
git commit -m "feat: add version tracking (v1.0.0)"
```

---

### Task 2: Updater module — version comparison and asset selection

**Files:**
- Create: `updater.ts`
- Create: `updater.test.ts`

**Step 1: Write the failing tests**

```ts
// updater.test.ts
import { test, expect } from "bun:test";
import { isNewer, getAssetName } from "./updater.ts";

test("isNewer: newer version returns true", () => {
  expect(isNewer("1.0.0", "1.0.1")).toBe(true);
  expect(isNewer("1.0.0", "1.1.0")).toBe(true);
  expect(isNewer("1.0.0", "2.0.0")).toBe(true);
});

test("isNewer: same version returns false", () => {
  expect(isNewer("1.0.0", "1.0.0")).toBe(false);
});

test("isNewer: older version returns false", () => {
  expect(isNewer("1.1.0", "1.0.0")).toBe(false);
  expect(isNewer("2.0.0", "1.9.9")).toBe(false);
});

test("isNewer: handles v prefix in remote", () => {
  expect(isNewer("1.0.0", "v1.0.1")).toBe(true);
  expect(isNewer("1.0.0", "v1.0.0")).toBe(false);
});

test("getAssetName: returns correct name per platform", () => {
  expect(getAssetName("darwin")).toBe("dida-feishu-macos");
  expect(getAssetName("win32")).toBe("dida-feishu.exe");
  expect(getAssetName("linux")).toBe("dida-feishu-linux");
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test updater.test.ts`
Expected: FAIL — `isNewer` and `getAssetName` not exported / don't exist

**Step 3: Implement version comparison and asset selection**

Create `updater.ts` with the tested functions and the full update logic:

```ts
// updater.ts
import * as p from "@clack/prompts";
import { APP_VERSION } from "./version.ts";

const REPO = "bili-jing/dida_feishu";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Compare semver: is remote newer than local? */
export function isNewer(local: string, remote: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [lMajor, lMinor, lPatch] = parse(local);
  const [rMajor, rMinor, rPatch] = parse(remote);
  if (rMajor !== lMajor) return rMajor > lMajor;
  if (rMinor !== lMinor) return rMinor > lMinor;
  return rPatch > lPatch;
}

/** Get the expected binary asset name for a platform */
export function getAssetName(platform: string): string {
  switch (platform) {
    case "win32": return "dida-feishu.exe";
    case "darwin": return "dida-feishu-macos";
    default: return "dida-feishu-linux";
  }
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
  html_url: string;
}

/** Check GitHub for a newer release and offer to update */
export async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(API_URL, {
      headers: { "Accept": "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;

    const release = (await res.json()) as ReleaseInfo;
    if (!isNewer(APP_VERSION, release.tag_name)) return;

    const remoteVersion = release.tag_name.replace(/^v/, "");
    const shouldUpdate = await p.confirm({
      message: `发现新版本 v${remoteVersion}（当前 v${APP_VERSION}），是否更新？`,
    });
    if (!shouldUpdate || typeof shouldUpdate === "symbol") return;

    const assetName = getAssetName(process.platform);
    const asset = release.assets.find(a => a.name === assetName);
    if (!asset) {
      p.log.warn(`未找到适用于当前平台的更新包 (${assetName})`);
      return;
    }

    await downloadAndReplace(asset.browser_download_url, remoteVersion);
  } catch {
    // Network error, timeout, etc — silently skip
  }
}

async function downloadAndReplace(url: string, version: string): Promise<void> {
  const s = p.spinner();
  s.start(`正在下载 v${version}...`);

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(120000), // 2 min for large binary
      redirect: "follow",
    });
    if (!res.ok) {
      s.stop(`下载失败: HTTP ${res.status}`);
      return;
    }

    const data = await res.arrayBuffer();
    const currentPath = process.execPath;

    // Dev mode (running via bun) — skip replacement
    const execName = currentPath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
    if (execName === "bun" || execName === "bun.exe") {
      s.stop(`开发模式下跳过替换（已下载 ${(data.byteLength / 1024 / 1024).toFixed(1)} MB）`);
      return;
    }

    const oldPath = currentPath + ".old";
    const tempPath = currentPath + ".new";

    // Write to temp file first
    await Bun.write(tempPath, data);

    if (process.platform !== "win32") {
      // macOS/Linux: chmod +x and remove quarantine
      const { $ } = Bun;
      await $`chmod +x ${tempPath}`.quiet();
      if (process.platform === "darwin") {
        await $`xattr -cr ${tempPath}`.quiet().nothrow();
      }
    }

    // Swap: current → .old, temp → current
    const { renameSync, unlinkSync } = await import("node:fs");
    try { unlinkSync(oldPath); } catch {} // clean up any previous .old
    renameSync(currentPath, oldPath);
    renameSync(tempPath, currentPath);

    s.stop(`更新完成！v${APP_VERSION} → v${version}`);
    p.log.success("请重新启动程序以使用新版本");
    process.exit(0);
  } catch (e) {
    s.stop(`更新失败: ${(e as Error).message}`);
    // Try to restore from .old if swap was partial
    try {
      const { existsSync, renameSync } = await import("node:fs");
      const currentPath = process.execPath;
      if (!existsSync(currentPath) && existsSync(currentPath + ".old")) {
        renameSync(currentPath + ".old", currentPath);
      }
    } catch {}
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test updater.test.ts`
Expected: all 5 tests PASS

**Step 5: Commit**

```bash
git add updater.ts updater.test.ts
git commit -m "feat: add auto-update module with version check and self-replacement"
```

---

### Task 3: Integrate updater into main entry point

**Files:**
- Modify: `index.ts:1212-1213` (add checkForUpdate call)

**Step 1: Add import and call**

In `index.ts`, add import at top and call in `main()`:

Add import near other imports (after line 17):
```ts
import { checkForUpdate } from "./updater.ts";
```

In `main()` function, add after `p.intro(...)` and before `const { userFilter } = parseArgs();`:
```ts
  await checkForUpdate();
```

**Step 2: Verify it compiles**

Run: `bun build --compile index.ts --outfile /tmp/test-dida`
Expected: compiles without errors

**Step 3: Commit**

```bash
git add index.ts
git commit -m "feat: check for updates on startup"
```

---

### Task 4: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Step 1: Create workflow file**

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: bun-darwin-arm64
            outfile: dida-feishu-macos
          - os: windows-latest
            target: bun-windows-x64
            outfile: dida-feishu.exe
          - os: ubuntu-latest
            target: bun-linux-x64
            outfile: dida-feishu-linux

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install

      - name: Build
        run: bun build --compile --target=${{ matrix.target }} index.ts --outfile dist/${{ matrix.outfile }}

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.outfile }}
          path: dist/${{ matrix.outfile }}

  release:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          files: |
            dist/dida-feishu-macos
            dist/dida-feishu.exe
            dist/dida-feishu-linux
```

**Step 2: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`
If python/pyyaml not available, visually inspect indentation.

**Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add GitHub Actions release workflow for auto-build on tag push"
```

---

### Task 5: Update build scripts and cleanup

**Files:**
- Modify: `package.json` (update build:mac target to arm64)
- Modify: `dist/启动.sh` (no longer needed after auto-update, but keep for first install)

**Step 1: Update build:mac target**

Since client is on macOS (likely Apple Silicon), update `package.json` build:mac:
```json
"build:mac": "bun build --compile --target=bun-darwin-arm64 index.ts --outfile dist/dida-feishu-macos"
```

Note: If the client is on Intel Mac, keep the current target. The GitHub Actions workflow already uses `macos-latest` which handles this.

**Step 2: Run all tests**

Run: `bun test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: update macOS build target to arm64"
```

---

### Task 6: End-to-end verification

**Step 1: Run full test suite**

Run: `bun test`
Expected: all tests pass

**Step 2: Test compilation**

Run: `bun build --compile index.ts --outfile /tmp/test-dida-update`
Expected: compiles successfully

**Step 3: Test updater in dev mode**

Run: `bun index.ts`
Expected: if no GitHub release exists yet, update check silently passes and main menu appears normally. If it can't reach GitHub, also silently skips.

**Step 4: Tag and push to trigger first release**

```bash
git tag v1.0.0
git push origin main --tags
```

Expected: GitHub Actions runs, creates Release with 3 binaries.

After release is live, running the **old** binary will detect v1.0.0 and offer update (or if versions match, silently skip).

---

## Version Bump Workflow (for future releases)

1. Make code changes, commit
2. Update `version.ts`: change `APP_VERSION` to new version
3. Commit: `git commit -am "chore: bump version to 1.0.1"`
4. Tag: `git tag v1.0.1`
5. Push: `git push origin main --tags`
6. Done — clients auto-update on next launch
