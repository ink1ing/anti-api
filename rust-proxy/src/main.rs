//! Anti-Proxy: Lightweight proxy for Google Cloud Code API
//!
//! CRITICAL DESIGN: This proxy does NOT retry 429 errors!
//! 429s must be handled by the TypeScript layer which can switch accounts.
//! This mimics proj-1's architecture where retry = account rotation.

use axum::{
    extract::{FromRequest, Json, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::sleep;
use tracing::{info, warn};

// ===== Configuration =====
const LISTEN_PORT: u16 = 8965;
const USER_AGENT: &str = "antigravity/1.11.9 windows/amd64";
const MIN_REQUEST_INTERVAL_MS: u64 = 500; // 500ms 最小间隔
const SIDECAR_TOKEN_ENV: &str = "ANTI_API_SIDECAR_TOKEN";
const SIDECAR_TOKEN_HEADER: &str = "x-anti-api-sidecar-token";

// API endpoints
const ENDPOINTS: [&str; 2] = [
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
];

// ===== State =====
struct AppState {
    http_client: reqwest::Client,
    last_request: Mutex<Option<Instant>>,
    request_semaphore: Semaphore,
    sidecar_token: String,
}

impl AppState {
    fn new(sidecar_token: String) -> Self {
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(600))
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent(USER_AGENT)
            .build()
            .expect("Failed to create HTTP client");

        Self {
            http_client,
            last_request: Mutex::new(None),
            request_semaphore: Semaphore::new(1),
            sidecar_token,
        }
    }

    async fn enforce_rate_limit(&self) {
        let mut last = self.last_request.lock().await;
        if let Some(last_time) = *last {
            let elapsed = last_time.elapsed();
            let min_interval = Duration::from_millis(MIN_REQUEST_INTERVAL_MS);
            if elapsed < min_interval {
                let wait_time = min_interval - elapsed;
                info!("⏱️ Rate limit: waiting {}ms", wait_time.as_millis());
                sleep(wait_time).await;
            }
        }
        *last = Some(Instant::now());
    }
}

// ===== Request/Response Types =====
#[derive(Debug, Deserialize)]
struct ProxyRequest {
    model: String,
    project: String,
    access_token: String,
    request: Value,
}

#[derive(Debug, Serialize)]
struct ProxyResponse {
    success: bool,
    data: Option<String>,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_code: Option<u16>,
}

fn constant_time_eq(expected: &[u8], provided: &[u8]) -> bool {
    let max_len = expected.len().max(provided.len());
    let mut difference = expected.len() ^ provided.len();

    for index in 0..max_len {
        let expected_byte = expected.get(index).copied().unwrap_or(0);
        let provided_byte = provided.get(index).copied().unwrap_or(0);
        difference |= usize::from(expected_byte ^ provided_byte);
    }

    difference == 0
}

fn has_valid_sidecar_token(headers: &HeaderMap, expected_token: &str) -> bool {
    headers
        .get(SIDECAR_TOKEN_HEADER)
        .map(|provided| constant_time_eq(expected_token.as_bytes(), provided.as_bytes()))
        .unwrap_or(false)
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ProxyResponse {
            success: false,
            data: None,
            error: Some("Unauthorized".to_string()),
            status_code: Some(StatusCode::UNAUTHORIZED.as_u16()),
        }),
    )
        .into_response()
}

// ===== Main Handler =====
async fn handle_proxy(State(state): State<Arc<AppState>>, request: Request) -> Response {
    // Authenticate from headers before the body (which contains access_token) is read or decoded.
    if !has_valid_sidecar_token(request.headers(), &state.sidecar_token) {
        return unauthorized_response();
    }

    let Json(req) = match Json::<ProxyRequest>::from_request(request, &state).await {
        Ok(request) => request,
        Err(rejection) => return rejection.into_response(),
    };

    // 获取信号量许可
    let _permit = state.request_semaphore.acquire().await.unwrap();
    info!("📨 Request acquired permit");

    // 强制执行速率限制
    state.enforce_rate_limit().await;

    // Build request body
    let body = json!({
        "model": req.model,
        "userAgent": "antigravity",
        "requestType": "agent",
        "project": req.project,
        "requestId": format!("agent-{}", uuid::Uuid::new_v4()),
        "request": req.request,
    });

    // 尝试两个端点，但不重试 429
    for (idx, endpoint) in ENDPOINTS.iter().enumerate() {
        info!(
            "[Endpoint {}/{}] Trying: {}",
            idx + 1,
            ENDPOINTS.len(),
            endpoint
        );

        let result = state
            .http_client
            .post(*endpoint)
            .header(header::CONTENT_TYPE, "application/json")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", req.access_token),
            )
            .header(header::ACCEPT, "text/event-stream")
            .json(&body)
            .send()
            .await;

        match result {
            Ok(response) => {
                let status = response.status();
                let status_code = status.as_u16();

                if status.is_success() {
                    info!("✓ Request successful");
                    let text = response.text().await.unwrap_or_default();
                    return (
                        StatusCode::OK,
                        Json(ProxyResponse {
                            success: true,
                            data: Some(text),
                            error: None,
                            status_code: None,
                        }),
                    )
                        .into_response();
                }

                let error_text = response.text().await.unwrap_or_default();

                match status_code {
                    // 429: 返回给 TypeScript 处理账号切换
                    429 => {
                        warn!("⚠️ 429 Rate limited - returning to TypeScript for account rotation");
                        return (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(ProxyResponse {
                                success: false,
                                data: None,
                                error: Some(error_text),
                                status_code: Some(429),
                            }),
                        )
                            .into_response();
                    }

                    // 400: 请求格式错误，不重试
                    400 => {
                        warn!("❌ Bad request (400)");
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(ProxyResponse {
                                success: false,
                                data: None,
                                error: Some(error_text),
                                status_code: Some(400),
                            }),
                        )
                            .into_response();
                    }

                    // 401/403: 认证错误，返回给 TypeScript
                    401 | 403 => {
                        warn!("❌ Auth error ({})", status_code);
                        return (
                            StatusCode::from_u16(status_code).unwrap_or(StatusCode::UNAUTHORIZED),
                            Json(ProxyResponse {
                                success: false,
                                data: None,
                                error: Some(error_text),
                                status_code: Some(status_code),
                            }),
                        )
                            .into_response();
                    }

                    // 5xx: 尝试下一个端点
                    _ if status.is_server_error() => {
                        warn!("Server error ({}), trying next endpoint", status_code);
                        continue;
                    }

                    // 其他错误
                    _ => {
                        return (
                            StatusCode::from_u16(status_code)
                                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                            Json(ProxyResponse {
                                success: false,
                                data: None,
                                error: Some(error_text),
                                status_code: Some(status_code),
                            }),
                        )
                            .into_response();
                    }
                }
            }
            Err(error) => {
                warn!("Network error: {}", error);
                continue; // Try next endpoint
            }
        }
    }

    // All endpoints failed
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ProxyResponse {
            success: false,
            data: None,
            error: Some("All endpoints failed".to_string()),
            status_code: Some(503),
        }),
    )
        .into_response()
}

// ===== Health Check =====
async fn health_check() -> &'static str {
    "OK"
}

// ===== Main =====
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let sidecar_token = std::env::var(SIDECAR_TOKEN_ENV)
        .ok()
        .filter(|token| !token.is_empty())
        .unwrap_or_else(|| panic!("{SIDECAR_TOKEN_ENV} must be set and non-empty"));
    let state = Arc::new(AppState::new(sidecar_token));

    let app = Router::new()
        .route("/proxy", post(handle_proxy))
        .route("/health", axum::routing::get(health_check))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", LISTEN_PORT);
    info!("🚀 Anti-Proxy starting on http://{}", addr);
    info!("📌 429 handling: Returns to TypeScript (no retry)");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn constant_time_comparison_accepts_only_identical_bytes() {
        assert!(constant_time_eq(b"same-token", b"same-token"));
        assert!(!constant_time_eq(b"same-token", b"same-tokem"));
        assert!(!constant_time_eq(b"same-token", b"same-token-longer"));
        assert!(!constant_time_eq(b"same-token", b"same"));
        assert!(!constant_time_eq(b"", b"non-empty"));
    }

    #[test]
    fn sidecar_auth_rejects_missing_and_incorrect_headers() {
        let mut headers = HeaderMap::new();
        assert!(!has_valid_sidecar_token(&headers, "expected-token"));

        headers.insert(
            SIDECAR_TOKEN_HEADER,
            HeaderValue::from_static("incorrect-token"),
        );
        assert!(!has_valid_sidecar_token(&headers, "expected-token"));

        headers.insert(
            SIDECAR_TOKEN_HEADER,
            HeaderValue::from_static("expected-token"),
        );
        assert!(has_valid_sidecar_token(&headers, "expected-token"));
    }
}
