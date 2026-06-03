import { ApiError } from './errors.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Content-Type': 'application/json',
};

export const json = (res, statusCode, payload) => {
  res.writeHead(statusCode, corsHeaders);
  res.end(JSON.stringify(payload));
};

export const readJson = async (req, maxBytes = 1_000_000) => {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON');
  }
};
