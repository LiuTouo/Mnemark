//! Backend-owned UI strings (tray menu, update dialogs) for both supported
//! languages. The webview's strings live separately in src/i18n.ts — there is
//! no shared build step between Rust and TypeScript, so keep both in sync by
//! hand.

/// Tray menu labels; kept so their text can be re-localized when the UI
/// language changes (see `AppState::tray_items`).
pub(crate) struct TrayLabels {
    pub(crate) pause: &'static str,
    pub(crate) resume: &'static str,
    pub(crate) settings: &'static str,
    pub(crate) tutorial: &'static str,
    pub(crate) about: &'static str,
    pub(crate) quit: &'static str,
}

pub(crate) fn tray_labels(lang: &str) -> TrayLabels {
    match lang {
        "en" => TrayLabels {
            pause: "Pause Monitoring",
            resume: "Resume Monitoring",
            settings: "Settings",
            tutorial: "Tutorial",
            about: "About",
            quit: "Quit",
        },
        _ => TrayLabels {
            pause: "暫停監聽",
            resume: "繼續監聽",
            settings: "設定",
            tutorial: "教學",
            about: "關於",
            quit: "結束",
        },
    }
}

/// Localized MessageBox strings for the auto-update restart prompt.
pub(crate) struct UpdateLabels {
    pub(crate) title: &'static str,
    pub(crate) restart_body: &'static str,
}

pub(crate) fn update_labels(lang: &str) -> UpdateLabels {
    if lang == "en" {
        UpdateLabels {
            title: "Mnemark Update",
            restart_body: "A new version has been installed. Restart Mnemark now?",
        }
    } else {
        UpdateLabels {
            title: "Mnemark 更新",
            restart_body: "已安裝新版本。現在重新啟動 Mnemark 嗎？",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{tray_labels, update_labels};

    /// Guards the copy-paste failure mode this module exists for: a label
    /// left empty, or one language's string accidentally reused for both.
    #[test]
    fn every_label_is_nonempty_and_differs_between_languages() {
        let (en, zh) = (tray_labels("en"), tray_labels("zh-TW"));

        let tray_pairs = [
            (en.pause, zh.pause),
            (en.resume, zh.resume),
            (en.settings, zh.settings),
            (en.tutorial, zh.tutorial),
            (en.about, zh.about),
            (en.quit, zh.quit),
        ];
        for (english, chinese) in tray_pairs {
            assert!(!english.is_empty());
            assert!(!chinese.is_empty());
            assert_ne!(english, chinese);
        }

        let (en, zh) = (update_labels("en"), update_labels("zh-TW"));
        for (english, chinese) in [(en.title, zh.title), (en.restart_body, zh.restart_body)] {
            assert!(!english.is_empty());
            assert!(!chinese.is_empty());
            assert_ne!(english, chinese);
        }
    }
}
