# Document Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to view, manage, and delete Feishu Bitable documents they've created, and prompt before full rebuild about handling old documents.

**Architecture:** New `feishu_doc_history` DB table tracks all created documents. Feishu cloud space scanning discovers orphaned documents. Two UI entry points (top-level menu + feishu config menu). Full rebuild flow prompts user about old document deletion.

**Tech Stack:** Bun, bun:sqlite, @larksuiteoapi/node-sdk, @clack/prompts

---

### Task 1: Add `feishu_doc_history` table and DB helpers

**Files:**
- Modify: `db/index.ts`

**Step 1: Add table creation in `initSchema`**

Add after the `feishu_config` table creation (after line 86), before the `attachment_cache` table:

```typescript
  db.run(`
    CREATE TABLE IF NOT EXISTS feishu_doc_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      app_token TEXT NOT NULL,
      table_id TEXT,
      app_url TEXT,
      name TEXT,
      is_current INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_doc_history_user ON feishu_doc_history (user_id, is_current)`);
```

**Step 2: Add CRUD functions**

Add after the `saveFeishuConfig` function (after line 299), before the `// ─── 飞书凭据` section:

```typescript
// ─── 飞书文档历史 ────────────────────────────────────

export interface DocHistoryRow {
  id: number;
  user_id: string;
  app_token: string;
  table_id: string | null;
  app_url: string | null;
  name: string | null;
  is_current: number;
  created_at: string;
  deleted_at: string | null;
}

/** 获取用户的所有文档历史（未删除的） */
export function getDocHistory(userId: string): DocHistoryRow[] {
  return getDb().query(
    `SELECT * FROM feishu_doc_history
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY is_current DESC, created_at DESC`
  ).all(userId) as DocHistoryRow[];
}

/** 添加文档历史记录 */
export function addDocHistory(
  userId: string, appToken: string, tableId: string | null,
  appUrl: string | null, name: string | null, isCurrent: boolean
) {
  // 如果标记为当前，先把其他的设为非当前
  if (isCurrent) {
    getDb().run(
      `UPDATE feishu_doc_history SET is_current = 0 WHERE user_id = ?`,
      [userId]
    );
  }
  getDb().run(
    `INSERT INTO feishu_doc_history (user_id, app_token, table_id, app_url, name, is_current)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, appToken, tableId, appUrl, name, isCurrent ? 1 : 0]
  );
}

/** 标记文档为已删除 */
export function markDocDeleted(appToken: string) {
  getDb().run(
    `UPDATE feishu_doc_history SET deleted_at = datetime('now'), is_current = 0
     WHERE app_token = ?`,
    [appToken]
  );
}

/** 将当前文档降级为历史文档 */
export function demoteCurrentDoc(userId: string) {
  getDb().run(
    `UPDATE feishu_doc_history SET is_current = 0 WHERE user_id = ? AND is_current = 1`,
    [userId]
  );
}

/** 获取当前文档 */
export function getCurrentDoc(userId: string): DocHistoryRow | null {
  return getDb().query(
    `SELECT * FROM feishu_doc_history WHERE user_id = ? AND is_current = 1 AND deleted_at IS NULL`
  ).get(userId) as DocHistoryRow | null;
}
```

**Step 3: Export new functions in imports**

Update the export list at the top of `db/index.ts` — no explicit export list needed since functions use `export` keyword directly.

**Step 4: Verify it compiles**

Run: `bun build db/index.ts --no-bundle`
Expected: No errors

**Step 5: Commit**

```bash
git add db/index.ts
git commit -m "feat: add feishu_doc_history table and helpers"
```

---

### Task 2: Add `deleteBitable` and `scanBitables` to Feishu client

**Files:**
- Modify: `feishu/client.ts`

**Step 1: Add `deleteBitable` function**

Add after the `getBitableInfo` function (after line 249):

```typescript
/** 删除飞书多维表格（移入回收站） */
export async function deleteBitable(appToken: string) {
  const client = getFeishuClient();
  const res = await client.drive.file.delete({
    params: { type: "bitable" },
    path: { file_token: appToken },
  });
  if (res.code !== 0) throw new Error(`删除多维表格失败: ${res.msg}`);
  return res.data;
}
```

**Step 2: Add `scanBitables` function**

Add right after `deleteBitable`:

```typescript
/** 扫描飞书云空间，查找名称包含指定前缀的多维表格 */
export async function scanBitables(namePrefix: string = "滴答清单"): Promise<Array<{
  token: string;
  name: string;
  type: string;
  created_time: string;
  modified_time: string;
  url: string;
}>> {
  const client = getFeishuClient();
  const results: Array<{
    token: string;
    name: string;
    type: string;
    created_time: string;
    modified_time: string;
    url: string;
  }> = [];

  let pageToken: string | undefined;
  do {
    const res = await client.drive.file.list({
      params: {
        folder_token: "",
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0) throw new Error(`扫描云空间失败: ${res.msg}`);

    for (const file of res.data?.files ?? []) {
      if (file.type === "bitable" && file.name?.includes(namePrefix)) {
        results.push({
          token: file.token!,
          name: file.name!,
          type: file.type!,
          created_time: file.created_time ?? "",
          modified_time: file.modified_time ?? "",
          url: file.url ?? `https://feishu.cn/base/${file.token}`,
        });
      }
    }
    pageToken = res.data?.next_page_token;
  } while (pageToken);

  return results;
}
```

**Step 3: Verify it compiles**

Run: `bun build feishu/client.ts --no-bundle`
Expected: No errors

**Step 4: Commit**

```bash
git add feishu/client.ts
git commit -m "feat: add deleteBitable and scanBitables to feishu client"
```

---

### Task 3: Update `sync.ts` to record document history

**Files:**
- Modify: `sync.ts`

**Step 1: Add imports**

Add `addDocHistory` and `demoteCurrentDoc` to imports. At the top of `sync.ts`, these functions are not imported from `db/index.ts` — instead `sync.ts` uses its own inline DB helpers. So add a new import at the top (after line 36):

```typescript
import {
  addDocHistory, demoteCurrentDoc, getDocHistory, markDocDeleted,
} from "./db/index.ts";
```

**Step 2: Update `fullSyncUser` to record history**

In `fullSyncUser`, after the existing cleanup block (lines 930-937) and before `// 1. 创建飞书多维表格`, add history demotion:

Replace lines 930-937:
```typescript
  // 清除旧的同步状态（重建表格）
  db.run(`DELETE FROM feishu_config WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM sync_state WHERE user_id = ?`, [userId]);
  // 清除旧的 file_token（新表格需要重新上传），但保留 local_path
  db.run(
    `UPDATE attachment_cache SET feishu_file_token = NULL, uploaded_at = NULL WHERE user_id = ?`,
    [userId]
  );
```

With:
```typescript
  // 将旧文档降级为历史
  demoteCurrentDoc(userId);

  // 清除旧的同步状态（重建表格）
  db.run(`DELETE FROM feishu_config WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM sync_state WHERE user_id = ?`, [userId]);
  // 清除旧的 file_token（新表格需要重新上传），但保留 local_path
  db.run(
    `UPDATE attachment_cache SET feishu_file_token = NULL, uploaded_at = NULL WHERE user_id = ?`,
    [userId]
  );
```

**Step 3: Record new document in history**

In `fullSyncUser`, after `saveFeishuConfig` (line 1051), add:

```typescript
  addDocHistory(userId, appToken, tableId, app.url, `滴答清单 - ${displayName}`, true);
```

**Step 4: Verify it compiles**

Run: `bun build sync.ts --no-bundle`
Expected: No errors

**Step 5: Commit**

```bash
git add sync.ts
git commit -m "feat: record document history on full sync"
```

---

### Task 4: Add document management menu to `index.ts`

**Files:**
- Modify: `index.ts`

**Step 1: Add new imports**

At the top of `index.ts` (line 4-9), add the new DB and feishu functions to the import lists:

Add to the `db/index.ts` import:
```typescript
  getDocHistory, addDocHistory, markDocDeleted, getCurrentDoc, demoteCurrentDoc,
```

Add to the `feishu/client.ts` import or add a new import:
```typescript
import { setFeishuCredentials, clearFeishuCredentials, scanBitables, deleteBitable } from "./feishu/client.ts";
```

**Step 2: Add the `docManagementMenu` function**

Add after the `aiConfigMenu` function (after line 672), before the `// ─── 同步到飞书` section:

```typescript
// ─── 文档管理 ──────────────────────────────────────

async function docManagementMenu(userId: string) {
  // 需要飞书凭据才能扫描
  if (!activateFeishuCredentials(userId)) {
    p.log.warn("需要先绑定飞书应用才能管理文档");
    return;
  }

  const s = p.spinner();
  s.start("扫描飞书云空间...");

  let cloudDocs: Array<{ token: string; name: string; created_time: string; url: string }> = [];
  try {
    cloudDocs = await scanBitables("滴答清单");
  } catch (e) {
    s.stop("扫描失败");
    p.log.error(`扫描飞书云空间失败: ${(e as Error).message}`);
    return;
  }

  // 合并本地历史
  const localDocs = getDocHistory(userId);
  const currentConfig = getFeishuConfig(userId);

  // 用 app_token 去重，云空间为准，补充本地标记
  const tokenSet = new Set<string>();
  interface MergedDoc {
    token: string;
    name: string;
    url: string;
    created_time: string;
    isCurrent: boolean;
    source: "cloud" | "local" | "both";
  }
  const merged: MergedDoc[] = [];

  for (const doc of cloudDocs) {
    tokenSet.add(doc.token);
    const local = localDocs.find(l => l.app_token === doc.token);
    merged.push({
      token: doc.token,
      name: doc.name,
      url: doc.url,
      created_time: doc.created_time,
      isCurrent: currentConfig?.app_token === doc.token,
      source: local ? "both" : "cloud",
    });
  }

  // 本地有但云空间没有的（可能已被手动删除）
  for (const doc of localDocs) {
    if (!tokenSet.has(doc.app_token)) {
      // 跳过已标记删除的
      if (doc.deleted_at) continue;
      merged.push({
        token: doc.app_token,
        name: doc.name ?? "未知文档",
        url: doc.app_url ?? "",
        created_time: doc.created_at,
        isCurrent: doc.is_current === 1,
        source: "local",
      });
    }
  }

  s.stop(`发现 ${merged.length} 个文档`);

  if (merged.length === 0) {
    p.log.info("没有发现任何飞书文档");
    return;
  }

  // 同步云空间发现的文档到本地历史
  for (const doc of merged) {
    if (doc.source === "cloud") {
      addDocHistory(userId, doc.token, null, doc.url, doc.name, doc.isCurrent);
    }
  }

  while (true) {
    const options: Array<{ value: string; label: string; hint?: string }> = merged
      .filter(d => d.source !== "local") // 只显示云空间中实际存在的
      .map(d => ({
        value: d.token,
        label: `${d.isCurrent ? "★ " : "  "}${d.name}`,
        hint: `${d.isCurrent ? "当前使用" : ""}${d.created_time ? ` ${formatTime(d.created_time)}` : ""}`,
      }));

    if (merged.some(d => d.source === "local")) {
      const localOnly = merged.filter(d => d.source === "local");
      p.log.warn(`${localOnly.length} 个本地记录的文档在云空间中未找到（可能已手动删除）`);
    }

    options.push({ value: "__batch_delete__", label: "批量删除非当前文档" });
    options.push({ value: "__back__", label: "← 返回" });

    const choice = await p.select({ message: "选择文档操作", options });
    exitIfCancelled(choice);

    if (choice === "__back__") return;

    if (choice === "__batch_delete__") {
      const nonCurrent = merged.filter(d => !d.isCurrent && d.source !== "local");
      if (nonCurrent.length === 0) {
        p.log.info("没有可删除的历史文档");
        continue;
      }

      const confirmed = await p.confirm({
        message: `确认删除 ${nonCurrent.length} 个非当前文档？（将移入飞书回收站）`,
      });
      exitIfCancelled(confirmed);
      if (!confirmed) continue;

      const ds = p.spinner();
      ds.start(`删除中 (0/${nonCurrent.length})...`);
      let deleted = 0;
      for (const doc of nonCurrent) {
        try {
          await deleteBitable(doc.token);
          markDocDeleted(doc.token);
          deleted++;
          ds.message(`删除中 (${deleted}/${nonCurrent.length})...`);
        } catch (e) {
          p.log.warn(`删除 ${doc.name} 失败: ${(e as Error).message}`);
        }
      }
      ds.stop(`已删除 ${deleted} 个文档`);

      // 刷新列表
      merged.splice(0, merged.length, ...merged.filter(d => d.isCurrent || !nonCurrent.includes(d)));
      continue;
    }

    // 选择了单个文档
    const doc = merged.find(d => d.token === choice);
    if (!doc) continue;

    const action = await p.select({
      message: doc.name,
      options: [
        ...(doc.url ? [{ value: "open", label: "查看链接", hint: doc.url }] : []),
        ...(!doc.isCurrent ? [{ value: "delete", label: "删除", hint: "移入飞书回收站" }] : []),
        { value: "__back__", label: "← 返回" },
      ],
    });
    exitIfCancelled(action);

    if (action === "open" && doc.url) {
      p.log.info(`飞书链接: ${doc.url}`);
    } else if (action === "delete") {
      const confirmed = await p.confirm({ message: `确认删除「${doc.name}」？` });
      exitIfCancelled(confirmed);
      if (confirmed) {
        try {
          const ds = p.spinner();
          ds.start("删除中...");
          await deleteBitable(doc.token);
          markDocDeleted(doc.token);
          ds.stop("已删除");

          // 从列表移除
          const idx = merged.indexOf(doc);
          if (idx !== -1) merged.splice(idx, 1);
        } catch (e) {
          p.log.error(`删除失败: ${(e as Error).message}`);
        }
      }
    }
  }
}

function formatTime(ts: string): string {
  // 飞书返回的 created_time 可能是秒级时间戳
  const num = Number(ts);
  if (!isNaN(num) && num > 1e9) {
    return new Date(num * 1000).toLocaleDateString("zh-CN");
  }
  // ISO 格式
  try {
    return new Date(ts).toLocaleDateString("zh-CN");
  } catch {
    return ts;
  }
}
```

**Step 3: Add "文档管理" to the user menu**

In the `userMenu` function (around line 889-906), add a new menu option. After the `ai_config` option (line 901) and before the `__back__` option (line 903), add:

```typescript
    options.push({
      value: "doc_management",
      label: "文档管理",
      hint: "查看/删除飞书文档",
    });
```

**Step 4: Add the case handler**

In the `switch (choice)` block (around line 914-938), add before `case "__back__"`:

```typescript
      case "doc_management":
        await docManagementMenu(user.id);
        break;
```

**Step 5: Verify it compiles**

Run: `bun build index.ts --no-bundle`
Expected: No errors

**Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: add document management menu with scan and delete"
```

---

### Task 5: Update feishu config menu to show document info

**Files:**
- Modify: `index.ts`

**Step 1: Enhance `feishuConfigMenu` to show document info**

In `feishuConfigMenu` (starting at line 539), update the info display. Replace the existing info block (lines 544-549):

```typescript
    // 已绑定 → 显示状态，提供换绑/解绑
    let info = `App ID: ${creds.app_id.slice(0, 6)}...${creds.app_id.slice(-4)}`;
    if (feishuConfig?.app_url) {
      info += `\n飞书链接: ${feishuConfig.app_url}`;
    }
    p.note(info, "当前飞书配置");
```

With:

```typescript
    // 已绑定 → 显示状态，提供换绑/解绑
    let info = `App ID: ${creds.app_id.slice(0, 6)}...${creds.app_id.slice(-4)}`;
    if (feishuConfig?.app_url) {
      info += `\n当前文档: ${feishuConfig.app_url}`;
    }
    const docHistory = getDocHistory(userId);
    const historyCount = docHistory.filter(d => d.is_current === 0).length;
    if (historyCount > 0) {
      info += `\n历史文档: ${historyCount} 个`;
    }
    p.note(info, "当前飞书配置");
```

**Step 2: Add "管理文档" option to feishu config menu**

In `feishuConfigMenu`, add a new option to the select menu. Replace the options array (lines 553-557):

```typescript
      options: [
        { value: "rebind", label: "换绑", hint: "更换飞书应用凭据" },
        { value: "unbind", label: "解绑", hint: "移除飞书凭据" },
        { value: "__back__", label: "← 返回" },
      ],
```

With:

```typescript
      options: [
        { value: "docs", label: "管理文档", hint: "查看/删除飞书文档" },
        { value: "rebind", label: "换绑", hint: "更换飞书应用凭据" },
        { value: "unbind", label: "解绑", hint: "移除飞书凭据" },
        { value: "__back__", label: "← 返回" },
      ],
```

**Step 3: Add handler for the new option**

In the if-else chain after the select (around line 561), add before the `rebind` handler:

```typescript
    if (choice === "docs") {
      await docManagementMenu(userId);
    } else if (choice === "rebind") {
```

(Replace the existing `if (choice === "rebind")` with `} else if (choice === "rebind")`.)

**Step 4: Verify it compiles**

Run: `bun build index.ts --no-bundle`
Expected: No errors

**Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: show document info in feishu config menu"
```

---

### Task 6: Add full-rebuild prompt for old document handling

**Files:**
- Modify: `index.ts`

**Step 1: Update the full rebuild flow in `syncToFeishu`**

In `syncToFeishu`, when the user selects `"full"` (full rebuild), we need to check for existing documents and prompt. Find the two places where full rebuild is triggered:

**Location 1:** Around line 722-726 (when data is already up to date but user chose full rebuild):

Replace:
```typescript
        s.start("全量同步中...");
        await fullSyncUser(db, userId, false);
        s.stop("全量同步完成");
```

With:
```typescript
        const shouldProceed = await promptDeleteOldDoc(userId);
        if (!shouldProceed) return;
        s.start("全量同步中...");
        await fullSyncUser(db, userId, false);
        s.stop("全量同步完成");
```

**Location 2:** Around line 773-776 (in the normal sync choice flow):

Replace:
```typescript
      } else {
        s.start("全量同步中...");
        await fullSyncUser(db, userId, false);
        s.stop("全量同步完成");
      }
```

With:
```typescript
      } else {
        const shouldProceed = await promptDeleteOldDoc(userId);
        if (!shouldProceed) { db.close(); return; }
        s.start("全量同步中...");
        await fullSyncUser(db, userId, false);
        s.stop("全量同步完成");
      }
```

**Step 2: Add the `promptDeleteOldDoc` helper function**

Add before `syncToFeishu` function (before line 676):

```typescript
/** 全量重建前提示用户处理旧文档 */
async function promptDeleteOldDoc(userId: string): Promise<boolean> {
  const config = getFeishuConfig(userId);
  if (!config) return true; // 没有旧文档，直接继续

  const choice = await p.select({
    message: `检测到旧表格，如何处理？`,
    options: [
      { value: "delete", label: "删除旧表格后重建", hint: "旧表格移入飞书回收站" },
      { value: "keep", label: "保留旧表格，创建新的" },
      { value: "cancel", label: "取消" },
    ],
  });
  exitIfCancelled(choice);

  if (choice === "cancel") return false;

  if (choice === "delete") {
    try {
      const s = p.spinner();
      s.start("删除旧表格...");
      await deleteBitable(config.app_token);
      markDocDeleted(config.app_token);
      s.stop("旧表格已删除（可在飞书回收站恢复）");
    } catch (e) {
      p.log.warn(`删除旧表格失败: ${(e as Error).message}，将保留旧表格继续重建`);
    }
  }

  return true;
}
```

**Step 3: Add `deleteBitable` to import**

Ensure `deleteBitable` is in the import from `feishu/client.ts` (should already be added in Task 4, Step 1).

**Step 4: Verify it compiles**

Run: `bun build index.ts --no-bundle`
Expected: No errors

**Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: prompt to handle old document before full rebuild"
```

---

### Task 7: Manual integration test

**Step 1: Run the app**

Run: `bun run index.ts`

**Step 2: Verify the menu**

1. Log in and select a user
2. Verify "文档管理" appears in the user menu
3. Enter "飞书配置" → verify it shows document count and has "管理文档" option

**Step 3: Test document scanning**

1. Select "文档管理"
2. Verify spinner shows "扫描飞书云空间..."
3. Verify list shows discovered documents with ★ for current

**Step 4: Test full rebuild prompt**

1. Select "同步到飞书" → "全量重建"
2. Verify prompt asks about old document handling
3. Verify "取消" properly cancels

**Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: integration test fixes for document management"
```
