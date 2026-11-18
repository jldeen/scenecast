//! App updates: a stub. The app asks here; until an update service exists, the answer is that there's nothing to
//! check against. When one is built, [`check`] is the one place to change (the Tauri updater plugin, with a signed
//! feed), and the app's "Check for updates" already calls it.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub available: Option<String>,
    pub message: String,
}

pub fn check(current: &str) -> UpdateCheck {
    UpdateCheck {
        current: current.to_owned(),
        available: None,
        message: format!(
            "You have Scenecast {current}. Automatic updates aren't switched on yet: get new versions from whoever shared the app with you."
        ),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn says_there_is_no_update_service_yet() {
        let c = super::check("0.2.0");
        assert_eq!(c.available, None);
        assert!(c.message.contains("0.2.0"));
    }
}
