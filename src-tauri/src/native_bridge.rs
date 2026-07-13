use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Runtime};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::sync::{mpsc, oneshot};

const PROTOCOL_VERSION: u32 = 1;
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

type PendingSender = oneshot::Sender<Result<Value, String>>;
type PendingMap = Arc<Mutex<HashMap<String, PendingSender>>>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeHealth {
    pub service: String,
    pub engine_version: String,
    pub protocol_version: u32,
}

pub struct NativeBridge {
    requests: Option<mpsc::Sender<String>>,
    pending: PendingMap,
    startup_error: Option<String>,
}

impl NativeBridge {
    pub fn launch_sidecar<R: Runtime>(app: &tauri::AppHandle<R>) -> Self {
        let command = match app.shell().sidecar("keyfinder-native") {
            Ok(command) => command,
            Err(error) => {
                return Self::unavailable(format!("Could not resolve native engine: {error}"));
            }
        };
        let (events, child) = match command.spawn() {
            Ok(process) => process,
            Err(error) => {
                return Self::unavailable(format!("Could not start native engine: {error}"));
            }
        };

        let pending = PendingMap::default();
        let (requests, receiver) = mpsc::channel(32);
        tauri::async_runtime::spawn(run_sidecar_writer(receiver, child, pending.clone()));

        let pending_for_reader = pending.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_sidecar_reader(events, pending_for_reader, move |event| {
                let _ = app.emit("native-event", event);
            })
            .await;
        });

        Self {
            requests: Some(requests),
            pending,
            startup_error: None,
        }
    }

    /// Starts the same request router against an explicit executable so the
    /// integration suite exercises the production protocol contract.
    pub fn launch_executable(path: &Path) -> Self {
        let mut child = match Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                return Self::unavailable(format!("Could not start native engine: {error}"));
            }
        };
        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => return Self::unavailable("Native engine stdin is unavailable".into()),
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => return Self::unavailable("Native engine stdout is unavailable".into()),
        };

        let pending = PendingMap::default();
        let (requests, mut receiver) = mpsc::channel::<String>(32);
        let pending_for_thread = pending.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let Some(line) = receiver.blocking_recv() else {
                    break;
                };
                if writeln!(stdin, "{line}")
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    fail_all(&pending_for_thread, "Could not write to native engine");
                    break;
                }

                // A command may be preceded by asynchronous job events, so
                // continue reading until its direct response has been routed.
                while has_pending(&pending_for_thread) {
                    let mut response = String::new();
                    match reader.read_line(&mut response) {
                        Ok(0) => {
                            fail_all(&pending_for_thread, "Native engine exited");
                            break;
                        }
                        Ok(_) => route_message(response.trim_end(), &pending_for_thread, |_| {}),
                        Err(error) => {
                            fail_all(
                                &pending_for_thread,
                                &format!("Could not read native engine response: {error}"),
                            );
                            break;
                        }
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        });

        Self {
            requests: Some(requests),
            pending,
            startup_error: None,
        }
    }

    fn unavailable(message: String) -> Self {
        Self {
            requests: None,
            pending: PendingMap::default(),
            startup_error: Some(message),
        }
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }

        let request_id = format!(
            "request-{}",
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        let line = json!({
            "version": PROTOCOL_VERSION,
            "requestId": request_id,
            "method": method,
            "params": params,
        })
        .to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Native response router is unavailable".to_owned())?
            .insert(request_id.clone(), sender);

        if self
            .requests
            .as_ref()
            .ok_or_else(|| "Native engine is unavailable".to_owned())?
            .send(line)
            .await
            .is_err()
        {
            remove_pending(&self.pending, &request_id);
            return Err("Native engine request channel closed".into());
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err("Native engine response channel closed".into()),
            Err(_) => {
                remove_pending(&self.pending, &request_id);
                Err(format!("Native engine {method} request timed out"))
            }
        }
    }

    pub async fn health(&self) -> Result<NativeHealth, String> {
        let value = self
            .call("health", json!({}), Duration::from_secs(5))
            .await?;
        serde_json::from_value(value)
            .map_err(|error| format!("Native health response is invalid: {error}"))
    }
}

async fn run_sidecar_writer(
    mut requests: mpsc::Receiver<String>,
    mut child: tauri_plugin_shell::process::CommandChild,
    pending: PendingMap,
) {
    while let Some(line) = requests.recv().await {
        if let Err(error) = child.write(format!("{line}\n").as_bytes()) {
            fail_all(
                &pending,
                &format!("Could not write to native engine: {error}"),
            );
            break;
        }
    }
    let _ = child.kill();
}

async fn run_sidecar_reader(
    mut events: mpsc::Receiver<CommandEvent>,
    pending: PendingMap,
    mut emit_event: impl FnMut(Value),
) {
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                for line in String::from_utf8_lossy(&bytes).lines() {
                    route_message(line, &pending, &mut emit_event);
                }
            }
            CommandEvent::Error(message) => {
                fail_all(&pending, &format!("Native engine error: {message}"));
                return;
            }
            CommandEvent::Terminated(_) => {
                fail_all(&pending, "Native engine exited");
                return;
            }
            _ => {}
        }
    }
    fail_all(&pending, "Native engine event channel closed");
}

fn route_message(raw: &str, pending: &PendingMap, mut emit_event: impl FnMut(Value)) {
    let message: Value = match serde_json::from_str(raw) {
        Ok(message) => message,
        Err(error) => {
            fail_all(
                pending,
                &format!("Native engine returned invalid JSON: {error}"),
            );
            return;
        }
    };

    if let Some(request_id) = message.get("requestId").and_then(Value::as_str) {
        let sender = pending
            .lock()
            .ok()
            .and_then(|mut requests| requests.remove(request_id));
        if let Some(sender) = sender {
            let result = decode_envelope(&message, request_id);
            let _ = sender.send(result);
        }
    } else if message.get("event").and_then(Value::as_str).is_some() {
        emit_event(message);
    }
}

fn decode_envelope(message: &Value, request_id: &str) -> Result<Value, String> {
    if message.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION.into()) {
        return Err("Native engine returned an unsupported protocol version".into());
    }
    if message.get("requestId").and_then(Value::as_str) != Some(request_id) {
        return Err("Native engine returned a mismatched request ID".into());
    }
    match (message.get("result"), message.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => Err(format!(
            "{}: {}",
            error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("NATIVE_ERROR"),
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The native engine reported an error")
        )),
        _ => Err("Native engine returned an invalid response envelope".into()),
    }
}

fn remove_pending(pending: &PendingMap, request_id: &str) {
    if let Ok(mut requests) = pending.lock() {
        requests.remove(request_id);
    }
}

fn has_pending(pending: &PendingMap) -> bool {
    pending
        .lock()
        .map(|requests| !requests.is_empty())
        .unwrap_or(false)
}

fn fail_all(pending: &PendingMap, message: &str) {
    let senders = pending
        .lock()
        .map(|mut requests| {
            requests
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(Err(message.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_typed_success_envelope() {
        let response = json!({
            "version": 1,
            "requestId": "request-7",
            "result": {"service": "keyfinder-native", "engineVersion": "0.1.0", "protocolVersion": 1}
        });
        let result = decode_envelope(&response, "request-7").expect("response should decode");
        let health: NativeHealth = serde_json::from_value(result).expect("health should be typed");
        assert_eq!(health.service, "keyfinder-native");
    }

    #[test]
    fn rejects_mixed_result_and_error_envelopes() {
        let response = json!({
            "version": 1,
            "requestId": "request-8",
            "result": {},
            "error": {"code": "BAD", "message": "bad"}
        });
        assert_eq!(
            decode_envelope(&response, "request-8").expect_err("mixed envelope must fail"),
            "Native engine returned an invalid response envelope"
        );
    }
}
