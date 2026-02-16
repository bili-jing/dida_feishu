import QRCode from "qrcode";
import { resolve } from "node:path";
import { BASE_DIR } from "./paths.ts";

/**
 * 在终端显示二维码
 * macOS/Linux: 终端内渲染
 * Windows: 保存为 PNG 并自动打开
 */
export async function displayQr(content: string): Promise<void> {
  if (process.platform === "win32") {
    // Windows 终端不支持 Unicode 半块字符，保存为图片并打开
    const qrPath = resolve(BASE_DIR, "qrcode.png");
    await QRCode.toFile(qrPath, content, { width: 300, margin: 2 });
    console.log(`二维码已保存: ${qrPath}`);
    // 用默认图片查看器打开
    Bun.spawn(["cmd", "/c", "start", "", qrPath], { stdio: ["ignore", "ignore", "ignore"] });
  } else {
    const terminalQr = await QRCode.toString(content, { type: "terminal", small: true });
    console.log(terminalQr);
  }
}
