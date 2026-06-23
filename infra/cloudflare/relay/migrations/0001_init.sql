-- ぺたりん 同期リレーの暗号文ストア(D1: petarin-sync)。
-- サーバーは暗号文しか持たない: ciphertext/nonce は端末側 vaultKey で AES-GCM 暗号化済み、
-- domain_hash は端末側で HMAC ハッシュ化済み(サーバーは「どのサイトか」も知らない)。
-- vault_id はハッシュ化済み DO id 文字列(生 vaultId は保存しない)。

CREATE TABLE IF NOT EXISTS notes (
  vault_id    TEXT    NOT NULL,           -- ハッシュ化済み vault 識別子(= DO id 文字列)
  domain_hash TEXT    NOT NULL,           -- HMAC(vaultKey, domain) の hex
  ciphertext  TEXT    NOT NULL,           -- AES-GCM 暗号文(base64url)
  nonce       TEXT    NOT NULL,           -- AES-GCM nonce/IV(base64url)
  seq         INTEGER NOT NULL,           -- per-vault 単調増加(catchup の since 比較に使う)
  updated_at  INTEGER NOT NULL,           -- サーバー受領時刻(ms)
  PRIMARY KEY (vault_id, domain_hash)
);

-- catchup(seq > since)と per-vault 走査用。
CREATE INDEX IF NOT EXISTS idx_notes_vault_seq ON notes (vault_id, seq);
