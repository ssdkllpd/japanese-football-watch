# Provider quota blocks and recovery

Normal updates reserve 100 provider requests; live acquisition separately reserves 1,200. A key with a 100-request daily limit cannot run either acquisition policy, even with zero requests used. Lowering the reserves or recording an empty refresh as a success does not restore the configured service.

On 2026-10-27 at 00:06:42 UTC, the key in the d1-staging execution environment returned `subscription.plan=Free`, `requests.current=0`, and `requests.limit_day=100`. The daily-limit and daily-remaining headers also both reported 100. Evidence: read-only quota inspection [run 40424243338](https://github.com/ssdkllpd/japanese-football-watch/actions/runs/40424243338). The last successful normal run before recurrence was [40163048789](https://github.com/ssdkllpd/japanese-football-watch/actions/runs/40163048789) at 2026-10-25 04:45 UTC, with 7,160 requests remaining; the 05:00 UTC run failed. These facts establish the current incompatible plan/key, not the billing reason for that state.

1. Check the API-Football account and plan associated with the configured key. If the paid account is active, verify that this environment uses that account's key. Never paste the key in an issue, log, or chat.
2. Run **Inspect API-Football quota** after correcting the provider-side state. This uses `/status` only and prints no key or account contact details.
3. Confirm sufficient total capacity and remaining balance, then verify both an actual normal update and schedule synchronization. Preserve failed-run history and the real trigger origin.
4. Treat live workflow exit success carefully: `quota_reserved` means acquisition was paused, not that live match data was refreshed.

The normal and schedule planners check capacity for the complete discovery batch before any charged discovery calls. Errors distinguish an insufficient total daily plan from an otherwise sufficient plan whose remaining daily balance is too low. Successful-publication checkpoints remain unchanged on preflight failure.
