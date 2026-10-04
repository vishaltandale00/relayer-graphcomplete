// Announce only committed product state. The announcement contains no catalog or
// readiness authority; renderers reread the app server, including after startup.
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
    publishCatalog: afterCommit(publishCatalog),
    publishReadiness: afterCommit(publishReadiness),
  });
}
