// monitor.rs — System stats poller for the Wallace dashboard
// Polls CPU + memory every second and fires "system-stats" events at the frontend.

use serde::Serialize;
use sysinfo::System;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct SystemStats {
    pub cpu_percent: f32,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
}

/// Spawn a background thread that polls CPU and memory every second.
/// Emits `"system-stats"` events that the frontend consumes for the
/// dashboard top bar (CPU %, MEM xG) and waveform speed.
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
        }
    });
}
