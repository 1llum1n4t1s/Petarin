# Petarin Privacy Policy

Last updated: 2026-07-30

Petarin ("the Extension") respects your privacy. This policy explains what data the Extension handles.

## Information We Collect

The Extension **does not collect any personal information**, and it **never transmits any data to servers operated by the developer** (the developer runs no servers).

## Data Storage

The sticky notes you create (text, color, icon, placement) and your settings are stored in your browser's local storage (`chrome.storage.local`).

- By default, this data never leaves your device.
- No third party, including the developer, can access this data.
- Removing the Extension deletes the stored data.

## Device Sync (optional, off by default)

The Extension includes an **optional** feature to sync your notes across multiple devices. **This feature is off by default**, and while it is off no data ever leaves your device. Browser-native sync is now the **only** sync method — the developer-operated relay ("Cloud Sync") was discontinued in July 2026 and the server was deleted.

### Browser-native sync (free)

Only if you turn sync on in the "Notes Desk", the notes for the profiles (note collections) you choose to sync are synchronized across your devices through your browser's built-in sync storage (`chrome.storage.sync`) — that is, via **the sync service provided by your browser vendor** (your Google, Microsoft, or Mozilla account, whichever you are signed into).

- In addition, only if you **separately turn on** "appearance settings" sync, your display preferences (which edge notes cling to, color, on-page show/hide, and note placement) are also synced through the same path. The settings that control sync itself are kept per device and are never synced.
- Data handled through this path is governed by your browser vendor's privacy policy. The developer cannot access it.
- Sync only works within the same browser family (Chrome, Edge, and Firefox are separate silos).
- **While sync is on, not only your active notes but also the bodies of deleted notes in the Trash are sent to the browser's sync storage.**
- You can turn it off anytime in the settings. Turning it off stops further sync (transmission) from this device. Data you have already synced remains in the browser's sync storage so your other devices can still use it (this action does not delete it).

### About the discontinued Cloud Sync

Earlier versions offered "Cloud Sync", which relayed notes in real time through a server operated by the developer (Cloudflare Workers). That feature was **discontinued on 30 July 2026**; the relay and its database of ciphertext were deleted. The Extension no longer communicates with any developer-operated server. If a pairing key from an older version is still stored on your device, it is deleted automatically the first time you run the updated version.

## Why Each Permission Is Used

- **storage**: to save your notes and settings on your device.
- **Host access (http/https)**: to draw the sticky-note rail at the edge of each page. The Extension does not read or transmit page content.

## Sharing With Third Parties

The Extension does not sell, share, or provide your data to any third party. It contains no advertising, analytics, or tracking of any kind.

## Contact

Questions? Please open an issue at https://github.com/1llum1n4t1s/Petarin/issues.

## Changes

If this policy changes, this file will be updated with a new "Last updated" date.
