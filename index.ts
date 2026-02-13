import { getDb, upsertProjects, upsertTasks, getStats, closeDb } from "./db/index.ts";
import { DidaClient } from "./dida/client.ts";
import type { UserConfig } from "./types.ts";

const USERS_FILE = "./users.json";

async function loadUsers(): Promise<UserConfig[]> {
  const file = Bun.file(USERS_FILE);
  if (!(await file.exists())) {
    throw new Error("请创建 users.json 配置文件");
  }
  return file.json();
}

function parseArgs(): string[] {
  const idx = process.argv.indexOf("--user");
  if (idx === -1 || !process.argv[idx + 1]) return []; // 全部
  const val = process.argv[idx + 1]!;
  return val === "all" ? [] : val.split(",");
}

async function exportUser(user: UserConfig) {
  console.log(`\n--- ${user.label} (${user.id}) ---\n`);

  const client = new DidaClient(user);

  // 1. 登录
  console.log("1. 登录中...");
  await client.login();
  console.log("  登录成功。");

  // 2. 用户信息
  console.log("2. 获取用户信息...");
  try {
    const profile = await client.getUserProfile();
    console.log(`  用户: ${profile.displayName || profile.name} (${profile.username})`);
  } catch (e) {
    console.error(`  获取用户信息失败: ${e}`);
  }

  // 3. 项目 + 活跃任务
  console.log("3. 获取项目和活跃任务...");
  const batch = await client.getBatchData();
  const projects = batch.projectProfiles;
  const activeTasks = batch.syncTaskBean?.update ?? [];
  console.log(`  项目: ${projects.length}，活跃任务: ${activeTasks.length}`);

  upsertProjects(user.id, projects);
  upsertTasks(user.id, activeTasks);

  // 4. 已完成任务
  console.log("4. 获取已完成任务...");
  try {
    const completed = await client.getCompletedTasks();
    upsertTasks(user.id, completed);
    console.log(`  已完成: ${completed.length}`);
  } catch (e) {
    console.error(`  失败: ${e}`);
  }

  // 5. 已放弃任务
  console.log("5. 获取已放弃任务...");
  try {
    const abandoned = await client.getAbandonedTasks();
    upsertTasks(user.id, abandoned);
    console.log(`  已放弃: ${abandoned.length}`);
  } catch (e) {
    console.error(`  失败: ${e}`);
  }

  // 6. 垃圾桶任务
  console.log("6. 获取垃圾桶任务...");
  try {
    const trash = await client.getTrashTasks();
    upsertTasks(user.id, trash);
    console.log(`  垃圾桶: ${trash.length}`);
  } catch (e) {
    console.error(`  失败: ${e}`);
  }

  // 统计
  const stats = getStats(user.id);
  console.log(`\n  项目: ${stats.projects} | 未完成: ${stats.active} | 已完成: ${stats.completed} | 已放弃: ${stats.abandoned} | 总计: ${stats.total}`);
}

async function main() {
  console.log("=== 滴答清单数据导出 ===");

  const users = await loadUsers();
  const filterIds = parseArgs();
  const targets = filterIds.length ? users.filter(u => filterIds.includes(u.id)) : users;

  if (!targets.length) {
    console.error("未找到匹配的用户");
    process.exit(1);
  }

  getDb(); // 初始化数据库

  for (const user of targets) {
    await exportUser(user);
  }

  closeDb();
  console.log("\n=== 导出完成 → dida.db ===");
}

main().catch((err) => {
  console.error("导出失败:", err);
  closeDb();
  process.exit(1);
});
