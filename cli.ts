import { createInterface } from "readline";
import { Writable } from "stream";

/** 读取一行输入 */
export function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 读取密码（不回显） */
export function askPassword(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const muted = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(prompt);
    rl.question("", answer => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/** 选择菜单，返回 1-based 索引 */
export async function select(prompt: string, options: string[]): Promise<number> {
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]}`);
  }
  while (true) {
    const answer = await ask(prompt);
    const n = parseInt(answer);
    if (n >= 1 && n <= options.length) return n;
    console.log(`  请输入 1-${options.length}`);
  }
}
