/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { planCommand } from './planCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import * as fs from 'node:fs';

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
}));

const mockSendMessageStream = vi.fn();

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    GeminiChat: vi.fn().mockImplementation(() => ({
      sendMessageStream: mockSendMessageStream,
    })),
  };
});

describe('planCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
      },
    });
    vi.clearAllMocks();
  });

  function createStreamResponse(text: string) {
    return (async function* () {
      yield {
        type: 'chunk',
        value: {
          candidates: [
            {
              content: {
                parts: [{ text }],
              },
            },
          ],
        },
      };
    })();
  }

  it('should run a planning session successfully', async () => {
    // Sequence of mocked responses:
    // 1. Generate Personas
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse(
        '[{"name": "AgentA", "description": "DescA"}, {"name": "AgentB", "description": "DescB"}]',
      ),
    );

    // 2. Proposal Round (Agent A)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('Plan A Content'),
    );
    // 3. Proposal Round (Agent B)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('Plan B Content'),
    );

    // 4. Review Round (Agent A)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('Refined Plan A Content'),
    );
    // 5. Review Round (Agent B)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('Refined Plan B Content'),
    );

    // 6. Vote (Agent A)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('{"votedFor": "AgentA", "reason": "Self vote"}'),
    );
    // 7. Vote (Agent B)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('{"votedFor": "AgentA", "reason": "B likes A"}'),
    );

    // Call command: /plan "Fix bug" --agents 2 --rounds 1
    if (!planCommand.action) throw new Error('No action');
    await planCommand.action(mockContext, '"Fix bug" --agents 2 --rounds 1');

    // Verify fs.writeFileSync called twice (transcript and winning plan)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);

    // Verify Transcript
    const transcriptCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(transcriptCall[0]).toContain('transcript-');
    expect(transcriptCall[1]).toContain('Planning Session Transcript');
    expect(transcriptCall[1]).toContain('AgentA');
    expect(transcriptCall[1]).toContain('AgentB');
    expect(transcriptCall[1]).toContain('Plan A Content');
    expect(transcriptCall[1]).toContain('Refined Plan A Content');
    expect(transcriptCall[1]).toContain('Winner: **AgentA**');

    // Verify Winning Plan
    const winningPlanCall = vi.mocked(fs.writeFileSync).mock.calls[1];
    expect(winningPlanCall[0]).toContain('winning_plan-');
    expect(winningPlanCall[1]).toContain('Winning Plan(s)');
    expect(winningPlanCall[1]).toContain('Refined Plan A Content');
  });

  it('should handle ties', async () => {
    // 1. Personas
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse(
        '[{"name": "AgentA", "description": "DescA"}, {"name": "AgentB", "description": "DescB"}]',
      ),
    );

    // 2. Proposals
    mockSendMessageStream.mockReturnValueOnce(createStreamResponse('Plan A'));
    mockSendMessageStream.mockReturnValueOnce(createStreamResponse('Plan B'));

    // 3. Votes (Split vote)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('{"votedFor": "AgentA", "reason": "Vote A"}'),
    );
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('{"votedFor": "AgentB", "reason": "Vote B"}'),
    );

    // Run with 0 rounds to skip review phase
    if (!planCommand.action) throw new Error('No action');
    await planCommand.action(mockContext, '"Tie test" --agents 2 --rounds 0');

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);

    const transcriptCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(transcriptCall[1]).toContain('Tie between: AgentA, AgentB');

    const winningPlanCall = vi.mocked(fs.writeFileSync).mock.calls[1];
    expect(winningPlanCall[1]).toContain('TIE between AgentA, AgentB');
    expect(winningPlanCall[1]).toContain('Plan A');
    expect(winningPlanCall[1]).toContain('Plan B');
  });

  it('should fail gracefully if personas cannot be generated', async () => {
    // 1. Personas (Invalid JSON)
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('Invalid JSON'),
    );

    // 2. Proposals (Fallback agents Agent_1, Agent_2)
    mockSendMessageStream.mockReturnValueOnce(createStreamResponse('Plan 1'));
    mockSendMessageStream.mockReturnValueOnce(createStreamResponse('Plan 2'));

    // 3. Votes
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('{"votedFor": "Agent_1", "reason": "Vote 1"}'),
    );
    mockSendMessageStream.mockReturnValueOnce(
      createStreamResponse('{"votedFor": "Agent_1", "reason": "Vote 1"}'),
    );

    if (!planCommand.action) throw new Error('No action');
    await planCommand.action(mockContext, '"Fail test" --agents 2 --rounds 0');

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    const transcriptCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    // Check if fallback personas were used
    expect(transcriptCall[1]).toContain('Agent_1');
    expect(transcriptCall[1]).toContain('Agent_2');
  });
});
