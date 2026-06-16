// ぺたりん ストア画像ジェネレータ（Chrome Web Store / Firefox AMO 用）
// webstore/0X.html を puppeteer-core + ローカル Chrome/Edge で各サイズの PNG に描画する。
// リポジトリ直下を簡易 HTTP 配信するので、実 popup プレビュー(docs/preview-popup.html)を
// iframe でそのまま埋め込める（相対パス・fetch・Web フォントが正しく解決する）。
//
// 実行: pnpm run generate-screenshots
// 出力: webstore/images/*.png
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(__dirname, "images");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

// リポジトリ直下を配信する最小静的サーバ（store 素材生成専用）
function startServer(root) {
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split("?")[0]);
    let fp = path.normalize(path.join(root, url));
    if (!fp.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
    if (fp.endsWith(path.sep)) fp = path.join(fp, "index.html");
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// puppeteer-core はブラウザを同梱しないので、ローカルの Chrome / Edge を探して使う。
function findBrowser() {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && fs.existsSync(env)) return env;
  const c = [];
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:/Program Files";
    const pfx = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
    const la = process.env["LOCALAPPDATA"] || "";
    c.push(
      path.join(pf, "Google/Chrome/Application/chrome.exe"),
      path.join(pfx, "Google/Chrome/Application/chrome.exe"),
      path.join(la, "Google/Chrome/Application/chrome.exe"),
      path.join(pfx, "Microsoft/Edge/Application/msedge.exe"),
      path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    c.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    c.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/microsoft-edge");
  }
  return c.find((p) => p && fs.existsSync(p)) || null;
}

const CONFIGS = [
  { input: "01-popup-ui.html",     output: "01-popup-ui-1280x800.png",   width: 1280, height: 800 },
  { input: "02-on-page.html",      output: "02-on-page-1280x800.png",    width: 1280, height: 800 },
  { input: "03-hero.html",         output: "03-hero-1280x800.png",       width: 1280, height: 800 },
  { input: "04-promo-small.html",  output: "promo-small-440x280.png",    width: 440,  height: 280 },
  { input: "05-promo-marquee.html", output: "promo-marquee-1400x560.png", width: 1400, height: 560 },
];

async function shoot(browser, base, cfg) {
  const page = await browser.newPage();
  try {
    // CWS のスクショ仕様は「1280x800 または 640x400 ちょうど」なので deviceScaleFactor=1 で等倍出力。
    await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1 });
    // 初期インストール時の見た目を伝えるためライトモード強制（dark の墨色背景にしない）。
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.goto(`${base}/webstore/${cfg.input}`, { waitUntil: "networkidle0", timeout: 45000 });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
    await new Promise((r) => setTimeout(r, 1300)); // フォント / iframe 描画 / リストスクロールの確定待ち
    await page.screenshot({
      path: path.join(OUTPUT_DIR, cfg.output),
      type: "png",
      clip: { x: 0, y: 0, width: cfg.width, height: cfg.height },
    });
    console.log(`✅ ${cfg.output} (${cfg.width}x${cfg.height})`);
  } finally {
    await page.close();
  }
}

async function main() {
  console.log("🎨 ぺたりん ストア画像を生成中...\n");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const exe = findBrowser();
  if (!exe) {
    console.error("❌ Chrome / Edge が見つかりません。PUPPETEER_EXECUTABLE_PATH で実行ファイルを指定してください。");
    process.exit(1);
  }
  console.log(`🧭 ブラウザ: ${exe}`);
  const server = await startServer(ROOT);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: exe,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--hide-scrollbars", "--force-color-profile=srgb"],
    protocolTimeout: 120000,
  });
  try {
    for (const cfg of CONFIGS) await shoot(browser, base, cfg);
  } finally {
    await browser.close();
    server.close();
  }
  console.log("\n✨ 完了！ webstore/images/ を確認してね");
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    const kb = (fs.statSync(path.join(OUTPUT_DIR, f)).size / 1024).toFixed(1);
    console.log(`   - ${f} (${kb} KB)`);
  }
}

main().catch((e) => { console.error("❌ エラー:", e); process.exit(1); });
