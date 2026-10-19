// Announcements contain no catalog or readiness authority. Progress only changes
// presentation; renderers still reread committed availability before admitting use.
export function createModelAvailabilityPublisher({ publishCatalog, publishReadiness, getWindow }) {
  function announce() {
    try {
      getWindow()?.webContents.send("relayer:models-changed");
    } catch {
      // A closed window must not turn a committed publication into a failure.
    }
  }
  const afterCommit = (publish) => async (...args) => {
    const result = await publish(...args);
    announce();
    return result;
  };
  return Object.freeze({
    notifyReadinessProgress: announce,
    publishCatalog: afterCommit(publishCatalog),
    publishReadiness: afterCommit(publishReadiness),
  });
}
