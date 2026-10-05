// Small shared pieces: calendar days, ISO times, the key hash, a string interner.
use std::collections::HashMap;

pub const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn day_name(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// `yyyy-mm-dd` -> days since the epoch.
pub fn parse_day(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    Some(days_from_civil(n(0..4)?, n(5..7)?, n(8..10)?))
}

/// An ISO time as JavaScript's Date.parse reads the ones we write (`2026-10-04T09:42:00.000Z`,
/// `2026-09-21T18:00:00Z`); None when it isn't one.
pub fn parse_iso(s: &str) -> Option<i64> {
    let day = parse_day(s.get(0..10)?)?;
    let rest = s.get(10..)?;
    if rest.is_empty() {
        return Some(day * DAY_MS);
    }
    let rest = rest.strip_prefix('T')?;
    let (time, tz) = if let Some(t) = rest.strip_suffix('Z') { (t, 0i64) } else if rest.len() > 6 {
        let (t, off) = rest.split_at(rest.len() - 6);
        let sign = match off.as_bytes()[0] { b'+' => 1, b'-' => -1, _ => return None };
        let h: i64 = off.get(1..3)?.parse().ok()?;
        let m: i64 = off.get(4..6)?.parse().ok()?;
        (t, sign * (h * 60 + m) * 60_000)
    } else {
        return None;
    };
    let (hms, frac) = match time.find('.') { Some(i) => (&time[..i], &time[i + 1..]), None => (time, "") };
    let mut parts = hms.split(':');
    let h: i64 = parts.next()?.parse().ok()?;
    let mi: i64 = parts.next()?.parse().ok()?;
    let sec: i64 = parts.next().map(|x| x.parse().ok()).unwrap_or(Some(0))?;
    let mut ms = 0i64;
    for (i, c) in frac.bytes().take(3).enumerate() {
        if !c.is_ascii_digit() {
            return None;
        }
        ms += (c - b'0') as i64 * [100, 10, 1][i];
    }
    Some(day * DAY_MS + ((h * 60 + mi) * 60 + sec) * 1000 + ms - tz)
}

pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let r = ms.rem_euclid(DAY_MS);
    format!("{}T{:02}:{:02}:{:02}.{:03}Z", day_name(days), r / 3_600_000, (r / 60_000) % 60, (r / 1000) % 60, r % 1000)
}

/// FNV-1a 64: the day's key set holds hashes, not keys.
pub fn hash_key(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// One copy of each dimension value; id 0 is "none".
#[derive(Default)]
pub struct Strs {
    map: HashMap<Box<str>, u32>,
    list: Vec<Box<str>>,
}

impl Strs {
    pub fn new() -> Self {
        Strs { map: HashMap::new(), list: vec!["".into()] }
    }
    pub fn id(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.map.get(s) {
            return i;
        }
        let i = self.list.len() as u32;
        self.list.push(s.into());
        self.map.insert(s.into(), i);
        i
    }
    pub fn opt(&mut self, s: Option<&str>) -> u32 {
        match s { Some(s) => self.id(s), None => 0 }
    }
    pub fn get(&self, i: u32) -> Option<&str> {
        if i == 0 { None } else { self.list.get(i as usize).map(|b| &**b) }
    }
    pub fn str(&self, i: u32) -> &str {
        self.get(i).unwrap_or("")
    }
}

pub fn round6(n: f64) -> f64 {
    (n * 1e6).round() / 1e6
}
