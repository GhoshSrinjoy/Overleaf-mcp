export type OverleafErrorCode =
  | 'NOT_LOGGED_IN'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'PROTOCOL'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'HTTP';

/** Errors carry a message meant to be shown as-is to a person or an AI agent. */
export class OverleafError extends Error {
  readonly code: OverleafErrorCode;
  readonly status?: number;

  constructor(code: OverleafErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OverleafError';
    this.code = code;
    this.status = options.status;
  }
}

export function notLoggedIn(serverUrl?: string): OverleafError {
  const where = serverUrl ? ` (${serverUrl})` : '';
  return new OverleafError(
    'NOT_LOGGED_IN',
    `Not signed in to Overleaf${where}, or the session has expired. Use the sign_in tool (it opens the Overleaf login page), or sign in from the Overleaf panel in VS Code.`,
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  return typeof error === 'object' && error !== null && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}
