#![cfg(feature = "ladybug")]

#[path = "../tests/support/search_index_corpus.rs"]
mod corpus;

use std::{path::PathBuf, process::ExitCode, sync::Arc, time::Instant};

use corpus::{CorpusCounts, CorpusShape, DEFAULT_SAMPLES, DEFAULT_SEED, DEFAULT_WARMUPS};
use relayer_graph_core::GraphDatabase;
use relayer_graph_server::search_index::LadybugSearchIndex;
use serde::Serialize;

const THRESHOLD_NS: u64 = 100_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    ordinal: usize,
    case_id: String,
    shape: CorpusShape,
    project_id: Option<i64>,
    thread_id: i64,
    counts: CorpusCounts,
    duration_ns: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Percentiles {
    p50_ns: u64,
    p90_ns: u64,
    p95_ns: u64,
    p99_ns: u64,
    max_ns: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema_version: u32,
    source_commit: String,
    target_os: &'static str,
    target_arch: &'static str,
    profile: &'static str,
    lbug_version: &'static str,
    corpus_version: u32,
    seed: u64,
    manifest_sha256: String,
    warmups: usize,
    measured_samples: usize,
    store_open_ns: u64,
    percentile_algorithm: &'static str,
    threshold_ns: u64,
    percentiles: Percentiles,
    over_threshold_ordinals: Vec<usize>,
    tukey_upper_fence_ns: u64,
    tukey_outlier_ordinals: Vec<usize>,
    samples: Vec<Sample>,
    passed: bool,
}

struct Options {
    seed: u64,
    warmups: usize,
    samples: usize,
    source_commit: String,
    output: PathBuf,
}

fn options() -> Result<Options, String> {
    let mut seed = DEFAULT_SEED;
    let mut warmups = DEFAULT_WARMUPS;
    let mut samples = DEFAULT_SAMPLES;
    let mut source_commit = None;
    let mut output = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--bench" {
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("{argument} requires a value"))?;
        match argument.as_str() {
            "--seed" => seed = value.parse().map_err(|_| "invalid --seed".to_owned())?,
            "--warmups" => warmups = value.parse().map_err(|_| "invalid --warmups".to_owned())?,
            "--samples" => samples = value.parse().map_err(|_| "invalid --samples".to_owned())?,
            "--source-commit" => source_commit = Some(value),
            "--output" => output = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {argument}")),
        }
    }
    let source_commit = source_commit.ok_or("--source-commit is required")?;
    if source_commit.len() != 40 || !source_commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("--source-commit must be a 40-character Git object id".into());
    }
    if samples < 20 {
        return Err("--samples must be at least 20".into());
    }
    Ok(Options {
        seed,
        warmups,
        samples,
        source_commit,
        output: output.ok_or("--output is required")?,
    })
}

fn percentile(sorted: &[u64], percentile: usize) -> u64 {
    let rank = (percentile * sorted.len()).div_ceil(100);
    sorted[rank.saturating_sub(1)]
}

fn duration_ns(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!("Ladybug save-latency p95 did not stay below 100 ms");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<bool> {
    let options = options().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64",
        "the qualifying benchmark runs only on macOS Apple Silicon"
    );
    let directory = tempfile::tempdir()?;
    let sqlite = directory.path().join("graph.db");
    let opened = Instant::now();
    let index = Arc::new(LadybugSearchIndex::open(&sqlite)?);
    let database = GraphDatabase::open_with_index(&sqlite, index).await?;
    let store_open_ns = duration_ns(opened);
    let all_cases = corpus::cases(options.seed, options.warmups + options.samples);

    for case in all_cases.iter().take(options.warmups) {
        corpus::author_and_complete(&database, case).await?;
    }

    let mut samples = Vec::with_capacity(options.samples);
    for case in all_cases.iter().skip(options.warmups) {
        let prepared = corpus::prepare_case(&database, case).await?;
        let started = Instant::now();
        prepared.writer.complete(prepared.interaction_id).await?;
        samples.push(Sample {
            ordinal: case.ordinal,
            case_id: case.id.clone(),
            shape: case.shape,
            project_id: case.project_id,
            thread_id: case.thread_id,
            counts: prepared.counts,
            duration_ns: duration_ns(started),
        });
    }

    let mut sorted = samples
        .iter()
        .map(|sample| sample.duration_ns)
        .collect::<Vec<_>>();
    sorted.sort_unstable();
    let p95_ns = percentile(&sorted, 95);
    let q1 = percentile(&sorted, 25);
    let q3 = percentile(&sorted, 75);
    let tukey_upper_fence_ns = q3.saturating_add((q3.saturating_sub(q1) * 3) / 2);
    let receipt = Receipt {
        schema_version: 1,
        source_commit: options.source_commit,
        target_os: std::env::consts::OS,
        target_arch: std::env::consts::ARCH,
        profile: "release",
        lbug_version: "0.18.0",
        corpus_version: corpus::CORPUS_VERSION,
        seed: options.seed,
        manifest_sha256: corpus::manifest_sha256(options.seed, options.warmups + options.samples),
        warmups: options.warmups,
        measured_samples: samples.len(),
        store_open_ns,
        percentile_algorithm: "nearest-rank",
        threshold_ns: THRESHOLD_NS,
        percentiles: Percentiles {
            p50_ns: percentile(&sorted, 50),
            p90_ns: percentile(&sorted, 90),
            p95_ns,
            p99_ns: percentile(&sorted, 99),
            max_ns: *sorted.last().unwrap(),
        },
        over_threshold_ordinals: samples
            .iter()
            .filter(|sample| sample.duration_ns >= THRESHOLD_NS)
            .map(|sample| sample.ordinal)
            .collect(),
        tukey_upper_fence_ns,
        tukey_outlier_ordinals: samples
            .iter()
            .filter(|sample| sample.duration_ns > tukey_upper_fence_ns)
            .map(|sample| sample.ordinal)
            .collect(),
        samples,
        passed: p95_ns < THRESHOLD_NS,
    };
    if let Some(parent) = options.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&options.output, serde_json::to_vec_pretty(&receipt)?)?;
    println!("wrote {}", options.output.display());
    Ok(receipt.passed)
}
