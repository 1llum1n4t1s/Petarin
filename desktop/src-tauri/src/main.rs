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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use velopack::{sources::HttpSource, UpdateCheck, UpdateManager, VelopackAsset};

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

/// レールの当たり判定 1 枠（論理 px・ウィンドウのクライアント座標）。
#[derive(serde::Deserialize)]
struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 帯ウィンドウの当たり判定を、実際に触れる部分（付箋タブ・展開した箱・絵文字ピッカー）だけに削る。
///
/// 帯は画面端の**全高**を占めるので、削らないと透明な部分がクリックを吸い、
/// **最大化ウィンドウの閉じるボタンや右端のスクロールバーが押せなくなる**（透明でも窓は窓）。
/// `SetWindowRgn` で窓の形そのものをタブの形へ削ると、region の外は OS から見て
/// 「窓が無い」ので下のアプリへクリックがそのまま通る。
///
/// AppBar（`SHAppBarMessage`）で画面領域を予約する方式は採らない。全ての最大化ウィンドウが
/// 帯のぶん縮むうえ、`ABM_REMOVE` をし損ねるとデスクトップの作業領域が縮んだまま残り、
/// アプリを消しても直らない（explorer の再起動が要る）。
///
/// **空配列は「制限なし」**＝窓全体を当たり判定に戻す。ライセンス面のように Shadow DOM の外へ
/// 生える UI は幅も当たり判定も窓いっぱい要るので、そちらは空を送って従来どおりにする。
#[tauri::command]
fn set_hit_regions(window: WebviewWindow, rects: Vec<HitRect>) -> Result<(), String> {
    #[cfg(windows)]
    {
        // SetWindowRgn は user32 の関数だが、windows-sys では GDI 側にまとめられている。
        use windows_sys::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
        };

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;

        if rects.is_empty() {
            // null region ＝ 制限解除。第 3 引数は再描画するか。
            unsafe { SetWindowRgn(hwnd, std::ptr::null_mut(), 1) };
            return Ok(());
        }

        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        // 端数は外側へ寄せる（内側へ丸めるとタブの縁 1px が押せない帯になる）。
        let total = unsafe { CreateRectRgn(0, 0, 0, 0) };
        for r in &rects {
            let x1 = (r.x * scale).floor() as i32;
            let y1 = (r.y * scale).floor() as i32;
            let x2 = ((r.x + r.w) * scale).ceil() as i32;
            let y2 = ((r.y + r.h) * scale).ceil() as i32;
            let part = unsafe { CreateRectRgn(x1, y1, x2, y2) };
            unsafe {
                CombineRgn(total, total, part, RGN_OR as i32);
                DeleteObject(part as _);
            }
        }
        // SetWindowRgn は region の所有権を OS へ渡す＝ここで DeleteObject してはいけない。
        unsafe { SetWindowRgn(hwnd, total, 1) };
    }
    #[cfg(not(windows))]
    let _ = (window, rects);
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

// ── 全画面アプリの前では最前面を降りる ──────────────────────────────
//
// レール窓は alwaysOnTop なので、既定のままだと**全画面の動画や映画の上に細い帯が居座る**。
// 前面ウィンドウがモニタを覆っているあいだだけ最前面属性を外し、抜けたら戻す。
// 隠す（hide）のではなく最前面だけ降ろすのが要点で、これなら全画面アプリの裏に自然に回り、
// 全画面を抜けた瞬間に元の位置へ戻る（表示状態を保存しないので「気付いたら消えていた」が起きない）。
#[cfg(windows)]
fn foreground_is_fullscreen(own_pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.is_null() {
            return false;
        }
        // 自分の窓（レール・ポップアップ・デスク）は対象外。デスクを最大化しただけで
        // レールが引っ込むのはおかしいため。
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == own_pid {
            return false;
        }

        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return false;
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut mi) == 0 {
            return false;
        }
        // rcMonitor（タスクバーを含むモニタ全体）を覆っていたら全画面とみなす。
        // デスクトップ（Progman/WorkerW）も全面だが、それが前面のときは pid 判定を抜けてここへ来る。
        // ただしデスクトップ表示中に最前面を降りても実害が無い（すぐ戻る）ので特別扱いはしない。
        rect.left <= mi.rcMonitor.left
            && rect.top <= mi.rcMonitor.top
            && rect.right >= mi.rcMonitor.right
            && rect.bottom >= mi.rcMonitor.bottom
    }
}

#[cfg(not(windows))]
fn foreground_is_fullscreen(_own_pid: u32) -> bool {
    false
}

/// 前面アプリの全画面状態を監視して、レール窓の最前面属性を追従させる。
/// 1 秒間隔のポーリング。イベント購読の口が Win32 に無く（WinEvent フックは別スレッドの
/// メッセージループが要る）、この用途では 1 秒の遅れが体感上問題にならないため。
fn watch_fullscreen(window: WebviewWindow) {
    let own_pid = std::process::id();
    std::thread::spawn(move || {
        let mut on_top = true;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let want_on_top = !foreground_is_fullscreen(own_pid);
            if want_on_top != on_top {
                on_top = want_on_top;
                if let Err(e) = window.set_always_on_top(want_on_top) {
                    eprintln!("[petarin] 最前面属性の切り替えに失敗: {e}");
                }
            }
        }
    });
}

// ── 更新（Velopack）────────────────────────────────────────────────
//
// 更新チャネルは release-local.ps1 が成果物を上げる R2 のカスタムドメイン。ここを変えるときは
// release-local.ps1 の $BaseUrl と揃えること（片方だけ変えると出荷済みアプリが更新を見失う）。
const UPDATE_URL: &str = "https://petarin.kagayoi.com";

/// トレイの「更新」項目の状態。ダウンロード済みの資産を持ち回って、次のクリックで適用する。
#[derive(Default)]
struct UpdateState {
    /// ダウンロード済みで適用待ちの版。None のあいだ「更新」項目は確認ボタンとして働く。
    ready: Option<VelopackAsset>,
    /// 確認・ダウンロードの実行中。二重起動を防ぐ。
    busy: bool,
}

/// UpdateManager を作る。**未インストール（`cargo tauri dev` 等）では Err になる**ので、
/// 呼び出し側はエラーを致命扱いせずメニューへ理由を出すだけにする。
fn update_manager() -> Result<UpdateManager, String> {
    UpdateManager::new(HttpSource::new(UPDATE_URL), None, None).map_err(|e| e.to_string())
}

/// トレイの更新項目のラベルを差し替える（進捗表示を兼ねる）。
fn set_update_label(item: &MenuItem<tauri::Wry>, text: &str, enabled: bool) {
    let _ = item.set_text(text);
    let _ = item.set_enabled(enabled);
}

/// 「更新を確認…」を押したときの一連の流れ。ネットワーク I/O をメニューのイベントスレッドで
/// 回すと UI が固まるので、別スレッドへ逃がしてラベルだけ書き換える。
fn start_update_check(app: &tauri::AppHandle, item: MenuItem<tauri::Wry>) {
    {
        let state = app.state::<Mutex<UpdateState>>();
        let mut s = state.lock().unwrap();
        if s.busy {
            return;
        }
        // ダウンロード済みなら 2 回目のクリック＝適用。再起動を伴うので、確認と適用は
        // 必ず別クリックに分ける（押した瞬間に落ちて驚かせない）。
        if let Some(asset) = s.ready.clone() {
            s.busy = true;
            drop(s);
            set_update_label(&item, "再起動しています…", false);
            std::thread::spawn(move || match update_manager() {
                Ok(um) => {
                    if let Err(e) = um.apply_updates_and_restart(&asset) {
                        eprintln!("[petarin] 更新の適用に失敗: {e}");
                    }
                }
                Err(e) => eprintln!("[petarin] 更新の適用に失敗: {e}"),
            });
            return;
        }
        s.busy = true;
    }

    set_update_label(&item, "更新を確認中…", false);
    let app = app.clone();
    std::thread::spawn(move || {
        let finish = |label: String, enabled: bool, ready: Option<VelopackAsset>| {
            let state = app.state::<Mutex<UpdateState>>();
            let mut s = state.lock().unwrap();
            s.busy = false;
            s.ready = ready;
            drop(s);
            set_update_label(&item, &label, enabled);
        };

        let um = match update_manager() {
            Ok(um) => um,
            // 未インストールのビルド（開発中・ポータブル展開）では更新できない。理由をそのまま出す。
            Err(e) => {
                eprintln!("[petarin] 更新の確認に失敗: {e}");
                return finish("更新を確認できません".into(), true, None);
            }
        };

        match um.check_for_updates() {
            Ok(UpdateCheck::UpdateAvailable(info)) => {
                let version = info.TargetFullRelease.Version.clone();
                set_update_label(&item, &format!("v{version} をダウンロード中…"), false);
                match um.download_updates(&info, None) {
                    Ok(()) => finish(
                        format!("v{version} へ更新（再起動）"),
                        true,
                        Some(info.TargetFullRelease.clone()),
                    ),
                    Err(e) => {
                        eprintln!("[petarin] 更新のダウンロードに失敗: {e}");
                        finish("ダウンロードに失敗（再試行）".into(), true, None)
                    }
                }
            }
            Ok(_) => finish("最新版です".into(), true, None),
            Err(e) => {
                eprintln!("[petarin] 更新の確認に失敗: {e}");
                finish("確認に失敗（再試行）".into(), true, None)
            }
        }
    });
}

// ── 起動時のサイレント更新 ──────────────────────────────────────────
//
// レール窓は `tauri.conf.json` で `visible:false` にしてあり、**ここが決着をつけるまで出さない**。
// 更新がある回はレールを一度も見せないまま新版へ入れ替わる＝「更新してから起動」になり、
// ユーザーが触っている最中に窓が消える事故が起きない。
//
// ただしネットワークが不調でも起動を人質に取ってはいけない（常駐アプリで「何も出ない」は
// 起動失敗にしか見えない）。下の猶予を超えたら見せるのを優先し、落としてきた版はトレイの
// 「更新」項目へ引き渡して手動適用に切り替える。

/// 更新の**確認**（数百バイトの JSON）だけを待つ猶予。
const REVEAL_AFTER_CHECK: Duration = Duration::from_secs(5);
/// **ダウンロード**（数十 MB）まで進んだ回に許す猶予。待つ価値があるので長めに取る。
const REVEAL_AFTER_DOWNLOAD: Duration = Duration::from_secs(90);

/// レール窓を出したか。**出した後は自動再起動しない**のが不変則。
static RAIL_SHOWN: AtomicBool = AtomicBool::new(false);
/// 起動時更新がダウンロード段階に入ったか（猶予を延ばす判断に使う）。
static STARTUP_DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// レール窓を 1 回だけ出す。以後の自動再起動を止める意思表示も兼ねる（二役なので必ずここを通す）。
fn reveal_rail(window: &WebviewWindow) {
    if RAIL_SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = window.show() {
        eprintln!("[petarin] レールの表示に失敗: {e}");
    }
}

/// トレイやポップアップを触られたら、更新の途中でもレールを出して自動再起動を諦める。
/// ユーザーがもう操作を始めている＝勝手に再起動してよい時間帯を過ぎたということ。
fn reveal_rail_from(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        reveal_rail(&w);
    }
}

/// 起動直後に 1 回だけ走るサイレント更新。無音で確認・ダウンロードし、レールを出す前に
/// 間に合えばそのまま再起動して新版で立ち上がる。
fn start_startup_update(app: &tauri::AppHandle, window: WebviewWindow, item: MenuItem<tauri::Wry>) {
    // 見せるまでの番人。更新スレッドが死んでも黙り込んでもレールは必ず出る。
    {
        let window = window.clone();
        std::thread::spawn(move || {
            let start = Instant::now();
            while !RAIL_SHOWN.load(Ordering::SeqCst) {
                let limit = if STARTUP_DOWNLOADING.load(Ordering::SeqCst) {
                    REVEAL_AFTER_DOWNLOAD
                } else {
                    REVEAL_AFTER_CHECK
                };
                if start.elapsed() >= limit {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            reveal_rail(&window);
        });
    }

    let app = app.clone();
    std::thread::spawn(move || {
        {
            let state = app.state::<Mutex<UpdateState>>();
            let mut s = state.lock().unwrap();
            if s.busy {
                return;
            }
            s.busy = true;
        }

        // 起動時は無音が約束なので、失敗してもラベルは既定（「更新を確認…」）のまま黙って進む。
        // 出せるのは「落としてきたけど適用が間に合わなかった」ときだけ。
        let settle = |ready: Option<VelopackAsset>, label: Option<String>| {
            let state = app.state::<Mutex<UpdateState>>();
            let mut s = state.lock().unwrap();
            s.busy = false;
            s.ready = ready;
            drop(s);
            if let Some(text) = label {
                set_update_label(&item, &text, true);
            }
            reveal_rail(&window);
        };

        let um = match update_manager() {
            Ok(um) => um,
            // 未インストールのビルド（`tauri dev` / `--no-bundle`）はここで必ず失敗する。異常ではない。
            Err(e) => {
                eprintln!("[petarin] 起動時の更新確認をとばした: {e}");
                return settle(None, None);
            }
        };
        let info = match um.check_for_updates() {
            Ok(UpdateCheck::UpdateAvailable(info)) => info,
            Ok(_) => return settle(None, None),
            Err(e) => {
                eprintln!("[petarin] 起動時の更新確認に失敗: {e}");
                return settle(None, None);
            }
        };

        STARTUP_DOWNLOADING.store(true, Ordering::SeqCst);
        let version = info.TargetFullRelease.Version.clone();
        if let Err(e) = um.download_updates(&info, None) {
            eprintln!("[petarin] 起動時の更新ダウンロードに失敗: {e}");
            return settle(None, None);
        }

        // まだレールを見せていない＝ユーザーは何も触っていない。ここで入れ替えて再起動する。
        // 成功すればプロセスは戻ってこない。
        if !RAIL_SHOWN.load(Ordering::SeqCst) {
            match um.apply_updates_and_restart(&info.TargetFullRelease) {
                Ok(()) => return,
                Err(e) => eprintln!("[petarin] 起動時の更新適用に失敗: {e}"),
            }
        }
        // 猶予切れか適用失敗。ダウンロード済みなので、次のクリックで適用できる状態にして渡す。
        settle(
            Some(info.TargetFullRelease.clone()),
            Some(format!("v{version} へ更新（再起動）")),
        );
    });
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
                // 起動時更新の最中でもここで見せる（自動再起動もここで諦める）。
                // 2 個目を起動した＝今すぐ使いたいということなので、待たせない。
                reveal_rail(&w);
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            resize_rail,
            set_hit_regions,
            open_desk,
            hide_popup
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");

            // 起動時は右端・格納幅で吸着（Web 側が設定を読んだら resize_rail で上書きしてくる）。
            dock(&window, Side::Right, COLLAPSED_WIDTH)?;
            watch_fullscreen(window.clone());

            app.manage(Mutex::new(UpdateState::default()));

            // 先頭に「今の版」を出す。押せない見出し項目にして、更新操作と取り違えられないようにする。
            // 表示は tauri.conf.json の version が正本（未インストールの開発ビルドでも正しく出る）。
            let version = app.package_info().version.to_string();
            let version_item = MenuItem::with_id(
                app,
                "version",
                format!("ぺたりん v{version}"),
                false,
                None::<&str>,
            )?;
            // ラベルが確認 →ダウンロード →適用と変わるので、ハンドラへ渡せるよう控えておく。
            let update = MenuItem::with_id(app, "update", "更新を確認…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            // 「レールを表示/隠す」は置かない。**起動していればレールは必ず出ている**のが約束で、
            // 邪魔なときは終了するか半透明にして避ける（ポップアップの「半透明」設定）。隠せると
            // 「常駐しているのに何も出ない・原因が分からない」状態を作れてしまうため。
            // 全画面アプリの前面に被らない対応は最前面属性の自動制御（watch_fullscreen）が担う。
            let desk = MenuItem::with_id(app, "desk", "付箋デスク…", true, None::<&str>)?;
            let license = MenuItem::with_id(app, "license", "ライセンス…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &version_item,
                    &update,
                    &sep,
                    &desk,
                    &license,
                    &quit,
                ],
            )?;
            let update_for_events = update.clone();

            // トレイのツールチップにも版を出す（メニューを開かなくても確認できる）。
            let tooltip = format!("ぺたりん v{version}");

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(&tooltip)
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
                        reveal_rail_from(app);
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
                .on_menu_event(move |app, event| {
                    // メニューを操作した時点でユーザーは使い始めている。起動時更新の
                    // 自動再起動はここで打ち切り、レールを出す。
                    reveal_rail_from(app);
                    match event.id.as_ref() {
                    "update" => start_update_check(app, update_for_events.clone()),
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
                    }
                })
                .build(app)?;

            // トレイができてから起動時更新を始める（進捗の引き渡し先＝更新項目が要るため）。
            // single-instance プラグインより後＝ここに来た時点で自分が唯一のインスタンスなので、
            // 稼働中の別インスタンスを巻き込んで更新を適用してしまう事故が起きない。
            start_startup_update(app.handle(), window.clone(), update);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running petarin desktop");
}
