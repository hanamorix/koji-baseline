// openai_compat.rs — OpenAI-compatible API client
// Handles Together.ai, Groq, Fireworks.ai — same /v1/chat/completions endpoint.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallResponse {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<OpenAIChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDefinition>>,
}

#[derive(Deserialize)]
struct StreamChunkResponse {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<DeltaContent>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct DeltaContent {
    content: Option<String>,
    tool_calls: Option<Vec<DeltaToolCall>>,
}

#[derive(Deserialize)]
struct DeltaToolCall {
    #[allow(dead_code)]
    index: Option<usize>,
    id: Option<String>,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    call_type: Option<String>,
    function: Option<DeltaFunction>,
}

#[derive(Deserialize)]
struct DeltaFunction {
    name: Option<String>,
    arguments: Option<String>,
}

/// Chunk emitted to the frontend for OpenAI-compatible streaming.
#[derive(Debug, Clone, Serialize)]
pub struct OpenAIChunk {
    pub chunk_type: String, // "text", "tool_call", "done", "error"
    pub content: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_arguments: Option<String>,
}

pub struct OpenAICompatClient {
    client: reqwest::Client,
}

impl OpenAICompatClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// Stream a chat completion from an OpenAI-compatible endpoint.
    /// Emits "openai-chunk" events to the frontend.
    pub async fn chat_stream(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        messages: Vec<OpenAIChatMessage>,
        tools: Option<Vec<ToolDefinition>>,
        app: &AppHandle,
    ) -> Result<(), String> {
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let body = ChatCompletionRequest {
            model: model.to_string(),
            messages,
            stream: true,
            tools,
        };

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenAI-compat request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            return Err(format!("OpenAI-compat returned HTTP {status}: {body_text}"));
        }

        let mut stream = response.bytes_stream();
        let mut line_buf = String::new();

        // Accumulate tool call arguments across multiple delta chunks
        let mut tool_call_id = String::new();
        let mut tool_call_name = String::new();
        let mut tool_call_args = String::new();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Stream read error: {e}"))?;
            let text = std::str::from_utf8(&chunk)
                .map_err(|e| format!("UTF-8 decode error: {e}"))?;

            for ch in text.chars() {
                if ch == '\n' {
                    let trimmed = line_buf.trim();
                    if trimmed.starts_with("data: ") {
                        let json_str = &trimmed[6..];
                        if json_str == "[DONE]" {
                            // Flush any pending tool call
                            if !tool_call_id.is_empty() {
                                let _ = app.emit("openai-chunk", OpenAIChunk {
                                    chunk_type: "tool_call".to_string(),
                                    content: None,
                                    tool_call_id: Some(tool_call_id.clone()),
                                    tool_name: Some(tool_call_name.clone()),
                                    tool_arguments: Some(tool_call_args.clone()),
                                });
                                tool_call_id.clear();
                                tool_call_name.clear();
                                tool_call_args.clear();
                            }
                            let _ = app.emit("openai-chunk", OpenAIChunk {
                                chunk_type: "done".to_string(),
                                content: None,
                                tool_call_id: None,
                                tool_name: None,
                                tool_arguments: None,
                            });
                        } else if let Ok(parsed) = serde_json::from_str::<StreamChunkResponse>(json_str) {
                            for choice in &parsed.choices {
                                if let Some(delta) = &choice.delta {
                                    // Text content
                                    if let Some(content) = &delta.content {
                                        let _ = app.emit("openai-chunk", OpenAIChunk {
                                            chunk_type: "text".to_string(),
                                            content: Some(content.clone()),
                                            tool_call_id: None,
                                            tool_name: None,
                                            tool_arguments: None,
                                        });
                                    }
                                    // Tool calls (streamed incrementally)
                                    if let Some(tool_calls) = &delta.tool_calls {
                                        for tc in tool_calls {
                                            if let Some(id) = &tc.id {
                                                // New tool call starting — flush previous if any
                                                if !tool_call_id.is_empty() {
                                                    let _ = app.emit("openai-chunk", OpenAIChunk {
                                                        chunk_type: "tool_call".to_string(),
                                                        content: None,
                                                        tool_call_id: Some(tool_call_id.clone()),
                                                        tool_name: Some(tool_call_name.clone()),
                                                        tool_arguments: Some(tool_call_args.clone()),
                                                    });
                                                    tool_call_args.clear();
                                                }
                                                tool_call_id = id.clone();
                                            }
                                            if let Some(func) = &tc.function {
                                                if let Some(name) = &func.name {
                                                    tool_call_name = name.clone();
                                                }
                                                if let Some(args) = &func.arguments {
                                                    tool_call_args.push_str(args);
                                                }
                                            }
                                        }
                                    }
                                }
                                // Check finish_reason for tool_calls
                                if choice.finish_reason.as_deref() == Some("tool_calls") {
                                    if !tool_call_id.is_empty() {
                                        let _ = app.emit("openai-chunk", OpenAIChunk {
                                            chunk_type: "tool_call".to_string(),
                                            content: None,
                                            tool_call_id: Some(tool_call_id.clone()),
                                            tool_name: Some(tool_call_name.clone()),
                                            tool_arguments: Some(tool_call_args.clone()),
                                        });
                                        tool_call_id.clear();
                                        tool_call_name.clear();
                                        tool_call_args.clear();
                                    }
                                }
                            }
                        }
                    }
                    line_buf.clear();
                } else {
                    line_buf.push(ch);
                }
            }
        }

        Ok(())
    }

    /// List models from an OpenAI-compatible /v1/models endpoint.
    pub async fn list_models(
        &self,
        base_url: &str,
        api_key: &str,
    ) -> Result<Vec<String>, String> {
        let url = format!("{}/models", base_url.trim_end_matches('/'));
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("Models request failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Models returned HTTP {}", resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("JSON parse error: {e}"))?;

        let models = body["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["id"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }
}
