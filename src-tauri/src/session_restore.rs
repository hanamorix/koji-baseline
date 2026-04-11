// session_restore.rs — Save and restore terminal sessions across app restarts

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub tabs: Vec<SavedTab>,
    pub active_tab_index: usize,
    pub window_width: f64,
    pub window_height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTab {
    pub name: String,
    pub panes: Vec<SavedPane>,
    pub layout: SavedLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPane {
    pub cwd: String,
    pub scrollback: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SavedLayout {
    Leaf { pane_index: usize },
    Branch {
        direction: String,
        ratio: f64,
        first: Box<SavedLayout>,
        second: Box<SavedLayout>,
    },
}

fn session_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".koji-baseline")
        .join("session.json")
}

pub fn save(session: &SavedSession) -> Result<(), String> {
    let path = session_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Serialize failed: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write failed: {e}"))
}

pub fn load() -> Option<SavedSession> {
    let path = session_path();
    if !path.exists() { return None; }
    let data = std::fs::read_to_string(&path).ok()?;
    let session: SavedSession = serde_json::from_str(&data).ok()?;
    // Delete after reading — single-use restore
    let _ = std::fs::remove_file(&path);
    Some(session)
}

pub fn clear() {
    let _ = std::fs::remove_file(session_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session() -> SavedSession {
        SavedSession {
            tabs: vec![SavedTab {
                name: "main".into(),
                panes: vec![SavedPane {
                    cwd: "/tmp".into(),
                    scrollback: vec!["$ echo hello".into()],
                }],
                layout: SavedLayout::Leaf { pane_index: 0 },
            }],
            active_tab_index: 0,
            window_width: 1200.0,
            window_height: 800.0,
        }
    }

    /// Save/load/clear helpers that operate on an isolated temp path per test.
    fn save_to(path: &PathBuf, session: &SavedSession) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
        }
        let json = serde_json::to_string_pretty(session)
            .map_err(|e| format!("Serialize failed: {e}"))?;
        std::fs::write(path, json).map_err(|e| format!("Write failed: {e}"))
    }

    fn load_from(path: &PathBuf) -> Option<SavedSession> {
        if !path.exists() { return None; }
        let data = std::fs::read_to_string(path).ok()?;
        let session: SavedSession = serde_json::from_str(&data).ok()?;
        let _ = std::fs::remove_file(path);
        Some(session)
    }

    fn clear_at(path: &PathBuf) {
        let _ = std::fs::remove_file(path);
    }

    fn temp_session_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("koji-test-{name}-session.json"))
    }

    #[test]
    fn save_and_load_round_trip() {
        let path = temp_session_path("roundtrip");
        let _ = std::fs::remove_file(&path);

        let session = test_session();
        save_to(&path, &session).expect("save should succeed");
        assert!(path.exists(), "session.json should exist after save");

        let loaded = load_from(&path).expect("load should return Some");
        assert_eq!(loaded.tabs.len(), 1);
        assert_eq!(loaded.tabs[0].name, "main");
        assert_eq!(loaded.tabs[0].panes[0].cwd, "/tmp");
        assert_eq!(loaded.active_tab_index, 0);

        // File should be deleted after load (single-use)
        assert!(!path.exists(), "session.json should be deleted after load");
    }

    #[test]
    fn load_returns_none_when_no_file() {
        let path = temp_session_path("nofile");
        let _ = std::fs::remove_file(&path);
        assert!(load_from(&path).is_none());
    }

    #[test]
    fn clear_removes_file() {
        let path = temp_session_path("clear");
        let session = test_session();
        save_to(&path, &session).expect("save should succeed");
        assert!(path.exists());

        clear_at(&path);
        assert!(!path.exists());
    }

    #[test]
    fn clear_is_noop_when_no_file() {
        let path = temp_session_path("clearnoop");
        let _ = std::fs::remove_file(&path);
        clear_at(&path); // Should not panic
    }

    #[test]
    fn branch_layout_serializes() {
        let path = temp_session_path("branch");
        let _ = std::fs::remove_file(&path);

        let session = SavedSession {
            tabs: vec![SavedTab {
                name: "split".into(),
                panes: vec![
                    SavedPane { cwd: "/home".into(), scrollback: vec![] },
                    SavedPane { cwd: "/tmp".into(), scrollback: vec![] },
                ],
                layout: SavedLayout::Branch {
                    direction: "horizontal".into(),
                    ratio: 0.5,
                    first: Box::new(SavedLayout::Leaf { pane_index: 0 }),
                    second: Box::new(SavedLayout::Leaf { pane_index: 1 }),
                },
            }],
            active_tab_index: 0,
            window_width: 1920.0,
            window_height: 1080.0,
        };
        save_to(&path, &session).expect("save branch layout");
        let loaded = load_from(&path).expect("load branch layout");
        assert_eq!(loaded.tabs[0].panes.len(), 2);
        match &loaded.tabs[0].layout {
            SavedLayout::Branch { direction, ratio, .. } => {
                assert_eq!(direction, "horizontal");
                assert!((ratio - 0.5).abs() < f64::EPSILON);
            }
            _ => panic!("Expected Branch layout"),
        }
    }

    #[test]
    fn session_path_is_under_koji_baseline() {
        let path = session_path();
        assert!(path.to_string_lossy().contains(".koji-baseline"));
        assert!(path.to_string_lossy().ends_with("session.json"));
    }
}
