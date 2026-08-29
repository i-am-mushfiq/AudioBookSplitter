import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PIPELINE_RESTARTS, nextWatchdogDelay, shouldRestartPipeline } from "../desktop/pipeline-watchdog.mjs";

test("watchdog restarts only abnormal non-terminal exits", () => {
  assert.equal(shouldRestartPipeline({ exitCode: 1, paused: false, quitting: false, terminalState: "interrupted", attempt: 0 }), true);
  assert.equal(shouldRestartPipeline({ exitCode: 0, paused: false, quitting: false, terminalState: "complete", attempt: 0 }), false);
  assert.equal(shouldRestartPipeline({ exitCode: 2, paused: true, quitting: false, terminalState: "paused", attempt: 0 }), false);
  assert.equal(shouldRestartPipeline({ exitCode: 1, paused: false, quitting: false, terminalState: "attention", attempt: 0 }), false);
  assert.equal(shouldRestartPipeline({ exitCode: 1, paused: false, quitting: true, terminalState: "interrupted", attempt: 0 }), false);
});

test("watchdog backoff is bounded and stops after the retry budget", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(nextWatchdogDelay), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(shouldRestartPipeline({ exitCode: 1, paused: false, quitting: false,
    terminalState: "interrupted", attempt: MAX_PIPELINE_RESTARTS }), false);
});
