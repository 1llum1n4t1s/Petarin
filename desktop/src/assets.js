// レールが要求する同梱アセット（rail.css・フォント woff2）の URL 解決。
//
// 拡張では chrome.runtime.getURL が拡張パッケージ内の URL を返すが、デスクトップでは bundler が
// 出力したハッシュ付き URL を返す必要がある。content.js からは `assetUrl(path)` の 1 関数に見える。
//
// import.meta.glob を使うのは、content.js が渡してくるのが "src/fonts/foo.woff2" のような
// **文字列パス**だからで、静的 import では書けないため。`query: "?url"` で URL だけを取り出す。

// CSS は **?raw で実テキストを取り込み、Blob URL にして渡す**。
// ?url にすると dev モードで Vite が CSS を JS モジュールへ変換して返すため、
// content.js の fetch().text() が JavaScript を拾い、<style> に入れてもルールが 0 件になる
// （症状: すべての要素が position:static のまま潰れて何も描画されない）。build では正しい URL に
// なるので dev だけで壊れる＝気付きにくい。raw + Blob なら両モードで同じ結果になる。
const rawCss = import.meta.glob("../../src/content/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const assets = {
  // フォントはバイナリで変換されないため ?url のままでよい。
  ...import.meta.glob("../../src/fonts/*.woff2", { query: "?url", import: "default", eager: true }),
  ...Object.fromEntries(
    Object.entries(rawCss).map(([key, css]) => [
      key,
      URL.createObjectURL(new Blob([css], { type: "text/css" })),
    ]),
  ),
};

// glob のキーはこのファイルからの相対パス。content.js が渡すリポジトリ相対パスへ引き直す。
const byRepoPath = new Map(
  Object.entries(assets).map(([key, url]) => [key.replace("../../", ""), url]),
);

export function railAssetUrl(path) {
  const url = byRepoPath.get(path);
  if (!url) {
    // 見つからなくてもレールは無スタイル/既定フォントで動く。原因追跡のため必ず記録する。
    console.warn("[petarin] 同梱アセットが見つからない:", path);
    return path;
  }
  return url;
}
