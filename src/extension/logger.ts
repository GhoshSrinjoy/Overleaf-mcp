import * as vscode from 'vscode';
import { Logger, formatDetails } from '../core/util/log';

export function createOutputLogger(channel: vscode.LogOutputChannel): Logger {
  const join = (message: string, details: unknown[]) => (details.length ? `${message} ${formatDetails(details)}` : message);
  return {
    debug: (message, ...details) => channel.debug(join(message, details)),
    info: (message, ...details) => channel.info(join(message, details)),
    warn: (message, ...details) => channel.warn(join(message, details)),
    error: (message, ...details) => channel.error(join(message, details)),
  };
}
