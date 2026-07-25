// icons/icon.svg から Flutter iOS の AppIcon 一式を生成する。
// App Store アイコンは透過不可なので、付箋紙に合う乳白色で背景を埋める。
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "icons", "icon.svg"));
const destination = join(
  root,
  "mobile_flutter",
  "ios",
  "Runner",
  "Assets.xcassets",
  "AppIcon.appiconset",
);

const icons = [
  ["Icon-App-20x20@1x.png", 20],
  ["Icon-App-20x20@2x.png", 40],
  ["Icon-App-20x20@3x.png", 60],
  ["Icon-App-29x29@1x.png", 29],
  ["Icon-App-29x29@2x.png", 58],
  ["Icon-App-29x29@3x.png", 87],
  ["Icon-App-40x40@1x.png", 40],
  ["Icon-App-40x40@2x.png", 80],
  ["Icon-App-40x40@3x.png", 120],
  ["Icon-App-60x60@2x.png", 120],
  ["Icon-App-60x60@3x.png", 180],
  ["Icon-App-76x76@1x.png", 76],
  ["Icon-App-76x76@2x.png", 152],
  ["Icon-App-83.5x83.5@2x.png", 167],
  ["Icon-App-1024x1024@1x.png", 1024],
];

for (const [filename, size] of icons) {
  await sharp(source, { density: 768 })
    .resize(size, size, { fit: "contain", background: "#fff8e7" })
    .flatten({ background: "#fff8e7" })
    .png()
    .toFile(join(destination, filename));
  console.log(`mobile_flutter AppIcon ${filename} ✔`);
}

const launchDestination = join(
  root,
  "mobile_flutter",
  "ios",
  "Runner",
  "Assets.xcassets",
  "LaunchImage.imageset",
);
for (const scale of [1, 2, 3]) {
  const canvasWidth = 168 * scale;
  const canvasHeight = 185 * scale;
  const markSize = 128 * scale;
  const mark = await sharp(source, { density: 768 })
    .resize(markSize, markSize, { fit: "contain" })
    .png()
    .toBuffer();
  const filename = scale === 1 ? "LaunchImage.png" : `LaunchImage@${scale}x.png`;
  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: mark,
        left: Math.round((canvasWidth - markSize) / 2),
        top: Math.round((canvasHeight - markSize) / 2),
      },
    ])
    .png()
    .toFile(join(launchDestination, filename));
  console.log(`mobile_flutter LaunchImage ${filename} ✔`);
}
