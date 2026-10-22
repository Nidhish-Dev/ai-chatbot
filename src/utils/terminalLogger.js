const { inspect } = require('node:util');

const REDACTED = '[REDACTED]';
const MAX_LOG_STRING_LENGTH = 12000;

function sanitize(value, key = '') {
  if (/api.?key|masked.?key|private.?key|authorization|secret|token|base64|file.?data/i.test(key)) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return value.length > MAX_LOG_STRING_LENGTH
      ? `${value.slice(0, MAX_LOG_STRING_LENGTH)}… [truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }
  return value;
}

function summarizeResponse(value) {
  if (!value || typeof value !== 'object' || !value.config) return sanitize(value);
  const { config, ...rest } = value;
  const safeRest = { ...rest };
  if (safeRest.openai) {
    safeRest.openai = {
      hasKey: !!safeRest.openai.hasKey,
      model: safeRest.openai.model
    };
  }
  return {
    ...sanitize(safeRest),
    config: {
      clientId: config.clientId,
      active: config.active,
      promptVersion: config.promptVersion,
      faqCount: Array.isArray(config.faqs) ? config.faqs.length : 0,
      draftFaqCount: Array.isArray(config.draft?.faqs) ? config.draft.faqs.length : 0,
      knowledgeDocumentCount: Array.isArray(config.knowledgeDocuments) ? config.knowledgeDocuments.length : 0,
      hasDraft: !!config.draft
    }
  };
}

function parseEventStream(streamText) {
  const events = [];
  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      events.push({ type: 'unparsed', text: line.slice(6) });
    }
  }
  const reply = events.filter(event => event.type === 'delta').map(event => event.text || '').join('');
  const completed = events.find(event => event.type === 'done');
  return { streamed: true, reply: completed?.reply || reply, completion: completed || null };
}

function logRequest(req, res, next) {
  const startedAt = Date.now();
  const requestId = `req_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  let responseBody;
  let streamedText = '';
  const originalJson = res.json.bind(res);
  const originalWrite = res.write.bind(res);

  req.requestId = requestId;
  res.json = body => {
    responseBody = body;
    return originalJson(body);
  };
  res.write = (...args) => {
    const chunk = args[0];
    streamedText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    return originalWrite(...args);
  };

  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    const durationMs = Date.now() - startedAt;
    const requestData = { query: sanitize(req.query || {}), body: sanitize(req.body || {}) };
    const responseData = responseBody !== undefined
      ? summarizeResponse(responseBody)
      : (streamedText ? parseEventStream(streamedText) : undefined);
    const inspectOptions = {
      depth: null,
      colors: Boolean(process.stdout.isTTY),
      compact: false,
      breakLength: 100,
      maxArrayLength: null,
      maxStringLength: MAX_LOG_STRING_LENGTH
    };

    console.log(`\n${'─'.repeat(76)}\n[${new Date().toISOString()}] ${level} ${req.method} ${req.path} → ${res.statusCode} (${durationMs} ms)\nRequest ID: ${requestId}\nRequest:\n${inspect(requestData, inspectOptions)}\nResponse:\n${inspect(responseData, inspectOptions)}\n${'─'.repeat(76)}`);
  });

  next();
}

module.exports = { logRequest, sanitize, summarizeResponse, parseEventStream };
