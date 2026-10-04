// The pricing rule of shared/model-prices/prices.ts (resolvePriceRef, periodAt, priceUsage with a
// forced tier), on the same price file and alias table. No download: the benchmark runs with
// fetching off, and the TypeScript price book owns pulls.
use crate::util::parse_iso;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Clone, Copy, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write5m: Option<f64>,
    pub cache_write1h: Option<f64>,
}

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub input_above: f64,
    pub rates: Rates,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Period {
    pub from: Option<String>,
    pub until: Option<String>,
    pub rates: Rates,
    #[serde(default)]
    pub tiers: Vec<Tier>,
    #[serde(skip)]
    pub from_ms: i64,
    #[serde(skip)]
    pub until_ms: i64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ModelPrice {
    pub name: Option<String>,
    pub periods: Vec<Period>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct LastChange {
    pub added: Vec<String>,
    pub changed: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub fetched_at: Option<String>,
    pub changed_at: Option<String>,
    pub last_change: Option<LastChange>,
    pub models: HashMap<String, ModelPrice>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct AliasTarget {
    pub until: Option<String>,
    pub to: Option<String>,
    pub free: Option<String>,
    pub unpriced: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum AliasEntry {
    One(AliasTarget),
    Many(Vec<AliasTarget>),
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct ProviderRule {
    pub to: Option<String>,
    pub local: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Aliases {
    pub providers: HashMap<String, ProviderRule>,
    pub models: HashMap<String, AliasEntry>,
}

pub fn parse_table(text: &str) -> Option<Table> {
    let mut t: Table = serde_json::from_str(text).ok()?;
    for m in t.models.values_mut() {
        if m.periods.is_empty() {
            return None;
        }
        for p in &mut m.periods {
            p.from_ms = p.from.as_deref().and_then(parse_iso).unwrap_or(i64::MIN);
            p.until_ms = p.until.as_deref().and_then(parse_iso).unwrap_or(i64::MAX);
        }
    }
    Some(t)
}

pub enum Resolved {
    Key(String),
    Free(String),
    Unpriced(String),
}

fn base_id(id: &str) -> &str {
    if id.len() >= 4 && id[id.len() - 4..].eq_ignore_ascii_case("[1m]") { &id[..id.len() - 4] } else { id }
}

fn strip_date(id: &str) -> Option<&str> {
    let b = id.as_bytes();
    if b.len() > 9 && b[b.len() - 9] == b'-' && b[b.len() - 8..].iter().all(|c| c.is_ascii_digit()) { Some(&id[..id.len() - 9]) } else { None }
}

pub fn resolve(table: &Table, aliases: &Aliases, provider: &str, model: &str, response_model: Option<&str>, at: i64) -> Resolved {
    let rule = aliases.providers.get(provider);
    if rule.and_then(|r| r.local).unwrap_or(false) {
        return Resolved::Free("local".into());
    }
    let lookup = |id: &str| -> Option<Resolved> {
        let entry = aliases.models.get(&format!("{provider}/{id}")).or_else(|| aliases.models.get(&format!("*/{id}")));
        if let Some(entry) = entry {
            let pick = |t: &&AliasTarget| t.until.as_deref().and_then(parse_iso).map_or(true, |u| at < u);
            let t = match entry { AliasEntry::One(t) => std::iter::once(t).find(pick), AliasEntry::Many(v) => v.iter().find(pick) }?;
            if let Some(f) = &t.free {
                return Some(Resolved::Free(f.clone()));
            }
            if let Some(u) = &t.unpriced {
                return Some(Resolved::Unpriced(u.clone()));
            }
            if let Some(to) = &t.to {
                return Some(if table.models.contains_key(to) { Resolved::Key(to.clone()) } else { Resolved::Unpriced(format!("models.dev lists no price for {to}")) });
            }
            return None;
        }
        let to = rule?.to.as_deref()?;
        let direct = format!("{to}/{id}");
        if table.models.contains_key(&direct) {
            return Some(Resolved::Key(direct));
        }
        if let Some(u) = strip_date(id) {
            let undated = format!("{to}/{u}");
            if table.models.contains_key(&undated) {
                return Some(Resolved::Key(undated));
            }
        }
        None
    };
    if let Some(rm) = response_model {
        match lookup(base_id(rm)) {
            Some(Resolved::Unpriced(_)) | None => {}
            Some(hit) => return hit,
        }
    }
    let id = base_id(model);
    if let Some(hit) = lookup(id) {
        return hit;
    }
    match rule {
        None => Resolved::Unpriced(format!("no price mapping for provider {provider}")),
        Some(r) => Resolved::Unpriced(format!("models.dev lists no price for {}/{id}", r.to.as_deref().unwrap_or("undefined"))),
    }
}

pub fn period_at(m: &ModelPrice, at: i64) -> Option<&Period> {
    m.periods.iter().find(|p| at >= p.from_ms && at < p.until_ms).or_else(|| m.periods.first())
}

/// input, output, cacheRead, cacheWrite5m, cacheWrite1h
pub type Tokens5 = [u64; 5];

pub enum Priced {
    Priced { key: String, period: Option<String>, tier: Option<f64>, usd: [f64; 5], total: f64 },
    Free(String),
    Unpriced(String),
}

fn rate_for(kind: usize, rates: &Rates, base: &Rates) -> Option<f64> {
    let own = |r: &Rates| match kind {
        0 => Some(r.input),
        1 => Some(r.output),
        2 => r.cache_read,
        3 => r.cache_write5m,
        _ => r.cache_write1h.or(r.cache_write5m),
    };
    own(rates).or_else(|| own(base))
}

/// `tier`: None = choose by this usage's request input; Some(None) = base rates; Some(Some(x)) = the tier above x.
pub fn price_usage(table: &Table, aliases: &Aliases, provider: &str, model: &str, response_model: Option<&str>, u: &Tokens5, at: i64, tier: Option<Option<f64>>) -> Priced {
    let key = match resolve(table, aliases, provider, model, response_model, at) {
        Resolved::Free(w) => return Priced::Free(w),
        Resolved::Unpriced(w) => return Priced::Unpriced(w),
        Resolved::Key(k) => k,
    };
    let Some(period) = period_at(&table.models[&key], at) else {
        return Priced::Unpriced(format!("models.dev lists no price for {key}"));
    };
    let chosen: Option<&Tier> = match tier {
        Some(None) => None,
        Some(Some(x)) => period.tiers.iter().find(|t| t.input_above == x),
        None => {
            let req = (u[0] + u[2] + u[3] + u[4]) as f64;
            let mut best: Option<&Tier> = None;
            for t in &period.tiers {
                if req > t.input_above && best.map_or(true, |b| t.input_above > b.input_above) {
                    best = Some(t);
                }
            }
            best
        }
    };
    let rates = chosen.map(|t| &t.rates).unwrap_or(&period.rates);
    let mut usd = [0f64; 5];
    let mut total = 0f64;
    for k in 0..5 {
        if u[k] == 0 {
            continue;
        }
        if let Some(r) = rate_for(k, rates, &period.rates) {
            usd[k] = u[k] as f64 * r / 1e6;
            total += usd[k];
        }
    }
    Priced::Priced { key, period: period.from.clone(), tier: chosen.map(|t| t.input_above), usd, total }
}
