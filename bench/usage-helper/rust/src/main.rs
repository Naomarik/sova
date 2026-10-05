// Benchmark twin of server/usage-helper/main.ts: the same ledger files under
// $PI_CODING_AGENT_DIR/usage/v1, the same price file, the same protocol (stdin: one JSON request
// per line `{"id", "op", ...}`; stdout: `<id> <status> <length>\n<JSON>`). One thread: poll(2) on
// stdin and an inotify descriptor, timers between.
mod ledger;
mod prices;
mod query;
mod tz;
mod util;

use ledger::Ledger;
use prices::{parse_table, Aliases, Table};
use query::Queries;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

struct Inotify {
    fd: i32,
    wds: HashMap<i32, String>, // wd -> day ("" = the root)
    by_day: HashMap<String, i32>,
}

impl Inotify {
    fn new() -> Inotify {
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        Inotify { fd, wds: HashMap::new(), by_day: HashMap::new() }
    }
    fn watch(&mut self, path: &Path, day: &str) {
        if self.by_day.contains_key(day) {
            return;
        }
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return };
        let mask = libc::IN_MODIFY | libc::IN_CREATE | libc::IN_MOVED_TO;
        let wd = unsafe { libc::inotify_add_watch(self.fd, c.as_ptr(), mask) };
        if wd >= 0 {
            self.wds.insert(wd, day.to_string());
            self.by_day.insert(day.to_string(), wd);
        }
    }
    fn unwatch(&mut self, day: &str) {
        if let Some(wd) = self.by_day.remove(day) {
            unsafe { libc::inotify_rm_watch(self.fd, wd) };
            self.wds.remove(&wd);
        }
    }
    /// (day, file name) pairs since the last read.
    fn read(&mut self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = unsafe { libc::read(self.fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 {
                break;
            }
            let mut i = 0usize;
            while i + 16 <= n as usize {
                let wd = i32::from_ne_bytes(buf[i..i + 4].try_into().unwrap());
                let len = u32::from_ne_bytes(buf[i + 12..i + 16].try_into().unwrap()) as usize;
                let name = &buf[i + 16..i + 16 + len];
                let name = String::from_utf8_lossy(&name[..name.iter().position(|&c| c == 0).unwrap_or(len)]).to_string();
                if let Some(day) = self.wds.get(&wd) {
                    out.push((day.clone(), name));
                }
                i += 16 + len;
            }
        }
        out
    }
}

struct Helper {
    ledger: Ledger,
    queries: Queries,
    prices: (Table, Aliases),
    prices_path: PathBuf,
    prices_stamp: String,
}

fn stamp(p: &Path) -> String {
    fs::metadata(p).map(|m| format!("{:?}:{}", m.modified().ok(), m.len())).unwrap_or_default()
}

impl Helper {
    fn reload_prices(&mut self) {
        let s = stamp(&self.prices_path);
        if s.is_empty() || s == self.prices_stamp {
            return;
        }
        self.prices_stamp = s;
        let Some(next) = fs::read_to_string(&self.prices_path).ok().and_then(|t| parse_table(&t)) else { return };
        let prev = std::mem::replace(&mut self.prices.0, next);
        let n = self.ledger.repriced(&prev, &self.prices);
        self.queries.repriced();
        if n > 0 {
            eprintln!("[usage-helper-rs] prices changed: folded {n} day(s) again");
        }
    }

    fn prices_info(&self) -> Value {
        let t = &self.prices.0;
        json!({"source": "models.dev", "asOf": t.fetched_at, "changedAt": t.changed_at,
            "lastChange": t.last_change.as_ref().map(|c| json!({"added": c.added, "changed": c.changed})),
            "fetching": false, "enabled": false, "error": null})
    }

    fn answer(&mut self, req: &Value) -> Result<Value, (u16, String)> {
        let now = now_ms();
        let tz = req["tz"].as_str().unwrap_or("UTC");
        let strings = |v: &Value| -> Vec<String> {
            match v {
                Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
                Value::String(s) => vec![s.clone()],
                _ => vec![],
            }
        };
        match req["op"].as_str().unwrap_or("") {
            "costs" => {
                let range = req["range"].as_str().unwrap_or("30d");
                if !matches!(range, "7d" | "30d" | "all") {
                    return Err((400, "range must be one of 7d, 30d, all".into()));
                }
                let mut v = self.queries.costs(&mut self.ledger, &self.prices, range, &strings(&req["provider"]), &strings(&req["model"]), tz, now);
                v["prices"] = self.prices_info();
                Ok(v)
            }
            "today" => Ok(self.queries.today(&mut self.ledger, &self.prices, tz, now)),
            "session" => match req["sid"].as_str() {
                Some(s) if !s.is_empty() => Ok(self.queries.session(&mut self.ledger, &self.prices, s, now)),
                _ => Err((400, "sid is required".into())),
            },
            "sessions" => {
                let sids = strings(&req["sids"]);
                if sids.len() > 500 {
                    return Err((400, "at most 500 sids".into()));
                }
                Ok(self.queries.sessions(&mut self.ledger, &self.prices, &sids, now))
            }
            "prices" | "refresh" => Ok(self.prices_info()),
            "stats" => {
                let s = self.ledger.stats;
                Ok(json!({"records": s.records, "duplicates": s.duplicates, "skipped": s.skipped, "bytes": s.bytes, "rebuilds": s.rebuilds, "closes": s.closes, "owners": self.ledger.owners.len(), "days": self.ledger.day_names().len()}))
            }
            op => Err((400, format!("unknown op {op}"))),
        }
    }
}

fn send(out: &mut impl Write, id: i64, status: u16, body: &Value) {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    // Blocking writes: an unread stdout stalls the helper, never queues. A closed one ends it.
    if write!(out, "{} {} {}\n", id, status, bytes.len()).and_then(|_| out.write_all(&bytes)).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn recent_days(root: &Path) -> Vec<String> {
    let now = now_ms();
    let mut days: HashSet<String> = [now - util::DAY_MS, now].iter().map(|&t| util::day_name(t.div_euclid(util::DAY_MS))).collect();
    if let Ok(rd) = fs::read_dir(root) {
        let mut all: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| ledger::is_day(n)).collect();
        all.sort();
        for d in all.iter().rev().take(2) {
            days.insert(d.clone());
        }
    }
    days.into_iter().collect()
}

fn main() {
    let agent = std::env::var("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".pi/agent"));
    let usage_root = agent.join("usage").join("v1");
    let state_root = agent.join("sova");
    let _ = fs::create_dir_all(&usage_root);
    let prices_path = state_root.join("model-prices.json");
    let aliases_path = std::env::var("SOVA_USAGE_ALIASES").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("shared/model-prices/aliases.json"));
    let aliases: Aliases = serde_json::from_str(&fs::read_to_string(&aliases_path).expect("aliases.json")).expect("aliases.json parses");
    let table = fs::read_to_string(&prices_path).ok().and_then(|t| parse_table(&t)).expect("model-prices.json");
    let device = fs::read_to_string(state_root.join("host.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["id"].as_str().map(String::from));
    let t0 = Instant::now();
    let mut h = Helper {
        ledger: Ledger::new(usage_root.clone(), state_root.join("usage-ledger-rs")),
        queries: Queries::new(device),
        prices: (table, aliases),
        prices_stamp: stamp(&prices_path),
        prices_path,
    };
    h.ledger.scan_all(now_ms(), &h.prices);
    h.ledger.index_all(&h.prices);
    h.ledger.close_days(now_ms(), &h.prices);
    h.ledger.flush();
    eprintln!("[usage-helper-rs] caught up in {} ms: {} records, {} days", t0.elapsed().as_millis(), h.ledger.stats.records, h.ledger.day_names().len());

    let mut ino = Inotify::new();
    ino.watch(&usage_root, "");
    let rewatch = |ino: &mut Inotify| {
        let keep: HashSet<String> = recent_days(&usage_root).into_iter().collect();
        let old: Vec<String> = ino.by_day.keys().filter(|d| !d.is_empty() && !keep.contains(*d)).cloned().collect();
        for d in old {
            ino.unwatch(&d);
        }
        for d in keep {
            ino.watch(&usage_root.join(&d), &d);
        }
    };
    rewatch(&mut ino);

    let mut stdout = std::io::stdout().lock();
    let mut inbuf: Vec<u8> = Vec::new();
    let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
    let mut settle: Option<Instant> = None;
    let (save, sweep, close, reload) = (Duration::from_secs(3), Duration::from_secs(30), Duration::from_secs(60), Duration::from_secs(5));
    let (mut next_save, mut next_sweep, mut next_close, mut next_reload) = (Instant::now() + save, Instant::now() + sweep, Instant::now() + close, Instant::now() + reload);
    unsafe { libc::fcntl(0, libc::F_SETFL, libc::fcntl(0, libc::F_GETFL) | libc::O_NONBLOCK) };

    let drain = |h: &mut Helper, pending: &mut HashMap<String, HashSet<String>>| {
        for (day, files) in pending.drain() {
            h.ledger.scan_day(&day, Some(&files), &h.prices);
        }
    };

    loop {
        let now = Instant::now();
        let mut deadline = next_save.min(next_sweep).min(next_close).min(next_reload);
        if let Some(s) = settle {
            deadline = deadline.min(s);
        }
        let timeout = deadline.saturating_duration_since(now).as_millis().min(60_000) as i32;
        let mut fds = [libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 }, libc::pollfd { fd: ino.fd, events: libc::POLLIN, revents: 0 }];
        unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout) };

        if fds[1].revents & libc::POLLIN != 0 {
            let mut new_day = false;
            for (day, name) in ino.read() {
                if day.is_empty() {
                    if ledger::is_day(&name) {
                        new_day = true;
                        pending.entry(name).or_default();
                    }
                } else {
                    pending.entry(day).or_default().insert(name);
                }
            }
            if new_day {
                rewatch(&mut ino);
                // A new directory's files may predate its watch.
                let days: Vec<String> = pending.iter().filter(|(_, f)| f.is_empty()).map(|(d, _)| d.clone()).collect();
                for d in days {
                    pending.remove(&d);
                    h.ledger.scan_day(&d, None, &h.prices);
                }
            }
            if settle.is_none() && !pending.is_empty() {
                settle = Some(Instant::now() + Duration::from_millis(100));
            }
        }
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            let mut buf = [0u8; 65536];
            let n = unsafe { libc::read(0, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n == 0 {
                drain(&mut h, &mut pending);
                h.ledger.flush();
                return;
            }
            if n > 0 {
                inbuf.extend_from_slice(&buf[..n as usize]);
                // A request is one short line: a stdin that never ends one isn't the server.
                if inbuf.len() > 1 << 20 && !inbuf.contains(&b'\n') {
                    eprintln!("[usage-helper-rs] stdin sent a line over 1 MB: not the server; exiting");
                    h.ledger.flush();
                    return;
                }
                while let Some(nl) = inbuf.iter().position(|&c| c == b'\n') {
                    let line: Vec<u8> = inbuf.drain(..=nl).collect();
                    let Ok(req) = serde_json::from_slice::<Value>(&line[..line.len() - 1]) else { continue };
                    let id = req["id"].as_i64().unwrap_or(0);
                    drain(&mut h, &mut pending);
                    settle = None;
                    match h.answer(&req) {
                        Ok(v) => send(&mut stdout, id, 200, &v),
                        Err((code, msg)) => send(&mut stdout, id, code, &json!({"error": msg})),
                    }
                }
            }
        }
        let now = Instant::now();
        if settle.map_or(false, |s| now >= s) {
            settle = None;
            drain(&mut h, &mut pending);
        }
        if now >= next_save {
            h.ledger.flush();
            next_save = now + save;
        }
        if now >= next_reload {
            h.reload_prices();
            next_reload = now + reload;
        }
        if now >= next_sweep {
            rewatch(&mut ino);
            for d in recent_days(&usage_root) {
                h.ledger.scan_day(&d, None, &h.prices);
            }
            next_sweep = now + sweep;
        }
        if now >= next_close {
            h.ledger.close_days(now_ms(), &h.prices);
            next_close = now + close;
        }
    }
}
