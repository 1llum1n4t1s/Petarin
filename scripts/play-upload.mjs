// Google Play Developer API v3 へ AAB をアップロードし、指定トラックへリリースする。
//
// サードパーティ Action を増やさない方針（publish.yml / mobile-ios.yml と同じ）に合わせ、
// 依存ゼロの Node22 標準機能だけで完結させる（fetch / node:crypto）。
//
// 前提: Play Console 側にアプリが存在し、**最低 1 つ AAB が手動アップロード済み**であること。
//       リリースが 1 つも無いアプリに対して API は `Package not found` を返す（Google の仕様）。
//
// 環境変数:
//   GOOGLE_PLAY_SA_JSON … サービスアカウントの JSON 鍵（そのまま貼り付け）
//   PLAY_PACKAGE_NAME   … 例 com.kagayoi.petarin
//   PLAY_TRACK          … internal | alpha | beta | production
//   PLAY_AAB_PATH       … アップロードする .aab のパス
//   PLAY_RELEASE_NAME   … リリース名（任意・省略時は versionCode）
//   PLAY_RELEASE_NOTES  … リリースノート ja-JP（任意）

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定`);
  return v;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// サービスアカウント鍵で JWT を作り、androidpublisher スコープのアクセストークンへ交換する。
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  // エラー本文はトークンを含まないのでそのまま出してよい。
  if (!res.ok) throw new Error(`トークン取得失敗 (${res.status}): ${JSON.stringify(json)}`);
  return json.access_token;
}

async function api(token, method, url, { body, contentType } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} 失敗 (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const sa = JSON.parse(need("GOOGLE_PLAY_SA_JSON"));
  const pkg = need("PLAY_PACKAGE_NAME");
  const track = need("PLAY_TRACK");
  const aabPath = need("PLAY_AAB_PATH");
  const aab = await readFile(aabPath);

  console.log(`パッケージ: ${pkg} / トラック: ${track}`);
  console.log(`AAB: ${aabPath} (${(aab.length / 1024 / 1024).toFixed(2)} MiB)`);

  const token = await getAccessToken(sa);

  const edit = await api(token, "POST", `${API}/${pkg}/edits`, { contentType: "application/json" });
  console.log(`edit 作成: ${edit.id}`);

  const bundle = await api(
    token,
    "POST",
    `${UPLOAD}/${pkg}/edits/${edit.id}/bundles?uploadType=media`,
    { body: aab, contentType: "application/octet-stream" },
  );
  const versionCode = bundle.versionCode;
  console.log(`AAB アップロード完了: versionCode=${versionCode}`);

  const release = {
    name: process.env.PLAY_RELEASE_NAME || String(versionCode),
    versionCodes: [String(versionCode)],
    status: "completed", // 内部テストは段階公開せず即時全テスターへ配る
  };
  if (process.env.PLAY_RELEASE_NOTES) {
    release.releaseNotes = [{ language: "ja-JP", text: process.env.PLAY_RELEASE_NOTES }];
  }

  await api(token, "PUT", `${API}/${pkg}/edits/${edit.id}/tracks/${track}`, {
    contentType: "application/json",
    body: JSON.stringify({ track, releases: [release] }),
  });
  console.log(`トラック ${track} を更新`);

  // commit して初めて Play 側へ反映される。ここまで失敗したら edit は破棄されるだけで副作用は無い。
  await api(token, "POST", `${API}/${pkg}/edits/${edit.id}:commit`, {
    contentType: "application/json",
  });
  console.log(`✅ 配信完了: ${pkg} / ${track} / versionCode=${versionCode}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
