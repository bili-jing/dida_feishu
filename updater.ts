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
      signal: AbortSignal.timeout(120000),
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
