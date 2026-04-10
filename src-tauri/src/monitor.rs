// monitor.rs — System stats poller for the Wallace dashboard
// Polls CPU + memory every second and fires "system-stats" events at the frontend.
// Task 13: also tracks CWD + git branch/status, emits "cwd-changed".

use serde::Serialize;
use sysinfo::System;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct SystemStats {
    pub cpu_percent: f32,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
}

#[derive(Serialize, Clone)]
pub struct CwdInfo {
    pub path: String,
    pub git_branch: Option<String>,
    pub git_status: Option<String>,
}

/// Runs git rev-parse + git status --porcelain in the given directory.
/// Returns (branch, status_string) — status is "[+N ~M]" or None if clean / not a git repo.
fn get_git_info(path: &str) -> (Option<String>, Option<String>) {
    let branch = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if branch.is_none() {
        return (None, None);
    }

    let status_raw = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();

    let mut new_count: u32 = 0;
    let mut modified_count: u32 = 0;

    for line in status_raw.lines() {
        if line.len() < 2 { continue; }
        if &line[..2] == "??" {
            new_count += 1;
        } else {
            // any staged or unstaged change counts as modified
            let x = &line[0..1];
            let y = &line[1..2];
            if x != " " && x != "?" { modified_count += 1; }
            if y != " " && y != "?" { modified_count += 1; }
        }
    }

    let status_str = if new_count == 0 && modified_count == 0 {
        None
    } else {
        let mut parts = Vec::new();
        if new_count > 0    { parts.push(format!("+{new_count}")); }
        if modified_count > 0 { parts.push(format!("~{modified_count}")); }
        Some(format!("[{}]", parts.join(" ")))
    };

    (branch, status_str)
}

/// Gets the current working directory, replacing home dir with ~.
fn get_cwd_info() -> CwdInfo {
    let raw_path = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "?".to_string());

    // Replace home dir prefix with ~
    let home = std::env::var("HOME").unwrap_or_default();
    let display_path = if !home.is_empty() && raw_path.starts_with(&home) {
        format!("~{}", &raw_path[home.len()..])
    } else {
        raw_path.clone()
    };

    // Only try git if the path actually exists
    let (git_branch, git_status) = if Path::new(&raw_path).exists() {
        get_git_info(&raw_path)
    } else {
        (None, None)
    };

    CwdInfo {
        path: display_path,
        git_branch,
        git_status,
    }
}

/// Spawn a background thread that polls CPU and memory every second.
/// Emits `"system-stats"` events that the frontend consumes for the
/// dashboard top bar (CPU %, MEM xG) and waveform speed.
/// Also emits `"cwd-changed"` with current directory and git info.
pub fn start_monitor(app: AppHandle) {
    thread::spawn(move || {
        let mut sys = System::new_all();

        loop {
            // First refresh — seeds the CPU deltas
            sys.refresh_cpu_usage();
            thread::sleep(Duration::from_secs(1));

            // Second refresh — now CPU % values are accurate
            sys.refresh_cpu_usage();
            sys.refresh_memory();

            // Average across all logical CPUs
            let cpus = sys.cpus();
            let cpu_percent = if cpus.is_empty() {
                0.0
            } else {
                cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
            };

            let mem_used_gb  = sys.used_memory()  as f32 / 1_073_741_824.0;
            let mem_total_gb = sys.total_memory() as f32 / 1_073_741_824.0;

            let stats = SystemStats {
                cpu_percent,
                mem_used_gb,
                mem_total_gb,
            };

            // Fire and forget — if the window closed we'll catch it next loop
            let _ = app.emit("system-stats", &stats);

            // CWD + git info — also fire and forget
            let cwd_info = get_cwd_info();
            let _ = app.emit("cwd-changed", &cwd_info);
        }
    });
}
