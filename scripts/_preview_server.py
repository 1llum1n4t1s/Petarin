# 開発プレビュー用スレッド化静的サーバー（http.server 単体はブラウザの並列接続でハングするため）
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ThreadingHTTPServer(("127.0.0.1", 8777), SimpleHTTPRequestHandler).serve_forever()
