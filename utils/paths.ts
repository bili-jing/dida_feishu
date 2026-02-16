import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

function getBaseDir(): string {
  const execName = process.execPath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  // 通过 bun 运行（开发模式）→ 使用 cwd
  if (execName === "bun" || execName === "bun.exe") {
    return process.cwd();
  }
  // 编译后的可执行文件 → 使用 exe 所在目录
  return dirname(process.execPath);
}

export const BASE_DIR = getBaseDir();
export const DB_DIR = resolve(BASE_DIR, "db");
export const DB_FILE = resolve(DB_DIR, "dida.db");
export const DOWNLOADS_DIR = resolve(BASE_DIR, "downloads");

// 确保 db 目录存在
mkdirSync(DB_DIR, { recursive: true });
