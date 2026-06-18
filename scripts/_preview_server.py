# 開発プレビュー用スレッド化静的サーバー（http.server 単体はブラウザの並列接続でハングするため）
# 反映漏れを防ぐためキャッシュを無効化する（ブラウザが旧 JS/CSS を握らないように）。
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


ThreadingHTTPServer(("127.0.0.1", 8777), NoCacheHandler).serve_forever()
