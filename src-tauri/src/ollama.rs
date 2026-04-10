// ollama.rs — Streaming Ollama HTTP client
// Talks to localhost:11434, parses NDJSON chunks, fires events at the frontend.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ─── Public types (cross the IPC boundary) ────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmChunk {
    pub content: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaStatus {
    pub model: String,
    pub state: String, // "ready" | "generating" | "offline"
}

// ─── Private wire types ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

#[derive(Deserialize)]
struct ChatResponseChunk {
    message: Option<ChunkMessage>,
    done: bool,
}

#[derive(Deserialize)]
struct ChunkMessage {
    content: String,
}

// ─── OllamaClient ─────────────────────────────────────────────────────────────

pub struct OllamaClient {
    client: reqwest::Client,
    base_url: String,
    pub current_model: String,
}

impl OllamaClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: "http://localhost:11434".to_string(),
            current_model: "nell-dpo".to_string(),
        }
    }

    /// GET /api/tags — if we get any response the server is up, pick model state.
    pub async fn check_status(&self) -> OllamaStatus {
        let url = format!("{}/api/tags", self.base_url);
        match self.client.get(&url).send().await {
            Ok(_) => OllamaStatus {
                model: self.current_model.clone(),
                state: "ready".to_string(),
            },
            Err(_) => OllamaStatus {
                model: self.current_model.clone(),
                state: "offline".to_string(),
            },
        }
    }

    /// POST /api/chat with stream:true.
    /// Reads the NDJSON byte stream, fires "llm-chunk" and "llm-status" events.
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        app: &AppHandle,
    ) -> Result<(), String> {
        let url = format!("{}/api/chat", self.base_url);

        let body = ChatRequest {
            model: self.current_model.clone(),
            messages,
            stream: true,
        };

        // Signal generating state
        let _ = app.emit(
            "llm-status",
            OllamaStatus {
                model: self.current_model.clone(),
                state: "generating".to_string(),
            },
        );

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let _ = app.emit(
                "llm-status",
                OllamaStatus {
                    model: self.current_model.clone(),
                    state: "offline".to_string(),
                },
            );
            return Err(format!("Ollama returned HTTP {status}"));
        }

        let mut stream = response.bytes_stream();
        let mut line_buf = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Stream read error: {e}"))?;
            let text = std::str::from_utf8(&chunk)
                .map_err(|e| format!("UTF-8 decode error: {e}"))?;

            // Ollama streams one JSON object per line — accumulate across chunk boundaries
            for ch in text.chars() {
                if ch == '\n' {
                    let trimmed = line_buf.trim();
                    if !trimmed.is_empty() {
                        if let Ok(parsed) = serde_json::from_str::<ChatResponseChunk>(trimmed) {
                            let content = parsed
                                .message
                                .map(|m| m.content)
                                .unwrap_or_default();

                            let _ = app.emit(
                                "llm-chunk",
                                LlmChunk {
                                    content: content.clone(),
                                    done: parsed.done,
                                },
                            );

                            if parsed.done {
                                // Final chunk — flip back to ready
                                let _ = app.emit(
                                    "llm-status",
                                    OllamaStatus {
                                        model: self.current_model.clone(),
                                        state: "ready".to_string(),
                                    },
                                );
                            }
                        }
                    }
                    line_buf.clear();
                } else {
                    line_buf.push(ch);
                }
            }
        }

        // Drain any remaining partial line (shouldn't happen with well-formed stream)
        if !line_buf.trim().is_empty() {
            if let Ok(parsed) = serde_json::from_str::<ChatResponseChunk>(line_buf.trim()) {
                let content = parsed.message.map(|m| m.content).unwrap_or_default();
                let _ = app.emit(
                    "llm-chunk",
                    LlmChunk {
                        content,
                        done: true,
                    },
                );
            }
        }

        // Guarantee ready state is emitted even if `done` was missed
        let _ = app.emit(
            "llm-status",
            OllamaStatus {
                model: self.current_model.clone(),
                state: "ready".to_string(),
            },
        );

        Ok(())
    }

    pub fn set_model(&mut self, model: String) {
        self.current_model = model;
    }

    /// GET /api/tags — return a list of model names available in Ollama.
    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/api/tags", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Ollama request failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Ollama returned HTTP {}", resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("JSON parse error: {e}"))?;

        let models = body["models"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["name"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    /// POST /api/pull — pull a model by name. Blocks until done (stream:false).
    pub async fn pull_model(&self, model: String) -> Result<(), String> {
        let url = format!("{}/api/pull", self.base_url);
        let body = serde_json::json!({ "name": model, "stream": false });

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama pull request failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Ollama pull returned HTTP {}", resp.status()));
        }

        Ok(())
    }
}
