# Blind design review

Pasta's rule: one Opus and one Sol reviewer, working separately and blind, compare the current UI with the redesign. The two are labelled A and B, assigned at random each round. Both must clearly prefer the redesign, and both also score it against well-designed multisig wallets such as Safe{Wallet}. Each reviewer saw the same 11 steps at 1440 px and 390 px.

| Round | Assignment | Reviewer | Verdict | Overall (redesign / old) | Against Safe (redesign / old) |
|---|---|---|---|---|---|
| 1 | A = old, B = redesign | Opus 5.5 | B, clear | 7.5 / 3 | 6 / 2 |
| 1 | A = old, B = redesign | Sol (GPT 6.2 Astra, high) | B, clear | 8 / 3 | 6 / 3 |
| 2 | A = redesign, B = old | Opus 5.5 (fresh agent) | A, clear | 7.5 / 2.5 | 6 / 2 |
| 2 | A = redesign, B = old | Sol (GPT 6.2 Astra, high, fresh agent) | A, clear | 8 / 4 | 7 / 3 |

Both reviewers clearly preferred the redesign in both rounds.

**Round 1 findings, fixed before round 2:**
- the signing dialog hid the exact transaction and showed amounts only in credits;
- a refused proposal still had a primary "broadcast" button;
- the group title changed once the key ceremony started;
- toasts could cover fingerprints;
- the identity's balance wasn't shown;
- the signing dialog didn't say what was checked;
- completed proposals read "enough to go ahead";
- the identity-creation entry was missing from the history;
- words broke mid-word in the key table on phones;
- the phrase warning was too weak.

**Round 2 findings, fixed after round 2:**
- the phone signing dialog clipped its title and actions (now a full-height sheet with a sticky action bar);
- members could continue without checking fingerprints (Continue is now secondary, with "N of M left to check");
- the proposal history was a wall of cards (now compact rows), and replaced proposals offered a retry;
- the green checks could read as "safe to sign" (now a neutral badge, plus a "confirm with the proposer" line);
- amounts were entered in credits (now DASH);
- two primary buttons showed while composing a proposal;
- the signing wording, the mismatch path, and seed entry before the walkthrough on phones.
