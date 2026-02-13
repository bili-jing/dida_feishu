import * as p from "@clack/prompts";
import { getDb, upsertProjects, upsertTasks, getStats, getValidUsers, deleteUser, getCachedToken, saveToken, closeDb } from "./db/index.ts";
import { DidaClient } from "./dida/client.ts";
import type { LoginCallbacks } from "./dida/client.ts";
import type { UserConfig } from "./types.ts";
import { displayQr } from "./utils/qr.ts";

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

// ─── 交互式菜单 ────────────────────────────────────────

async function interactiveMode(): Promise<{ user: UserConfig; isNew: boolean } | null> {
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
      message: "请选择操作",
      options: [
        ...items.map(i => ({ value: i.value, label: i.label, hint: i.hint })),
        { value: "__add__", label: "添加新用户" },
        { value: "__delete__", label: "删除用户" },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "__delete__") {
      await deleteUserMenu(items);
      return interactiveMode();
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

// ─── 微信扫码回调（终端 QR + spinner） ─────────────────

function createWechatCallbacks(s: ReturnType<typeof p.spinner>): LoginCallbacks {
  return {
    async onQrUrl(imageUrl, qrData) {
      s.stop("获取二维码成功");
      try {
        await displayQr(qrData);
      } catch {
        p.log.warn(`终端渲染失败，请打开链接扫码: ${imageUrl}`);
      }
    },
    onScanWaiting() { s.start("等待微信扫码..."); },
    onScanScanned() { s.message("已扫码，等待确认..."); },
    onScanConfirmed() { s.stop("微信授权成功"); },
  };
}

// ─── 数据导出 ──────────────────────────────────────────

async function exportUser(user: UserConfig, forceLogin = false) {
  const client = new DidaClient(user);
  const s = p.spinner();

  // 1. 登录
  s.start("登录中...");
  try {
    const callbacks = user.authType === "wechat" ? createWechatCallbacks(s) : undefined;
    await client.login(forceLogin, callbacks);
    if (!callbacks) s.stop("登录成功");
  } catch (e) {
    s.stop("登录失败");
    throw e;
  }

  // 2. 获取用户信息
  s.start("获取用户信息...");
  try {
    const profile = await client.getUserProfile();
    s.stop(`用户: ${profile.displayName || profile.name} (${profile.username})`);

    if (forceLogin && profile.userCode) {
      // 新用户：通过 userCode 检查是否已存在
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
          return;
        }

        // 用新 token 更新已有账户，清理临时数据
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
        // 微信新用户：用真实用户名替换占位ID
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
        // 密码新用户：补充 userCode
        const cached = getCachedToken(user.id);
        if (cached) {
          saveToken(user.id, cached.token, {
            ...cached.extra, userCode: profile.userCode,
            displayName: profile.displayName || profile.name,
          }, cached.expires_at);
        }
      }
    } else if (profile.userCode) {
      // 已有用户：首次补充 userCode
      const cached = getCachedToken(user.id);
      if (cached && !cached.extra?.userCode) {
        saveToken(user.id, cached.token, {
          ...cached.extra, userCode: profile.userCode,
          displayName: profile.displayName || profile.name,
        }, cached.expires_at);
      }
    }
  } catch (e) {
    s.stop("获取用户信息失败");
    p.log.error(String(e));
  }

  // 3. 项目和活跃任务
  s.start("获取项目和活跃任务...");
  const batch = await client.getBatchData();
  const projects = batch.projectProfiles;
  const activeTasks = batch.syncTaskBean?.update ?? [];
  upsertProjects(user.id, projects);
  upsertTasks(user.id, activeTasks);
  s.stop(`项目: ${projects.length}，活跃任务: ${activeTasks.length}`);

  // 4. 已完成任务
  s.start("获取已完成任务...");
  try {
    const completed = await client.getCompletedTasks();
    upsertTasks(user.id, completed);
    s.stop(`已完成: ${completed.length}`);
  } catch (e) {
    s.stop("获取已完成任务失败");
  }

  // 5. 已放弃任务
  s.start("获取已放弃任务...");
  try {
    const abandoned = await client.getAbandonedTasks();
    upsertTasks(user.id, abandoned);
    s.stop(`已放弃: ${abandoned.length}`);
  } catch (e) {
    s.stop("获取已放弃任务失败");
  }

  // 6. 垃圾桶任务
  s.start("获取垃圾桶任务...");
  try {
    const trash = await client.getTrashTasks();
    upsertTasks(user.id, trash);
    s.stop(`垃圾桶: ${trash.length}`);
  } catch (e) {
    s.stop("获取垃圾桶任务失败");
  }

  // 统计
  const stats = getStats(user.id);
  p.note(
    `项目: ${stats.projects}  未完成: ${stats.active}  已完成: ${stats.completed}  已放弃: ${stats.abandoned}  总计: ${stats.total}`,
    "导出统计"
  );
}

// ─── 主流程 ────────────────────────────────────────────

async function main() {
  p.intro("滴答清单数据导出");

  const { userFilter } = parseArgs();

  getDb();

  if (userFilter) {
    // 非交互：--user id1,id2 或 --user all
    const allCached = getValidUsers();

    if (userFilter.length === 0) {
      // --user all
      if (!allCached.length) {
        p.log.error("数据库中没有已缓存的用户，请先交互登录");
        process.exit(1);
      }
      for (const c of allCached) {
        await exportUser(cachedToUserConfig(c));
      }
    } else {
      // --user id1,id2
      for (const id of userFilter) {
        const cached = getCachedToken(id);
        if (!cached) {
          p.log.error(`未找到用户: ${id}，请先交互登录`);
          continue;
        }
        await exportUser(cachedToUserConfig({
          user_id: id, extra: cached.extra, expires_at: cached.expires_at,
        }));
      }
    }
  } else {
    // 交互模式（默认）
    const result = await interactiveMode();
    if (!result) {
      p.cancel("已取消");
      closeDb();
      return;
    }
    await exportUser(result.user, result.isNew);
  }

  closeDb();
  p.outro("导出完成 → db/dida.db");
}

main().catch((err) => {
  p.log.error(`导出失败: ${err}`);
  closeDb();
  process.exit(1);
});
