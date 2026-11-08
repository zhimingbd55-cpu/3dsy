import { flowLimits } from './tryon-flow.mjs';

// Old recordings retain their original validation tolerance. New recordings
// receive only the budget persisted by the server, never a client duration.
export function recordingPolicy(session = {}) {
  const maxSeconds = flowLimits(session).recordingSeconds;
  const modern = Number(session.flow_version) > 0;
  const expected = Number(session.expected_recording_seconds);
  return {
    maxSeconds,
    maxInputSeconds: modern ? maxSeconds + 5 : 50,
    expectedSeconds: modern && expected > 0 ? Math.min(maxSeconds, expected) : modern && session.flow_mode === 'auto' ? 0 : 30,
    transcodeTimeoutMs: Math.max(120000, maxSeconds * 3000),
  };
}

export function recordingIsShort(session, recordings) {
  const expected = recordingPolicy(session).expectedSeconds;
  return expected > 0 && recordings.some(row => Number(row.duration) < Math.max(0, expected - 0.7));
}

export function posterTime(session, segments, duration) {
  const start = session.recording_started_at ?? session.first_frame_at;
  if (!(start > 0) || !(duration > 0)) return 0;
  const stable = segments.filter(row => Number(row.stable_at) > 0);
  const segment = [...stable].reverse().find(row => row.mode === 'fixed' || row.is_locked === 1) || stable[0];
  if (!segment) return 0;
  return Math.min(Math.max(0, duration - 0.1), Math.max(0, (segment.stable_at - start) / 1000) + 0.5);
}
