// ぺたりん デスクトップ版のライセンス。Kiriha（src/Kiriha/Services/LicenseService.cs）の契約を
// そのまま JS へ移植したもの。仕様を変えるときは Kiriha 側と揃えること。
//
// キー形式:  PETARIN-<base64url(payload JSON)>.<base64url(ECDSA P-256 署名)>
//   payload: {"e":"メールアドレス","p":"購入ID","d":"発行日時"}
// 検証はオフライン（埋め込み公開鍵）。ハブが返したキーも必ずここを通す＝ハブを信頼しない。
//
// 状態機械:
//   Licensed / Trial(14日) / TrialExpired / OnlineCheckRequired(有効キーだが失効確認が30日通らない)
//
// デバイス数制限は Kiriha と同様に **意図的に設けない**。1 購入 = 何台でも使えるキーで、
// 強制力は購入単位の失効だけ（返金時に全台の次回チェックで無効化）。送るのは購入 ID のみで
// 端末識別子は送らないため、ハブ側だけで台数制限を足すことはできない。仕様変更なしに足さないこと。

const KEY_PREFIX = "PETARIN-";
const TRIAL_DAYS = 14;
const OFFLINE_GRACE_DAYS = 30;

const HUB = "https://sekisho.kagayoi.com";
const CHECK_URLS = [`${HUB}/license/petarin/check`];
const RECOVER_REQUEST_URL = `${HUB}/license/petarin/recover/request`;
const RECOVER_REDEEM_URL = `${HUB}/license/petarin/recover`;

// 公開鍵（SPKI base64）。ローテーションできるよう配列で持つ＝古いキーも検証し続けられる。
// 秘密鍵はリポジトリ外（dev/Secret/petarin-license）。**形式そのものは変えないこと**。
const PUBLIC_KEYS_SPKI = [
  // 2026-07-29 発行（秘密鍵は dev/Secret/petarin-license/signing-key.pkcs8.b64）
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEy+xSATgcuyiMSmGHxmtkXbmebyqb2OppuOE+LhqzXmOdJ28OJfkSaquVIM6THBYeXNfEpiewB2RERKbtW83Y8w==",
];

export const LicenseState = {
  Licensed: "Licensed",
  Trial: "Trial",
  TrialExpired: "TrialExpired",
  OnlineCheckRequired: "OnlineCheckRequired",
};

const STORE_KEYS = {
  license: "petarin:license", // { key, email, purchaseId, lastCheckUtc, maxSeenUtc }
  trial: "petarin:trial", // { startUtc, maxSeenUtc }（maxSeenUtc は購入前も効かせる時計巻き戻しガード）
};

const DAY_MS = 86_400_000;
const b64urlToBytes = (s) => {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/// 埋め込み公開鍵のどれか 1 つで通れば有効。ローテーション中は新旧が並ぶ。
async function verifySignature(payloadB64, sigB64) {
  const data = new TextEncoder().encode(payloadB64);
  const sig = b64urlToBytes(sigB64);
  for (const spki of PUBLIC_KEYS_SPKI) {
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        b64urlToBytes(spki.replaceAll("+", "-").replaceAll("/", "_")),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data)) return true;
    } catch {
      // 壊れた公開鍵は飛ばして次を試す（1 本の破損で全キーが死なないように）
    }
  }
  return false;
}

/// キー文字列を検証して payload を返す。無効なら null。
export async function parseKey(raw) {
  const key = String(raw ?? "").trim();
  if (!key.startsWith(KEY_PREFIX)) return null;
  const body = key.slice(KEY_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;
  const [payloadB64, sigB64] = [body.slice(0, dot), body.slice(dot + 1)];
  if (!(await verifySignature(payloadB64, sigB64))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
    if (!payload?.p) return null; // 購入 ID の無いキーは失効確認ができない＝無効扱い
    return { email: payload.e ?? "", purchaseId: payload.p, issuedAt: payload.d ?? "" };
  } catch {
    return null;
  }
}

export function createLicenseService(backend) {
  const read = async (k) => {
    const s = await backend.getItem(k);
    if (s == null) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const write = (k, v) => backend.setItem(k, JSON.stringify(v));

  /// ISO 文字列を時刻数値へ。未設定・壊れた値は -Infinity（＝Math.max で無視される）にする。
  const stamp = (s) => {
    const v = s ? Date.parse(s) : NaN;
    return Number.isFinite(v) ? v : -Infinity;
  };

  /// 試用開始日。**記録済みの値をそのまま返す**（Kiriha は file と HKCU の 2 箇所で二重化している。
  /// デスクトップ版は store 1 箇所＋maxSeenUtc の単調増加ガードで守る）。
  ///
  /// かつてここは `Math.min(recorded, now)` だった。「記録済みの最も早い日付を採る」つもりの式だが、
  /// OS の日時を過去へ戻すと now 側が選ばれ、経過日数が 0 になって**試用期間が丸ごと復活する**。
  /// now は guardedNow が単調化した値なので、記録済みの開始日をそのまま信じてよい。
  async function trialStart(now, trial) {
    const recorded = stamp(trial?.startUtc);
    if (recorded > -Infinity) return recorded;
    const iso = new Date(now).toISOString();
    await write(STORE_KEYS.trial, { ...(trial || {}), startUtc: iso, maxSeenUtc: iso });
    return now;
  }

  /// 時計を巻き戻して試用や猶予を延ばす攻撃を潰す。観測した最大時刻を単調に持ち上げる。
  ///
  /// **試用中も効かせる**のが要点。ライセンスレコードは購入するまで存在しないので、そちらだけを
  /// 見ていると試用期間中はガードが素通りし、日時を戻すだけで残日数が戻る。打刻は初回起動で必ず
  /// 生える試用レコード側にも置き、両方＋試用開始日の最大値を採る（開始日より前へは戻せない）。
  function guardedNow(trial, license) {
    return Math.max(Date.now(), stamp(trial?.maxSeenUtc), stamp(license?.maxSeenUtc), stamp(trial?.startUtc));
  }

  /// 観測時刻を単調に前進させて永続化する。これが無いと maxSeenUtc は購入・失効確認の成功時にしか
  /// 進まず、その打刻より後の任意の時点へ日時を戻してオフライン猶予を無限に伸ばせる。
  /// 前進していないときは書かない（起動ごとの無駄書きを避ける）。
  async function touchMaxSeen(now, trial, license) {
    const iso = new Date(now).toISOString();
    if (trial && stamp(trial.maxSeenUtc) < now) await write(STORE_KEYS.trial, { ...trial, maxSeenUtc: iso });
    if (license && stamp(license.maxSeenUtc) < now) await write(STORE_KEYS.license, { ...license, maxSeenUtc: iso });
  }

  return {
    /// 起動時に呼ぶ。state / email / trialDaysLeft は組で意味を持つのでまとめて返す。
    async evaluate() {
      const [trial, persisted] = await Promise.all([read(STORE_KEYS.trial), read(STORE_KEYS.license)]);
      const now = guardedNow(trial, persisted);
      await touchMaxSeen(now, trial, persisted);

      if (persisted?.key) {
        const parsed = await parseKey(persisted.key);
        if (parsed) {
          const last = persisted.lastCheckUtc ? Date.parse(persisted.lastCheckUtc) : NaN;
          const staleDays = Number.isFinite(last) ? (now - last) / DAY_MS : Infinity;
          const state =
            staleDays > OFFLINE_GRACE_DAYS ? LicenseState.OnlineCheckRequired : LicenseState.Licensed;
          return { state, email: parsed.email, trialDaysLeft: 0 };
        }
        // 署名が通らないキーは捨てて試用判定へ落とす（改竄・鍵ローテ漏れの両方をここで吸収）
      }

      const started = await trialStart(now, trial);
      const left = Math.max(0, TRIAL_DAYS - Math.floor((now - started) / DAY_MS));
      return {
        state: left > 0 ? LicenseState.Trial : LicenseState.TrialExpired,
        email: "",
        trialDaysLeft: left,
      };
    },

    /// キーを直接入力して有効化する（第二の経路）。
    async activateKey(raw) {
      const parsed = await parseKey(raw);
      if (!parsed) return { ok: false, reason: "invalid" };
      const now = Date.now();
      await write(STORE_KEYS.license, {
        key: String(raw).trim(),
        email: parsed.email,
        purchaseId: parsed.purchaseId,
        lastCheckUtc: new Date(now).toISOString(),
        maxSeenUtc: new Date(now).toISOString(),
      });
      return { ok: true, email: parsed.email };
    },

    /// メールアドレスへ 6 桁コードを送る（第一の経路）。再送クールダウン・試行上限はハブ側が持つ。
    async requestRecoveryCode(email) {
      const res = await fetch(RECOVER_REQUEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      return { ok: res.ok, status: res.status };
    },

    /// 6 桁コードを署名済みキーへ交換する。**ハブが返したキーも必ず activateKey の署名検証を通す**
    /// ＝ハブが答えたというだけでは信頼しない（Kiriha と同じ設計）。
    async redeemRecoveryCode(email, code) {
      const res = await fetch(RECOVER_REDEEM_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const key = (await res.json())?.key;
      if (!key) return { ok: false, status: res.status };
      const activated = await this.activateKey(key);
      return activated.ok ? { ok: true, email: activated.email } : { ok: false, status: 401 };
    },

    /// 失効確認。送るのは購入 ID だけ（端末識別子は送らない）。
    /// 成功したら lastCheckUtc を進め、明示的に無効と言われたときだけキーを捨てる。
    /// ネットワーク失敗では捨てない＝オフラインでも 30 日は使える。
    async refreshRevocation() {
      const persisted = await read(STORE_KEYS.license);
      if (!persisted?.purchaseId) return { checked: false };
      for (const url of CHECK_URLS) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ purchaseId: persisted.purchaseId }),
          });
          if (!res.ok) continue;
          const valid = (await res.json())?.valid === true;
          const now = new Date().toISOString();
          if (valid) {
            await write(STORE_KEYS.license, { ...persisted, lastCheckUtc: now, maxSeenUtc: now });
            return { checked: true, valid: true };
          }
          await backend.removeItem(STORE_KEYS.license); // 返金・失効が確定した場合だけ落とす
          return { checked: true, valid: false };
        } catch {
          // 次の URL を試す。全滅ならオフライン扱いで据え置き。
        }
      }
      return { checked: false };
    },

    /// この端末の有効化だけ解除する。**試用開始日は消さない**
    /// （消すと押すたびに試用が復活し、期限切れ状態のテストもできなくなる）。
    async deactivate() {
      const persisted = await read(STORE_KEYS.license);
      await write(STORE_KEYS.license, { maxSeenUtc: persisted?.maxSeenUtc ?? new Date().toISOString() });
    },
  };
}
