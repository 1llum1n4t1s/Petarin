// petarin.kagayoi.com のランディングページ配信 + 自動更新配信 Worker。
//
// トップページと特商法表記は Worker 自身が返し、それ以外のパスは R2（petarin-updates）から返す。
// Velopack の更新チャネル（releases.win.json / *.nupkg / RELEASES / *-Setup.exe / *-Portable.zip）は
// すべて後者を通るので、**R2 のパススルー挙動を壊さないこと**が最優先の制約になる。
//
// Kiriha の web/worker.js を移植したが、購入・ライセンス系の互換パス（/buy, /license/*）は持たない:
// Petarin のデスクトップ版は最初から Sekisho hub（sekisho.kagayoi.com）を直接叩く実装で、
// このドメインにライセンス API を置いた出荷済みバージョンが存在しないため。
import landingHtml from "./index.html";
import tokushohoHtml from "./tokushoho.html";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // 読み取り専用の配信面なので、GET / HEAD 以外は入口で落とす（ページ配信も R2 も同じ扱いにする）。
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("許可されていないメソッドです。", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(landingHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    // 特定商取引法に基づく表記（買い切りライセンス販売のため掲示が要る）
    if (pathname === "/tokushoho" || pathname === "/tokushoho.html") {
      return new Response(tokushohoHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    let key;
    try {
      key = decodeURIComponent(pathname.slice(1));
    } catch {
      return new Response("不正なパスです。", { status: 400 });
    }

    if (request.method === "HEAD") {
      const metadata = await env.UPDATES.head(key);
      if (metadata === null) return notFound();
      const headers = buildHeaders(metadata, key);
      headers.set("content-length", String(metadata.size));
      return new Response(null, { headers });
    }

    // Velopack の差分ダウンロードは Range 要求を使うので、206 / 416 まで正しく返す。
    const requestedRange = parseRangeHeader(request.headers.get("range"));
    if (requestedRange === false) return new Response(null, { status: 416 });
    let object;
    try {
      object = await env.UPDATES.get(key, requestedRange ? { range: requestedRange } : undefined);
    } catch (error) {
      if (!requestedRange) {
        // R2 の一時的な不調を事後調査できるよう記録した上で、既定のエラーページではなく 500 を返す
        console.error(`R2 の取得に失敗: key=${key}`, error);
        return new Response("一時的なエラーが発生しました。しばらくしてから再試行してください。", { status: 500 });
      }
      const metadata = await env.UPDATES.head(key);
      if (metadata === null) return notFound();
      const headers = buildHeaders(metadata, key);
      headers.set("content-range", `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (object === null || object.body === undefined) {
      return notFound();
    }

    const headers = buildHeaders(object, key);
    if (requestedRange) {
      const returned = object.range;
      if (returned === undefined) return new Response(null, { status: 416, headers });
      const start = returned.offset;
      const end = start + returned.length - 1;
      headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
      headers.set("content-length", String(returned.length));
      return new Response(object.body, { status: 206, headers });
    }

    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  },
};

function notFound() {
  return new Response("ページが見つかりません。", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

function buildHeaders(object, key) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("accept-ranges", "bytes");

  if (!headers.has("content-type")) {
    headers.set("content-type", contentTypeFor(key));
  }
  if (!headers.has("cache-control")) {
    // nupkg は版ごとに名前が変わる不変ファイル、releases.*.json は更新判定の入口なので短命にする。
    headers.set(
      "cache-control",
      key.endsWith(".nupkg")
        ? "public, max-age=31536000, immutable"
        : key.startsWith("releases.")
          ? "public, max-age=60, must-revalidate"
          : "public, max-age=300",
    );
  }
  return headers;
}

function contentTypeFor(key) {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (key.endsWith(".zip") || key.endsWith(".nupkg")) return "application/zip";
  return "application/octet-stream";
}

function parseRangeHeader(value) {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || (!match[1] && !match[2])) return false;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { suffix };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : undefined;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (requestedEnd !== undefined &&
      (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))
  ) {
    return false;
  }

  return requestedEnd === undefined
    ? { offset: start }
    : { offset: start, length: requestedEnd - start + 1 };
}
