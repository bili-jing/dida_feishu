import * as p from "@clack/prompts";
import { Database } from "bun:sqlite";
import {
  getDb, upsertProjects, upsertTasks, getStats, getValidUsers, deleteUser,
  getCachedToken, saveToken, closeDb, getFeishuConfig, getSyncComparison,
  searchTasks, getTaskDetail, getUnsyncedTasks, getModifiedTasks,
  getFeishuCredentials, saveFeishuCredentials, deleteFeishuCredentials,
  type TaskSearchResult,
} from "./db/index.ts";
import { DidaClient } from "./dida/client.ts";
import type { LoginCallbacks } from "./dida/client.ts";
import type { UserConfig } from "./types.ts";
import { displayQr } from "./utils/qr.ts";
import { fullSyncUser, incrementalSyncUser } from "./sync.ts";
import { setFeishuCredentials, clearFeishuCredentials } from "./feishu/client.ts";
import { DB_FILE } from "./utils/paths.ts";

// ─── 参数解析 ──────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const userIdx = args.indexOf("--user");
  if (userIdx !== -1 && args[userIdx + 1]) {
    const val = args[userIdx + 1]!;
    return { userFilter: val === "all" ? [] : val.split(",") };
  }
  return { userFilter: null };
}

/** 从 DB 缓存记录还原 UserConfig */
function cachedToUserConfig(c: { user_id: string; extra: any; expires_at: number }): UserConfig {
  return {
    id: c.user_id,
    label: c.extra?.displayName ?? c.extra?.username ?? c.user_id,
    authType: c.extra?.authType,
    username: c.extra?.username,
    password: c.extra?.password,
  };
}

/** Ctrl+C 检查，取消时优雅退出 */
function exitIfCancelled(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (p.isCancel(value)) {
    p.cancel("已取消");
    closeDb();
    process.exit(0);
  }
}

// ─── 状态文字辅助 ──────────────────────────────────────

function statusLabel(status: number): string {
  switch (status) {
    case 0: return "进行中";
    case 2: return "已完成";
    case -1: return "已放弃";
    default: return "未知";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

// ─── 主菜单：选择/添加/删除用户 ─────────────────────────

async function mainMenu(): Promise<{ user: UserConfig; isNew: boolean } | null> {
  const cached = getValidUsers();

  type Item = { value: string; label: string; hint: string; user: UserConfig };
  const items: Item[] = cached.map(c => {
    const authLabel = c.extra?.authType === "wechat" ? "微信" : "密码";
    const name = c.extra?.displayName ?? c.extra?.username ?? c.user_id;
    const days = Math.ceil((c.expires_at - Date.now() / 1000) / 86400);
    return {
      value: c.user_id,
      label: String(name),
      hint: `${authLabel}, ${days}天有效`,
      user: cachedToUserConfig(c),
    };
  });

  if (items.length > 0) {
    const choice = await p.select({
      message: "请选择用户",
      options: [
        ...items.map(i => ({ value: i.value, label: i.label, hint: i.hint })),
        { value: "__add__", label: "添加新用户" },
        { value: "__delete__", label: "删除用户" },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "__delete__") {
      await deleteUserMenu(items);
      return mainMenu();
    }

    if (choice !== "__add__") {
      const selected = items.find(i => i.value === choice);
      if (selected) return { user: selected.user, isNew: false };
    }
  } else {
    p.log.info("暂无已保存的用户，请添加");
  }

  const user = await addNewUser();
  return user ? { user, isNew: true } : null;
}

async function deleteUserMenu(items: { value: string; label: string; user: UserConfig }[]) {
  const choice = await p.select({
    message: "选择要删除的用户",
    options: [
      ...items.map(i => ({ value: i.value, label: i.label })),
      { value: "__cancel__", label: "取消" },
    ],
  });
  exitIfCancelled(choice);
  if (choice === "__cancel__") return;

  const target = items.find(i => i.value === choice);
  if (!target) return;

  const confirmed = await p.confirm({ message: `确认删除「${target.label}」的所有数据？` });
  exitIfCancelled(confirmed);
  if (!confirmed) {
    p.log.info("已取消");
    return;
  }

  deleteUser(target.value);
  p.log.success(`已删除: ${target.label} (${target.value})`);
}

async function addNewUser(): Promise<UserConfig | null> {
  const authType = await p.select({
    message: "请选择登录方式",
    options: [
      { value: "password" as const, label: "手机号/邮箱登录" },
      { value: "wechat" as const, label: "微信扫码登录" },
    ],
  });
  exitIfCancelled(authType);

  if (authType === "wechat") {
    const label = await p.text({ message: "备注名称", placeholder: "可选，直接回车跳过" });
    exitIfCancelled(label);
    return { id: "wechat", label: (label as string) || "微信用户", authType: "wechat" };
  }

  const result = await p.group({
    username: () => p.text({ message: "手机号/邮箱", validate: v => !v ? "请输入" : undefined }),
    password: () => p.password({ message: "密码", validate: v => !v ? "请输入" : undefined }),
    label: () => p.text({ message: "备注名称", placeholder: "可选，直接回车跳过" }),
  }, { onCancel: () => { p.cancel("已取消"); closeDb(); process.exit(0); } });

  return {
    id: result.username,
    label: result.label || result.username,
    authType: "password",
    username: result.username,
    password: result.password,
  };
}

// ─── 微信扫码回调（不使用 spinner，避免 Bun clearInterval 问题）───

function createWechatCallbacks(): LoginCallbacks {
  return {
    async onQrUrl(imageUrl, qrData) {
      p.log.step("获取二维码成功");
      try {
        await displayQr(qrData);
      } catch {
        p.log.warn(`终端渲染失败，请打开链接扫码: ${imageUrl}`);
      }
    },
    onScanWaiting() { p.log.info("请使用微信扫描上方二维码..."); },
    onScanScanned() { p.log.step("已扫码，等待确认..."); },
    onScanConfirmed() { p.log.step("微信授权成功"); },
  };
}

// ─── 数据拉取 ──────────────────────────────────────────

async function fetchData(user: UserConfig, forceLogin = false) {
  const client = new DidaClient(user);

  // 1. 登录（不用 spinner，Bun 下 clearInterval 对短生命周期 interval 清理不干净）
  try {
    const callbacks = user.authType === "wechat" ? createWechatCallbacks() : undefined;
    await client.login(forceLogin, callbacks);
    if (!callbacks) p.log.step("登录成功");
  } catch (e) {
    p.log.error("登录失败");
    throw e;
  }

  // 2. 获取用户信息（不用 spinner，可能需要用户交互）
  try {
    const profile = await client.getUserProfile();
    p.log.step(`用户: ${profile.displayName || profile.name} (${profile.username})`);

    if (forceLogin && profile.userCode) {
      const existingUsers = getValidUsers();
      const duplicate = existingUsers.find(u =>
        u.extra?.userCode === profile.userCode && u.user_id !== user.id
      );

      if (duplicate) {
        const name = duplicate.extra?.displayName ?? duplicate.extra?.username ?? duplicate.user_id;
        p.log.warn(`该用户已登录为: ${name} (${duplicate.user_id})`);
        const useExisting = await p.confirm({ message: "直接使用已有账户？" });
        exitIfCancelled(useExisting);

        if (!useExisting) {
          deleteUser(user.id);
          p.log.info("已取消");
          return null;
        }

        const newToken = getCachedToken(user.id);
        if (newToken) {
          saveToken(duplicate.user_id, newToken.token, {
            ...duplicate.extra, userCode: profile.userCode,
          }, newToken.expires_at);
        }
        deleteUser(user.id);
        user.id = duplicate.user_id;
        user.label = String(name);
        client.updateUserId(duplicate.user_id);
      } else if (user.authType === "wechat" && profile.username && profile.username !== user.id) {
        const oldId = user.id;
        const cached = getCachedToken(oldId);
        if (cached) {
          saveToken(profile.username, cached.token, {
            ...cached.extra, username: profile.username,
            userCode: profile.userCode, displayName: profile.displayName || profile.name,
          }, cached.expires_at);
        }
        deleteUser(oldId);
        user.id = profile.username;
        client.updateUserId(profile.username);
        p.log.step(`用户ID: ${oldId} → ${profile.username}`);
      } else {
        const cached = getCachedToken(user.id);
        if (cached) {
          saveToken(user.id, cached.token, {
            ...cached.extra, userCode: profile.userCode,
            displayName: profile.displayName || profile.name,
          }, cached.expires_at);
        }
      }
    } else if (profile.userCode) {
      const cached = getCachedToken(user.id);
      if (cached && !cached.extra?.userCode) {
        saveToken(user.id, cached.token, {
          ...cached.extra, userCode: profile.userCode,
          displayName: profile.displayName || profile.name,
        }, cached.expires_at);
      }
    }
  } catch (e) {
    p.log.error(`获取用户信息失败: ${e}`);
  }

  // 3. 拉取前的统计（用于对比）
  const beforeStats = getStats(user.id);

  // 4-7. 数据拉取（单个 spinner，用 message() 更新进度，只有一次 start/stop）
  const s = p.spinner();
  s.start("获取项目和活跃任务...");

  const batch = await client.getBatchData();
  const projects = batch.projectProfiles;
  const activeTasks = batch.syncTaskBean?.update ?? [];
  upsertProjects(user.id, projects);
  upsertTasks(user.id, activeTasks);

  s.message(`获取已完成任务... (项目: ${projects.length}, 活跃: ${activeTasks.length})`);
  try {
    const completed = await client.getCompletedTasks();
    upsertTasks(user.id, completed);
  } catch (e) {
    p.log.warn(`获取已完成任务失败: ${e}`);
  }

  s.message("获取已放弃任务...");
  try {
    const abandoned = await client.getAbandonedTasks();
    upsertTasks(user.id, abandoned);
  } catch (e) {
    p.log.warn(`获取已放弃任务失败: ${e}`);
  }

  s.message("获取垃圾桶任务...");
  try {
    const trash = await client.getTrashTasks();
    upsertTasks(user.id, trash);
  } catch (e) {
    p.log.warn(`获取垃圾桶任务失败: ${e}`);
  }

  s.stop("数据拉取完成");

  // 8. 统计对比
  const afterStats = getStats(user.id);
  const diff = afterStats.total - beforeStats.total;

  let summary = `项目: ${afterStats.projects}  未完成: ${afterStats.active}  已完成: ${afterStats.completed}  已放弃: ${afterStats.abandoned}  总计: ${afterStats.total}`;
  if (beforeStats.total > 0 && diff > 0) {
    summary += `\n新增: +${diff} 条`;
  }
  p.note(summary, "数据概况");

  return user;
}

// ─── 数据概况 ──────────────────────────────────────────

function showDataOverview(userId: string) {
  const stats = getStats(userId);
  const feishuConfig = getFeishuConfig(userId);
  const comparison = feishuConfig ? getSyncComparison(userId) : null;

  let info = `项目: ${stats.projects}  未完成: ${stats.active}  已完成: ${stats.completed}  已放弃: ${stats.abandoned}  总计: ${stats.total}`;

  if (comparison) {
    info += `\n\n飞书同步状态:`;
    info += `\n  已同步: ${comparison.synced}  未同步: ${comparison.newTasks}  已修改: ${comparison.modified}  未变: ${comparison.unchanged}`;
    if (feishuConfig?.app_url) {
      info += `\n  链接: ${feishuConfig.app_url}`;
    }
  } else {
    info += `\n\n尚未同步到飞书`;
  }

  p.note(info, "数据概况");
}

// ─── 搜索功能 ──────────────────────────────────────────

function formatTaskItem(t: TaskSearchResult): { value: string; label: string; hint: string } {
  const syncIcon = t.sync_status === "synced" ? "✓" : "○";
  const statusIcon = t.status === 2 ? "✓" : t.status === -1 ? "✗" : "●";
  return {
    value: t.id,
    label: `${statusIcon} ${truncate(t.title, 40)}`,
    hint: `${syncIcon} ${t.project_name || "收集箱"} · ${statusLabel(t.status)}`,
  };
}

async function searchMenu(userId: string) {
  while (true) {
    const keyword = await p.text({
      message: "搜索任务（标题/内容）",
      placeholder: "输入关键词，直接回车返回",
    });
    exitIfCancelled(keyword);

    if (!keyword) return; // 空回车 = 返回

    const results = searchTasks(userId, keyword as string);

    if (results.length === 0) {
      p.log.warn("未找到匹配的任务");
      continue;
    }

    p.log.info(`找到 ${results.length} 条结果 (✓=已同步 ○=未同步)`);

    const choice = await p.select({
      message: "选择查看详情",
      options: [
        ...results.map(formatTaskItem),
        { value: "__back__", label: "← 继续搜索" },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "__back__") continue;

    // 显示任务详情
    await showTaskDetail(userId, choice as string);
  }
}

async function showTaskDetail(userId: string, taskId: string) {
  const task = getTaskDetail(userId, taskId);
  if (!task) {
    p.log.error("未找到该任务");
    return;
  }

  const lines: string[] = [];
  lines.push(`标题: ${task.title}`);
  lines.push(`状态: ${statusLabel(task.status)}  清单: ${task.project_name || "收集箱"}`);

  if (task.content) {
    const content = task.content.length > 200 ? task.content.slice(0, 200) + "..." : task.content;
    lines.push(`内容: ${content}`);
  }

  if (task.tags) {
    try {
      const tags = JSON.parse(task.tags);
      if (tags.length) lines.push(`标签: ${tags.join(", ")}`);
    } catch {}
  }

  if (task.created_time) lines.push(`创建: ${task.created_time}`);
  if (task.modified_time) lines.push(`修改: ${task.modified_time}`);

  lines.push("");
  if (task.sync_status === "synced") {
    lines.push(`同步状态: 已同步`);
    if (task.last_synced_at) lines.push(`同步时间: ${task.last_synced_at}`);
  } else {
    lines.push(`同步状态: 未同步`);
  }

  p.note(lines.join("\n"), "任务详情");
}

// ─── 查看未同步/已修改 ─────────────────────────────────

async function viewPendingTasks(userId: string) {
  const comparison = getSyncComparison(userId);

  if (comparison.newTasks === 0 && comparison.modified === 0) {
    p.log.success("所有任务已同步，无待处理项");
    return;
  }

  const options: Array<{ value: string; label: string; hint: string }> = [];

  if (comparison.newTasks > 0) {
    options.push({
      value: "new",
      label: `未同步的任务`,
      hint: `${comparison.newTasks} 条`,
    });
  }
  if (comparison.modified > 0) {
    options.push({
      value: "modified",
      label: `已修改的任务`,
      hint: `${comparison.modified} 条`,
    });
  }
  options.push({ value: "__back__", label: "← 返回" });

  const choice = await p.select({ message: "查看待处理任务", options });
  exitIfCancelled(choice);
  if (choice === "__back__") return;

  const tasks = choice === "new" ? getUnsyncedTasks(userId, 50) : getModifiedTasks(userId, 50);
  const title = choice === "new" ? "未同步" : "已修改";

  if (tasks.length === 0) {
    p.log.info("没有待处理的任务");
    return;
  }

  const taskChoice = await p.select({
    message: `${title}的任务 (${tasks.length} 条)`,
    options: [
      ...tasks.map(formatTaskItem),
      { value: "__back__", label: "← 返回" },
    ],
  });
  exitIfCancelled(taskChoice);

  if (taskChoice !== "__back__") {
    await showTaskDetail(userId, taskChoice as string);
  }
}

// ─── 飞书配置管理 ─────────────────────────────────────

/** 激活用户的飞书凭据（设置到 client） */
function activateFeishuCredentials(userId: string): boolean {
  const creds = getFeishuCredentials(userId);
  if (creds) {
    setFeishuCredentials(creds.app_id, creds.app_secret);
    return true;
  }
  // 尝试 env 回退
  if (Bun.env.FEISHU_APP_ID && Bun.env.FEISHU_APP_SECRET) {
    clearFeishuCredentials();
    return true;
  }
  return false;
}

/** 绑定飞书凭据流程 */
async function bindFeishu(userId: string): Promise<boolean> {
  p.log.info("请在飞书开放平台创建应用，获取 App ID 和 App Secret");
  p.log.info("地址: https://open.feishu.cn/app");

  const appId = await p.text({
    message: "飞书 App ID",
    validate: v => !v ? "请输入 App ID" : undefined,
  });
  exitIfCancelled(appId);

  const appSecret = await p.text({
    message: "飞书 App Secret",
    validate: v => !v ? "请输入 App Secret" : undefined,
  });
  exitIfCancelled(appSecret);

  // 验证凭据是否有效
  const s = p.spinner();
  s.start("验证飞书凭据...");
  try {
    setFeishuCredentials(appId as string, appSecret as string);
    const { getFeishuClient } = await import("./feishu/client.ts");
    const client = getFeishuClient();
    // 尝试一个简单的 API 调用来验证
    await client.drive.file.list({ params: { folder_token: "", page_size: 1 } });
    s.stop("飞书凭据验证成功");
  } catch (e) {
    s.stop("飞书凭据验证失败");
    p.log.error(`验证失败: ${(e as Error).message}`);
    p.log.warn("请检查 App ID 和 App Secret 是否正确，以及应用是否已开通相关权限");
    clearFeishuCredentials();
    return false;
  }

  saveFeishuCredentials(userId, appId as string, appSecret as string);
  p.log.success("飞书凭据已保存");
  return true;
}

async function feishuConfigMenu(userId: string) {
  const creds = getFeishuCredentials(userId);
  const feishuConfig = getFeishuConfig(userId);

  if (creds) {
    // 已绑定 → 显示状态，提供换绑/解绑
    let info = `App ID: ${creds.app_id.slice(0, 6)}...${creds.app_id.slice(-4)}`;
    if (feishuConfig?.app_url) {
      info += `\n飞书链接: ${feishuConfig.app_url}`;
    }
    p.note(info, "当前飞书配置");

    const choice = await p.select({
      message: "飞书配置操作",
      options: [
        { value: "rebind", label: "换绑", hint: "更换飞书应用凭据" },
        { value: "unbind", label: "解绑", hint: "移除飞书凭据" },
        { value: "__back__", label: "← 返回" },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "rebind") {
      await bindFeishu(userId);
    } else if (choice === "unbind") {
      const confirmed = await p.confirm({ message: "确认解绑飞书？解绑后需重新配置才能同步" });
      exitIfCancelled(confirmed);
      if (confirmed) {
        deleteFeishuCredentials(userId);
        clearFeishuCredentials();
        p.log.success("已解绑飞书");
      }
    }
  } else {
    // 未绑定 → 直接引导绑定
    await bindFeishu(userId);
  }
}

// ─── 同步到飞书 ───────────────────────────────────────

async function syncToFeishu(userId: string) {
  // 检查飞书凭据
  if (!activateFeishuCredentials(userId)) {
    p.log.warn("尚未绑定飞书应用，需要先配置飞书凭据才能同步");
    const doBind = await p.confirm({ message: "现在绑定飞书？" });
    exitIfCancelled(doBind);
    if (!doBind) return;
    const ok = await bindFeishu(userId);
    if (!ok) return;
  }

  const feishuConfig = getFeishuConfig(userId);
  const comparison = feishuConfig ? getSyncComparison(userId) : null;

  if (feishuConfig && comparison) {
    // 已有飞书配置 → 显示同步状态
    let info = `飞书链接: ${feishuConfig.app_url ?? "未知"}`;
    info += `\n已同步: ${comparison.synced}  新增: ${comparison.newTasks}  修改: ${comparison.modified}`;

    if (comparison.newTasks === 0 && comparison.modified === 0) {
      p.note(info + "\n\n所有数据已是最新", "同步状态");
      const force = await p.confirm({ message: "是否强制全量重建？", initialValue: false });
      exitIfCancelled(force);
      if (!force) return;

      // 全量重建
      const db = new Database(DB_FILE);
      db.run("PRAGMA journal_mode = WAL");
      try {
        const s = p.spinner();
        s.start("全量同步中...");
        await fullSyncUser(db, userId, false);
        s.stop("全量同步完成");
      } finally {
        db.close();
      }
      return;
    }

    p.note(info, "同步状态");

    const syncChoice = await p.select({
      message: "选择同步方式",
      options: [
        { value: "incremental", label: "增量同步", hint: `更新 ${comparison.newTasks + comparison.modified} 条` },
        { value: "full", label: "全量重建", hint: "创建新表格，重新上传所有数据" },
        { value: "__back__", label: "← 返回" },
      ],
    });
    exitIfCancelled(syncChoice);
    if (syncChoice === "__back__") return;

    const skipAtt = await p.confirm({ message: "是否跳过附件？", initialValue: false });
    exitIfCancelled(skipAtt);

    const db = new Database(DB_FILE);
    db.run("PRAGMA journal_mode = WAL");
    try {
      const s = p.spinner();
      if (syncChoice === "incremental") {
        s.start(`增量同步中 (新增: ${comparison.newTasks}, 修改: ${comparison.modified})...`);
        const result = await incrementalSyncUser(
          db, userId, feishuConfig.app_token, feishuConfig.table_id, feishuConfig.app_url, skipAtt as boolean
        );
        if (result === null) {
          s.stop("飞书表格不可访问，切换全量同步");
          s.start("全量同步中...");
          await fullSyncUser(db, userId, skipAtt as boolean);
          s.stop("全量同步完成");
        } else {
          s.stop("增量同步完成");
        }
      } else {
        s.start("全量同步中...");
        await fullSyncUser(db, userId, skipAtt as boolean);
        s.stop("全量同步完成");
      }
    } finally {
      db.close();
    }
  } else {
    // 没有飞书配置 → 首次全量同步
    p.log.info("尚未同步到飞书，将执行首次全量同步");
    const confirm = await p.confirm({ message: "开始全量同步？" });
    exitIfCancelled(confirm);
    if (!confirm) return;

    const skipAtt = await p.confirm({ message: "是否跳过附件？", initialValue: false });
    exitIfCancelled(skipAtt);

    const db = new Database(DB_FILE);
    db.run("PRAGMA journal_mode = WAL");
    try {
      const s = p.spinner();
      s.start("全量同步中...");
      await fullSyncUser(db, userId, skipAtt as boolean);
      s.stop("全量同步完成");
    } finally {
      db.close();
    }
  }

  // 同步完成后显示最新状态
  const newConfig = getFeishuConfig(userId);
  if (newConfig?.app_url) {
    p.log.success(`飞书链接: ${newConfig.app_url}`);
  }
}

// ─── 用户操作菜单 ──────────────────────────────────────

async function userMenu(user: UserConfig, isNew: boolean) {
  // 新用户或首次进入时拉取数据
  if (isNew) {
    const updated = await fetchData(user, true);
    if (!updated) return; // 用户取消
    user = updated;

    // 新用户提示绑定飞书
    if (!getFeishuCredentials(user.id)) {
      const hasEnv = !!(Bun.env.FEISHU_APP_ID && Bun.env.FEISHU_APP_SECRET);
      if (!hasEnv) {
        const doBind = await p.confirm({
          message: "是否绑定飞书应用？绑定后可将任务同步到飞书多维表格",
          initialValue: false,
        });
        exitIfCancelled(doBind);
        if (doBind) {
          await bindFeishu(user.id);
        }
      }
    }
  }

  // 激活该用户的飞书凭据
  activateFeishuCredentials(user.id);

  while (true) {
    const stats = getStats(user.id);
    const feishuConfig = getFeishuConfig(user.id);
    const comparison = feishuConfig ? getSyncComparison(user.id) : null;

    // 构建菜单选项
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    options.push({
      value: "fetch",
      label: "拉取最新数据",
      hint: `本地 ${stats.total} 条`,
    });

    options.push({
      value: "overview",
      label: "数据概况",
    });

    options.push({
      value: "search",
      label: "搜索任务",
    });

    if (comparison && (comparison.newTasks > 0 || comparison.modified > 0)) {
      options.push({
        value: "pending",
        label: "待同步任务",
        hint: `新增 ${comparison.newTasks} + 修改 ${comparison.modified}`,
      });
    }

    if (feishuConfig) {
      const syncHint = comparison
        ? (comparison.newTasks + comparison.modified > 0
            ? `${comparison.newTasks + comparison.modified} 条待更新`
            : "已是最新")
        : "";
      options.push({
        value: "sync",
        label: "同步到飞书",
        hint: syncHint,
      });
    } else {
      options.push({
        value: "sync",
        label: "同步到飞书",
        hint: "首次同步",
      });
    }

    const creds = getFeishuCredentials(user.id);
    options.push({
      value: "feishu_config",
      label: "飞书配置",
      hint: creds ? `已绑定 (${creds.app_id.slice(0, 6)}...)` : "未绑定",
    });

    options.push({
      value: "__back__",
      label: "← 返回主菜单",
    });

    const choice = await p.select({
      message: `${user.label} - 操作`,
      options,
    });
    exitIfCancelled(choice);

    switch (choice) {
      case "fetch":
        await fetchData(user);
        break;
      case "overview":
        showDataOverview(user.id);
        break;
      case "search":
        await searchMenu(user.id);
        break;
      case "pending":
        await viewPendingTasks(user.id);
        break;
      case "sync":
        await syncToFeishu(user.id);
        break;
      case "feishu_config":
        await feishuConfigMenu(user.id);
        break;
      case "__back__":
        return;
    }
  }
}

// ─── 非交互模式 ───────────────────────────────────────

async function batchMode(userFilter: string[]) {
  const allCached = getValidUsers();

  if (userFilter.length === 0) {
    // --user all
    if (!allCached.length) {
      p.log.error("数据库中没有已缓存的用户，请先交互登录");
      process.exit(1);
    }
    for (const c of allCached) {
      await fetchData(cachedToUserConfig(c));
    }
  } else {
    // --user id1,id2
    for (const id of userFilter) {
      const cached = getCachedToken(id);
      if (!cached) {
        p.log.error(`未找到用户: ${id}，请先交互登录`);
        continue;
      }
      await fetchData(cachedToUserConfig({
        user_id: id, extra: cached.extra, expires_at: cached.expires_at,
      }));
    }
  }
}

// ─── 主流程 ────────────────────────────────────────────

async function main() {
  p.intro("滴答清单数据管理");

  const { userFilter } = parseArgs();
  getDb();

  if (userFilter) {
    await batchMode(userFilter);
  } else {
    // 交互模式：主菜单循环
    while (true) {
      const result = await mainMenu();
      if (!result) {
        p.cancel("已取消");
        break;
      }
      await userMenu(result.user, result.isNew);
    }
  }

  closeDb();
  p.outro("再见");
  await waitBeforeExit();
  process.exit(0);
}

/** Windows 双击运行时等待用户按回车再退出，防止闪退 */
async function waitBeforeExit() {
  if (process.platform === "win32" && process.stdin.isTTY) {
    console.log("\n按回车键退出...");
    process.stdin.resume();
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  }
}

main().catch(async (err) => {
  p.log.error(`运行失败: ${err}`);
  closeDb();
  await waitBeforeExit();
  process.exit(1);
});
