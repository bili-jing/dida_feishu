import QRCode from "qrcode";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 在终端显示二维码
 * macOS/Linux: 终端内渲染
 * Windows: 保存为 PNG 到临时目录并自动打开
 */
export async function displayQr(content: string): Promise<void> {
  if (process.platform === "win32") {
    const qrPath = join(tmpdir(), "dida-feishu-qr.png");
    await QRCode.toFile(qrPath, content, { width: 300, margin: 2 });
    console.log(`二维码已保存: ${qrPath}`);
    Bun.spawn(["cmd", "/c", "start", "", qrPath], { stdio: ["ignore", "ignore", "ignore"] });
  } else {
    const terminalQr = await QRCode.toString(content, { type: "terminal", small: true });
    console.log(terminalQr);
  }
}
