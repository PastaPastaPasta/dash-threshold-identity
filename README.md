# Guided UI and every-network support: evidence

Screenshots for dash-threshold-identity PR #4. Desktop is 1440 px at 2x (dark theme), phone is 390 px at 2x (light theme). Every screenshot was taken with the seed phrase field empty; the drivers check this before each capture.

## Before and after, step by step

"Before" is the UI that was live on new-multisig.dashhq.org before this change. "After" is the final build.

| Step | Before | After |
|---|---|---|
| 01-landing | [1440](before/01-landing__desktop.png) · [390](before/01-landing__phone.png) | [1440](after/01-landing__desktop.png) · [390](after/01-landing__phone.png) |
| 02-no-group | [1440](before/02-no-group__desktop.png) · [390](before/02-no-group__phone.png) | [1440](after/02-no-group__desktop.png) · [390](after/02-no-group__phone.png) |
| 03-group-alone | [1440](before/03-group-alone__desktop.png) · [390](before/03-group-alone__phone.png) | [1440](after/03-group-alone__desktop.png) · [390](after/03-group-alone__phone.png) |
| 04-members-joined | [1440](before/04-members-joined__desktop.png) · [390](before/04-members-joined__phone.png) | [1440](after/04-members-joined__desktop.png) · [390](after/04-members-joined__phone.png) |
| 05-ceremony-waiting | [1440](before/05-ceremony-waiting__desktop.png) · [390](before/05-ceremony-waiting__phone.png) | [1440](after/05-ceremony-waiting__desktop.png) · [390](after/05-ceremony-waiting__phone.png) |
| 06-keys-ready | [1440](before/06-keys-ready__desktop.png) · [390](before/06-keys-ready__phone.png) | [1440](after/06-keys-ready__desktop.png) · [390](after/06-keys-ready__phone.png) |
| 07-fund-identity | [1440](before/07-fund-identity__desktop.png) · [390](before/07-fund-identity__phone.png) | [1440](after/07-fund-identity__desktop.png) · [390](after/07-fund-identity__phone.png) |
| 08-identity | [1440](before/08-identity__desktop.png) · [390](before/08-identity__phone.png) | [1440](after/08-identity__desktop.png) · [390](after/08-identity__phone.png) |
| 09-proposals | [1440](before/09-proposals__desktop.png) · [390](before/09-proposals__phone.png) | [1440](after/09-proposals__desktop.png) · [390](after/09-proposals__phone.png) |
| 10-review-and-sign | [1440](before/10-review-and-sign__desktop.png) · [390](before/10-review-and-sign__phone.png) | [1440](after/10-review-and-sign__desktop.png) · [390](after/10-review-and-sign__phone.png) |
| 11-new-proposal | [1440](before/11-new-proposal__desktop.png) · [390](before/11-new-proposal__phone.png) | [1440](after/11-new-proposal__desktop.png) · [390](after/11-new-proposal__phone.png) |

## Mainnet, read only

[Landing 1440](mainnet/landing__desktop.png) · [landing 390](mainnet/landing__phone.png) · [network check 1440](mainnet/group-netcheck__desktop.png) · [network check 390](mainnet/group-netcheck__phone.png) · [keys step, read only, 1440](mainnet/keys-readonly__desktop.png) · [keys step, read only, 390](mainnet/keys-readonly__phone.png)

## End-to-end runs (three browser profiles, 2-of-3)

- Testnet on https://new-multisig.dashhq.org: [log](e2e-testnet/log.txt), shots in [e2e-testnet/](e2e-testnet/)
- Local dashmate regtest through https://new-multisig.dashhq.org: [log](e2e-local/log.txt), shots in [e2e-local/](e2e-local/)

## Blind design review

See [REVIEWS.md](REVIEWS.md).
