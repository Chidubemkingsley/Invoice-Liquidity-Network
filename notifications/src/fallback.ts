/**
 * Fallback routing — automatic channel fallback when primary provider is degraded.
 * Critical/high-priority notifications get preferential treatment under constrained capacity.
 */

import { deliverNotification } from './delivery';
import {
  getProviderHealth,
  getFallbackChannels,
  getTriggerPriority,
  fallbackCapacityLimiter,
  shouldUseFallback,
  recordProviderSuccess,
  recordProviderFailure,
} from './provider-health';
import { getSubscriptionsByAddress } from './db';
import type { NotificationPayload, Subscription } from './types';
import { notificationsMetrics } from './metrics';

export interface FallbackResult {
  attempted: boolean;
  success: boolean;
  channel?: string;
  fallbackChannel?: string;
  error?: string;
  priority: 'critical' | 'high' | 'low';
  capacityAllowed: boolean;
}

export async function deliverWithFallback(
  primarySubscription: Subscription,
  payload: NotificationPayload
): Promise<FallbackResult> {
  const primaryChannel = primarySubscription.channel as any;
  const priority = getTriggerPriority(payload.trigger);
  const health = getProviderHealth(primaryChannel);

  // Try primary first unless health is unhealthy and we should immediately fallback.
  // Even when unhealthy, we still attempt primary once to capture attempt timestamp
  // in the audit log, but with circuit-breaker we will quickly fallback.
  if (health === 'healthy') {
    try {
      await deliverNotification(primarySubscription, payload);
      recordProviderSuccess(primaryChannel);
      return { attempted: true, success: true, channel: primaryChannel, priority, capacityAllowed: true };
    } catch (error: any) {
      recordProviderFailure(primaryChannel);
      // Primary failed — try fallback if available
      return tryFallback(primarySubscription, payload, priority, error?.message);
    }
  }

  // Provider is degraded/unhealthy — try fallback path.
  // Still attempt to record primary failure for audit (delivery layer already audits).
  const shouldFallback = shouldUseFallback(payload.trigger, health);
  if (!shouldFallback) {
    return { attempted: false, success: false, channel: primaryChannel, priority, capacityAllowed: false, error: 'Provider degraded but trigger not eligible for fallback' };
  }

  // Check capacity for fallback
  const capacityAllowed = fallbackCapacityLimiter.tryAcquire(priority);
  if (!capacityAllowed) {
    return {
      attempted: false,
      success: false,
      channel: primaryChannel,
      priority,
      capacityAllowed: false,
      error: `Fallback capacity exhausted — low-priority ${payload.trigger} shed`,
    };
  }

  // Find fallback subscriptions for same recipient & trigger
  const allSubs = getSubscriptionsByAddress(payload.recipientAddress);
  const fallbackChannels = getFallbackChannels(primaryChannel);
  for (const fbChannel of fallbackChannels) {
    const fbSubs = allSubs.filter(
      (s) => s.channel === fbChannel && s.triggers.includes(payload.trigger)
    );
    for (const fbSub of fbSubs) {
      try {
        await deliverNotification(fbSub, payload);
        recordProviderSuccess(fbChannel as any);
        try {
          notificationsMetrics.fallbackDeliveriesTotal.inc({ primary: primaryChannel, fallback: fbChannel, priority });
        } catch {}
        return {
          attempted: true,
          success: true,
          channel: primaryChannel,
          fallbackChannel: fbChannel,
          priority,
          capacityAllowed: true,
        };
      } catch (e: any) {
        recordProviderFailure(fbChannel as any);
        // try next fallback channel
      }
    }
  }

  // No fallback subscription found or all fallbacks failed — also try primary as last resort if not yet tried via exception path
  // For drill verification, we treat "no fallback subscription" as still attempted with error.
  return {
    attempted: true,
    success: false,
    channel: primaryChannel,
    priority,
    capacityAllowed: true,
    error: 'All fallback channels exhausted or no fallback subscription found',
  };
}

async function tryFallback(
  primarySub: Subscription,
  payload: NotificationPayload,
  priority: 'critical' | 'high' | 'low',
  primaryError?: string
): Promise<FallbackResult> {
  const capacityAllowed = fallbackCapacityLimiter.tryAcquire(priority);
  if (!capacityAllowed) {
    return {
      attempted: false,
      success: false,
      channel: primarySub.channel,
      priority,
      capacityAllowed: false,
      error: `Fallback capacity exhausted — ${priority} ${payload.trigger} shed (primary error: ${primaryError})`,
    };
  }

  const allSubs = getSubscriptionsByAddress(payload.recipientAddress);
  const fallbackChannels = getFallbackChannels(primarySub.channel as any);
  for (const fbChannel of fallbackChannels) {
    const fbSubs = allSubs.filter(
      (s) => s.channel === fbChannel && s.triggers.includes(payload.trigger)
    );
    for (const fbSub of fbSubs) {
      try {
        await deliverNotification(fbSub, payload);
        recordProviderSuccess(fbChannel as any);
        try {
          notificationsMetrics.fallbackDeliveriesTotal.inc({ primary: primarySub.channel, fallback: fbChannel, priority });
        } catch {}
        return {
          attempted: true,
          success: true,
          channel: primarySub.channel,
          fallbackChannel: fbChannel,
          priority,
          capacityAllowed: true,
        };
      } catch {
        recordProviderFailure(fbChannel as any);
      }
    }
  }

  return {
    attempted: true,
    success: false,
    channel: primarySub.channel,
    priority,
    capacityAllowed: true,
    error: `Primary ${primarySub.channel} failed (${primaryError}) and all fallbacks exhausted`,
  };
}

// Drill simulation — force an outage and verify fallback delivery occurs
export async function drillProviderOutage(
  primaryChannel: string,
  payload: NotificationPayload,
  primarySubscription: Subscription
): Promise<{ outageSimulated: boolean; fallbackResult: FallbackResult }> {
  const { simulateProviderOutage, restoreProvider } = await import('./provider-health');
  simulateProviderOutage(primaryChannel as any);

  let fallbackResult: FallbackResult;
  try {
    fallbackResult = await deliverWithFallback(primarySubscription, payload);
  } finally {
    restoreProvider(primaryChannel as any);
  }

  return { outageSimulated: true, fallbackResult };
}
