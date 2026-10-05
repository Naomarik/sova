// The answers of server/usage-helper/query.ts (shared/usage/wire.ts shapes): costs, today, session,
// sessions; from per-day summaries (rows collapsed by local day, owner, kind, cwd, project, model)
// cached per zone, table version and day version.
use crate::ledger::{price_row, Ledger, D_CWD, D_KIND, D_MODEL, D_OWNER, D_PROJECT, D_PROVIDER};
use crate::prices::{Aliases, Table};
use crate::tz::Zone;
use crate::util::{day_name, parse_day, round6, Strs};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Default)]
pub struct Acc {
    usd: f64,
    tokens: [u64; 5], // input, output, cacheRead, cacheWrite (both), cacheWrite1h
    usd_by: [f64; 5],
    calls: u64,
    unpriced: u64,
    last_at: i64,
}

impl Acc {
    fn merge(&mut self, o: &Acc) {
        self.usd += o.usd;
        for k in 0..5 {
            self.tokens[k] += o.tokens[k];
            self.usd_by[k] += o.usd_by[k];
        }
        self.calls += o.calls;
        self.unpriced += o.unpriced;
        self.last_at = self.last_at.max(o.last_at);
    }
    fn token_sum(&self) -> u64 {
        self.tokens[0] + self.tokens[1] + self.tokens[2] + self.tokens[3]
    }
    fn spend(&self, m: &mut Map<String, Value>) {
        let t = |a: [u64; 5]| json!({"input": a[0], "output": a[1], "cacheRead": a[2], "cacheWrite": a[3], "cacheWrite1h": a[4]});
        let u = |a: [f64; 5]| json!({"input": round6(a[0]), "output": round6(a[1]), "cacheRead": round6(a[2]), "cacheWrite": round6(a[3]), "cacheWrite1h": round6(a[4])});
        m.insert("usd".into(), json!(round6(self.usd)));
        m.insert("tokens".into(), t(self.tokens));
        m.insert("usdBy".into(), u(self.usd_by));
        m.insert("calls".into(), json!(self.calls));
        m.insert("unpricedTokens".into(), json!(self.unpriced));
    }
    fn value(&self) -> Value {
        let mut m = Map::new();
        self.spend(&mut m);
        Value::Object(m)
    }
}

#[derive(Clone, Default)]
struct Pricing {
    status: u8, // 0 none, 1 priced, 2 free, 3 unpriced, 4 mixed
    key: u32,
    key_at: i64,
    why: u32,
}

impl Pricing {
    fn add(&mut self, status: u8, key: u32, at: i64, why: u32) {
        self.status = if self.status == 0 || self.status == status { status } else { 4 };
        if status == 1 && at >= self.key_at {
            self.key = key;
            self.key_at = at;
        }
        if status == 2 && self.why == 0 {
            self.why = why;
        }
        if status == 3 {
            self.why = why;
        }
    }
    fn merge(&mut self, o: &Pricing) {
        if o.status != 0 {
            self.status = if self.status == 0 || self.status == o.status { o.status } else { 4 };
        }
        if o.key != 0 && o.key_at >= self.key_at {
            self.key = o.key;
            self.key_at = o.key_at;
        }
        if self.why == 0 {
            self.why = o.why;
        }
    }
    fn out(&self, m: &mut Map<String, Value>, strs: &Strs, table: &Table) {
        let status = ["unpriced", "priced", "free", "unpriced", "mixed"][self.status as usize];
        m.insert("status".into(), json!(status));
        if self.key != 0 {
            let k = strs.str(self.key);
            m.insert("priceKey".into(), json!(k));
            if let Some(n) = table.models.get(k).and_then(|x| x.name.clone()) {
                m.insert("name".into(), json!(n));
            }
        }
        if self.why != 0 && self.status != 1 {
            m.insert("why".into(), json!(strs.str(self.why)));
        }
    }
}

#[derive(Clone)]
struct Entry {
    ld: i64,
    owner: u32,
    kind: u32,
    cwd: u32,
    project: u32,
    provider: u32,
    model: u32,
    acc: Acc,
    pricing: Pricing,
}

struct Summary {
    key: (String, u64, u64),
    entries: Vec<Entry>,
    by_owner: HashMap<u32, Vec<usize>>,
}

pub struct Queries {
    pub tv: u64,
    zones: HashMap<String, (Zone, HashMap<i64, i64>)>,
    summaries: HashMap<String, Vec<(String, Summary)>>,
    last_tz: String,
    pub device: Option<String>,
}

const MAX_ZONES: usize = 3;

impl Queries {
    pub fn new(device: Option<String>) -> Queries {
        Queries { tv: 1, zones: HashMap::new(), summaries: HashMap::new(), last_tz: "UTC".into(), device }
    }

    pub fn repriced(&mut self) {
        self.tv += 1;
        self.summaries.clear();
    }

    fn zone(&mut self, tz: &str) -> String {
        let tz = if tz.is_empty() { "UTC" } else { tz };
        if !self.zones.contains_key(tz) {
            self.zones.insert(tz.to_string(), (Zone::load(tz), HashMap::new()));
        }
        tz.to_string()
    }

    fn local_day(&mut self, tz: &str, ms: i64) -> i64 {
        let (z, cache) = self.zones.get_mut(tz).unwrap();
        *cache.entry(ms).or_insert_with(|| z.local_day(ms))
    }

    fn summary_idx(&mut self, l: &mut Ledger, day: &str, tz: &str, prices: &(Table, Aliases)) -> usize {
        self.last_tz = tz.to_string();
        let want = (tz.to_string(), self.tv, l.version_of(day));
        if let Some(list) = self.summaries.get(day) {
            if let Some(i) = list.iter().position(|(z, s)| z == tz && s.key == want) {
                return i;
            }
        }
        let mut by: HashMap<(i64, u32, u32, u32, u32, u32, u32), usize> = HashMap::new();
        let mut entries: Vec<Entry> = Vec::new();
        let tv = self.tv;
        if l.ensure(day, false, prices) {
            let version = l.version_of(day);
            let rows: Vec<_> = l.days[day].rows.keys().copied().collect();
            for k in rows {
                let local = self.local_day(tz, k.b);
                let (strs, days) = (&mut l.strs, &mut l.days);
                let v = days.get_mut(day).unwrap().rows.get_mut(&k).unwrap();
                price_row(strs, &k, v, tv, prices);
                let id = (local, k.d[D_OWNER], k.d[D_KIND], k.d[D_CWD], k.d[D_PROJECT], k.d[D_PROVIDER], k.d[D_MODEL]);
                let i = *by.entry(id).or_insert_with(|| {
                    entries.push(Entry { ld: local, owner: k.d[D_OWNER], kind: k.d[D_KIND], cwd: k.d[D_CWD], project: k.d[D_PROJECT], provider: k.d[D_PROVIDER], model: k.d[D_MODEL], acc: Acc::default(), pricing: Pricing::default() });
                    entries.len() - 1
                });
                let e = &mut entries[i];
                e.acc.tokens[0] += v.t[0];
                e.acc.tokens[1] += v.t[1];
                e.acc.tokens[2] += v.t[2];
                e.acc.tokens[3] += v.t[3] + v.t[4];
                e.acc.tokens[4] += v.t[4];
                e.acc.calls += v.n;
                e.acc.last_at = e.acc.last_at.max(v.a1);
                if v.status == 3 {
                    e.acc.unpriced += v.t.iter().sum::<u64>();
                } else {
                    e.acc.usd += v.usd;
                    e.acc.usd_by[0] += v.by[0];
                    e.acc.usd_by[1] += v.by[1];
                    e.acc.usd_by[2] += v.by[2];
                    e.acc.usd_by[3] += v.by[3] + v.by[4];
                    e.acc.usd_by[4] += v.by[4];
                }
                e.pricing.add(v.status, k.pk, v.a1, v.why);
            }
            let _ = version;
            l.evict(day);
        }
        let mut by_owner: HashMap<u32, Vec<usize>> = HashMap::new();
        for (i, e) in entries.iter().enumerate() {
            if e.owner != 0 {
                by_owner.entry(e.owner).or_default().push(i);
            }
        }
        let list = self.summaries.entry(day.to_string()).or_default();
        list.retain(|(z, _)| z != tz);
        list.push((tz.to_string(), Summary { key: want, entries, by_owner }));
        if list.len() > MAX_ZONES {
            list.remove(0);
        }
        list.len() - 1
    }

    fn summary<'a>(&'a mut self, l: &mut Ledger, day: &str, tz: &str, prices: &(Table, Aliases)) -> &'a Summary {
        let i = self.summary_idx(l, day, tz, prices);
        &self.summaries[day][i].1
    }

    fn utc_days(l: &Ledger, from: i64, to: i64) -> Vec<String> {
        l.day_names().into_iter().filter(|d| parse_day(d).map_or(false, |n| n >= from - 1 && n <= to + 1)).collect()
    }

    pub fn costs(&mut self, l: &mut Ledger, prices: &(Table, Aliases), range: &str, providers: &[String], models: &[String], tz: &str, now: i64) -> Value {
        let tz = self.zone(tz);
        let today = self.local_day(&tz, now);
        let from = match range { "all" => None, "7d" => Some(today - 6), _ => Some(today - 29) };
        let days: Vec<String> = match from { None => l.day_names().into_iter().filter(|d| parse_day(d).map_or(false, |n| n <= today + 1)).collect(), Some(f) => Self::utc_days(l, f, today) };
        let pset: HashSet<&str> = providers.iter().map(|s| s.as_str()).collect();
        let mset: HashSet<&str> = models.iter().map(|s| s.as_str()).collect();
        let mut facet_p: BTreeMap<String, ()> = BTreeMap::new();
        let mut facet_m: BTreeMap<(String, String), ()> = BTreeMap::new();
        let mut total = Acc::default();
        let mut kinds: HashMap<u32, Acc> = HashMap::new();
        let mut daily: HashMap<i64, Acc> = HashMap::new();
        let mut by_provider: HashMap<u32, Acc> = HashMap::new();
        let mut by_model: HashMap<(u32, u32), (Acc, Pricing)> = HashMap::new();
        let mut by_project: HashMap<(u32, u32), Acc> = HashMap::new();
        let mut sessions: HashMap<u32, Acc> = HashMap::new();
        let mut first: Option<i64> = None;
        for day in &days {
            let i = self.summary_idx(l, day, &tz, prices);
            let s = &self.summaries[day.as_str()][i].1;
            for e in &s.entries {
                if from.map_or(false, |f| e.ld < f) || e.ld > today {
                    continue;
                }
                let p = l.strs.str(e.provider);
                let m = l.strs.str(e.model);
                facet_p.insert(p.to_string(), ());
                facet_m.insert((p.to_string(), m.to_string()), ());
                if !pset.is_empty() && !pset.contains(p) {
                    continue;
                }
                if !mset.is_empty() && !mset.contains(format!("{p}/{m}").as_str()) {
                    continue;
                }
                first = Some(first.map_or(e.ld, |f| f.min(e.ld)));
                total.merge(&e.acc);
                kinds.entry(e.kind).or_default().merge(&e.acc);
                daily.entry(e.ld).or_default().merge(&e.acc);
                by_provider.entry(e.provider).or_default().merge(&e.acc);
                let bm = by_model.entry((e.provider, e.model)).or_default();
                bm.0.merge(&e.acc);
                bm.1.merge(&e.pricing);
                let pk = if e.project != 0 { (e.project, 0) } else { (0, e.cwd) };
                by_project.entry(pk).or_default().merge(&e.acc);
                if e.owner != 0 {
                    sessions.entry(e.owner).or_default().merge(&e.acc);
                }
            }
        }
        let start = from.or(first);
        let mut daily_out = Vec::new();
        if let Some(s) = start {
            for d in s..=today {
                let a = daily.get(&d);
                daily_out.push(json!({"day": day_name(d), "usd": round6(a.map_or(0.0, |a| a.usd)), "tokens": a.map_or(0, |a| a.token_sum())}));
            }
        }
        let kid = |l: &mut Ledger, k: &str| l.strs.id(k);
        let (k_main, k_over, k_worker, k_one) = (kid(l, "main"), kid(l, "overseer"), kid(l, "worker"), kid(l, "oneshot"));
        let kacc = |k: u32| kinds.get(&k).cloned().unwrap_or_default();
        let mut main = kacc(k_main);
        main.merge(&kacc(k_over));
        let row = |acc: &Acc, extra: Vec<(&str, Value)>| {
            let mut m = Map::new();
            for (k, v) in extra {
                m.insert(k.into(), v);
            }
            acc.spend(&mut m);
            Value::Object(m)
        };
        let by_usd = |a: &Value, b: &Value| b["usd"].as_f64().unwrap_or(0.0).partial_cmp(&a["usd"].as_f64().unwrap_or(0.0)).unwrap();
        let mut top: Vec<(u32, Acc)> = sessions.into_iter().collect();
        top.sort_by(|a, b| b.1.usd.partial_cmp(&a.1.usd).unwrap().then(b.1.token_sum().cmp(&a.1.token_sum())));
        top.truncate(20);
        let strs = &l.strs;
        let opt = |i: u32| strs.get(i).map_or(Value::Null, |s| json!(s));
        let top: Vec<Value> = top
            .iter()
            .map(|(sid, acc)| {
                let o = l.owners.get(sid).cloned().unwrap_or_default();
                let mut extra = vec![("sid", json!(strs.str(*sid))), ("kind", json!(strs.get(o.kind).unwrap_or("main"))), ("parent", opt(o.parent)), ("cwd", opt(o.cwd)), ("project", opt(o.project)), ("lastAt", json!(acc.last_at))];
                if o.worker != 0 {
                    extra.push(("worker", json!(strs.str(o.worker))));
                }
                row(acc, extra)
            })
            .collect();
        let mut bp: Vec<Value> = by_provider.iter().map(|(p, a)| row(a, vec![("provider", json!(strs.str(*p)))])).collect();
        bp.sort_by(by_usd);
        let (table, _) = prices;
        let mut bm: Vec<Value> = by_model
            .iter()
            .map(|((p, m), (a, pr))| {
                let mut o = Map::new();
                o.insert("provider".into(), json!(strs.str(*p)));
                o.insert("model".into(), json!(strs.str(*m)));
                a.spend(&mut o);
                pr.out(&mut o, strs, table);
                Value::Object(o)
            })
            .collect();
        bm.sort_by(by_usd);
        let order = [("main", k_main), ("overseer", k_over), ("worker", k_worker), ("oneshot", k_one)];
        let bk: Vec<Value> = order.iter().filter(|(_, id)| kinds.contains_key(id)).map(|(n, id)| row(&kinds[id], vec![("kind", json!(n))])).collect();
        let mut bpr: Vec<Value> = by_project.iter().map(|((p, c), a)| row(a, vec![("project", opt(*p)), ("cwd", if *p != 0 { Value::Null } else { opt(*c) })])).collect();
        bpr.sort_by(by_usd);
        json!({
            "device": {"id": self.device, "self": true},
            "range": range,
            "from": start.map(day_name),
            "to": day_name(today),
            "asOf": now,
            "providers": providers,
            "models": models,
            "facets": {"providers": facet_p.keys().collect::<Vec<_>>(), "models": facet_m.keys().map(|(p, m)| json!({"provider": p, "model": m})).collect::<Vec<_>>()},
            "total": total.value(),
            "main": main.value(),
            "workers": kacc(k_worker).value(),
            "oneshots": kacc(k_one).value(),
            "daily": daily_out,
            "byProvider": bp,
            "byModel": bm,
            "byKind": bk,
            "byProject": bpr,
            "topSessions": top,
        })
    }

    pub fn today(&mut self, l: &mut Ledger, prices: &(Table, Aliases), tz: &str, now: i64) -> Value {
        let tz = self.zone(tz);
        let today = self.local_day(&tz, now);
        let mut acc = Acc::default();
        for day in Self::utc_days(l, today, today) {
            let s = self.summary(l, &day, &tz, prices);
            for e in &s.entries {
                if e.ld == today {
                    acc.merge(&e.acc);
                }
            }
        }
        json!({"device": {"id": self.device, "self": true}, "day": day_name(today), "usd": round6(acc.usd), "tokens": acc.token_sum(), "calls": acc.calls, "asOf": now})
    }

    fn family(l: &Ledger, sid: u32) -> Vec<u32> {
        let mut out = vec![sid];
        let mut seen: HashSet<u32> = HashSet::from([sid]);
        let mut i = 0;
        while i < out.len() {
            if let Some(cs) = l.children.get(&out[i]) {
                for &c in cs {
                    if seen.insert(c) {
                        out.push(c);
                    }
                }
            }
            i += 1;
        }
        out
    }

    fn each_entry(&mut self, l: &mut Ledger, prices: &(Table, Aliases), owners: &[u32], mut f: impl FnMut(&Entry)) {
        let mut days: Vec<String> = owners.iter().flat_map(|o| l.owners.get(o).map(|x| x.days.iter().cloned().collect::<Vec<_>>()).unwrap_or_default()).collect();
        days.sort();
        days.dedup();
        let tz = self.last_tz.clone();
        self.zone(&tz);
        for day in days {
            let s = self.summary(l, &day, &tz, prices);
            for o in owners {
                for &i in s.by_owner.get(o).map(|v| v.as_slice()).unwrap_or(&[]) {
                    f(&s.entries[i]);
                }
            }
        }
    }

    pub fn session(&mut self, l: &mut Ledger, prices: &(Table, Aliases), sid_s: &str, now: i64) -> Value {
        let sid = l.strs.id(sid_s);
        let fam = Self::family(l, sid);
        let one = l.strs.id("oneshot");
        let (mut own, mut ones, mut workers) = (Acc::default(), Acc::default(), Acc::default());
        let mut models: BTreeMap<(u8, u32, u32), (Acc, Pricing)> = BTreeMap::new();
        let mut per_worker: HashMap<u32, Acc> = HashMap::new();
        self.each_entry(l, prices, &fam, |e| {
            let origin = if e.owner != sid { 2u8 } else if e.kind == one { 1 } else { 0 };
            match origin {
                2 => {
                    workers.merge(&e.acc);
                    per_worker.entry(e.owner).or_default().merge(&e.acc);
                }
                1 => ones.merge(&e.acc),
                _ => own.merge(&e.acc),
            }
            let m = models.entry((origin, e.provider, e.model)).or_default();
            m.0.merge(&e.acc);
            m.1.merge(&e.pricing);
        });
        let mut total = own.clone();
        total.merge(&ones);
        total.merge(&workers);
        let (table, _) = prices;
        let strs = &l.strs;
        let mut ms: Vec<Value> = models
            .iter()
            .map(|((o, p, m), (a, pr))| {
                let mut x = Map::new();
                x.insert("origin".into(), json!(["main", "oneshot", "worker"][*o as usize]));
                x.insert("provider".into(), json!(strs.str(*p)));
                x.insert("model".into(), json!(strs.str(*m)));
                a.spend(&mut x);
                pr.out(&mut x, strs, table);
                Value::Object(x)
            })
            .collect();
        ms.sort_by(|a, b| b["usd"].as_f64().unwrap_or(0.0).partial_cmp(&a["usd"].as_f64().unwrap_or(0.0)).unwrap());
        let mut wl: Vec<Value> = per_worker
            .iter()
            .map(|(w, a)| {
                let o = l.owners.get(w).cloned().unwrap_or_default();
                let mut with = Acc::default();
                for s in Self::family(l, *w) {
                    if let Some(x) = per_worker.get(&s) {
                        with.merge(x);
                    }
                }
                let mut x = Map::new();
                x.insert("sid".into(), json!(strs.str(*w)));
                x.insert("parent".into(), json!(strs.get(o.parent).unwrap_or(sid_s)));
                if o.worker != 0 {
                    x.insert("worker".into(), json!(strs.str(o.worker)));
                }
                a.spend(&mut x);
                x.insert("withWorkers".into(), with.value());
                Value::Object(x)
            })
            .collect();
        wl.sort_by(|a, b| b["usd"].as_f64().unwrap_or(0.0).partial_cmp(&a["usd"].as_f64().unwrap_or(0.0)).unwrap());
        json!({
            "sid": sid_s, "device": {"id": self.device, "self": true}, "asOf": now,
            "total": total.value(), "own": own.value(), "oneshots": ones.value(), "workers": workers.value(),
            "models": ms, "workerList": wl,
            "lastAt": if total.last_at > 0 { json!(total.last_at) } else { Value::Null },
            "prices": {"asOf": table.fetched_at},
        })
    }

    pub fn sessions(&mut self, l: &mut Ledger, prices: &(Table, Aliases), sids: &[String], now: i64) -> Value {
        let mut out = Map::new();
        for s in sids {
            let sid = l.strs.id(s);
            if !l.owners.contains_key(&sid) {
                continue;
            }
            let fam = Self::family(l, sid);
            let (mut total, mut workers) = (Acc::default(), Acc::default());
            self.each_entry(l, prices, &fam, |e| {
                total.merge(&e.acc);
                if e.owner != sid {
                    workers.merge(&e.acc);
                }
            });
            out.insert(s.clone(), json!({"total": total.value(), "workers": workers.value()}));
        }
        json!({"asOf": now, "sessions": out})
    }
}
