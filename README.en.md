<div align="center">

<img src="docs/images/banner.svg" alt="floating todo — desktop task widget" width="100%" />

# floating todo

[简体中文](README.md) | [English](README.en.md)

**A translucent, always-on-top desktop task widget for macOS and Windows.**

Keep today, tomorrow, and the day after tomorrow in view. Capture tasks with a global shortcut, get reminders, and track daily habits. Works offline by default, with optional WebDAV, LAN, and Tailscale synchronization. No application account or ads.

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-2767c8)](#download-and-install)
[![Tauri](https://img.shields.io/badge/built%20with-Tauri%202-ffc131?logo=tauri&logoColor=white)](https://tauri.app)
[![Release](https://img.shields.io/github/v/release/pisceskkk/floating-todo?include_prereleases)](../../releases)
[![Stars](https://img.shields.io/github/stars/pisceskkk/floating-todo?style=social)](../../stargazers)

</div>

## About

floating todo keeps a small task list visible in a corner of your desktop while you write, work, or meet. Data is stored locally, and synchronization is optional. Its three-day view keeps planning focused on the near term.

This is a free, open-source project. If it helps you, a star, bug report, or contribution is welcome.

<div align="center">
<img src="docs/images/widget.svg" alt="Desktop widget preview" width="330" />
</div>

The application interface and illustrated previews currently use Chinese. This English README describes the existing features; it does not imply an English interface or English natural-language date parsing.

## Features

### Tasks and daily habits

- Separate lists for today, tomorrow, and the day after tomorrow.
- Add, complete, edit, delete, or move tasks between dates. Completed tasks stay below unfinished tasks.
- Drag a task title or its sorting handle to reorder it. Focus a handle and use `Alt + ↑ / ↓` for keyboard sorting. Manual order is saved for dated and daily lists.
- Parse Chinese date/time input such as `明天 15:00 提交方案` into tomorrow's list with a 15:00 reminder. Time expressions such as `下午3点半` are also supported.
- Optional local notification reminders. Reminder preferences remain local to each device.
- Double-click a title to edit it, or use its menu to edit details, move it, make it a daily task, or delete it.
- Clickable links in task descriptions.
- Daily recurring tasks reset each day and track completion streaks, with a celebration effect when completed.
- Automatic day rollover: tomorrow becomes today, and unfinished tasks carry forward.
- Clear completed tasks in one action.

### Window and appearance

- Press `⌘⇧Space` on macOS or `Ctrl+Shift+Space` on Windows to show the widget and focus task entry. Use `Esc` to dismiss it.
- Always-on-top mode, adjustable transparency, custom background color, and system/light/dark appearance.
- Optional rounded window shadow, remembered across restarts.
- Resize from window edges and corners; compact mode shows only today's list.
- **Mini bar:** click the task count at the top right to collapse the panel into a capsule anchored at its top-right corner. You can also shrink it from the bottom-left corner, then continue dragging toward the upper right past its center. Drag its left handle to reposition it, and click the count to restore the full panel and its previous size. The bar shows the date and unfinished count, turning green when no tasks remain.
- **Quick entry:** click `＋` on the mini bar or press the global shortcut to open a small input card. Select a date, enter a time, project, or tags, then press `Enter` to submit. `Esc` or clicking outside closes the card while retaining an unsent draft.
- Tray/menu-bar access without occupying the taskbar or Dock.
- **Windows desktop pinning:** keep the widget visible after `Win+D`. This mode places it in the desktop layer rather than above ordinary windows or full-screen games, and is mutually exclusive with always-on-top mode.
- Click-through mode lets mouse clicks reach windows underneath; turn it off from the tray menu.
- Optional launch at login.
- Settings group window behavior, appearance, categories, synchronization/backups, and notifications separately.

<div align="center">
<img src="docs/images/mini-bar.svg" alt="Mini bar and quick entry previews" width="100%" />
</div>

### Projects and tags

- Use `+project` and `#tag` while typing, with inline suggestions. Quote names containing spaces or purely numeric names, for example `+"Website Redesign"`.
- Each task can belong to one project and multiple tags, including recurring daily tasks. Project colors tint task cards; tag colors appear as small dots.
- Combine project and tag filters within a date. Filters persist when switching dates; clearing completed tasks affects only visible tasks when a filter is active.
- Rename, recolor, or delete categories in Settings → Projects and tags (`项目与标签`). Backups include categories and colors, and older data migrates automatically.

### Notes and backups

- A shared memo independent of the selected day, saved automatically.
- Export JSON backups with revision history. Import previews and merges data while preserving items unique to the current device.

### WebDAV synchronization

- Configure your own WebDAV endpoint and sync space in Settings → WebDAV sync and conflicts (`WebDAV 同步与冲突`). Devices using the same space synchronize tasks, projects, tags, habit records, ordering, and the memo.
- Changes are saved locally first. Automatic sync uploads them when available; offline changes remain queued. View pending uploads, the last successful sync, errors, or trigger a sync manually.
- Independent edits merge automatically, and duplicate revisions do not create duplicate tasks. Window appearance and local reminder settings stay device-specific.
- Concurrent changes to the same item retain their branches, displaying the latest state under the version model's deterministic ordering. Keep the current state, restore another version, edit a resolution, or save a conflicting task as a new task.
- WebDAV passwords are stored in macOS Keychain or Windows Credential Manager. **WebDAV files are not end-to-end encrypted:** use a trusted service. See the [WebDAV protocol and usage guide](docs/webdav-sync.md) (Chinese).

### LAN and Tailscale synchronization

- **Device discovery:** enable Settings → Sync and backup → LAN and Tailscale sync (`局域网与 Tailscale 同步`) on both devices to find peers on your LAN or Tailscale/Headscale network. Devices use their computer names by default; manual IPv4 lookup is also available.
- **Code pairing:** enter the other device's six-digit temporary code or persistent eight-digit code. Temporary codes refresh every 60 seconds; fixed codes survive restarts. Refresh codes or revoke individual pairings from settings.
- **Shared task data:** pairing merges both devices' complete tasks, projects, tags, habit records, ordering, and memo. Concurrent edits retain their versions for review and recovery in settings.
- **Automatic synchronization:** saved changes notify paired devices, periodic checks catch missed updates, and synchronization resumes after reconnection. Enable WebDAV alongside LAN sync to pass updates between devices using either connection.
- **Encrypted transfer:** data is encrypted between paired devices. Pairing credentials are encrypted locally, with their key stored in macOS Keychain or Windows Credential Manager.
- **Optional setup:** disabled by default. Allow local-network access and inbound TCP 47831. Tailscale/Headscale requires a signed-in local client and network rules that allow connections between devices. See the [LAN sync usage guide](docs/lan-sync.md#使用) (Chinese).

### Update checks

- **New version alerts:** checks after startup and every six hours while running. A new version displays a prompt and a dot on the settings button.
- **Installed version:** view your current version even offline in Settings → Application updates (`应用更新`), or check for updates manually.
- **Download access:** open the matching [Release page](https://github.com/pisceskkk/floating-todo/releases) from settings, download the installer for your platform, and install the new version.
- **Update channels:** stable versions receive stable updates; RC versions also receive newer RC releases. If a check fails, view the reason in settings and retry later.

## Download and install

Download an installer from [Releases](../../releases):

| Platform | Download filename | Requirement |
| --- | --- | --- |
| macOS, Apple silicon | `floating-todo_x.x.x_aarch64.dmg` | Apple M-series chip |
| macOS, Intel | `floating-todo_x.x.x_x64.dmg` | Intel processor |
| Windows | `floating-todo_x.x.x_x64-setup.exe` | 64-bit Windows 10/11 |

The application and installer product name is **floating todo**. GitHub download assets use the `floating-todo_` prefix; the installed macOS bundle is `floating todo.app`.

When upgrading from the former Chinese bundle name, quit the old app, drag the new app into Applications, then remove `悬浮待办.app` to avoid running two copies. The application identifier is unchanged, so existing task data and credentials remain in use.

### macOS first launch

Builds use ad-hoc signing. This allows checking the bundle's integrity but does not authenticate the developer or provide Apple notarization. macOS may require permission under System Settings → Privacy & Security.

If macOS reports that the app is damaged, first verify the installed bundle:

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/floating todo.app"
```

An error such as `code has no resources but signature indicates they must be present` indicates an incomplete signature. Use a corrected build or rebuild from trusted source. Removing quarantine does not fix a broken signature.

For a trusted older build that needs a temporary local repair, re-sign the complete bundle and verify it before removing its download quarantine:

```bash
codesign --force --sign - "/Applications/floating todo.app"
codesign --verify --deep --strict --verbose=2 "/Applications/floating todo.app"
# Only after verification succeeds:
xattr -dr com.apple.quarantine "/Applications/floating todo.app"
```

Re-signing does not verify the download's origin. Developer ID signing and Apple notarization remain on the roadmap. See [Tauri's macOS signing documentation](https://v2.tauri.app/distribute/sign/macos/).

### Windows first launch

The app does not currently use a paid Windows code-signing certificate. For a trusted download blocked by SmartScreen, select **More info → Run anyway**.

## Build and contribute

Install Node.js 20+, Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/pisceskkk/floating-todo.git
cd floating-todo
npm ci
npm run dev       # Development mode
npm run build     # Platform installers
```

Pushing a `v*` tag triggers macOS and Windows builds through [GitHub Actions](.github/workflows/release.yml). The macOS release check mounts the final DMG read-only and verifies the enclosed `floating todo.app`, application identifier, and complete code signature. It does not depend on the intermediate `.app` directory that Tauri cleans up after a DMG-only build.

Run frontend checks:

```bash
npm ci
npm test
npx playwright install chromium
npm run test:ui
```

Set `PLAYWRIGHT_CHANNEL=msedge` on Windows to use installed Edge, or `PLAYWRIGHT_CHANNEL=chrome` to use Chrome. Browser tests start a local preview server. Native notification and file-dialog APIs are mocked; actual system behavior requires desktop testing.

Run native checks and verify a local DMG on macOS:

```bash
cargo test --manifest-path crates/lan-sync/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
npm run build -- --bundles dmg
bash scripts/verify-macos-dmg.sh src-tauri/target
```

## Architecture

- **Tauri 2:** Rust backend with the operating system WebView.
- **Frontend:** plain HTML, CSS, and JavaScript, with no frontend bundling step.
- **Storage:** local SQLite on desktop, with migration from legacy `localStorage`; optional WebDAV and native LAN sync, with keys in the OS credential store.
- **Integrations:** global shortcuts, notifications, launch at login, and file dialogs.

```text
floating-todo/
├─ src/                  # Frontend and synchronization UI/model
├─ src-tauri/            # Rust desktop integration and packaging
├─ crates/lan-sync/      # Native discovery, pairing, encrypted transport
├─ scripts/              # Installer verification
├─ .github/workflows/    # Cross-platform CI and releases
└─ legacy-macos-swift/   # Archived early Swift implementation
```

## Roadmap

- [ ] macOS notarization and Windows code signing
- [x] Optional WebDAV sync, offline queues, and recoverable conflicts
- [x] LAN/Tailscale discovery, code pairing, encrypted sync, and conflict recovery
- [ ] Customizable global shortcuts
- [ ] Richer natural-language parsing, including weekly recurrence and relative dates

Issues and pull requests are welcome. If floating todo helps you, consider giving it a star.
