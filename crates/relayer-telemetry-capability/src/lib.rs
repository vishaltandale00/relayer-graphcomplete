use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    panic,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use url::Url;

const BOOTSTRAP_SCHEMA: &str = "relayer.authenticated-error-capability/v1";
const REPORT_PATH: &str = "/v1/authenticated-errors/report";
const MAX_BOOTSTRAP_BYTES: usize = 8 * 1024;
const MAX_MODULE_BYTES: usize = 256;
const IO_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilityBootstrap {
    schema: String,
    capability: Option<WireCapability>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCapability {
    endpoint: String,
    authorization: String,
}

#[derive(Clone)]
pub struct AuthenticatedErrorCapability {
    address: SocketAddr,
    authorization: String,
}

#[derive(Clone, Copy)]
pub struct PanicEventDefinition {
    pub code: &'static str,
    pub approved_module_prefix: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorRecord<'a> {
    code: &'a str,
    exception_class: Option<&'a str>,
    frames: Vec<ErrorFrame>,
}

#[derive(Serialize)]
struct ErrorFrame {
    module: String,
    line: u32,
    column: u32,
}

struct PendingErrorRecord {
    code: &'static str,
    frames: Vec<ErrorFrame>,
}

#[derive(Clone)]
pub struct PanicReporter {
    capability: Arc<RwLock<Option<AuthenticatedErrorCapability>>>,
    pending: Arc<Mutex<Option<PendingErrorRecord>>>,
}

pub fn read_capability_bootstrap(
    input: &mut impl BufRead,
) -> Result<Option<AuthenticatedErrorCapability>, String> {
    let line = read_bounded_line(input)
        .map_err(|_| "invalid authenticated-error capability bootstrap".to_owned())?;
    let bootstrap: CapabilityBootstrap = serde_json::from_slice(&line)
        .map_err(|_| "invalid authenticated-error capability bootstrap".to_owned())?;
    if bootstrap.schema != BOOTSTRAP_SCHEMA {
        return Err("invalid authenticated-error capability bootstrap".to_owned());
    }
    bootstrap.capability.map(validate_capability).transpose()
}

pub fn read_capability_update(
    input: &mut impl BufRead,
    reporter: &PanicReporter,
) -> Result<(), String> {
    let capability = read_capability_bootstrap(input)?;
    reporter.replace_capability(capability);
    Ok(())
}

pub fn install_panic_reporter(
    capability: Option<AuthenticatedErrorCapability>,
    definition: PanicEventDefinition,
) -> PanicReporter {
    let reporter = PanicReporter {
        capability: Arc::new(RwLock::new(capability)),
        pending: Arc::new(Mutex::new(None)),
    };
    let pending = Arc::clone(&reporter.pending);
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |information| {
        if let Ok(mut slot) = pending.lock() {
            *slot = Some(PendingErrorRecord {
                code: definition.code,
                frames: approved_location(
                    information.location(),
                    definition.approved_module_prefix,
                )
                .into_iter()
                .collect(),
            });
        }
        previous(information);
    }));
    reporter
}

impl PanicReporter {
    pub fn replace_capability(&self, capability: Option<AuthenticatedErrorCapability>) {
        if let Ok(mut current) = self.capability.write() {
            *current = capability;
        }
    }

    pub fn report_terminal_panic(&self) {
        let pending = self.pending.lock().ok().and_then(|mut slot| slot.take());
        let capability = self
            .capability
            .read()
            .ok()
            .and_then(|current| current.clone());
        let (Some(pending), Some(capability)) = (pending, capability) else {
            return;
        };
        capability.submit(&ErrorRecord {
            code: pending.code,
            exception_class: None,
            frames: pending.frames,
        });
    }
}

impl AuthenticatedErrorCapability {
    fn submit(&self, record: &ErrorRecord<'_>) {
        let Ok(body) = serde_json::to_vec(record) else {
            return;
        };
        let Ok(mut stream) = TcpStream::connect_timeout(&self.address, IO_TIMEOUT) else {
            return;
        };
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let header = format!(
            "POST {REPORT_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.address.port(),
            self.authorization,
            body.len(),
        );
        if stream.write_all(header.as_bytes()).is_err() || stream.write_all(&body).is_err() {
            return;
        }
        let mut response = [0_u8; 128];
        let _ = stream.read(&mut response);
    }
}

fn validate_capability(wire: WireCapability) -> Result<AuthenticatedErrorCapability, String> {
    let endpoint = Url::parse(&wire.endpoint)
        .map_err(|_| "invalid authenticated-error capability bootstrap".to_owned())?;
    if endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || endpoint.path() != REPORT_PATH
        || endpoint.port().is_none()
        || endpoint.username() != ""
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !valid_authorization(&wire.authorization)
    {
        return Err("invalid authenticated-error capability bootstrap".to_owned());
    }
    Ok(AuthenticatedErrorCapability {
        address: SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            endpoint.port().expect("validated capability port"),
        ),
        authorization: wire.authorization,
    })
}

fn valid_authorization(value: &str) -> bool {
    value.len() == "Bearer ".len() + 43
        && value.starts_with("Bearer ")
        && value["Bearer ".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn approved_location(
    location: Option<&panic::Location<'_>>,
    approved_prefix: &str,
) -> Option<ErrorFrame> {
    let location = location?;
    let normalized = location.file().replace('\\', "/");
    let start = normalized.find(approved_prefix)?;
    let module = normalized[start..].to_owned();
    if module.is_empty() || module.len() > MAX_MODULE_BYTES {
        return None;
    }
    Some(ErrorFrame {
        module,
        line: location.line(),
        column: location.column(),
    })
}

fn read_bounded_line(input: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "bootstrap ended early",
            ));
        }
        let used = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len() + used > MAX_BOOTSTRAP_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bootstrap is oversized",
            ));
        }
        line.extend_from_slice(&available[..used]);
        input.consume(used);
        if line.last() == Some(&b'\n') {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(line);
        }
    }
}
