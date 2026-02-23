import * as p from "@clack/prompts";
import { Database } from "bun:sqlite";
import {
  getDb, upsertProjects, upsertTasks, getStats, getValidUsers, deleteUser,
  getCachedToken, saveToken, closeDb, getFeishuConfig, getSyncComparison,
  searchTasks, getTaskDetail, getUnsyncedTasks, getModifiedTasks,
  getFeishuCredentials, saveFeishuCredentials, deleteFeishuCredentials,
  getAICredentials, saveAICredentials, deleteAICredentials, clearAICache,
  getDocHistory, addDocHistory, markDocDeleted, getCurrentDoc, demoteCurrentDoc,
  type TaskSearchResult,
} from "./db/index.ts";
import { DidaClient } from "./dida/client.ts";
import type { LoginCallbacks } from "./dida/client.ts";
import type { UserConfig } from "./types.ts";
import { displayQr } from "./utils/qr.ts";
import { fullSyncUser, incrementalSyncUser, aiOnlySyncUser } from "./sync.ts";
import { setFeishuCredentials, clearFeishuCredentials, scanBitables, deleteBitable } from "./feishu/client.ts";
import { DB_FILE } from "./utils/paths.ts";
import { checkForUpdate } from "./updater.ts";
import { APP_VERSION } from "./version.ts";

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
      info += `\n当前文档: ${feishuConfig.app_url}`;
    }
    const docHistory = getDocHistory(userId);
    const historyCount = docHistory.filter(d => d.is_current === 0).length;
    if (historyCount > 0) {
      info += `\n历史文档: ${historyCount} 个`;
    }
    p.note(info, "当前飞书配置");

    const choice = await p.select({
      message: "飞书配置操作",
      options: [
        { value: "docs", label: "管理文档", hint: "查看/删除飞书文档" },
        { value: "rebind", label: "换绑", hint: "更换飞书应用凭据" },
        { value: "unbind", label: "解绑", hint: "移除飞书凭据" },
        { value: "__back__", label: "← 返回" },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "docs") {
      await docManagementMenu(userId);
    } else if (choice === "rebind") {
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

// ─── AI 配置 ──────────────────────────────────────────

async function bindAI(userId: string): Promise<boolean> {
  p.log.info("请在火山引擎控制台获取 API Key 和模型名称");
  p.log.info("地址: https://console.volcengine.com/ark");

  const apiKey = await p.text({
    message: "API Key",
    validate: (v) => (!v ? "请输入 API Key" : undefined),
  });
  exitIfCancelled(apiKey);

  const model = await p.text({
    message: "文本模型名称",
    placeholder: "doubao-seed-2-0-lite-260215",
    defaultValue: "doubao-seed-2-0-lite-260215",
  });
  exitIfCancelled(model);

  const useVision = await p.confirm({
    message: "是否配置视觉模型（用于图片理解）？",
    initialValue: false,
  });
  exitIfCancelled(useVision);

  let visionModel: string | undefined;
  if (useVision) {
    const vid = await p.text({
      message: "视觉模型名称",
      placeholder: "doubao-1-5-vision-pro-250328",
    });
    exitIfCancelled(vid);
    visionModel = vid as string;
  }

  // 验证
  const s = p.spinner();
  s.start("验证 AI 配置...");
  try {
    const { validateConfig } = await import("./ai/client.ts");
    const ok = await validateConfig({
      apiKey: apiKey as string,
      model: model as string,
      visionModel,
    });
    if (!ok) throw new Error("API 验证失败");
    s.stop("AI 配置验证成功");
  } catch (e) {
    s.stop("AI 配置验证失败");
    p.log.error(`验证失败: ${(e as Error).message}`);
    return false;
  }

  saveAICredentials(userId, apiKey as string, model as string, visionModel);
  p.log.success("AI 配置已保存，同步时将自动生成摘要");
  return true;
}

async function aiConfigMenu(userId: string) {
  const creds = getAICredentials(userId);

  if (creds) {
    let info = `模型: ${creds.model}`;
    if (creds.vision_model) info += `\n视觉模型: ${creds.vision_model}`;
    p.note(info, "当前 AI 配置");

    const choice = await p.select({
      message: "AI 配置操作",
      options: [
        { value: "rebind", label: "重新配置", hint: "更换 API Key 和模型" },
        { value: "unbind", label: "移除配置", hint: "关闭 AI 功能" },
        { value: "clear_cache", label: "清除缓存", hint: "重新生成所有 AI 摘要" },
        { value: "__back__", label: "← 返回" },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "rebind") {
      await bindAI(userId);
    } else if (choice === "unbind") {
      const confirmed = await p.confirm({ message: "确认移除 AI 配置？" });
      exitIfCancelled(confirmed);
      if (confirmed) {
        deleteAICredentials(userId);
        clearAICache(userId);
        p.log.success("已移除 AI 配置");
      }
    } else if (choice === "clear_cache") {
      clearAICache(userId);
      p.log.success("AI 缓存已清除，下次同步将重新生成摘要");
    }
  } else {
    await bindAI(userId);
  }
}

// ─── 文档管理 ──────────────────────────────────────

function formatTime(ts: string): string {
  const num = Number(ts);
  if (!isNaN(num) && num > 1e9) {
    return new Date(num * 1000).toLocaleDateString("zh-CN");
  }
  try {
    return new Date(ts).toLocaleDateString("zh-CN");
  } catch {
    return ts;
  }
}

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

  // 自动清理本地孤儿记录（云端已不存在）
  const localOnly = merged.filter(d => d.source === "local");
  if (localOnly.length > 0) {
    for (const d of localOnly) markDocDeleted(d.token);
    merged.splice(0, merged.length, ...merged.filter(d => d.source !== "local"));
    p.log.info(`已自动清理 ${localOnly.length} 个失效记录（云端已不存在）`);
  }

  if (merged.length === 0) {
    p.log.info("没有有效的飞书文档");
    return;
  }

  // 直接打印文档列表
  for (const d of merged) {
    const prefix = d.isCurrent ? "★" : " ";
    const date = d.created_time ? formatTime(d.created_time) : "";
    const url = d.url || "无链接";
    p.log.info(`${prefix} ${d.name}  ${date}  ${url}`);
  }

  while (true) {
    const options: Array<{ value: string; label: string; hint?: string }> = merged
      .map(d => ({
        value: d.token,
        label: `${d.isCurrent ? "★ " : "  "}${d.name}`,
        hint: d.isCurrent ? "当前使用" : "",
      }));

    options.push({ value: "__batch_delete__", label: "批量删除非当前文档" });
    options.push({ value: "__back__", label: "← 返回" });

    const choice = await p.select({ message: "选择文档操作", options });
    exitIfCancelled(choice);

    if (choice === "__back__") return;

    if (choice === "__batch_delete__") {
      const nonCurrent = merged.filter(d => !d.isCurrent);
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
          if (deleted < nonCurrent.length) await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          p.log.warn(`删除 ${doc.name} 失败: ${(e as Error).message}`);
        }
      }
      ds.stop(`已删除 ${deleted} 个文档`);

      merged.splice(0, merged.length, ...merged.filter(d => d.isCurrent));
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

          const idx = merged.indexOf(doc);
          if (idx !== -1) merged.splice(idx, 1);
        } catch (e) {
          p.log.error(`删除失败: ${(e as Error).message}`);
        }
      }
    }
  }
}

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
    const s = p.spinner();
    s.start("删除旧表格...");
    try {
      await deleteBitable(config.app_token);
      markDocDeleted(config.app_token);
      s.stop("旧表格已删除（可在飞书回收站恢复）");
    } catch (e) {
      s.stop("删除旧表格失败");
      p.log.warn(`${(e as Error).message}，将保留旧表格继续重建`);
    }
  }

  return true;
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

    const hasAI = !!getAICredentials(userId);

    if (comparison.newTasks === 0 && comparison.modified === 0) {
      p.note(info + "\n\n所有数据已是最新", "同步状态");

      // 数据没变化，但仍可选 AI 更新或全量重建
      const options: Array<{ value: string; label: string; hint?: string }> = [];
      if (hasAI) {
        options.push({ value: "ai_only", label: "AI 增量更新", hint: "只更新 AI标题/摘要/链接内容，不动附件" });
      }
      options.push(
        { value: "full", label: "全量重建", hint: "创建新表格，重新上传所有数据" },
        { value: "__back__", label: "← 返回" },
      );

      const choice = await p.select({ message: "选择操作", options });
      exitIfCancelled(choice);
      if (choice === "__back__") return;

      const db = new Database(DB_FILE);
      db.run("PRAGMA journal_mode = WAL");
      try {
        const s = p.spinner();
        if (choice === "ai_only") {
          s.start("AI 增量更新中...");
          await aiOnlySyncUser(db, userId);
          s.stop("AI 增量更新完成");
        } else {
          const shouldProceed = await promptDeleteOldDoc(userId);
          if (!shouldProceed) { db.close(); return; }
          s.start("全量同步中...");
          await fullSyncUser(db, userId, false);
          s.stop("全量同步完成");
        }
      } finally {
        db.close();
      }
      return;
    }

    p.note(info, "同步状态");

    const syncOptions: Array<{ value: string; label: string; hint?: string }> = [
      { value: "incremental", label: "增量同步", hint: `更新 ${comparison.newTasks + comparison.modified} 条` },
    ];
    if (hasAI) {
      syncOptions.push({ value: "ai_only", label: "AI 增量更新", hint: "只更新 AI标题/摘要/链接内容，不动附件" });
    }
    syncOptions.push(
      { value: "full", label: "全量重建", hint: "创建新表格，重新上传所有数据" },
      { value: "__back__", label: "← 返回" },
    );

    const syncChoice = await p.select({ message: "选择同步方式", options: syncOptions });
    exitIfCancelled(syncChoice);
    if (syncChoice === "__back__") return;

    const db = new Database(DB_FILE);
    db.run("PRAGMA journal_mode = WAL");
    try {
      const s = p.spinner();
      if (syncChoice === "ai_only") {
        s.start("AI 增量更新中...");
        await aiOnlySyncUser(db, userId);
        s.stop("AI 增量更新完成");
      } else if (syncChoice === "incremental") {
        const skipAtt = await p.confirm({ message: "是否跳过附件？", initialValue: false });
        exitIfCancelled(skipAtt);
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
        const shouldProceed = await promptDeleteOldDoc(userId);
        if (!shouldProceed) { db.close(); return; }
        s.start("全量同步中...");
        await fullSyncUser(db, userId, false);
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

    const aiCreds = getAICredentials(user.id);
    options.push({
      value: "ai_config",
      label: "AI配置",
      hint: aiCreds ? `已配置 (${aiCreds.model})` : "未配置",
    });

    options.push({
      value: "doc_management",
      label: "文档管理",
      hint: "查看/删除飞书文档",
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
      case "ai_config":
        await aiConfigMenu(user.id);
        break;
      case "doc_management":
        await docManagementMenu(user.id);
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
  p.intro(`滴答清单数据管理 v${APP_VERSION}`);

  await checkForUpdate();

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
  const errObj = err instanceof Error ? err : new Error(String(err));
  p.log.error(`运行失败: ${errObj.message}`);
  if (errObj.stack) {
    // 只显示前几行堆栈，帮助定位
    const stackLines = errObj.stack.split("\n").slice(1, 6).join("\n");
    p.log.warn(`堆栈:\n${stackLines}`);
  }
  closeDb();
  await waitBeforeExit();
  process.exit(1);
});
