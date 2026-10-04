// The rollup, as server/usage-helper/ledger.ts: byte-offset tailing of every producer file, dedup by
// key hash per day, rows keyed by 15-minute bucket, dimensions, price key, period and tier band;
// per-day snapshots (offsets, rows and key hashes saved together); close + gzip of ended days;
// a day folded again from its records when the price history moves a row out of its period.
use crate::prices::{price_usage, Aliases, Priced, Table};
use crate::util::{hash_key, parse_day, round6, Strs, DAY_MS};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Deserialize;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const BUCKET_MS: i64 = 15 * 60_000;
pub const CLOSE_GRACE_MS: i64 = 2 * 60 * 60_000;
pub const NDIMS: usize = 12;
// owner, parent, worker, kind, purpose, cwd, project, src, provider, model, responseModel, starter
pub const D_OWNER: usize = 0;
pub const D_PARENT: usize = 1;
pub const D_WORKER: usize = 2;
pub const D_KIND: usize = 3;
pub const D_PURPOSE: usize = 4;
pub const D_CWD: usize = 5;
pub const D_PROJECT: usize = 6;
pub const D_PROVIDER: usize = 8;
pub const D_MODEL: usize = 9;
pub const D_RM: usize = 10;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct RowKey {
    pub b: i64,
    pub d: [u32; NDIMS],
    /// price key id ("free:local" style for free), 0 = unpriced
    pub pk: u32,
    /// period `from` id, 0 = the first period
    pub pf: u32,
    /// tier band, -1 = base rates
    pub tier: i64,
}

#[derive(Clone)]
pub struct RowVal {
    pub t: [u64; 5],
    pub n: u64,
    pub a0: i64,
    pub a1: i64,
    // The row's price, cached for a table version and a call count.
    pub pv: u64,
    pub pn: u64,
    pub usd: f64,
    pub by: [f64; 5],
    /// 1 priced, 2 free, 3 unpriced
    pub status: u8,
    pub why: u32,
}

#[derive(Clone, Copy, Default)]
struct FileState {
    off: u64,
    gz: bool,
}

pub struct Day {
    pub name: String,
    files: HashMap<String, FileState>,
    pub rows: HashMap<RowKey, RowVal>,
    keys: Option<HashSet<u64>>,
    pub closed: bool,
    torn: u64,
    dirty: bool,
    pub version: u64,
}

#[derive(Default, Clone)]
pub struct OwnerInfo {
    pub parent: u32,
    pub worker: u32,
    pub kind: u32,
    pub cwd: u32,
    pub project: u32,
    pub days: BTreeSet<String>,
}

#[derive(Default, Clone, Copy)]
pub struct Stats {
    pub records: u64,
    pub duplicates: u64,
    pub skipped: u64,
    pub bytes: u64,
    pub rebuilds: u64,
    pub closes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rec<'a> {
    v: u8,
    #[serde(borrow)]
    key: Cow<'a, str>,
    ts: i64,
    #[serde(borrow)]
    src: Cow<'a, str>,
    #[serde(borrow)]
    provider: Cow<'a, str>,
    #[serde(borrow)]
    model: Cow<'a, str>,
    #[serde(borrow, default)]
    response_model: Option<Cow<'a, str>>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    #[serde(default)]
    cache_write1h: Option<u64>,
    #[serde(borrow)]
    owner: Option<Cow<'a, str>>,
    #[serde(borrow)]
    parent: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    worker: Option<Cow<'a, str>>,
    #[serde(borrow)]
    kind: Cow<'a, str>,
    #[serde(borrow, default)]
    purpose: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    cwd: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    project: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    starter: Option<Cow<'a, str>>,
}

const MAX_TOKENS: u64 = 10_000_000_000;

pub struct Ledger {
    pub usage_root: PathBuf,
    state_dir: PathBuf,
    pub days: BTreeMap<String, Day>,
    on_disk: BTreeSet<String>,
    gens: HashMap<String, u64>,
    clock: u64,
    pub strs: Strs,
    pub owners: HashMap<u32, OwnerInfo>,
    pub children: HashMap<u32, HashSet<u32>>,
    pub projects: HashMap<u32, BTreeSet<String>>,
    pub stats: Stats,
}

fn is_producer_file(n: &str) -> bool {
    n.ends_with(".jsonl") && n.len() > 6 && n.len() <= 70 && n.as_bytes()[0].is_ascii_alphanumeric() && n[..n.len() - 6].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
}
pub fn is_day(n: &str) -> bool {
    parse_day(n).is_some()
}
fn day_end(name: &str) -> i64 {
    parse_day(name).map(|d| (d + 1) * DAY_MS).unwrap_or(i64::MAX)
}
fn size_of(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

impl Ledger {
    pub fn new(usage_root: PathBuf, state_dir: PathBuf) -> Ledger {
        let _ = fs::create_dir_all(state_dir.join("days"));
        let mut on_disk = BTreeSet::new();
        if let Ok(rd) = fs::read_dir(state_dir.join("days")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if let Some(d) = n.strip_suffix(".snap") {
                    if is_day(d) {
                        on_disk.insert(d.to_string());
                    }
                }
            }
        }
        Ledger { usage_root, state_dir, days: BTreeMap::new(), on_disk, gens: HashMap::new(), clock: 0, strs: Strs::new(), owners: HashMap::new(), children: HashMap::new(), projects: HashMap::new(), stats: Stats::default() }
    }

    pub fn day_names(&self) -> Vec<String> {
        let mut s: BTreeSet<String> = self.on_disk.clone();
        s.extend(self.days.keys().cloned());
        s.into_iter().collect()
    }

    pub fn version_of(&self, day: &str) -> u64 {
        self.days.get(day).map(|d| d.version).or_else(|| self.gens.get(day).copied()).unwrap_or(0)
    }

    fn bump(&mut self, name: &str) {
        self.clock += 1;
        let v = self.clock;
        if let Some(d) = self.days.get_mut(name) {
            d.version = v;
        }
        self.gens.insert(name.to_string(), v);
    }

    /// Make sure a day is in memory (loaded from its snapshot, or new when `create`).
    pub fn ensure(&mut self, name: &str, create: bool, prices: &(Table, Aliases)) -> bool {
        if self.days.contains_key(name) {
            return true;
        }
        if self.on_disk.contains(name) {
            if let Some(d) = self.load(name) {
                for k in d.rows.keys().copied().collect::<Vec<_>>() {
                    self.note(&k, name);
                }
                self.days.insert(name.to_string(), d);
                return true;
            }
            let d = Day { name: name.to_string(), files: HashMap::new(), rows: HashMap::new(), keys: Some(HashSet::new()), closed: false, torn: 0, dirty: true, version: 0 };
            self.days.insert(name.to_string(), d);
            self.rebuild(name, prices);
            return true;
        }
        if !create {
            return false;
        }
        let d = Day { name: name.to_string(), files: HashMap::new(), rows: HashMap::new(), keys: Some(HashSet::new()), closed: false, torn: 0, dirty: true, version: 0 };
        self.days.insert(name.to_string(), d);
        true
    }

    pub fn evict(&mut self, name: &str) {
        if let Some(d) = self.days.get(name) {
            if d.closed && !d.dirty {
                self.days.remove(name);
            }
        }
    }

    pub fn index_all(&mut self, prices: &(Table, Aliases)) {
        for name in self.day_names() {
            let kept = self.days.contains_key(&name);
            if !self.ensure(&name, false, prices) {
                continue;
            }
            let keys: Vec<RowKey> = self.days[&name].rows.keys().copied().collect();
            for k in keys {
                self.note(&k, &name);
            }
            if !kept {
                self.evict(&name);
            }
        }
    }

    fn note(&mut self, k: &RowKey, day: &str) {
        let project = k.d[D_PROJECT];
        if project != 0 {
            self.projects.entry(project).or_default().insert(day.to_string());
        }
        let owner = k.d[D_OWNER];
        if owner == 0 {
            return;
        }
        let oneshot = self.strs.id("oneshot");
        let o = self.owners.entry(owner).or_default();
        if !o.days.contains(day) {
            o.days.insert(day.to_string());
        }
        if k.d[D_KIND] != oneshot && o.kind == 0 {
            o.kind = k.d[D_KIND];
        }
        if o.worker == 0 {
            o.worker = k.d[D_WORKER];
        }
        if o.cwd == 0 {
            o.cwd = k.d[D_CWD];
        }
        if o.project == 0 {
            o.project = project;
        }
        let parent = k.d[D_PARENT];
        if parent != 0 && o.parent == 0 && parent != owner {
            o.parent = parent;
            self.children.entry(parent).or_default().insert(owner);
        }
    }

    // ---- catch-up and follow -----------------------------------------------------------------

    pub fn scan_all(&mut self, now: i64, prices: &(Table, Aliases)) {
        let Ok(rd) = fs::read_dir(&self.usage_root) else { return };
        let mut dirs: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_day(n)).collect();
        dirs.sort();
        for name in dirs {
            self.scan_day(&name, None, prices);
            let due = self.days.get(&name).map_or(false, |d| !d.closed && now >= day_end(&name) + CLOSE_GRACE_MS);
            if due {
                self.close(&name, prices);
                self.evict(&name);
            }
        }
    }

    pub fn scan_day(&mut self, name: &str, only: Option<&HashSet<String>>, prices: &(Table, Aliases)) {
        if !is_day(name) {
            return;
        }
        let dir = self.usage_root.join(name);
        let files: Vec<String> = match only {
            Some(set) => set.iter().filter(|f| is_producer_file(f)).cloned().collect(),
            None => match fs::read_dir(&dir) {
                Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| is_producer_file(f)).collect(),
                Err(_) => return,
            },
        };
        if files.is_empty() && only.is_some() {
            return;
        }
        self.ensure(name, true, prices);
        if self.days[name].closed {
            let grown = files.iter().any(|f| size_of(&dir.join(f)) > self.days[name].files.get(f).map_or(0, |s| s.off));
            if grown {
                self.rebuild(name, prices);
            }
            return;
        }
        for f in files {
            self.tail(name, &f, prices);
        }
    }

    fn tail(&mut self, name: &str, file: &str, prices: &(Table, Aliases)) {
        let full = self.usage_root.join(name).join(file);
        let st = self.days[name].files.get(file).copied().unwrap_or_default();
        let Ok(mut fh) = fs::File::open(&full) else { return };
        let size = fh.metadata().map(|m| m.len()).unwrap_or(0);
        if size < st.off {
            drop(fh);
            self.rebuild(name, prices);
            return;
        }
        if size == st.off && self.days[name].files.contains_key(file) {
            return;
        }
        let mut buf = Vec::with_capacity((size - st.off) as usize);
        if fh.seek(SeekFrom::Start(st.off)).is_err() || fh.take(size - st.off).read_to_end(&mut buf).is_err() {
            return;
        }
        let whole = match buf.iter().rposition(|&c| c == b'\n') { Some(i) => i + 1, None => 0 };
        if whole > 0 {
            self.fold_text(name, &buf[..whole], prices);
        }
        let off = st.off + whole as u64;
        self.stats.bytes += whole as u64;
        let d = self.days.get_mut(name).unwrap();
        if off != st.off || !d.files.contains_key(file) {
            d.files.insert(file.to_string(), FileState { off, gz: st.gz });
            d.dirty = true;
        }
    }

    fn fold_text(&mut self, name: &str, text: &[u8], prices: &(Table, Aliases)) {
        let mut changed = false;
        for line in text.split(|&c| c == b'\n') {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<Rec>(line) {
                Ok(r) if valid(&r) => {
                    if self.fold(name, &r, prices) {
                        changed = true;
                    }
                }
                _ => self.stats.skipped += 1,
            }
        }
        if changed {
            self.bump(name);
        }
    }

    fn fold(&mut self, name: &str, r: &Rec, prices: &(Table, Aliases)) -> bool {
        let h = hash_key(&r.key);
        let day = self.days.get_mut(name).unwrap();
        let keys = day.keys.get_or_insert_with(HashSet::new);
        if !keys.insert(h) {
            self.stats.duplicates += 1;
            return false;
        }
        self.stats.records += 1;
        let cw1h = r.cache_write1h.unwrap_or(0);
        let u = [r.input, r.output, r.cache_read, r.cache_write - cw1h, cw1h];
        let (table, aliases) = prices;
        let rm = r.response_model.as_deref();
        let priced = price_usage(table, aliases, &r.provider, &r.model, rm, &u, r.ts, None);
        let s = &mut self.strs;
        let (pk, pf, tier) = match &priced {
            Priced::Priced { key, period, tier, .. } => (s.id(key), s.opt(period.as_deref()), tier.map_or(-1, |t| t as i64)),
            Priced::Free(w) => (s.id(&format!("free:{w}")), 0, -1),
            Priced::Unpriced(_) => (0, 0, -1),
        };
        let d = [
            s.opt(r.owner.as_deref()),
            s.opt(r.parent.as_deref()),
            s.opt(r.worker.as_deref()),
            s.id(&r.kind),
            s.opt(r.purpose.as_deref()),
            s.opt(r.cwd.as_deref()),
            s.opt(r.project.as_deref()),
            s.id(&r.src),
            s.id(&r.provider),
            s.id(&r.model),
            s.opt(rm),
            s.opt(r.starter.as_deref()),
        ];
        let key = RowKey { b: r.ts - r.ts.rem_euclid(BUCKET_MS), d, pk, pf, tier };
        let day = self.days.get_mut(name).unwrap();
        let mut fresh = false;
        let row = day.rows.entry(key).or_insert_with(|| {
            fresh = true;
            RowVal { t: [0; 5], n: 0, a0: r.ts, a1: r.ts, pv: 0, pn: 0, usd: 0.0, by: [0.0; 5], status: 0, why: 0 }
        });
        for k in 0..5 {
            row.t[k] += u[k];
        }
        row.n += 1;
        row.a0 = row.a0.min(r.ts);
        row.a1 = row.a1.max(r.ts);
        day.dirty = true;
        if fresh {
            self.note(&key, name);
        }
        true
    }

    // ---- rebuild -----------------------------------------------------------------------------

    pub fn rebuild(&mut self, name: &str, prices: &(Table, Aliases)) {
        let dir = self.usage_root.join(name);
        let Ok(rd) = fs::read_dir(&dir) else { return };
        let names: HashSet<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        {
            let d = &self.days[name];
            for (f, st) in &d.files {
                let has = (st.gz && names.contains(&format!("{f}.gz"))) || names.contains(f) || (!st.gz && st.off == 0);
                if !has {
                    eprintln!("[usage-helper-rs] {name}: {f} is gone; keeping the day's rows");
                    return;
                }
            }
        }
        self.stats.rebuilds += 1;
        {
            let d = self.days.get_mut(name).unwrap();
            d.rows.clear();
            d.keys = Some(HashSet::new());
            d.files.clear();
        }
        let mut producers: Vec<String> = names
            .iter()
            .filter_map(|n| if is_producer_file(n) { Some(n.clone()) } else { n.strip_suffix(".gz").filter(|p| is_producer_file(p)).map(String::from) })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        producers.sort();
        for f in producers {
            let mut gz = false;
            if names.contains(&format!("{f}.gz")) {
                if let Ok(bytes) = fs::read(dir.join(format!("{f}.gz"))) {
                    let mut text = Vec::new();
                    if GzDecoder::new(&bytes[..]).read_to_end(&mut text).is_ok() {
                        let whole = text.iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
                        self.fold_text(name, &text[..whole], prices);
                        gz = true;
                    }
                }
            }
            self.days.get_mut(name).unwrap().files.insert(f.clone(), FileState { off: 0, gz });
            if names.contains(&f) {
                self.tail(name, &f, prices);
            }
        }
        let d = self.days.get_mut(name).unwrap();
        d.closed = false;
        d.dirty = true;
        self.bump(name);
    }

    /// The price file changed: fold again every day with a row whose calls may sit in another key, period or band.
    pub fn repriced(&mut self, prev: &Table, prices: &(Table, Aliases)) -> usize {
        let mut n = 0;
        for name in self.day_names() {
            let kept = self.days.contains_key(&name);
            if !self.ensure(&name, false, prices) {
                continue;
            }
            if self.stale(&name, prev, prices) {
                self.rebuild(&name, prices);
                n += 1;
            } else if !kept {
                self.evict(&name);
            }
        }
        n
    }

    fn stale(&self, name: &str, prev: &Table, prices: &(Table, Aliases)) -> bool {
        let (next, aliases) = prices;
        let band = |t: &Table, pk: &str, at: i64| -> Option<(Option<String>, String)> {
            let m = t.models.get(pk)?;
            let p = crate::prices::period_at(m, at)?;
            Some((p.from.clone(), format!("{:?}", p.tiers)))
        };
        let zero = [0u64; 5];
        for k in self.days[name].rows.keys() {
            let v = &self.days[name].rows[k];
            let provider = self.strs.str(k.d[D_PROVIDER]);
            let model = self.strs.str(k.d[D_MODEL]);
            let rm = self.strs.get(k.d[D_RM]);
            let pk_now = self.strs.get(k.pk);
            for at in [v.a0, v.a1] {
                let p = price_usage(next, aliases, provider, model, rm, &zero, at, None);
                let now_pk: Option<String> = match &p { Priced::Priced { key, .. } => Some(key.clone()), Priced::Free(w) => Some(format!("free:{w}")), Priced::Unpriced(_) => None };
                if now_pk.as_deref() != pk_now {
                    return true;
                }
                if let Some(pk) = pk_now.filter(|p| !p.starts_with("free:")) {
                    let was = band(prev, pk, at);
                    let now = band(next, pk, at);
                    if now.as_ref().map(|b| b.0.as_deref()) .flatten() != self.strs.get(k.pf) {
                        return true;
                    }
                    if was.map(|b| b.1) != now.map(|b| b.1) {
                        return true;
                    }
                }
            }
        }
        false
    }

    // ---- close -------------------------------------------------------------------------------

    pub fn close_days(&mut self, now: i64, prices: &(Table, Aliases)) -> usize {
        let due: Vec<String> = self.days.values().filter(|d| !d.closed && now >= day_end(&d.name) + CLOSE_GRACE_MS).map(|d| d.name.clone()).collect();
        for n in &due {
            self.close(n, prices);
        }
        due.len()
    }

    fn close(&mut self, name: &str, prices: &(Table, Aliases)) {
        let dir = self.usage_root.join(name);
        let files: Vec<String> = self.days[name].files.keys().cloned().collect();
        for f in &files {
            self.tail(name, f, prices);
        }
        for f in files {
            let plain = dir.join(&f);
            if !plain.exists() {
                continue;
            }
            let st = self.days[name].files[&f];
            let sealing = dir.join(format!("{f}.sealing"));
            if fs::rename(&plain, &sealing).is_err() {
                continue;
            }
            let buf = fs::read(&sealing).unwrap_or_default();
            let extra = &buf[(st.off as usize).min(buf.len())..];
            let last = extra.iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
            if last > 0 {
                let chunk = extra[..last].to_vec();
                self.fold_text(name, &chunk, prices);
            }
            if last < extra.len() {
                self.days.get_mut(name).unwrap().torn += 1;
            }
            let whole = &buf[..st.off as usize + last];
            let gz_path = dir.join(format!("{f}.gz"));
            let mut before = Vec::new();
            if st.gz {
                if let Ok(b) = fs::read(&gz_path) {
                    let _ = GzDecoder::new(&b[..]).read_to_end(&mut before);
                }
            }
            let tmp = dir.join(format!("{f}.gz.tmp"));
            let mut enc = GzEncoder::new(Vec::new(), Compression::default());
            let _ = enc.write_all(&before);
            let _ = enc.write_all(whole);
            if let Ok(out) = enc.finish() {
                if fs::write(&tmp, out).is_ok() && fs::rename(&tmp, &gz_path).is_ok() {
                    let _ = fs::remove_file(&sealing);
                }
            }
            self.days.get_mut(name).unwrap().files.insert(f, FileState { off: 0, gz: true });
        }
        let d = self.days.get_mut(name).unwrap();
        d.closed = true;
        d.keys = None;
        d.dirty = true;
        self.stats.closes += 1;
        self.bump(name);
        self.save(name);
    }

    // ---- snapshots ---------------------------------------------------------------------------

    pub fn flush(&mut self) {
        let dirty: Vec<String> = self.days.values().filter(|d| d.dirty).map(|d| d.name.clone()).collect();
        for n in dirty {
            self.save(&n);
        }
    }

    fn snap_path(&self, name: &str) -> PathBuf {
        self.state_dir.join("days").join(format!("{name}.snap"))
    }

    fn save(&mut self, name: &str) {
        let d = &self.days[name];
        let s = &self.strs;
        let opt = |i: u32| s.get(i).map_or(Value::Null, |x| Value::String(x.to_string()));
        let rows: Vec<Value> = d
            .rows
            .iter()
            .map(|(k, v)| json!([k.b, k.d.iter().map(|&i| opt(i)).collect::<Vec<_>>(), opt(k.pk), opt(k.pf), if k.tier < 0 { Value::Null } else { json!(k.tier) }, v.t, v.n, v.a0, v.a1]))
            .collect();
        let files: serde_json::Map<String, Value> = d.files.iter().map(|(f, st)| (f.clone(), json!({"off": st.off, "gz": st.gz}))).collect();
        let head = json!({"v": 1, "day": name, "closed": d.closed, "torn": d.torn, "files": files, "rows": rows});
        let mut out = serde_json::to_vec(&head).unwrap_or_default();
        out.push(b'\n');
        while out.len() % 8 != 0 {
            out.push(b' ');
        }
        if let Some(keys) = &d.keys {
            out.reserve(keys.len() * 8);
            for k in keys {
                out.extend_from_slice(&k.to_le_bytes());
            }
        }
        let file = self.snap_path(name);
        let tmp = file.with_extension("snap.tmp");
        if fs::write(&tmp, &out).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
        self.days.get_mut(name).unwrap().dirty = false;
        self.on_disk.insert(name.to_string());
    }

    fn load(&mut self, name: &str) -> Option<Day> {
        let buf = fs::read(self.snap_path(name)).ok()?;
        let nl = buf.iter().position(|&c| c == b'\n')?;
        let head: Value = serde_json::from_slice(&buf[..nl]).ok()?;
        let closed = head["closed"].as_bool().unwrap_or(false);
        let mut rows = HashMap::new();
        for r in head["rows"].as_array()? {
            let a = r.as_array()?;
            let mut d = [0u32; NDIMS];
            for (i, x) in a[1].as_array()?.iter().enumerate().take(NDIMS) {
                d[i] = self.strs.opt(x.as_str());
            }
            let t5 = a[5].as_array()?;
            let mut t = [0u64; 5];
            for (i, x) in t5.iter().enumerate().take(5) {
                t[i] = x.as_u64().unwrap_or(0);
            }
            let key = RowKey { b: a[0].as_i64()?, d, pk: self.strs.opt(a[2].as_str()), pf: self.strs.opt(a[3].as_str()), tier: a[4].as_i64().unwrap_or(-1) };
            rows.insert(key, RowVal { t, n: a[6].as_u64()?, a0: a[7].as_i64()?, a1: a[8].as_i64()?, pv: 0, pn: 0, usd: 0.0, by: [0.0; 5], status: 0, why: 0 });
        }
        let mut files = HashMap::new();
        if let Some(obj) = head["files"].as_object() {
            for (f, st) in obj {
                files.insert(f.clone(), FileState { off: st["off"].as_u64().unwrap_or(0), gz: st["gz"].as_bool().unwrap_or(false) });
            }
        }
        let keys = if closed {
            None
        } else {
            let start = (nl + 1 + 7) / 8 * 8;
            let bytes = buf.get(start..).unwrap_or(&[]);
            Some(bytes.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect())
        };
        let version = self.gens.get(name).copied().unwrap_or(0);
        Some(Day { name: name.to_string(), files, rows, keys, closed, torn: head["torn"].as_u64().unwrap_or(0), dirty: false, version })
    }
}

fn valid(r: &Rec) -> bool {
    r.v == 1
        && r.ts > 0
        && !r.key.is_empty()
        && matches!(&*r.kind, "main" | "worker" | "overseer" | "oneshot")
        && matches!(&*r.src, "pi" | "claude" | "claude-residual" | "claude-p" | "jev")
        && r.input <= MAX_TOKENS
        && r.output <= MAX_TOKENS
        && r.cache_read <= MAX_TOKENS
        && r.cache_write <= MAX_TOKENS
        && r.cache_write1h.map_or(true, |x| x <= r.cache_write)
        && r.starter.as_deref().map_or(true, |s| matches!(s, "operator" | "overseer" | "sova"))
}

/// A row's dollars at the current table (cached on the row for a table version and call count).
pub fn price_row(strs: &mut Strs, k: &RowKey, v: &mut RowVal, tv: u64, prices: &(Table, Aliases)) {
    if v.pv == tv && v.pn == v.n {
        return;
    }
    let (table, aliases) = prices;
    let p = price_usage(table, aliases, strs.str(k.d[D_PROVIDER]), strs.str(k.d[D_MODEL]), strs.get(k.d[D_RM]), &v.t, v.a0, Some(if k.tier < 0 { None } else { Some(k.tier as f64) }));
    match p {
        Priced::Priced { usd, total, .. } => {
            v.usd = total;
            v.by = usd;
            v.status = 1;
            v.why = 0;
        }
        Priced::Free(w) => {
            v.usd = 0.0;
            v.by = [0.0; 5];
            v.status = 2;
            v.why = strs.id(&w);
        }
        Priced::Unpriced(w) => {
            v.usd = 0.0;
            v.by = [0.0; 5];
            v.status = 3;
            v.why = strs.id(&w);
        }
    }
    v.pv = tv;
    v.pn = v.n;
    let _ = round6;
}
