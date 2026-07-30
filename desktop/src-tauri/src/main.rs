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
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
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

/// ポップアップの論理サイズ。幅は拡張の popup.css（400px）に合わせる。
const POPUP_WIDTH: f64 = 400.0;
const POPUP_HEIGHT: f64 = 620.0;

/// 付箋デスク（拡張の options ページ相当）を出す。
///
/// レール窓と違い**通常の装飾つきウィンドウ**にする。デスクは文字入力・スクロール・リサイズが
/// 要るうえ、ゴミ箱の完全削除や同期モード切替といった取り消せない操作を置く。レール窓は
/// transparent / decorations:false / alwaysOnTop / focus:false / resizable:false ＝
/// フォーカスもリサイズも拒否する設定なので、同居させるとそれを全部剥がすことになる。
fn show_desk(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("desk") {
        let _ = w.unminimize();
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, "desk", WebviewUrl::App("manage.html".into()))
        .title("ぺたりん — 付箋デスク")
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .center()
        .build()?;
    w.set_focus()?;
    Ok(())
}

/// トレイアイコンのクリックで出す小窓＝拡張のツールバーポップアップに相当。
/// ブラウザと同じ体感にするため、枠なし・常に手前・タスクバーに出さない・
/// **フォーカスを失ったら閉じる**。`at` はトレイアイコンの物理座標。
fn show_popup(app: &tauri::AppHandle, at: PhysicalPosition<f64>) -> tauri::Result<()> {
    let window = match app.get_webview_window("popup") {
        Some(w) => w,
        None => {
            let w = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("popup.html".into()))
                .title("ぺたりん")
                .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false) // 位置を決めてから出す（既定位置に一瞬出るのを防ぐ）
                .build()?;
            let handle = w.clone();
            w.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = handle.hide();
                }
            });
            w
        }
    };

    // トレイアイコンの真上あたりへ。画面外へはみ出さないようモニタ内へ収める。
    if let Some(monitor) = window.current_monitor()? {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let origin = monitor.position();
        let w_phys = (POPUP_WIDTH * scale).round() as i32;
        let h_phys = (POPUP_HEIGHT * scale).round() as i32;
        let x = (at.x as i32 - w_phys / 2).clamp(origin.x, origin.x + size.width as i32 - w_phys);
        let y = (at.y as i32 - h_phys).max(origin.y);
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// popup の「付箋デスク」ボタン（chrome.runtime.openOptionsPage 相当）。
#[tauri::command]
fn open_desk(app: tauri::AppHandle) -> Result<(), String> {
    show_desk(&app).map_err(|e| e.to_string())
}

/// popup.js の window.close() 相当（Tauri の webview は JS からの close が効かない）。
#[tauri::command]
fn hide_popup(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("popup") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    // Velopack のインストール/更新フックを最初に処理する。
    //
    // Velopack はインストール直後などに本体を `--veloapp-install <ver>` 等の引数付きで起動し、
    // **その終了を待つ**。ここが無いとアプリは引数を無視して常駐 GUI を立ち上げたまま終了せず、
    // インストーラが「インストールが部分的に成功しました」と報告する（ショートカットは作られる
    // ので一見ちゃんと入っているように見え、原因に気付きにくい）。
    // GUI の構築より前＝main の先頭に置く必要がある。
    velopack::VelopackApp::build().run();

    tauri::Builder::default()
        // 2 重起動は既存ウィンドウを前面に出して終わる（常駐アプリなので多重起動は無意味）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            resize_rail,
            set_rail_visible,
            open_desk,
            hide_popup
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");

            // 起動時は右端・格納幅で吸着（Web 側が設定を読んだら resize_rail で上書きしてくる）。
            dock(&window, Side::Right, COLLAPSED_WIDTH)?;

            let show = MenuItem::with_id(app, "show", "レールを表示", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "レールを隠す", true, None::<&str>)?;
            let desk = MenuItem::with_id(app, "desk", "付箋デスク…", true, None::<&str>)?;
            let license = MenuItem::with_id(app, "license", "ライセンス…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &desk, &license, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ぺたりん")
                .menu(&menu)
                // 右クリックだけメニューを出す。左クリックはブラウザのツールバーアイコンと同じく
                // ポップアップに割り当てる（既定のままだと左クリックでもメニューが出てしまう）。
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        // 出ている状態でもう一度押したら閉じる（ブラウザのポップアップと同じ）。
                        if let Some(w) = app.get_webview_window("popup") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                                return;
                            }
                        }
                        if let Err(e) = show_popup(app, position) {
                            eprintln!("[petarin] ポップアップの表示に失敗: {e}");
                        }
                    }
                })
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
                    "desk" => {
                        if let Err(e) = show_desk(app) {
                            eprintln!("[petarin] 付箋デスクの表示に失敗: {e}");
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
