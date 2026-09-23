/**
 * Email templates barrel (#446) + hardening batch injection audit
 *
 * Re-exports all template renderers, subject-line builders and the escaping
 * helpers so callers can import from a single entry point:
 *
 *   import { renderFundedEmail, buildFundedSubject } from "./templates";
 *   import { escapeHtml, escapeDiscordMarkdown } from "./templates";
 */

export { renderFundedEmail, buildFundedSubject } from './funded.template';

export { renderPaymentEmail, buildPaymentSubject } from './payment.template';

export { renderDisputeEmail, buildDisputeSubject } from './dispute.template';

export { renderDueWarningEmail, buildDueWarningSubject } from './due-warning.template';

export { renderDigestEmail, buildDigestSubject } from './digest.template';

export {
  emailShell,
  escapeHtml,
  escapeAttribute,
  escapeDiscordMarkdown,
  escapeSmsText,
  escapeHeaderValue,
  isJsonSafeRoundTrip,
  formatAmount,
  formatDate,
  shortAddress,
} from './helpers';
