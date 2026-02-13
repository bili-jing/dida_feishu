import QRCode from "qrcode";

/**
 * 在终端显示二维码
 * 直接从文本内容生成，无需下载图片解码
 */
export async function displayQr(content: string): Promise<void> {
  const terminalQr = await QRCode.toString(content, { type: "terminal", small: true });
  console.log(terminalQr);
}
