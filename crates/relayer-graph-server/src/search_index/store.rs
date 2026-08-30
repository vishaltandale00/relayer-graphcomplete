//! Opening the Ladybug store, and running work against it.
//!
//! `lbug`'s Rust surface is blocking FFI, and a `Connection` borrows the
//! `Database` it came from. Both are therefore owned by one worker thread that
//! keeps them on its own stack, and callers submit jobs to it. That keeps the
//! engine off the async runtime's threads and lets a handle to the store be
//! `Send + 'static` without a self-referential struct.

use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::mpsc::{Sender, channel},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow};
use lbug::{Connection, Database, SystemConfig, Value};
use tokio::sync::oneshot;

use super::value::{EndpointIds, string_property};

/// `<db>.ladybug/{active,quarantine}/`, a sibling of the SQLite file the store
/// derives from, so the pair travels together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreLayout {
    root: PathBuf,
}

impl StoreLayout {
    pub fn beside(database: &Path) -> Self {
        let mut root = OsString::from(database.as_os_str());
        root.push(".ladybug");
        Self {
            root: PathBuf::from(root),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The atomic pointer naming the generation that answers queries and writes.
    pub fn active(&self) -> PathBuf {
        self.root.join("active")
    }

    pub fn generations(&self) -> PathBuf {
        self.root.join("generations")
    }

    /// Where a store that will not open, or whose versions are incompatible, is
    /// moved before being rebuilt from SQLite. Reserved here; #302 owns the move.
    pub fn quarantine(&self) -> PathBuf {
        self.root.join("quarantine")
    }

    pub fn rollback(&self) -> PathBuf {
        self.root.join("rollback")
    }

    pub fn active_generation(&self) -> Result<Option<PathBuf>> {
        let pointer = self.active();
        reject_symlink_if_present(&pointer)?;
        let name = match fs::read_to_string(&pointer) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("read active Ladybug generation"),
        };
        let name = name.trim();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err(anyhow!("active Ladybug generation pointer is invalid"));
        }
        let generation = self.generations().join(name);
        self.validate_generation_reference(&generation)?;
        Ok(Some(generation))
    }

    /// Copy the pre-generation `active` database and all of its sidecars into a
    /// generation without disturbing the bytes startup may still need to keep.
    pub fn snapshot_legacy_active(&self) -> Result<Option<PathBuf>> {
        if !self.active().exists() {
            return Ok(None);
        }
        // A syntactically readable pointer is a damaged generation layout, not
        // the pre-generation Ladybug database. Never reinterpret attacker-
        // controlled text as legacy database bytes.
        match fs::read_to_string(self.active()) {
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {}
            Err(error) => return Err(error.into()),
        }
        let generation = self.create_generation()?;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(suffix) = name.strip_prefix("active") else {
                continue;
            };
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(anyhow!("legacy Ladybug store contains a symlink"));
            }
            if !kind.is_file() {
                continue;
            }
            let target = generation.join(format!("store{suffix}"));
            fs::copy(entry.path(), &target)?;
            fs::File::open(target)?.sync_all()?;
        }
        sync_directory(&generation)?;
        Ok(Some(generation))
    }

    pub fn remove_legacy_sidecars(&self) -> Result<()> {
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with("active")
                && entry.path() != self.active()
                && entry.file_type()?.is_file()
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }

    pub fn create_generation(&self) -> Result<PathBuf> {
        reject_symlink_if_present(&self.root)?;
        fs::create_dir_all(self.generations())?;
        ensure_plain_directory(&self.root)?;
        ensure_plain_directory(&self.generations())?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let generation = self
            .generations()
            .join(format!("generation-{}-{nonce}", std::process::id()));
        if generation.exists() {
            return Err(anyhow!("new Ladybug generation already exists"));
        }
        fs::create_dir(&generation)?;
        sync_directory(&self.generations())?;
        Ok(generation)
    }

    pub fn publish(&self, generation: &Path) -> Result<()> {
        self.validate_generation_path(generation)?;
        sync_tree(generation)?;
        sync_directory(&self.generations())?;
        let name = generation
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("Ladybug generation has no portable name"))?;
        if generation.parent() != Some(self.generations().as_path()) {
            return Err(anyhow!("Ladybug generation is outside its store layout"));
        }
        fs::create_dir_all(&self.root)?;
        ensure_plain_directory(&self.root)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let next = self
            .root
            .join(format!(".active-next-{}-{nonce}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&next)?;
        file.write_all(format!("{name}\n").as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&next, self.active())?;
        sync_directory(&self.root)?;
        Ok(())
    }

    pub fn retain_previous(&self, previous: &Path, quarantine: bool) -> Result<()> {
        if !previous.exists() {
            return Ok(());
        }
        self.validate_generation_path(previous)?;
        let destination_root = if quarantine {
            self.quarantine()
        } else {
            self.rollback()
        };
        fs::create_dir_all(&destination_root)?;
        ensure_plain_directory(&destination_root)?;
        let name = previous
            .file_name()
            .ok_or_else(|| anyhow!("previous Ladybug generation has no name"))?;
        let retained = destination_root.join(name);
        fs::rename(previous, &retained)?;
        sync_directory(&self.generations())?;
        sync_directory(&destination_root)?;
        if quarantine {
            fs::create_dir_all(self.rollback())?;
            ensure_plain_directory(&self.rollback())?;
            copy_generation(&retained, &self.rollback().join(name))?;
            sync_directory(&self.rollback())?;
        }
        Ok(())
    }

    pub fn validate_generation_path(&self, generation: &Path) -> Result<()> {
        self.validate_generation_reference(generation)?;
        ensure_plain_directory(generation)?;
        Ok(())
    }

    fn validate_generation_reference(&self, generation: &Path) -> Result<()> {
        ensure_plain_directory(&self.generations())?;
        if generation.parent() != Some(self.generations().as_path()) {
            return Err(anyhow!("Ladybug generation is outside its store layout"));
        }
        match fs::symlink_metadata(generation) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(anyhow!(
                    "Ladybug directory is not a confined plain directory: {}",
                    generation.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        reject_symlink_if_present(&generation.join("store"))?;
        Ok(())
    }
}

fn copy_generation(source: &Path, destination: &Path) -> Result<()> {
    ensure_plain_directory(source)?;
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if kind.is_symlink() {
            return Err(anyhow!(
                "Ladybug generation contains an unsupported symlink"
            ));
        } else if kind.is_dir() {
            copy_generation(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
            fs::File::open(target)?.sync_all()?;
        } else {
            return Err(anyhow!(
                "Ladybug generation contains an unsupported file type"
            ));
        }
    }
    sync_directory(destination)?;
    Ok(())
}

fn sync_tree(path: &Path) -> Result<()> {
    ensure_plain_directory(path)?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(anyhow!("Ladybug generation contains a symlink"));
        }
        if kind.is_dir() {
            sync_tree(&entry.path())?;
        } else if kind.is_file() {
            fs::File::open(entry.path())?.sync_all()?;
        } else {
            return Err(anyhow!(
                "Ladybug generation contains an unsupported file type"
            ));
        }
    }
    sync_directory(path)
}

fn reject_symlink_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(anyhow!(
            "Ladybug path must not be a symlink: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_plain_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspect Ladybug directory {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "Ladybug directory is not a confined plain directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    ensure_plain_directory(path)?;
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

/// A unit of work to run against the store's connection, on the worker thread.
type Job = Box<dyn for<'connection> FnOnce(&Connection<'connection>) + Send>;

/// An open Ladybug store. Dropping it shuts the worker down and closes the
/// database, releasing its file lock.
pub struct LadybugStore {
    jobs: Option<Sender<Job>>,
    worker: Option<JoinHandle<()>>,
    layout: StoreLayout,
    query_timeout: Duration,
}

impl LadybugStore {
    /// Open, creating the store directory and its schema when it is not there
    /// yet. The store is left empty rather than seeded; closures arrive through
    /// the write path.
    ///
    /// `query_timeout` is pushed into the engine as well as being enforced by the
    /// caller's deadline, so a stuck statement aborts inside Ladybug rather than
    /// leaving the worker thread blocked with the SQLite write lock held.
    pub fn open(layout: StoreLayout, query_timeout: Duration) -> Result<Self> {
        reject_symlink_if_present(&layout.root)?;
        fs::create_dir_all(&layout.root)
            .with_context(|| format!("create Ladybug store at {}", layout.root.display()))?;
        ensure_plain_directory(&layout.root)?;
        let active = match layout.active_generation()? {
            Some(active) => active,
            None => {
                let active = layout.create_generation()?;
                layout.publish(&active)?;
                active
            }
        };
        Self::open_path(layout, active, query_timeout)
    }

    pub fn open_path(
        layout: StoreLayout,
        generation: PathBuf,
        query_timeout: Duration,
    ) -> Result<Self> {
        layout.validate_generation_path(&generation)?;
        let active = generation.join("store");
        let existed = active.exists();
        let (ready, opened) = channel();
        let (jobs, queue) = channel::<Job>();
        let worker = thread::Builder::new()
            .name("ladybug-search-index".into())
            .spawn(move || {
                // The database and its connection live on this thread's stack for
                // the worker's whole life, so the borrow never leaves the thread.
                let database = match Database::new(&active, SystemConfig::default())
                    .with_context(|| format!("open Ladybug store at {}", active.display()))
                {
                    Ok(database) => database,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                let connection = match Connection::new(&database).context("connect Ladybug store") {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                connection.set_query_timeout(
                    u64::try_from(query_timeout.as_millis()).unwrap_or(u64::MAX),
                );
                if !existed && let Err(error) = super::schema::create(&connection) {
                    let _ = ready.send(Err(error));
                    return;
                }
                if ready.send(Ok(())).is_err() {
                    return;
                }
                // Ends when the last sender is dropped, which is what closes the
                // database and releases its lock.
                for job in queue {
                    job(&connection);
                }
            })
            .context("start the Ladybug worker thread")?;
        match opened.recv() {
            Ok(Ok(())) => Ok(Self {
                jobs: Some(jobs),
                worker: Some(worker),
                layout,
                query_timeout,
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err(anyhow!(
                    "the Ladybug worker stopped before the store opened"
                ))
            }
        }
    }

    pub fn layout(&self) -> &StoreLayout {
        &self.layout
    }

    /// Run one job against the store and await its result.
    pub async fn run<T, F>(&self, job: F) -> Result<T>
    where
        F: for<'connection> FnOnce(&Connection<'connection>) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        self.run_undoable(job, |_| {}).await
    }

    /// Run engine work under the remaining time of one outer operation, then
    /// restore the store's ordinary query timeout for unrelated work.
    pub async fn run_until<T, F>(&self, deadline: Instant, job: F) -> Result<T>
    where
        F: for<'connection> FnOnce(&Connection<'connection>) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        self.run_undoable_until(deadline, job, |_| {}).await
    }

    /// Run a job whose effect has to be undone when nobody is waiting for it any
    /// more.
    ///
    /// A queued job runs whether or not its caller is still there: a deadline
    /// that expires, or a request that is cancelled, drops the reply channel but
    /// cannot stop the work. `undo` runs on the same connection, immediately
    /// after, when the job succeeded and the answer had nowhere to go. Without it
    /// an abandoned `BEGIN TRANSACTION` would leave the store holding an open
    /// transaction that fails every later write.
    pub async fn run_undoable<T, F, U>(&self, job: F, undo: U) -> Result<T>
    where
        F: for<'connection> FnOnce(&Connection<'connection>) -> Result<T> + Send + 'static,
        U: for<'connection> FnOnce(&Connection<'connection>) + Send + 'static,
        T: Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        self.submit(Box::new(move |connection| {
            let outcome = job(connection);
            let took_effect = outcome.is_ok();
            if reply.send(outcome).is_err() && took_effect {
                undo(connection);
            }
        }))?;
        answer
            .await
            .map_err(|_| anyhow!("the Ladybug worker dropped the job"))?
    }

    pub async fn run_undoable_until<T, F, U>(&self, deadline: Instant, job: F, undo: U) -> Result<T>
    where
        F: for<'connection> FnOnce(&Connection<'connection>) -> Result<T> + Send + 'static,
        U: for<'connection> FnOnce(&Connection<'connection>) + Send + 'static,
        T: Send + 'static,
    {
        if deadline <= Instant::now() {
            return Err(anyhow!("the Ladybug operation deadline expired"));
        }
        let default_timeout = self.query_timeout;
        let (reply, answer) = oneshot::channel();
        self.submit(Box::new(move |connection| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            connection
                .set_query_timeout(u64::try_from(remaining.as_millis().max(1)).unwrap_or(u64::MAX));
            let outcome = job(connection);
            connection
                .set_query_timeout(u64::try_from(default_timeout.as_millis()).unwrap_or(u64::MAX));
            let took_effect = outcome.is_ok();
            if reply.send(outcome).is_err() && took_effect {
                undo(connection);
            }
        }))?;
        answer
            .await
            .map_err(|_| anyhow!("the Ladybug worker dropped the job"))?
    }

    /// Queue a job without waiting for it. Used to release an abandoned
    /// transaction from a `Drop`, where there is nothing left to await with.
    pub fn detach<F>(&self, job: F)
    where
        F: for<'connection> FnOnce(&Connection<'connection>) + Send + 'static,
    {
        let _ = self.submit(Box::new(job));
    }

    fn submit(&self, job: Job) -> Result<()> {
        self.jobs
            .as_ref()
            .ok_or_else(|| anyhow!("the Ladybug store is closing"))?
            .send(job)
            .map_err(|_| anyhow!("the Ladybug worker is gone"))
    }
}

impl Drop for LadybugStore {
    fn drop(&mut self) {
        // Dropping the sender ends the worker loop, which drops the connection
        // and then the database, releasing the store's file lock.
        self.jobs = None;
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Run a statement for its effect.
pub fn exec(connection: &Connection<'_>, query: &str) -> Result<()> {
    connection
        .query(query)
        .with_context(|| format!("Ladybug statement failed: {query}"))?;
    Ok(())
}

/// Collect a read-only query's rows, refusing anything the engine does not parse
/// as read-only.
pub fn rows(connection: &Connection<'_>, query: &str) -> Result<Vec<Vec<Value>>> {
    let prepared = connection
        .prepare(query)
        .with_context(|| format!("prepare {query}"))?;
    if !prepared.is_read_only() {
        return Err(anyhow!("query was not parsed read-only: {query}"));
    }
    let mut result = connection.query(query)?;
    Ok((&mut result).map(|row| row.to_vec()).collect())
}

/// Map every stored node's engine-internal identity to its Relayer identity, so
/// relationships can name their endpoints.
pub fn endpoint_index(connection: &Connection<'_>) -> Result<EndpointIds> {
    let mut index = EndpointIds::new();
    for query in ["MATCH (n:Content) RETURN n", "MATCH (n:Layer) RETURN n"] {
        for row in rows(connection, query)? {
            let Value::Node(node) = &row[0] else {
                return Err(anyhow!("endpoint index query returned a non-node"));
            };
            index.insert(
                node.get_node_id().clone(),
                string_property(node.get_properties(), "id")?,
            );
        }
    }
    Ok(index)
}
