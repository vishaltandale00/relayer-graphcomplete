export function createGraphSimulationController({
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
} = {}) {
  let frame;
  let generation = 0;

  const cancel = () => {
    generation += 1;
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  };

  const start = (step) => {
    cancel();
    const runGeneration = generation;
    const tick = () => {
      if (runGeneration !== generation) return;
      frame = undefined;
      const continueRunning = step();
      if (continueRunning && runGeneration === generation) {
        frame = requestFrame(tick);
      }
    };
    tick();
  };

  return Object.freeze({ cancel, start });
}
