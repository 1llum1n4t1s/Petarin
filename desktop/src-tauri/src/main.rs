// ぺたりん デスクトップ版のシェル。
//
// 設計の肝: 「デスクトップの端から付箋が生える」を全画面透過ウィンドウで作ると、デスクトップの
// クリックを全部奪うので click-through のヒットテスト（カーソル位置ポーリング）が必要になり壊れやすい。
// 代わりに **画面の端に接した細い帯ウィンドウを、付箋の展開に合わせて動的リサイズする**。
// 見た目は同じで、デスクトップ操作を一切邪魔しない。レール本体の描画は Web 側（拡張の rail.css 流用）。
//
// Rust 側が持つ責務はこれだけ:
//   - 作業領域（タスクバーを除いた領域）へウィンドウを吸着させる
//   - Web からの要求でウィンドウ幅/高さを変える（付箋の展開・格納）
//   - トレイ常駐と表示トグル
// 付箋データ・同期・ライセンスはすべて Web 側（拡張と単一ソースの JS エンジン）が担う。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};

/// レールを吸着させる画面の端。Web 側の `settings.side` と対応する。
#[derive(serde::Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Side {
    Left,
    Right,
}

/// 格納時の帯の幅（論理 px）。展開時は Web から実寸を渡してもらう。
const COLLAPSED_WIDTH: u32 = 56;

/// ウィンドウを作業領域の指定サイドへ吸着させる。
/// `width` は論理 px。スケールを掛けて物理 px へ直す（高 DPI で細くなるのを防ぐ）。
fn dock(window: &WebviewWindow, side: Side, width: u32) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(()); // モニタが取れない構成では位置合わせを諦めて既定位置のまま出す
    };
    let scale = monitor.scale_factor();
    let area = monitor.size();
    let origin = monitor.position();

    let phys_width = (width as f64 * scale).round() as u32;
    let height = area.height;

    let x = match side {
        Side::Left => origin.x,
        Side::Right => origin.x + area.width as i32 - phys_width as i32,
    };

    window.set_size(PhysicalSize::new(phys_width, height))?;
    window.set_position(PhysicalPosition::new(x, origin.y))?;
    Ok(())
}

/// 付箋の開閉に合わせて帯の幅を変える。Web 側が展開ボックスの実寸を知っているので受け取る。
#[tauri::command]
fn resize_rail(window: WebviewWindow, side: Side, width: u32) -> Result<(), String> {
    dock(&window, side, width.max(COLLAPSED_WIDTH)).map_err(|e| e.to_string())
}

/// レールの表示/非表示（トレイと同じ操作を Web からも呼べるように）。
#[tauri::command]
fn set_rail_visible(window: WebviewWindow, visible: bool) -> Result<(), String> {
    if visible {
        window.show().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // 2 重起動は既存ウィンドウを前面に出して終わる（常駐アプリなので多重起動は無意味）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![resize_rail, set_rail_visible])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");

            // 起動時は右端・格納幅で吸着（Web 側が設定を読んだら resize_rail で上書きしてくる）。
            dock(&window, Side::Right, COLLAPSED_WIDTH)?;

            let show = MenuItem::with_id(app, "show", "レールを表示", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "レールを隠す", true, None::<&str>)?;
            let license = MenuItem::with_id(app, "license", "ライセンス…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &license, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ぺたりん")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    // ライセンス面は Web 側が持つ（ロック面と同一のフォームを使い回すため）。
                    "license" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.emit("petarin://license-panel", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running petarin desktop");
}
