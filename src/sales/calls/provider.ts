/**
 * Call-analytics integration interface. Mirrors the CRM adapter pattern: the
 * service depends only on this abstraction; concrete providers (mock, Zoom,
 * Google Meet) implement it, and a factory selects one from config.
 */

import type { SalesConfig } from '../config';
import type { CallInsights } from '../types';
import { MockCallProvider } from './mock';
import { ZoomCallProvider, type ZoomEnv } from './zoom';
import { GoogleMeetCallProvider, type GoogleMeetEnv } from './meet';

/** A rep the provider should look up calls for. */
export interface CallRepRef {
  repId: string;
  name: string;
  email?: string;
}

/** A single call as returned by a provider, before storage. */
export interface RawCall {
  id: string;
  repId: string;
  /** ISO date (YYYY-MM-DD) of the call. */
  date: string;
  durationSec: number;
  /** Rep talk / total talk, 0..1 (computed by the provider from its transcript). */
  talkRatio: number;
  title?: string;
  /**
   * Full transcript text, if the provider can supply it. Used only in-memory
   * for optional AI insight extraction; never persisted.
   */
  transcript?: string;
  /** Pre-computed insights, if the provider supplies them (most don't). */
  insights?: CallInsights;
}

/** Pluggable call-recording analytics source. */
export interface CallAnalyticsProvider {
  readonly name: string;
  /** Fetch analyzed calls for the given reps for one week (Monday-anchored). */
  fetchCalls(weekOf: string, reps: CallRepRef[]): Promise<RawCall[]>;
}

export type CallEnv = ZoomEnv & GoogleMeetEnv;

/**
 * Build the configured call-analytics provider. Defaults to the mock provider.
 * Returns null when call analytics is disabled (`callProvider: 'none'`).
 */
export function createCallProvider(config: SalesConfig, env: CallEnv): CallAnalyticsProvider | null {
  switch (config.callProvider) {
    case 'none':
      return null;
    case 'zoom':
      return new ZoomCallProvider(env);
    case 'google_meet':
    case 'meet':
      return new GoogleMeetCallProvider(env);
    case 'mock':
    default:
      return new MockCallProvider();
  }
}
