import {
  createErrorDeduper,
  describeError,
  ERROR_MESSAGE_MAX_LENGTH,
  ERROR_STACK_MAX_LENGTH,
  type ScrubOptions,
  scrubErrorMessage,
} from "../src/lib/errorReporting";
import type { MainErrorReport } from "../src/types/desktop";

/** The part of Electron's WebContents the reporter needs. */
export interface MainErrorTarget {
  send(channel: string, report: MainErrorReport): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface MainErrorReporterOptions extends ScrubOptions {
  channel: string;
  maxBuffered?: number;
  dedupeWindowMs?: number;
  now?: () => number;
}

export interface MainErrorReporter {
  /** Queues an error for the renderer, which reports it through PostHog (or drops it when analytics is off). */
  report(source: string, error: unknown): void;
  /** Called when a renderer starts listening; flushes buffered errors to it. */
  attach(target: MainErrorTarget): void;
}

/**
 * Main-process errors are reported by the renderer, so they share its anonymous device id,
 * scrubbing and opt-out. Until a window is listening they wait in a bounded buffer.
 */
export function createMainErrorReporter(options: MainErrorReporterOptions): MainErrorReporter {
  const maxBuffered = options.maxBuffered ?? 50;
  const shouldReport = createErrorDeduper(options.dedupeWindowMs ?? 60_000, options.now);
  const buffer: MainErrorReport[] = [];
  let target: MainErrorTarget | null = null;

  const deliver = (report: MainErrorReport): boolean => {
    if (!target || target.isDestroyed()) return false;
    try {
      target.send(options.channel, report);
      return true;
    } catch {
      return false;
    }
  };

  const flush = () => {
    while (buffer.length > 0) {
      const next = buffer[0];
      if (!next || !deliver(next)) return;
      buffer.shift();
    }
  };

  return {
    report(source, error) {
      try {
        const { type, message } = describeError(error);
        const report: MainErrorReport = {
          source,
          name: type,
          // Pre-scrub with the known home directory and username; the renderer scrubs again.
          message: scrubErrorMessage(message ?? String(error), ERROR_MESSAGE_MAX_LENGTH, options),
        };
        if (error instanceof Error && error.stack) {
          report.stack = scrubErrorMessage(error.stack, ERROR_STACK_MAX_LENGTH, options);
        }
        if (!shouldReport(`${source}\u0000${report.name}\u0000${report.message}`)) return;
        if (deliver(report)) return;
        buffer.push(report);
        if (buffer.length > maxBuffered) buffer.shift();
      } catch {
        // Reporting must never be the thing that fails.
      }
    },
    attach(next) {
      if (target !== next) {
        target = next;
        next.once("destroyed", () => {
          if (target === next) target = null;
        });
      }
      flush();
    },
  };
}
