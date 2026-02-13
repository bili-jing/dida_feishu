import { getDb, upsertProjects, upsertTasks, getStats, getValidUsers, deleteUser, getCachedToken, saveToken, closeDb } from "./db/index.ts";
import { DidaClient } from "./dida/client.ts";
import type { UserConfig } from "./types.ts";
import { ask, askPassword, select } from "./cli.ts";

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
    label: c.extra?.username ?? c.user_id,
    authType: c.extra?.authType,
    username: c.extra?.username,
    password: c.extra?.password,
  };
}

// ─── 交互式菜单 ────────────────────────────────────────

async function interactiveMode(): Promise<{ user: UserConfig; isNew: boolean }> {
  const cached = getValidUsers();

  const items: { label: string; user: UserConfig }[] = [];

  for (const c of cached) {
    const authLabel = c.extra?.authType === "wechat" ? "微信" : "密码";
    const name = c.extra?.displayName ?? c.extra?.username ?? c.user_id;
    const days = Math.ceil((c.expires_at - Date.now() / 1000) / 86400);
    items.push({
      label: `${name} (${authLabel}, ${days}天有效)`,
      user: cachedToUserConfig(c),
    });
  }

  if (items.length > 0) {
    const options = [...items.map(i => i.label), "添加新用户", "删除用户"];
    const choice = await select("\n请选择操作: ", options);

    if (choice <= items.length) {
      return { user: items[choice - 1]!.user, isNew: false };
    }

    if (choice === items.length + 2) {
      await deleteUserMenu(items);
      return interactiveMode();
    }
  } else {
    console.log("\n暂无已保存的用户，请添加:");
  }

  return { user: await addNewUser(), isNew: true };
}

async function deleteUserMenu(items: { label: string; user: UserConfig }[]) {
  const options = [...items.map(i => i.label), "取消"];
  const choice = await select("\n选择要删除的用户: ", options);

  if (choice > items.length) return; // 取消

  const target = items[choice - 1]!;
  const confirm = await ask(`确认删除 "${target.user.label}" 的所有数据? (y/N): `);
  if (confirm.toLowerCase() !== "y") {
    console.log("  已取消");
    return;
  }

  deleteUser(target.user.id);
  console.log(`  已删除用户: ${target.user.label} (${target.user.id})`);
}

async function addNewUser(): Promise<UserConfig> {
  console.log("\n请选择登录方式:");
  const choice = await select("请输入选项: ", [
    "手机号/邮箱登录",
    "微信扫码登录",
  ]);

  if (choice === 2) {
    const label = await ask("备注名称 (可选，直接回车跳过): ");
    return { id: "wechat", label: label || "微信用户", authType: "wechat" };
  }

  const username = await ask("手机号/邮箱: ");
  const password = await askPassword("密码: ");
  const label = await ask("备注名称 (可选，直接回车跳过): ");
  return {
    id: username,
    label: label || username,
    authType: "password",
    username,
    password,
  };
}

// ─── 数据导出 ──────────────────────────────────────────

async function exportUser(user: UserConfig, forceLogin = false) {
  console.log(`\n--- ${user.label} (${user.id}) ---\n`);

  const client = new DidaClient(user);

  console.log("1. 登录中...");
  await client.login(forceLogin);
  console.log("  登录成功。");

  console.log("2. 获取用户信息...");
  try {
    const profile = await client.getUserProfile();
    console.log(`  用户: ${profile.displayName || profile.name} (${profile.username})`);

    if (forceLogin && profile.userCode) {
      // 新用户：通过 userCode 检查是否已存在
      const existingUsers = getValidUsers();
      const duplicate = existingUsers.find(u =>
        u.extra?.userCode === profile.userCode && u.user_id !== user.id
      );

      if (duplicate) {
        const name = duplicate.extra?.displayName ?? duplicate.extra?.username ?? duplicate.user_id;
        console.log(`\n  该用户已登录为: ${name} (${duplicate.user_id})`);
        const choice = await ask("  直接使用已有账户？(Y/n): ");

        if (choice.toLowerCase() === "n") {
          deleteUser(user.id);
          console.log("  已取消");
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
        console.log(`  已切换到已有账户`);
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
        console.log(`  用户ID: ${oldId} → ${profile.username}`);
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
    console.error(`  获取用户信息失败: ${e}`);
  }

  console.log("3. 获取项目和活跃任务...");
  const batch = await client.getBatchData();
  const projects = batch.projectProfiles;
  const activeTasks = batch.syncTaskBean?.update ?? [];
  console.log(`  项目: ${projects.length}，活跃任务: ${activeTasks.length}`);

  upsertProjects(user.id, projects);
  upsertTasks(user.id, activeTasks);

  console.log("4. 获取已完成任务...");
  try {
    const completed = await client.getCompletedTasks();
    upsertTasks(user.id, completed);
    console.log(`  已完成: ${completed.length}`);
  } catch (e) {
    console.error(`  失败: ${e}`);
  }

  console.log("5. 获取已放弃任务...");
  try {
    const abandoned = await client.getAbandonedTasks();
    upsertTasks(user.id, abandoned);
    console.log(`  已放弃: ${abandoned.length}`);
  } catch (e) {
    console.error(`  失败: ${e}`);
  }

  console.log("6. 获取垃圾桶任务...");
  try {
    const trash = await client.getTrashTasks();
    upsertTasks(user.id, trash);
    console.log(`  垃圾桶: ${trash.length}`);
  } catch (e) {
    console.error(`  失败: ${e}`);
  }

  const stats = getStats(user.id);
  console.log(`\n  项目: ${stats.projects} | 未完成: ${stats.active} | 已完成: ${stats.completed} | 已放弃: ${stats.abandoned} | 总计: ${stats.total}`);
}

// ─── 主流程 ────────────────────────────────────────────

async function main() {
  console.log("=== 滴答清单数据导出 ===");

  const { userFilter } = parseArgs();

  getDb();

  if (userFilter) {
    // 非交互：--user id1,id2 或 --user all
    const allCached = getValidUsers();

    if (userFilter.length === 0) {
      // --user all
      if (!allCached.length) {
        console.error("数据库中没有已缓存的用户，请先交互登录");
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
          console.error(`未找到用户: ${id}，请先交互登录`);
          continue;
        }
        await exportUser(cachedToUserConfig({
          user_id: id, extra: cached.extra, expires_at: cached.expires_at,
        }));
      }
    }
  } else {
    // 交互模式（默认）
    const { user, isNew } = await interactiveMode();
    await exportUser(user, isNew);
  }

  closeDb();
  console.log("\n=== 导出完成 → db/dida.db ===");
}

main().catch((err) => {
  console.error("导出失败:", err);
  closeDb();
  process.exit(1);
});
