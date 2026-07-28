// レールが要求する同梱アセット（rail.css・フォント woff2）の URL 解決。
//
// 拡張では chrome.runtime.getURL が拡張パッケージ内の URL を返すが、デスクトップでは bundler が
// 出力したハッシュ付き URL を返す必要がある。content.js からは `assetUrl(path)` の 1 関数に見える。
//
// import.meta.glob を使うのは、content.js が渡してくるのが "src/fonts/foo.woff2" のような
// **文字列パス**だからで、静的 import では書けないため。`query: "?url"` で URL だけを取り出す。

const assets = {
  ...import.meta.glob("../../src/content/rail.css", { query: "?url", import: "default", eager: true }),
  ...import.meta.glob("../../src/fonts/*.woff2", { query: "?url", import: "default", eager: true }),
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
