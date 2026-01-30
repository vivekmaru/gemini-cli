/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { LocalAgentDefinition } from './types.js';
import {
  SHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  LS_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
} from '../tools/tool-names.js';
import type { Config } from '../config/config.js';
import {
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  isPreviewModel,
} from '../config/models.js';

const TestFixerAgentSchema = z.object({
  result: z.string().describe('The final result of the test fixing session.'),
});

/**
 * An agent specialized in running tests, analyzing failures, and applying fixes.
 */
export const TestFixerAgent = (
  config: Config,
): LocalAgentDefinition<typeof TestFixerAgentSchema> => {
  const model = isPreviewModel(config.getModel())
    ? PREVIEW_GEMINI_FLASH_MODEL
    : DEFAULT_GEMINI_MODEL;

  return {
    name: 'test_fixer',
    kind: 'local',
    displayName: 'Test Fixer Agent',
    description:
      'A specialized agent that iteratively runs tests, analyzes failures, and applies fixes to the codebase until the tests pass or a limit is reached.',
    inputConfig: {
      inputSchema: {
        type: 'object',
        properties: {
          test_command: {
            type: 'string',
            description:
              'The command to execute the tests (e.g., "npm test", "pytest tests/").',
          },
          max_attempts: {
            type: 'number',
            description: 'The maximum number of fix attempts to make.',
            default: 5,
          },
        },
        required: ['test_command'],
      },
    },
    outputConfig: {
      outputName: 'result',
      description: 'The outcome of the test fixing process.',
      schema: TestFixerAgentSchema,
    },
    modelConfig: {
      model,
      generateContentConfig: {
        temperature: 0.2, // Lower temperature for more deterministic code fixes
      },
    },
    toolConfig: {
      tools: [
        SHELL_TOOL_NAME,
        READ_FILE_TOOL_NAME,
        EDIT_TOOL_NAME,
        LS_TOOL_NAME,
        GREP_TOOL_NAME,
        READ_MANY_FILES_TOOL_NAME,
      ],
    },
    runConfig: {
      maxTurns: 30, // Allow enough turns for the loop (run, analyze, fix) * attempts
      maxTimeMinutes: 15,
    },
    processOutput: (output) => JSON.stringify(output, null, 2),
    promptConfig: {
      query: `Please fix the tests using the following command: \${test_command}.
You have a maximum of \${max_attempts} attempts.`,
      systemPrompt: `You are the **Test Fixer Agent**, a specialized software engineering AI focused on resolving test failures.

Your Goal: Make the specified test command pass by iteratively running it, analyzing the output, and modifying the code.

## Workflow
1.  **Run Test:** Execute the provided \`test_command\` using \`${SHELL_TOOL_NAME}\`.
2.  **Analyze:**
    *   If the command succeeds (exit code 0), you are done. Report success.
    *   If the command fails, analyze the stdout/stderr to identify the specific error (compilation error, assertion failure, etc.).
3.  **Investigate:** Use \`${READ_FILE_TOOL_NAME}\` or \`${GREP_TOOL_NAME}\` to locate the problematic code or test file. Understand *why* it failed.
4.  **Fix:** Use \`${EDIT_TOOL_NAME}\` to apply a fix to the source code or the test file (if the test itself is incorrect).
5.  **Verify:** Loop back to step 1 and run the test again to verify the fix.

## Rules
*   **Iterate:** You have a limited number of attempts. Use them wisely.
*   **Focus:** Fix *only* the errors reported by the test command. Do not refactor unrelated code.
*   **Context:** You might need to read multiple files to understand the dependencies.
*   **Stop Condition:** Stop immediately if the tests pass. Stop if you run out of attempts.
*   **Reporting:** When finishing, summarize what you fixed or why you couldn't fix it.

## Tools
*   Use \`${SHELL_TOOL_NAME}\` to run the test command.
*   Use \`${READ_FILE_TOOL_NAME}\` to examine code.
*   Use \`${EDIT_TOOL_NAME}\` to modify files.
*   Use \`${GREP_TOOL_NAME}\` or \`${LS_TOOL_NAME}\` to find files.

Start by running the test command.
`,
    },
  };
};
