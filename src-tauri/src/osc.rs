// osc.rs — Stateless OSC byte scanner for PTY output
// Extracts OSC 7 (working directory) and OSC 133 (semantic zones) that
// alacritty_terminal silently ignores. Read-only — never modifies the buffer.

use serde::Serialize;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum OscEventKind {
    WorkingDirectory(String),
    PromptStart,
    InputStart,
    OutputStart,
    CommandEnd { exit_code: Option<i32> },
    SyncStart,
    SyncEnd,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OscEvent {
    pub kind: OscEventKind,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Scan raw PTY bytes for OSC 7 and OSC 133 sequences.
/// Returns all events found, in order. Empty vec for normal output.
pub fn scan_osc(bytes: &[u8]) -> Vec<OscEvent> {
    let mut events = Vec::new();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        // CSI ? 2026 h/l — synchronized update (DCS mode 2026)
        if bytes[i] == 0x1b && i + 7 < len
            && bytes[i + 1] == b'['
            && bytes[i + 2] == b'?'
            && bytes[i + 3] == b'2'
            && bytes[i + 4] == b'0'
            && bytes[i + 5] == b'2'
            && bytes[i + 6] == b'6'
        {
            if bytes[i + 7] == b'h' {
                events.push(OscEvent { kind: OscEventKind::SyncStart });
                i += 8;
                continue;
            }
            if bytes[i + 7] == b'l' {
                events.push(OscEvent { kind: OscEventKind::SyncEnd });
                i += 8;
                continue;
            }
        }

        // Look for ESC ] (0x1B 0x5D)
        if bytes[i] == 0x1B && i + 1 < len && bytes[i + 1] == 0x5D {
            if let Some((event, consumed)) = parse_osc(&bytes[i + 2..]) {
                events.push(event);
                i += 2 + consumed;
                continue;
            }
        }
        i += 1;
    }
    events
}

// ─── Internal parsers ────────────────────────────────────────────────────────

/// Parse the payload after ESC ]. Returns the event and number of bytes
/// consumed from `data` (including the terminator).
pub fn parse_osc(data: &[u8]) -> Option<(OscEvent, usize)> {
    // Find terminator: BEL (0x07) or ST (ESC \)
    let (payload_end, terminator_len) = find_terminator(data)?;
    let payload = &data[..payload_end];
    let consumed = payload_end + terminator_len;

    // Try to interpret as UTF-8
    let text = std::str::from_utf8(payload).ok()?;

    // OSC 7 — working directory: "7;file://host/path"
    if let Some(url) = text.strip_prefix("7;") {
        let path = parse_file_url(url)?;
        return Some((OscEvent { kind: OscEventKind::WorkingDirectory(path) }, consumed));
    }

    // OSC 133 — semantic zones: "133;X" or "133;D;N"
    if let Some(rest) = text.strip_prefix("133;") {
        let kind = match rest {
            "A" => OscEventKind::PromptStart,
            "B" => OscEventKind::InputStart,
            "C" => OscEventKind::OutputStart,
            _ if rest.starts_with("D") => {
                let exit_code = rest.strip_prefix("D;")
                    .and_then(|s| s.parse::<i32>().ok());
                OscEventKind::CommandEnd { exit_code }
            }
            _ => return None,
        };
        return Some((OscEvent { kind }, consumed));
    }

    None
}

/// Find BEL (0x07) or ST (ESC \, i.e. 0x1B 0x5C) terminator.
/// Returns (payload_end_index, terminator_length).
fn find_terminator(data: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0x07 {
            return Some((i, 1));
        }
        if data[i] == 0x1B && i + 1 < data.len() && data[i + 1] == 0x5C {
            return Some((i, 2));
        }
        i += 1;
    }
    None // Truncated — no terminator found
}

/// Extract the path component from a file:// URL.
/// Accepts `file://hostname/path` and `file:///path` (empty host).
pub fn parse_file_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    // Skip hostname — everything from first `/` onward is the path
    let path_start = rest.find('/')?;
    let raw_path = &rest[path_start..];
    Some(percent_decode(raw_path))
}

/// Decode %XX hex sequences in a string.
pub fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // 1. OSC 7 with host
    #[test]
    fn test_scan_osc7_valid() {
        let input = b"\x1b]7;file://myhost/Users/hana/projects\x07";
        let events = scan_osc(input);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            OscEventKind::WorkingDirectory("/Users/hana/projects".to_string())
        );
    }

    // 2. OSC 7 with empty host (file:///tmp)
    #[test]
    fn test_scan_osc7_no_host() {
        let input = b"\x1b]7;file:///tmp\x07";
        let events = scan_osc(input);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            OscEventKind::WorkingDirectory("/tmp".to_string())
        );
    }

    // 3. Percent-encoded spaces
    #[test]
    fn test_scan_osc7_spaces_in_path() {
        let input = b"\x1b]7;file://host/Users/hana/my%20project\x07";
        let events = scan_osc(input);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            OscEventKind::WorkingDirectory("/Users/hana/my project".to_string())
        );
    }

    // 4. Normal text — no OSC sequences
    #[test]
    fn test_scan_osc7_empty_buffer() {
        let input = b"just some normal terminal text\r\nwith newlines";
        let events = scan_osc(input);
        assert!(events.is_empty());
    }

    // 5. ST terminator (ESC \) instead of BEL
    #[test]
    fn test_scan_osc7_st_terminator() {
        let input = b"\x1b]7;file://host/Users/hana/code\x1b\\";
        let events = scan_osc(input);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            OscEventKind::WorkingDirectory("/Users/hana/code".to_string())
        );
    }

    // 6. All four OSC 133 markers in one buffer
    #[test]
    fn test_scan_osc133_all_markers() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x1b]133;A\x07");
        buf.extend_from_slice(b"\x1b]133;B\x07");
        buf.extend_from_slice(b"\x1b]133;C\x07");
        buf.extend_from_slice(b"\x1b]133;D;0\x07");
        let events = scan_osc(&buf);
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].kind, OscEventKind::PromptStart);
        assert_eq!(events[1].kind, OscEventKind::InputStart);
        assert_eq!(events[2].kind, OscEventKind::OutputStart);
        assert_eq!(events[3].kind, OscEventKind::CommandEnd { exit_code: Some(0) });
    }

    // 7. D marker with various exit codes
    #[test]
    fn test_scan_osc133_d_with_exit_codes() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x1b]133;D;1\x07");
        buf.extend_from_slice(b"\x1b]133;D;127\x07");
        let events = scan_osc(&buf);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, OscEventKind::CommandEnd { exit_code: Some(1) });
        assert_eq!(events[1].kind, OscEventKind::CommandEnd { exit_code: Some(127) });
    }

    // 8. D marker without exit code
    #[test]
    fn test_scan_osc133_d_without_exit_code() {
        let input = b"\x1b]133;D\x07";
        let events = scan_osc(input);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, OscEventKind::CommandEnd { exit_code: None });
    }

    // 9. Mixed: normal output interleaved with OSC sequences
    #[test]
    fn test_scan_mixed_osc() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"$ ls\r\n");
        buf.extend_from_slice(b"\x1b]133;A\x07");
        buf.extend_from_slice(b"file1.txt  file2.txt\r\n");
        buf.extend_from_slice(b"\x1b]133;B\x07");
        buf.extend_from_slice(b"more output here\r\n");
        buf.extend_from_slice(b"\x1b]7;file://localhost/Users/hana/projects\x07");
        let events = scan_osc(&buf);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, OscEventKind::PromptStart);
        assert_eq!(events[1].kind, OscEventKind::InputStart);
        assert_eq!(
            events[2].kind,
            OscEventKind::WorkingDirectory("/Users/hana/projects".to_string())
        );
    }

    // 10. Partial/truncated sequence — no terminator
    #[test]
    fn test_scan_osc_partial_sequence() {
        let input = b"\x1b]7;file://host/Users/hana/proj";
        let events = scan_osc(input);
        assert!(events.is_empty());
    }

    // 11. Typical ls output — no false positives
    #[test]
    fn test_scan_osc_in_normal_output() {
        let input = b"total 42\r\ndrwxr-xr-x  5 hana staff  160 Apr 10 12:00 .\r\n-rw-r--r--  1 hana staff 1234 Apr 10 11:59 Cargo.toml\r\n";
        let events = scan_osc(input);
        assert!(events.is_empty());
    }

    // 12. Malformed payload after ESC ] — no panic, no events
    #[test]
    fn test_scan_osc_malformed() {
        // Garbage that looks like it starts an OSC but has nonsense payload
        let input = b"\x1b]zzz;garbage\x07\x1b];\x07\x1b]\xff\x07";
        let events = scan_osc(input);
        assert!(events.is_empty());
    }

    // 13. DCS mode 2026 — synchronized update start + end
    #[test]
    fn test_scan_sync_start_end() {
        let bytes = b"\x1b[?2026h some content \x1b[?2026l";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, OscEventKind::SyncStart);
        assert_eq!(events[1].kind, OscEventKind::SyncEnd);
    }
}
