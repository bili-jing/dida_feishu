import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, copyFileSync, unlinkSync } from "node:fs";

function getBaseDir(): string {
  const execName = process.execPath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (execName === "bun" || execName === "bun.exe") {
    return process.cwd();
  }
  return dirname(process.execPath);
}

/**
 * 数据目录放在用户 home 下，避免在云同步目录（坚果云/iCloud/Dropbox 等）中
 * 频繁读写 SQLite 导致同步引擎崩溃或数据库损坏。
 */
function getDataDir(): string {
  return resolve(homedir(), ".dida-feishu");
}

export const BASE_DIR = getBaseDir();
export const DATA_DIR = getDataDir();
export const DB_DIR = resolve(DATA_DIR, "db");
export const DB_FILE = resolve(DB_DIR, "dida.db");
export const DOWNLOADS_DIR = resolve(BASE_DIR, "downloads");

mkdirSync(DB_DIR, { recursive: true });

// 自动迁移：如果旧位置（exe 旁的 db/）有数据库而新位置没有，则复制过来
const _oldDbFile = resolve(BASE_DIR, "db", "dida.db");
if (BASE_DIR !== DATA_DIR && !existsSync(DB_FILE) && existsSync(_oldDbFile)) {
  try {
    copyFileSync(_oldDbFile, DB_FILE);
    // WAL 模式下 -wal/-shm 可能包含未 checkpoint 的数据，单独 try/catch 允许主库迁移成功
    for (const suffix of ["-wal", "-shm"]) {
      const oldAux = _oldDbFile + suffix;
      if (existsSync(oldAux)) {
        try { copyFileSync(oldAux, DB_FILE + suffix); } catch {}
      }
    }
    console.log(`[迁移] 数据库已从 ${_oldDbFile} 复制到 ${DB_FILE}`);
    console.log(`[迁移] 旧数据库文件保留未删除，确认无误后可手动删除。`);
  } catch (e) {
    // 主库复制失败，清理残留避免使用损坏的空文件
    try { unlinkSync(DB_FILE); } catch {}
    console.error(`[迁移] 数据库迁移失败: ${(e as Error).message}`);
    console.error(`[迁移] 请手动将 ${_oldDbFile} 复制到 ${DB_FILE}`);
  }
}
