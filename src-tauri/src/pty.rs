// pty.rs — PTY Manager: spawn a shell, pipe I/O like a feral systems engineer
// no hand-holding, no apologies. just raw bytes and a very patient zsh.

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct PtyManager {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    master_writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master_reader: Arc<Mutex<Box<dyn Read + Send>>>,
}

impl PtyManager {
    /// Spawn a shell in a fresh PTY. rows/cols configurable, TERM set, slave dropped post-spawn.
    /// Optional cwd sets the initial working directory (tilde-expanded).
    pub fn new(rows: u16, cols: u16, cwd: Option<&str>) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
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
        // Spawn as login + interactive shell so ~/.zshrc, ~/.zprofile, etc. are sourced.
        // This ensures PATH includes user-installed tools (claude, node, cargo, etc.)
        cmd.arg("-l");
        cmd.arg("-i");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Inherit user environment but strip sensitive vars that shouldn't leak into shells.
        // The blocklist covers common credential/token env vars.
        const SENSITIVE_PREFIXES: &[&str] = &[
            "AWS_SECRET", "AWS_SESSION_TOKEN",
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
            "GITHUB_TOKEN", "GH_TOKEN",
            "NPM_TOKEN", "NODE_AUTH_TOKEN",
            "DOCKER_PASSWORD",
            "SECRET_", "PRIVATE_KEY",
        ];
        for (key, value) in std::env::vars() {
            if key == "TERM" || key == "COLORTERM" {
                continue; // Already set above
            }
            let dominated = SENSITIVE_PREFIXES.iter().any(|p| key.starts_with(p));
            if !dominated {
                cmd.env(&key, &value);
            }
        }

        // Shell integration injection — OSC 7/133 scripts for zsh/bash/fish
        if let Some(si_dir) = Self::shell_integration_dir() {
            let si_str = si_dir.to_string_lossy().to_string();
            cmd.env("KOJI_SHELL_INTEGRATION", "1");
            cmd.env("KOJI_SHELL_INTEGRATION_DIR", &si_str);
            cmd.env("TERM_PROGRAM", "koji-baseline");
            cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

            if shell.ends_with("/zsh") || shell.ends_with("/zsh5") || shell == "zsh" {
                // Redirect ZDOTDIR so our .zshenv loads first, then chains the real one
                let orig = std::env::var("ZDOTDIR").unwrap_or_default();
                cmd.env("KOJI_ORIG_ZDOTDIR", if orig.is_empty() {
                    std::env::var("HOME").unwrap_or_default()
                } else {
                    orig
                });
                cmd.env("ZDOTDIR", si_dir.join("zdotdir").to_string_lossy().as_ref());
            } else if shell.ends_with("/bash") || shell == "bash" {
                // Bash: add --rcfile so our wrapper sources ~/.bashrc then koji.bash.
                // -l (already set) coexists fine — it sets login context while --rcfile
                // overrides which startup file gets sourced.
                cmd.arg("--rcfile");
                cmd.arg(si_dir.join("bash-wrapper.sh").to_string_lossy().as_ref());
            } else if shell.ends_with("/fish") || shell == "fish" {
                // Fish: prepend our vendor dir so koji.fish auto-loads
                let xdg = std::env::var("XDG_DATA_DIRS")
                    .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
                let fish_vendor = si_dir.join("fish-vendor");
                cmd.env("XDG_DATA_DIRS", format!("{}:{}", fish_vendor.to_string_lossy(), xdg));
            }
        }

        // Set CWD if provided — expand tilde, verify it exists
        if let Some(dir) = cwd {
            let expanded = if dir.starts_with("~/") {
                if let Some(home) = dirs::home_dir() {
                    home.join(&dir[2..])
                } else {
                    PathBuf::from(dir)
                }
            } else {
                PathBuf::from(dir)
            };
            if expanded.is_dir() {
                cmd.cwd(&expanded);
            }
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

    /// Locate the shell-integration scripts directory.
    /// Returns None if the user disabled integration via config, or if no scripts found.
    fn shell_integration_dir() -> Option<PathBuf> {
        // Check TOML config — user can opt out with shell_integration = false
        let config = crate::config::load();
        if !config.terminal.shell_integration {
            return None;
        }

        // Dev mode: resources dir next to Cargo.toml
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let dev = PathBuf::from(manifest)
                .parent()
                .map(|p| p.join("resources").join("shell-integration"))
                .unwrap_or_default();
            if dev.is_dir() {
                return Some(dev);
            }
        }

        // Production: macOS app bundle — <exe>/../../Resources/shell-integration/
        if let Ok(exe) = std::env::current_exe() {
            if let Some(bundle) = exe.parent().and_then(|p| p.parent()).map(|p| {
                p.join("Resources").join("shell-integration")
            }) {
                if bundle.is_dir() {
                    return Some(bundle);
                }
            }
        }

        None
    }
}
