use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{exit, Command, Stdio};
use std::thread;
use std::time::Duration;

#[derive(Serialize)]
struct Request {
    id: String,
    action: String,
    #[serde(flatten)]
    extra: Value,
}

#[derive(Deserialize, Serialize)]
struct Response {
    success: bool,
    data: Option<Value>,
    error: Option<String>,
}

fn get_socket_path() -> PathBuf {
    let session = env::var("AGENT_BROWSER_SESSION").unwrap_or_else(|_| "default".to_string());
    let tmp = env::temp_dir();
    tmp.join(format!("agent-browser-{}.sock", session))
}

fn get_pid_path() -> PathBuf {
    let session = env::var("AGENT_BROWSER_SESSION").unwrap_or_else(|_| "default".to_string());
    let tmp = env::temp_dir();
    tmp.join(format!("agent-browser-{}.pid", session))
}

fn is_daemon_running() -> bool {
    let pid_path = get_pid_path();
    if !pid_path.exists() {
        return false;
    }
    if let Ok(pid_str) = fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<i32>() {
            // Check if process exists
            unsafe {
                return libc::kill(pid, 0) == 0;
            }
        }
    }
    false
}

fn ensure_daemon() -> Result<(), String> {
    let socket_path = get_socket_path();
    
    if is_daemon_running() && socket_path.exists() {
        return Ok(());
    }
    
    // Find daemon.js
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().unwrap();
    
    let daemon_paths = [
        exe_dir.join("daemon.js"),
        exe_dir.join("../dist/daemon.js"),
        PathBuf::from("dist/daemon.js"),
    ];
    
    let daemon_path = daemon_paths
        .iter()
        .find(|p| p.exists())
        .ok_or("Daemon not found. Run from project directory or ensure daemon.js is alongside binary.")?;
    
    // Start daemon
    let session = env::var("AGENT_BROWSER_SESSION").unwrap_or_else(|_| "default".to_string());
    Command::new("node")
        .arg(daemon_path)
        .env("AGENT_BROWSER_DAEMON", "1")
        .env("AGENT_BROWSER_SESSION", &session)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start daemon: {}", e))?;
    
    // Wait for socket
    for _ in 0..50 {
        if socket_path.exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    
    Err("Daemon failed to start".to_string())
}

fn send_command(cmd: Value) -> Result<Response, String> {
    let socket_path = get_socket_path();
    let mut stream = UnixStream::connect(&socket_path)
        .map_err(|e| format!("Failed to connect: {}", e))?;
    
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    
    let mut json_str = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    json_str.push('\n');
    
    stream.write_all(json_str.as_bytes())
        .map_err(|e| format!("Failed to send: {}", e))?;
    
    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader.read_line(&mut response_line)
        .map_err(|e| format!("Failed to read: {}", e))?;
    
    serde_json::from_str(&response_line)
        .map_err(|e| format!("Invalid response: {}", e))
}

fn gen_id() -> String {
    format!("r{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() % 1000000)
}

fn parse_command(args: &[String]) -> Option<Value> {
    if args.is_empty() {
        return None;
    }
    
    let cmd = args[0].as_str();
    let rest: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();
    let id = gen_id();
    
    match cmd {
        "open" | "goto" | "navigate" => {
            let url = rest.get(0)?;
            let url = if url.starts_with("http") {
                url.to_string()
            } else {
                format!("https://{}", url)
            };
            Some(json!({ "id": id, "action": "navigate", "url": url }))
        }
        "click" => Some(json!({ "id": id, "action": "click", "selector": rest.get(0)? })),
        "fill" => Some(json!({ "id": id, "action": "fill", "selector": rest.get(0)?, "value": rest[1..].join(" ") })),
        "type" => Some(json!({ "id": id, "action": "type", "selector": rest.get(0)?, "text": rest[1..].join(" ") })),
        "hover" => Some(json!({ "id": id, "action": "hover", "selector": rest.get(0)? })),
        "snapshot" => {
            let mut cmd = json!({ "id": id, "action": "snapshot" });
            let obj = cmd.as_object_mut().unwrap();
            for (i, arg) in rest.iter().enumerate() {
                match *arg {
                    "-i" | "--interactive" => { obj.insert("interactive".to_string(), json!(true)); }
                    "-c" | "--compact" => { obj.insert("compact".to_string(), json!(true)); }
                    "-d" | "--depth" => {
                        if let Some(d) = rest.get(i + 1) {
                            if let Ok(n) = d.parse::<i32>() {
                                obj.insert("maxDepth".to_string(), json!(n));
                            }
                        }
                    }
                    "-s" | "--selector" => {
                        if let Some(s) = rest.get(i + 1) {
                            obj.insert("selector".to_string(), json!(s));
                        }
                    }
                    _ => {}
                }
            }
            Some(cmd)
        }
        "screenshot" => Some(json!({ "id": id, "action": "screenshot", "path": rest.get(0) })),
        "close" | "quit" | "exit" => Some(json!({ "id": id, "action": "close" })),
        "get" => match rest.get(0).map(|s| *s) {
            Some("text") => Some(json!({ "id": id, "action": "gettext", "selector": rest.get(1)? })),
            Some("url") => Some(json!({ "id": id, "action": "url" })),
            Some("title") => Some(json!({ "id": id, "action": "title" })),
            _ => None,
        },
        "press" => Some(json!({ "id": id, "action": "press", "key": rest.get(0)? })),
        "wait" => {
            if let Some(arg) = rest.get(0) {
                if arg.parse::<u64>().is_ok() {
                    Some(json!({ "id": id, "action": "wait", "timeout": arg.parse::<u64>().unwrap() }))
                } else {
                    Some(json!({ "id": id, "action": "wait", "selector": arg }))
                }
            } else {
                None
            }
        }
        "back" => Some(json!({ "id": id, "action": "back" })),
        "forward" => Some(json!({ "id": id, "action": "forward" })),
        "reload" => Some(json!({ "id": id, "action": "reload" })),
        "eval" => Some(json!({ "id": id, "action": "evaluate", "script": rest.join(" ") })),
        _ => None,
    }
}

fn print_response(resp: &Response, json_mode: bool) {
    if json_mode {
        println!("{}", serde_json::to_string(resp).unwrap_or_default());
        return;
    }
    
    if !resp.success {
        eprintln!("\x1b[31m✗ Error:\x1b[0m {}", resp.error.as_deref().unwrap_or("Unknown error"));
        exit(1);
    }
    
    if let Some(data) = &resp.data {
        if let Some(url) = data.get("url").and_then(|v| v.as_str()) {
            if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
                println!("\x1b[32m✓\x1b[0m \x1b[1m{}\x1b[0m", title);
                println!("\x1b[2m  {}\x1b[0m", url);
                return;
            }
            println!("{}", url);
            return;
        }
        if let Some(snapshot) = data.get("snapshot").and_then(|v| v.as_str()) {
            println!("{}", snapshot);
            return;
        }
        if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
            println!("{}", title);
            return;
        }
        if let Some(text) = data.get("text").and_then(|v| v.as_str()) {
            println!("{}", text);
            return;
        }
        if let Some(result) = data.get("result") {
            println!("{}", serde_json::to_string_pretty(result).unwrap_or_default());
            return;
        }
        if data.get("closed").is_some() {
            println!("\x1b[32m✓\x1b[0m Browser closed");
            return;
        }
        println!("\x1b[32m✓\x1b[0m Done");
    }
}

fn print_help() {
    println!(r#"
agent-browser - fast browser automation CLI (Rust)

Usage: agent-browser <command> [args] [--json]

Commands:
  open <url>              Navigate to URL
  click <sel>             Click element (@ref from snapshot)
  fill <sel> <text>       Fill input
  type <sel> <text>       Type text
  hover <sel>             Hover element
  snapshot [opts]         Get accessibility tree with refs
  screenshot [path]       Take screenshot
  get text <sel>          Get text content
  get url                 Get current URL
  get title               Get page title
  press <key>             Press keyboard key
  wait <ms|sel>           Wait for time or element
  eval <js>               Evaluate JavaScript
  close                   Close browser

Snapshot Options:
  -i, --interactive       Only interactive elements
  -c, --compact           Remove empty structural elements
  -d, --depth <n>         Limit tree depth
  -s, --selector <sel>    Scope to CSS selector

Options:
  --json                  Output JSON

Examples:
  agent-browser open example.com
  agent-browser snapshot -i
  agent-browser click @e2
"#);
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let json_mode = args.iter().any(|a| a == "--json");
    let clean_args: Vec<String> = args.iter().filter(|a| !a.starts_with("--")).cloned().collect();
    
    if clean_args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }
    
    let cmd = match parse_command(&clean_args) {
        Some(c) => c,
        None => {
            eprintln!("\x1b[31mUnknown command:\x1b[0m {}", clean_args.get(0).unwrap_or(&String::new()));
            exit(1);
        }
    };
    
    if let Err(e) = ensure_daemon() {
        if json_mode {
            println!(r#"{{"success":false,"error":"{}"}}"#, e);
        } else {
            eprintln!("\x1b[31m✗ Error:\x1b[0m {}", e);
        }
        exit(1);
    }
    
    match send_command(cmd) {
        Ok(resp) => {
            let success = resp.success;
            print_response(&resp, json_mode);
            if !success {
                exit(1);
            }
        }
        Err(e) => {
            if json_mode {
                println!(r#"{{"success":false,"error":"{}"}}"#, e);
            } else {
                eprintln!("\x1b[31m✗ Error:\x1b[0m {}", e);
            }
            exit(1);
        }
    }
}
