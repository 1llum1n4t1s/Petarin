# Petarin Privacy Policy

Last updated: 2026-06-23

Petarin ("the Extension") respects your privacy. This policy explains what data the Extension handles.

## Information We Collect

The Extension **does not collect any personal information**. Except when you turn on "Cloud Sync" (described below) yourself, it never transmits any data to servers operated by the developer.

## Data Storage

The sticky notes you create (text, color, icon, placement) and your settings are stored in your browser's local storage (`chrome.storage.local`).

- By default, this data never leaves your device.
- No third party, including the developer, can access this data.
- Removing the Extension deletes the stored data.

## Device Sync (optional, off by default)

The Extension and the mobile app include an **optional** feature to sync your notes across multiple devices. **This feature is off by default**, and while it is off no data ever leaves your device. There are two sync methods, and you choose which to use.

### A. Browser-native sync (free)

Only if you turn sync on in the "Notes Desk" and choose "browser-native sync", the notes for the domains you choose to sync are synchronized across your devices through your browser's built-in sync storage (`chrome.storage.sync`) — that is, via **the sync service provided by your browser vendor** (your Google, Microsoft, or Mozilla account, whichever you are signed into).

- In addition, only if you **separately turn on** "appearance settings" sync, your display preferences (which edge notes cling to, color, on-page show/hide, and note placement) are also synced through the same path. The settings that control sync itself are kept per device and are never synced.
- Data handled through this path is governed by your browser vendor's privacy policy. The developer cannot access it.
- Sync only works within the same browser family (Chrome, Edge, and Firefox are separate silos).

### B. Cloud sync (one-time purchase, end-to-end encrypted)

Only if you choose "Cloud Sync" and pair your devices, your notes are synced in real time across devices (including between the PC extension and the mobile app) through a relay server operated by the developer (Cloudflare Workers). This relay has the following protections:

- Note bodies, colors, icons, etc. are **encrypted on your device with AES-GCM** before being sent, and the decryption key is stored **only on your devices** (shared between devices via the QR-code/text pairing). The relay only ever receives ciphertext, and **no one — including the developer — can read the contents** (zero-knowledge).
- The domain name that identifies which site a note belongs to is also **hashed (HMAC)** on your device before sending, so the relay does not learn which sites your notes are for.
- **While sync is on, not only your active notes but also the bodies of deleted notes in the Trash are sent (also encrypted) to the relay.** The relay, lacking the decryption key, cannot read these either.
- If you lose the decryption key, the synced data cannot be recovered (the key exists only on your devices).
- Regardless of browser or mobile app, sync happens only between devices that share the same pairing.

### Common

- You can turn it off anytime in the settings. Turning it off stops further sync (transmission) from this device. Data you have already synced remains in the sync storage / relay so your other devices can still use it (this action does not delete it).

## Why Each Permission Is Used

- **storage**: to save your notes and settings on your device.
- **activeTab**: to determine the domain of the current tab so the right notes are shown.
- **Host access (http/https)**: to draw the sticky-note rail at the edge of each page. The Extension does not read or transmit page content.

## Sharing With Third Parties

The Extension does not sell, share, or provide your data to any third party. It contains no advertising, analytics, or tracking of any kind.

## Contact

Questions? Please open an issue at https://github.com/1llum1n4t1s/Petarin/issues.

## Changes

If this policy changes, this file will be updated with a new "Last updated" date.
