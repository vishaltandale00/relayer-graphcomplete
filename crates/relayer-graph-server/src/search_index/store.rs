//! Opening the Ladybug store, and running work against it.
//!
//! `lbug`'s Rust surface is blocking FFI, and a `Connection` borrows the
//! `Database` it came from. Both are therefore owned by one worker thread that
//! keeps them on its own stack, and callers submit jobs to it. That keeps the
//! engine off the async runtime's threads and lets a handle to the store be
//! `Send + 'static` without a self-referential struct.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::mpsc::{Sender, channel},
    thread::{self, JoinHandle},
    time::Duration,
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

    /// The store that answers queries and takes writes.
    pub fn active(&self) -> PathBuf {
        self.root.join("active")
    }

    /// Where a store that will not open, or whose versions are incompatible, is
    /// moved before being rebuilt from SQLite. Reserved here; #302 owns the move.
    pub fn quarantine(&self) -> PathBuf {
        self.root.join("quarantine")
    }
}

/// A unit of work to run against the store's connection, on the worker thread.
type Job = Box<dyn for<'connection> FnOnce(&Connection<'connection>) + Send>;

/// An open Ladybug store. Dropping it shuts the worker down and closes the
/// database, releasing its file lock.
pub struct LadybugStore {
    jobs: Option<Sender<Job>>,
    worker: Option<JoinHandle<()>>,
    layout: StoreLayout,
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
        let active = layout.active();
        fs::create_dir_all(&layout.root)
            .with_context(|| format!("create Ladybug store at {}", layout.root.display()))?;
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
