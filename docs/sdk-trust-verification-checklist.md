# SDK Trust Model Verification Checklist

This checklist is the first implementation slice for turning `docs/sdk-trust-model.md` claims into automated assertions.

## Trust Claims To Assert

| Trust boundary | Automatable assertion |
| --- | --- |
| Stellar address validation | SDK write methods reject invalid account ids before transaction construction. |
| Signer identity | State-changing calls require the signer public key to match the expected actor. |
| RPC simulation | Prepared transactions must be produced from the same configured RPC endpoint used for simulation. |
| Network passphrase | Transactions are built with the configured network passphrase and do not fall back silently. |
| Contract id | Contract invocations target the configured contract id only. |
| Notifications | Notification payloads remain read-only mirrors and are never used as write-path authority. |
| Oracle verification | `require_oracle_verification` gates funding only when explicitly requested. |

## Harness Shape

Prefer static checks for wiring invariants and integration tests for signer/RPC behavior:

1. Static scan for direct contract invocation paths that bypass shared SDK builders.
2. Unit tests for invalid addresses and mismatched signer identities.
3. Integration fixtures for RPC simulation and prepared transaction consistency.
4. Release checklist item requiring intentional simulation drift to be recorded in `docs/sdk-next-migration.md`.

## CI Failure Criteria

The harness should fail when a documented trust boundary is bypassed, weakened, or no longer represented in code. If the implementation is intentionally different, update `docs/sdk-trust-model.md` in the same PR so the documentation remains authoritative.