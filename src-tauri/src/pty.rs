// pty.rs — PTY Manager: spawn a shell, pipe I/O like a feral systems engineer
// no hand-holding, no apologies. just raw bytes and a very patient zsh.
// Task 14: master handle stored for resize — because windows change shape, deal with it.

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub struct PtyManager {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    master_writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master_reader: Arc<Mutex<Box<dyn Read + Send>>>,
}

impl PtyManager {
    /// Spawn a shell in a fresh PTY. rows/cols configurable, TERM set, slave dropped post-spawn.
    pub fn new(rows: u16, cols: u16) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pty_system = NativePtySystem::default();

        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        // Respect the user's shell. Fall back to zsh because we're on a Mac and have standards.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        // Inherit HOME, USER, PATH — the usual suspects
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        if let Ok(user) = std::env::var("USER") {
            cmd.env("USER", user);
        }
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }

        // Spawn on the slave side, then nuke the slave handle — master owns the session now
        let _child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        Ok(Self {
            master: Arc::new(Mutex::new(pair.master)),
            master_writer: Arc::new(Mutex::new(writer)),
            master_reader: Arc::new(Mutex::new(reader)),
        })
    }

    /// Write raw bytes into the shell's stdin. Keystrokes, escape sequences, whatever you got.
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut writer = self.master_writer.lock().unwrap();
        writer.write_all(data)
    }

    /// Resize the PTY — poke the kernel, signal the child. Called on window resize.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master = self.master.lock().unwrap();
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY resize failed: {e}"))
    }

    /// Hand off a clone of the reader Arc — caller spins an I/O thread with this.
    pub fn take_reader(&self) -> Arc<Mutex<Box<dyn Read + Send>>> {
        Arc::clone(&self.master_reader)
    }
}
