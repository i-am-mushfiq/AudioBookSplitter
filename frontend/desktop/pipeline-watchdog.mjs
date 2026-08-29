export const MAX_PIPELINE_RESTARTS = 5;

export function nextWatchdogDelay(attempt) {
  return Math.min(30000, 2000 * (2 ** Math.max(0, attempt)));
}

export function shouldRestartPipeline({ exitCode, paused, quitting, terminalState, attempt }) {
  if (paused || quitting || exitCode === 0 || exitCode === 2) return false;
  if (["complete", "attention", "waiting_upload", "paused"].includes(terminalState)) return false;
  return attempt < MAX_PIPELINE_RESTARTS;
}
