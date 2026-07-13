use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Runtime;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::sync::{mpsc, oneshot};

const PROTOCOL_VERSION: u32 = 1;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeHealth {
    pub service: String,
    pub engine_version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolResponse<T> {
    version: u32,
    request_id: String,
    result: Option<T>,
    error: Option<ProtocolError>,
}

#[derive(Debug, Deserialize)]
struct ProtocolError {
    code: String,
    message: String,
}

struct PendingRequest {
    line: String,
    response: oneshot::Sender<Result<String, String>>,
}

pub struct NativeBridge {
    requests: Option<mpsc::Sender<PendingRequest>>,
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

        let (requests, receiver) = mpsc::channel(16);
        tauri::async_runtime::spawn(run_sidecar_driver(receiver, events, child));

        Self {
            requests: Some(requests),
            startup_error: None,
        }
    }

    /// Starts the same bridge against an explicit executable. This keeps the
    /// integration smoke test on the production protocol and command path.
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
        let (requests, mut receiver) = mpsc::channel::<PendingRequest>(16);

        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Some(pending) = receiver.blocking_recv() {
                let write_result = writeln!(stdin, "{}", pending.line).and_then(|_| stdin.flush());
                if let Err(error) = write_result {
                    let _ = pending
                        .response
                        .send(Err(format!("Could not write to native engine: {error}")));
                    break;
                }

                let mut response = String::new();
                match reader.read_line(&mut response) {
                    Ok(0) => {
                        let _ = pending.response.send(Err("Native engine exited".into()));
                        break;
                    }
                    Ok(_) => {
                        let _ = pending.response.send(Ok(response.trim_end().to_owned()));
                    }
                    Err(error) => {
                        let _ = pending.response.send(Err(format!(
                            "Could not read native engine response: {error}"
                        )));
                        break;
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        });

        Self {
            requests: Some(requests),
            startup_error: None,
        }
    }

    fn unavailable(message: String) -> Self {
        Self {
            requests: None,
            startup_error: Some(message),
        }
    }

    pub async fn health(&self) -> Result<NativeHealth, String> {
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }

        let request_id = format!("health-{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
        let line = json!({
            "version": PROTOCOL_VERSION,
            "requestId": request_id,
            "method": "health",
            "params": {},
        })
        .to_string();

        let (response_sender, response_receiver) = oneshot::channel();
        self.requests
            .as_ref()
            .ok_or_else(|| "Native engine is unavailable".to_owned())?
            .send(PendingRequest {
                line,
                response: response_sender,
            })
            .await
            .map_err(|_| "Native engine request channel closed".to_owned())?;

        let raw_response = tokio::time::timeout(RESPONSE_TIMEOUT, response_receiver)
            .await
            .map_err(|_| "Native engine health request timed out".to_owned())?
            .map_err(|_| "Native engine response channel closed".to_owned())??;

        decode_health_response(&request_id, &raw_response)
    }
}

fn decode_health_response(request_id: &str, raw: &str) -> Result<NativeHealth, String> {
    let response: ProtocolResponse<NativeHealth> = serde_json::from_str(raw)
        .map_err(|error| format!("Native engine returned invalid JSON: {error}"))?;

    if response.version != PROTOCOL_VERSION {
        return Err(format!(
            "Native engine returned protocol version {}",
            response.version
        ));
    }
    if response.request_id != request_id {
        return Err("Native engine returned a mismatched request ID".into());
    }

    match (response.result, response.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(format!("{}: {}", error.code, error.message)),
        _ => Err("Native engine returned an invalid response envelope".into()),
    }
}

async fn run_sidecar_driver(
    mut requests: mpsc::Receiver<PendingRequest>,
    mut events: mpsc::Receiver<CommandEvent>,
    mut child: tauri_plugin_shell::process::CommandChild,
) {
    while let Some(pending) = requests.recv().await {
        let payload = format!("{}\n", pending.line);
        if let Err(error) = child.write(payload.as_bytes()) {
            let _ = pending
                .response
                .send(Err(format!("Could not write to native engine: {error}")));
            break;
        }

        loop {
            match events.recv().await {
                Some(CommandEvent::Stdout(bytes)) => {
                    let line = String::from_utf8_lossy(&bytes).trim_end().to_owned();
                    let _ = pending.response.send(Ok(line));
                    break;
                }
                Some(CommandEvent::Stderr(_)) => continue,
                Some(CommandEvent::Error(message)) => {
                    let _ = pending
                        .response
                        .send(Err(format!("Native engine error: {message}")));
                    return;
                }
                Some(CommandEvent::Terminated(_)) | None => {
                    let _ = pending.response.send(Err("Native engine exited".into()));
                    return;
                }
                _ => continue,
            }
        }
    }

    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_typed_success_envelope() {
        let health = decode_health_response(
            "health-7",
            r#"{"version":1,"requestId":"health-7","result":{"service":"keyfinder-native","engineVersion":"0.1.0","protocolVersion":1}}"#,
        )
        .expect("response should decode");

        assert_eq!(health.service, "keyfinder-native");
        assert_eq!(health.engine_version, "0.1.0");
        assert_eq!(health.protocol_version, 1);
    }

    #[test]
    fn rejects_mixed_result_and_error_envelopes() {
        let result = decode_health_response(
            "health-8",
            r#"{"version":1,"requestId":"health-8","result":{"service":"keyfinder-native","engineVersion":"0.1.0","protocolVersion":1},"error":{"code":"BAD","message":"bad"}}"#,
        );

        assert_eq!(
            result.expect_err("mixed envelope must fail"),
            "Native engine returned an invalid response envelope"
        );
    }
}
