// Deliberately no general-purpose logger: only the fields below may leave the
// application. Audio, headers, cookies and provider response/error bodies never do.
const ENDPOINT = 'https://api.axiom.co';
const EVENTS = new Set(['transcription.completed', 'transcription.failed', 'realtime.session.completed', 'realtime.session.failed', 'fact_check.completed', 'fact_check.failed']);
const VERDICTS = new Set(['true', 'false', 'misleading', 'unverifiable']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

export function redactTranscript(value, env = process.env, limit = 6000) {
  if (typeof value !== 'string') return undefined;
  let result = value;
  // Known configured secrets are removed even when spoken/pasted without a label.
  for (const [key, secret] of Object.entries(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && typeof secret === 'string' && secret.length >= 8) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  result = result
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|xaat-|xapt-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(api[_ -]?key|password|secret|access[_ -]?token|session[_ -]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]');
  return result.slice(0, limit);
}

export function telemetryCorrelation(req) {
  return {
    sessionId: identifier(req.headers['x-session-id']),
    transcriptRunId: identifier(req.headers['x-transcript-run-id']),
    chunkIndex: identifier(req.headers['x-transcript-chunk-index']),
    segmentId: identifier(req.headers['x-segment-id']),
    revision: identifier(req.headers['x-segment-revision']),
  };
}

export function createTranscriptLogger({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 1500, warn = (...args) => console.warn(...args) } = {}) {
  const enabled = env.AXIOM_TRANSCRIPT_LOGGING === 'true' && Boolean(env.AXIOM_TOKEN && env.AXIOM_DATASET);
  const log = async (event, fields = {}) => {
    if (!enabled || !EVENTS.has(event)) return false;
    const record = { _time: new Date().toISOString(), service: 'factcheckme', schemaVersion: 1, event };
    for (const key of ['requestId', 'sessionId', 'transcriptRunId', 'chunkIndex', 'segmentId', 'revision']) {
      const value = identifier(fields[key]); if (value !== undefined) record[key] = value;
    }
    for (const key of ['durationMs', 'audioBytes', 'textLength', 'claimLength', 'contextLength']) {
      if (Number.isSafeInteger(fields[key]) && fields[key] >= 0) record[key] = fields[key];
    }
    for (const [key, limit] of [['text', 16000], ['claim', 2000], ['context', 6000]]) {
      const value = redactTranscript(fields[key], env, limit);
      if (value !== undefined) { record[key] = value; if (fields[key].length > limit) record[`${key}Truncated`] = true; }
    }
    if (typeof fields.noClaim === 'boolean') record.noClaim = fields.noClaim;
    if (fields.incomplete === true) record.incomplete = true;
    if (VERDICTS.has(fields.verdict)) record.verdict = fields.verdict;
    if (Number.isFinite(fields.confidence) && fields.confidence >= 0 && fields.confidence <= 100) record.confidence = fields.confidence;
    // Never copy an error's message/code blindly: providers can echo credentials.
    if (['configuration_error', 'provider_error', 'provider_timeout', 'request_timeout', 'client_disconnected'].includes(fields.errorCode)) record.errorCode = fields.errorCode;
    if (Number.isInteger(fields.statusCode) && fields.statusCode >= 100 && fields.statusCode <= 599) record.statusCode = fields.statusCode;
    let timer;
    const controller = new AbortController();
    try {
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('telemetry_timeout')); }, timeoutMs);
      });
      const request = (async () => {
        const response = await fetchImpl(`${ENDPOINT}/v1/datasets/${encodeURIComponent(env.AXIOM_DATASET)}/ingest`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${env.AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([record]),
        });
        if (!response.ok) return false;
        const result = await response.json();
        return result?.ingested === 1 && result?.failed === 0;
      })();
      const accepted = await Promise.race([request, timedOut]);
      if (!accepted) warn('FactCheckMe telemetry failure', 'ingest_rejected');
      return accepted;
    } catch {
      warn('FactCheckMe telemetry failure', controller.signal.aborted ? 'ingest_timeout' : 'ingest_failed');
      return false;
    } finally { clearTimeout(timer); }
  };
  log.enabled = enabled;
  return log;
}
