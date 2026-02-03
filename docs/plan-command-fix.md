# Plan command fix

## Overview

This document describes the fix applied to the `/plan` command in Gemini CLI.
The command previously failed with `ResourceExhausted` errors when running with
multiple agents due to API rate limits.

## Problem

The `/plan` command executes a multi-agent planning session involving:

1.  **Proposal generation:** Each agent proposes a plan.
2.  **Review rounds:** Agents critique and refine plans.
3.  **Voting:** Agents vote for the best plan.

Previously, these steps executed agent actions in parallel using `Promise.all`.
With 5 agents, this triggered 5 simultaneous complex requests to the Gemini API,
exceeding the allowed quota per minute (RPM) or tokens per minute (TPM),
resulting in a crash.

## Solution

The execution flow in `packages/cli/src/ui/commands/planCommand.ts` was
refactored to run sequentially.

### Key changes

1.  **Sequential loops:** Replaced `Promise.all` mapping with `for...of` loops.
    Agents now generate their responses one after another.
2.  **Delays:** Added a 1-second delay (`setTimeout`) between agent actions.
    This "breathing room" further reduces the likelihood of hitting rate limits.

### Impact

- **Reliability:** The command now completes successfully even with 5 or more
  agents.
- **Performance:** The total execution time is longer (linear vs. parallel), but
  this is a necessary trade-off for stability on standard quotas.

## Verification

### Automated tests

Updated `packages/cli/src/ui/commands/planCommand.test.ts` to support sequential
execution:

- Stubbed the global `setTimeout` to execute immediately during tests, ensuring
  tests remain fast.
- Verified the flow completes without timeouts.

### Manual verification

You can verify the fix by running:

```bash
/plan "Test plan" --agents 5 --rounds 1
```

The session should progress through all phases (Proposal, Review, Voting)
without error.
