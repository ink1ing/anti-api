# Authorized Multi-Account Management

Anti-API can store more than one provider account and route requests through an account selected by the operator. Configure only accounts that you own or are explicitly authorized to administer, and only where the provider's current terms permit this integration.

## Intended Use

Multi-account support is intended for:

- Explicit account selection for separate projects or organizations
- Reliability failover between separately authorized service accounts
- Isolating provider configuration and credentials
- Waiting for an authorized account to recover after a transient upstream failure

It must not be used to create account pools, aggregate free-tier allowances, evade per-user or per-organization quotas, bypass rate limits, or circumvent provider enforcement.

## Add an Authorized Account

```bash
bun run src/main.ts add-account
```

The command opens the provider login flow and stores a local credential copy under `~/.anti-api`. Credential files are written with owner-only permissions where the operating system supports POSIX modes. Do not add another person's account or share credential files.

## List Accounts

```bash
bun run src/main.ts accounts
```

Do not print or copy the raw JSON credential files into issue reports, chat messages, or CI logs.

## Rate Limits and Quotas

When an upstream returns `429`, Anti-API records a cooldown and respects an available `Retry-After` or reset signal. If all eligible accounts are cooling down, requests wait or fail rather than clearing the recorded limits.

A `429` can represent a short-term request-rate limit, model capacity, or an exhausted allowance. The appropriate response is to:

1. Reduce request concurrency and frequency.
2. Respect `Retry-After` and provider reset times.
3. Verify that the account and organization have the required authorized quota.
4. Contact the provider or purchase the appropriate plan when more capacity is needed.

Adding or creating accounts to continue after a quota limit is not a supported use.

## Credential Import

Imports from another CLI or IDE are explicit operations. Anti-API may copy access and refresh tokens into its own data directory. Automatic startup import is disabled unless the corresponding `ANTI_API_IMPORT_*` environment variable is set. External Kiro credential stores are not modified unless `ANTI_API_KIRO_WRITEBACK=1` is explicitly enabled.

Deleting an account from Anti-API deletes only Anti-API's copy; it does not delete Codex CLI or CLIProxy credential files.

## Troubleshooting

### Every authorized account is cooling down

- Stop sending requests and wait for the earliest allowed retry time.
- Check the provider's quota dashboard and organization policy.
- Confirm system time and proxy behavior.
- Do not clear cooldowns or add accounts to evade the upstream limit.

### An account cannot authenticate

- Confirm that the account belongs to you or your organization.
- Re-authenticate through the provider's supported login flow.
- Install the correct enterprise certificate authority if TLS validation fails; do not disable certificate verification as a first response.
- Remove and re-add only Anti-API's local account copy when necessary.
