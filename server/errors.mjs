export class ApiError extends Error {
  constructor(statusCode, code, message, { expose = true } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

export const toPublicError = (error) => {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: error.expose ? error.message : 'Internal server error',
        code: error.code,
      },
    };
  }

  const message = error instanceof Error ? error.message : 'Unknown error';
  if (message.includes('is not configured')) {
    return {
      statusCode: 503,
      payload: {
        error: message,
        code: 'configuration_error',
      },
    };
  }

  if (message.startsWith('Gemini API error') || message.startsWith('Mistral')) {
    return {
      statusCode: 502,
      payload: {
        error: 'Upstream provider request failed',
        code: 'provider_error',
      },
    };
  }

  return {
    statusCode: 500,
    payload: {
      error: 'Internal server error',
      code: 'internal_error',
    },
  };
};
