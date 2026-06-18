# Petarin Privacy Policy

Last updated: 2026-06-18

Petarin ("the Extension") respects your privacy. This policy explains what data the Extension handles.

## Information We Collect

The Extension **does not collect any personal information**, and it never transmits any data to servers operated by the developer.

## Data Storage

The sticky notes you create (text, color, icon, placement) and your settings are stored in your browser's local storage (`chrome.storage.local`).

- By default, this data never leaves your device.
- No third party, including the developer, can access this data.
- Removing the Extension deletes the stored data.

## Multi-Device Sync (optional, off by default)

The Extension includes an **optional** feature to sync your notes across multiple devices. **This feature is off by default**, and while it is off no data ever leaves your device.

Only if you **turn it on yourself** in the "Notes Desk" settings, the notes for the domains you choose to sync are synchronized across your devices through your browser's built-in sync storage (`chrome.storage.sync`) — that is, via **the sync service provided by your browser vendor** (your Google, Microsoft, or Mozilla account, whichever you are signed into in your browser).

- In addition, only if you **separately turn on** "appearance settings" sync, your display preferences (which edge notes cling to, color, on-page show/hide, and note placement) are also synced across your devices through the same path. The settings that control sync itself are kept per device and are never synced.
- Data handled through this path is governed by your browser vendor's privacy policy. The developer cannot access it.
- Sync only works within the same browser family (Chrome, Edge, and Firefox are separate silos; cross-browser sync is not possible).
- Turning it off stops further sync (transmission) from this device, but data you have already synced remains in the browser's sync storage so your other devices can still use it (this action does not delete it).

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
