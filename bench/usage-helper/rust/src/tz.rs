// Local days in an IANA zone without a crate: the system's TZif file (/usr/share/zoneinfo), its
// transitions, and its footer's POSIX TZ rule for times past the last transition. An unknown zone
// reads as UTC (as the TypeScript helper's validZone does).
use crate::util::{days_from_civil, DAY_MS};

pub struct Zone {
    trans: Vec<i64>,
    offs: Vec<i64>,
    /// Offset before the first transition.
    first: i64,
    rule: Option<Rule>,
}

struct Rule {
    std: i64,
    dst: Option<(i64, RuleDate, i64, RuleDate, i64)>,
}

#[derive(Clone, Copy)]
struct RuleDate {
    m: i64,
    w: i64,
    d: i64,
}

impl Zone {
    pub fn utc() -> Zone {
        Zone { trans: vec![], offs: vec![], first: 0, rule: None }
    }

    pub fn load(name: &str) -> Zone {
        if name == "UTC" || name.is_empty() || name.contains("..") || !name.chars().all(|c| c.is_ascii_alphanumeric() || "/_-+".contains(c)) {
            return Zone::utc();
        }
        let dir = std::env::var("TZDIR").unwrap_or_else(|_| "/usr/share/zoneinfo".into());
        match std::fs::read(format!("{dir}/{name}")) {
            Ok(b) => parse(&b).unwrap_or_else(Zone::utc),
            Err(_) => Zone::utc(),
        }
    }

    /// Seconds east of UTC at `ms`.
    pub fn offset(&self, ms: i64) -> i64 {
        let t = ms.div_euclid(1000);
        if self.trans.is_empty() || t >= *self.trans.last().unwrap() {
            if let Some(r) = &self.rule {
                return r.offset(t);
            }
            return self.offs.last().copied().unwrap_or(self.first);
        }
        match self.trans.binary_search(&t) {
            Ok(i) => self.offs[i],
            Err(0) => self.first,
            Err(i) => self.offs[i - 1],
        }
    }

    /// Days since the epoch of the local date at `ms`.
    pub fn local_day(&self, ms: i64) -> i64 {
        (ms + self.offset(ms) * 1000).div_euclid(DAY_MS)
    }
}

fn be32(b: &[u8], i: usize) -> Option<i64> {
    Some(i32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?) as i64)
}
fn be64(b: &[u8], i: usize) -> Option<i64> {
    Some(i64::from_be_bytes(b.get(i..i + 8)?.try_into().ok()?))
}

fn parse(b: &[u8]) -> Option<Zone> {
    if b.get(0..4)? != b"TZif" {
        return None;
    }
    let counts = |at: usize| -> Option<[usize; 6]> {
        let mut c = [0usize; 6];
        for (k, v) in c.iter_mut().enumerate() {
            *v = be32(b, at + 20 + k * 4)? as usize;
        }
        Some(c)
    };
    let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0)?;
    let v1len = 44 + timecnt * 5 + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
    let version = *b.get(4)?;
    let (base, tsize, c) = if version >= b'2' { (v1len, 8, counts(v1len)?) } else { (0, 4, [isut, isstd, leap, timecnt, typecnt, charcnt]) };
    let [isut, isstd, leap, timecnt, typecnt, charcnt] = c;
    let mut p = base + 44;
    let mut trans = Vec::with_capacity(timecnt);
    for i in 0..timecnt {
        trans.push(if tsize == 8 { be64(b, p + i * 8)? } else { be32(b, p + i * 4)? });
    }
    p += timecnt * tsize;
    let idx: Vec<usize> = b.get(p..p + timecnt)?.iter().map(|&x| x as usize).collect();
    p += timecnt;
    let mut types = Vec::with_capacity(typecnt);
    for i in 0..typecnt {
        types.push((be32(b, p + i * 6)?, *b.get(p + i * 6 + 4)? != 0));
    }
    p += typecnt * 6 + charcnt + leap * (tsize + 4) + isstd + isut;
    let offs = idx.iter().map(|&i| types.get(i).map(|t| t.0).unwrap_or(0)).collect();
    let first = types.iter().find(|t| !t.1).or(types.first()).map(|t| t.0).unwrap_or(0);
    let rule = if tsize == 8 {
        let rest = b.get(p..)?;
        let s = std::str::from_utf8(rest).ok()?;
        let line = s.trim_start_matches('\n').split('\n').next().unwrap_or("");
        parse_rule(line)
    } else {
        None
    };
    Some(Zone { trans, offs, first, rule })
}

// ---- POSIX TZ strings: "CET-1CEST,M3.5.0,M10.5.0/3", "<+0530>-5:30", "EST5EDT,M3.2.0,M11.1.0" ----

fn parse_rule(s: &str) -> Option<Rule> {
    let mut c = s.as_bytes();
    let name = |c: &mut &[u8]| -> Option<()> {
        if c.first() == Some(&b'<') {
            let end = c.iter().position(|&x| x == b'>')?;
            *c = &c[end + 1..];
        } else {
            let n = c.iter().take_while(|x| x.is_ascii_alphabetic()).count();
            if n < 3 {
                return None;
            }
            *c = &c[n..];
        }
        Some(())
    };
    let hms = |c: &mut &[u8]| -> Option<i64> {
        let mut sign = 1;
        if let Some(&x) = c.first() {
            if x == b'+' || x == b'-' {
                if x == b'-' {
                    sign = -1;
                }
                *c = &c[1..];
            }
        }
        let mut total = 0i64;
        for mult in [3600, 60, 1] {
            let n = c.iter().take_while(|x| x.is_ascii_digit()).count();
            if n == 0 {
                break;
            }
            let v: i64 = std::str::from_utf8(&c[..n]).ok()?.parse().ok()?;
            total += v * mult;
            *c = &c[n..];
            if c.first() == Some(&b':') {
                *c = &c[1..];
            } else {
                break;
            }
        }
        Some(sign * total)
    };
    name(&mut c)?;
    // POSIX offsets are west of UTC.
    let std = -hms(&mut c)?;
    if c.is_empty() {
        return Some(Rule { std, dst: None });
    }
    name(&mut c)?;
    let dst_off = if c.first().map_or(false, |x| *x != b',') { -hms(&mut c)? } else { std + 3600 };
    let date = |c: &mut &[u8]| -> Option<(RuleDate, i64)> {
        if c.first() != Some(&b',') {
            return None;
        }
        *c = &c[1..];
        if c.first() != Some(&b'M') {
            return None; // Jn / n forms: no zone in use needs them
        }
        *c = &c[1..];
        let mut nums = [0i64; 3];
        for (k, n) in nums.iter_mut().enumerate() {
            let len = c.iter().take_while(|x| x.is_ascii_digit()).count();
            *n = std::str::from_utf8(&c[..len]).ok()?.parse().ok()?;
            *c = &c[len..];
            if k < 2 {
                if c.first() != Some(&b'.') {
                    return None;
                }
                *c = &c[1..];
            }
        }
        let time = if c.first() == Some(&b'/') {
            *c = &c[1..];
            hms(c)?
        } else {
            7200
        };
        Some((RuleDate { m: nums[0], w: nums[1], d: nums[2] }, time))
    };
    let (start, st) = date(&mut c)?;
    let (end, et) = date(&mut c)?;
    Some(Rule { std, dst: Some((dst_off, start, st, end, et)) })
}

impl RuleDate {
    /// Day number of the rule's date in `year` (Mm.w.d: the d'th weekday of week w; 5 = last).
    fn day(&self, year: i64) -> i64 {
        let first = days_from_civil(year, self.m, 1);
        let wd_first = (first + 4).rem_euclid(7); // 1970-01-01 was a Thursday
        let mut day = first + (self.d - wd_first).rem_euclid(7) + (self.w - 1) * 7;
        let next = if self.m == 12 { days_from_civil(year + 1, 1, 1) } else { days_from_civil(year, self.m + 1, 1) };
        while day >= next {
            day -= 7;
        }
        day
    }
}

impl Rule {
    fn offset(&self, t: i64) -> i64 {
        let Some((dst, start, st, end, et)) = self.dst else { return self.std };
        let year = crate::util::civil_from_days((t + self.std).div_euclid(86_400)).0;
        // Transition instants in UTC: start is in standard local time, end in daylight time.
        let s = start.day(year) * 86_400 + st - self.std;
        let e = end.day(year) * 86_400 + et - dst;
        let in_dst = if s < e { t >= s && t < e } else { !(t >= e && t < s) };
        if in_dst { dst } else { self.std }
    }
}
