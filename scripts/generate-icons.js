// icons/icon.svg から icon-16/48/128.png を生成する（ビルド用 / sharp）
// 使い方: pnpm run generate-icons
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "icons", "icon.svg"));
const sizes = [16, 48, 128];

for (const size of sizes) {
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(root, "icons", `icon-${size}.png`));
  console.log(`icons/icon-${size}.png ✔`);
}
