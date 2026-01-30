/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GeminiChat,
  type Config,
} from '@google/gemini-cli-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';

interface Persona {
  name: string;
  description: string;
}

interface Plan {
  agentName: string;
  content: string;
}

interface Vote {
  voterName: string;
  votedFor: string;
  reason: string;
}

class PlanAgent {
  private chat: GeminiChat;
  public readonly name: string;
  public readonly description: string;

  constructor(
    name: string,
    description: string,
    config: Config,
  ) {
    this.name = name;
    this.description = description;
    this.chat = new GeminiChat(
      config,
      `You are ${name}. ${description}\n\nYou are participating in a planning session with other agents.`,
      [], // No tools for now, purely cognitive/planning
      [],
    );
  }

  async generate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const promptId = Math.random().toString(36).substring(7);

    const responseStream = await this.chat.sendMessageStream(
      { model: 'inherit' }, // Use default model
      [{ text: prompt }],
      promptId,
      controller.signal,
    );

    let fullText = '';
    for await (const chunk of responseStream) {
      if (chunk.type === 'chunk' && chunk.value.candidates?.[0]?.content?.parts?.[0]?.text) {
        fullText += chunk.value.candidates[0].content.parts[0].text;
      }
    }
    return fullText;
  }
}

async function generatePersonas(
  query: string,
  count: number,
  config: Config,
): Promise<Persona[]> {
  const chat = new GeminiChat(
    config,
    'You are an expert team builder. Your goal is to create diverse, capable personas to solve a specific problem.',
  );

  const prompt = `
    I need to solve the following problem: "${query}".
    Generate ${count} distinct, expert personas that would be best suited to solve this problem together.
    They should have different perspectives (e.g., specific technical expertise, cautious vs. innovative, user-focused vs. backend-focused).

    Return the result ONLY as a raw JSON array of objects, where each object has "name" and "description" fields.
    Do not include markdown formatting like \`\`\`json.
    Example:
    [{"name": "SecurityExpert", "description": "Focuses on vulnerabilities..."}, {"name": "UXDesigner", "description": "Prioritizes user journey..."}]
  `;

  const controller = new AbortController();
  const promptId = Math.random().toString(36).substring(7);

  const responseStream = await chat.sendMessageStream(
    { model: 'inherit' },
    [{ text: prompt }],
    promptId,
    controller.signal,
  );

  let fullText = '';
  for await (const chunk of responseStream) {
    if (chunk.type === 'chunk' && chunk.value.candidates?.[0]?.content?.parts?.[0]?.text) {
      fullText += chunk.value.candidates[0].content.parts[0].text;
    }
  }

  try {
    // Clean up potential markdown code blocks
    const cleaned = fullText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as Persona[];
  } catch (e) {
    // Fallback if parsing fails - create generic personas
    return Array.from({ length: count }, (_, i) => ({
        name: `Agent_${i+1}`,
        description: `An expert agent focused on aspect ${i+1} of the problem.`
    }));
  }
}

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Start a multi-agent planning session',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available.',
      };
    }

    // Parse arguments
    // Format: /plan "query" --agents 3 --rounds 1
    // Simple parsing for now
    let query = args;
    let agentCount = 3;
    let rounds = 1;

    // Extract flags
    if (query.includes('--agents')) {
      const match = query.match(/--agents\s+(\d+)/);
      if (match) {
        agentCount = parseInt(match[1], 10);
        // Clean up arg string (simplistic)
        query = query.replace(match[0], '');
      }
    }
    if (query.includes('--rounds')) {
      const match = query.match(/--rounds\s+(\d+)/);
      if (match) {
        rounds = parseInt(match[1], 10);
        query = query.replace(match[0], '');
      }
    }

    query = query.trim();
    // Remove quotes if present
    if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
      query = query.slice(1, -1);
    }

    if (!query) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Please provide a problem statement. Usage: /plan "How to fix bug X" [--agents 3] [--rounds 1]',
      };
    }

    // Bounds check
    agentCount = Math.max(1, Math.min(6, agentCount));
    rounds = Math.max(0, Math.min(5, rounds));

    context.ui.addItem({
      type: MessageType.INFO,
      text: `Starting planning session for: "${query}"\nAgents: ${agentCount}, Rounds: ${rounds}`,
    }, Date.now());

    let transcript = `# Planning Session Transcript\n\n## Problem Statement\n${query}\n\n`;

    try {
      // 1. Generate Personas
      context.ui.addItem({ type: MessageType.INFO, text: 'Generating personas...' }, Date.now());
      const personas = await generatePersonas(query, agentCount, config);

      const personaText = personas.map(p => `- **${p.name}**: ${p.description}`).join('\n');
      transcript += `## Personas\n${personaText}\n\n`;
      context.ui.addItem({ type: MessageType.INFO, text: `Personas created:\n${personaText}` }, Date.now());

      // 2. Instantiate Agents
      const agents = personas.map(p => new PlanAgent(p.name, p.description, config));

      // 3. Proposal Round
      context.ui.addItem({ type: MessageType.INFO, text: 'Phase 1: Initial Proposals' }, Date.now());
      transcript += `## Phase 1: Initial Proposals\n\n`;

      let currentPlans: Plan[] = [];

      // Run in parallel
      const proposalPromises = agents.map(async (agent) => {
        const prompt = `The user has the following problem: "${query}".\n\nBased on your expertise, propose a detailed plan to solve this. Structure it clearly.`;
        const planContent = await agent.generate(prompt);
        return { agentName: agent.name, content: planContent };
      });

      currentPlans = await Promise.all(proposalPromises);

      for (const plan of currentPlans) {
        transcript += `### ${plan.agentName}'s Proposal\n${plan.content}\n\n`;
        context.ui.addItem({ type: MessageType.INFO, text: `**${plan.agentName}** has proposed a plan.` }, Date.now());
      }

      // 4. Review Rounds
      for (let r = 1; r <= rounds; r++) {
        context.ui.addItem({ type: MessageType.INFO, text: `Phase 2: Review Round ${r}/${rounds}` }, Date.now());
        transcript += `## Phase 2: Review Round ${r}\n\n`;

        const allPlansText = currentPlans.map(p => `Plan from ${p.agentName}:\n${p.content}\n---`).join('\n');

        const reviewPromises = agents.map(async (agent) => {
          const prompt = `
            Here are the current plans proposed by the team:
            ${allPlansText}

            Critique the other plans and then provide an UPDATED, refined version of your own plan (or adopt a better one) based on the feedback and ideas you see.
            Make your new plan comprehensive.
          `;
          const refinedContent = await agent.generate(prompt);
          return { agentName: agent.name, content: refinedContent };
        });

        currentPlans = await Promise.all(reviewPromises);

        for (const plan of currentPlans) {
          transcript += `### ${plan.agentName}'s Refined Plan (Round ${r})\n${plan.content}\n\n`;
          context.ui.addItem({ type: MessageType.INFO, text: `**${plan.agentName}** has refined their plan.` }, Date.now());
        }
      }

      // 5. Voting
      context.ui.addItem({ type: MessageType.INFO, text: 'Phase 3: Voting' }, Date.now());
      transcript += `## Phase 3: Voting\n\n`;

      const finalPlansText = currentPlans.map(p => `Plan from ${p.agentName}:\n${p.content}\n---`).join('\n');

      const votePromises = agents.map(async (agent) => {
        const prompt = `
          The discussion is over. Here are the final plans:
          ${finalPlansText}

          Vote for the single best plan. You may vote for your own if it is truly superior, but be objective.

          Return ONLY a raw JSON object with fields: "votedFor" (the name of the agent whose plan you choose) and "reason" (string).
          Do not include markdown formatting.
          Example: {"votedFor": "SecurityExpert", "reason": "It addresses the root cause..."}
        `;
        const voteResponse = await agent.generate(prompt);
        try {
            const cleaned = voteResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const voteData = JSON.parse(cleaned);
            return { voterName: agent.name, votedFor: voteData.votedFor, reason: voteData.reason } as Vote;
        } catch (e) {
            return { voterName: agent.name, votedFor: "Unknown", reason: "Failed to parse vote" } as Vote;
        }
      });

      const votes = await Promise.all(votePromises);
      const voteCounts: Record<string, number> = {};

      for (const vote of votes) {
        transcript += `- **${vote.voterName}** voted for **${vote.votedFor}**: "${vote.reason}"\n`;
        context.ui.addItem({ type: MessageType.INFO, text: `**${vote.voterName}** voted for **${vote.votedFor}**.` }, Date.now());

        if (voteCounts[vote.votedFor]) {
            voteCounts[vote.votedFor]++;
        } else {
            voteCounts[vote.votedFor] = 1;
        }
      }

      // Determine Winner
      let maxVotes = 0;
      let winners: string[] = [];
      for (const [agent, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
            maxVotes = count;
            winners = [agent];
        } else if (count === maxVotes) {
            winners.push(agent);
        }
      }

      transcript += `\n## Result\n`;
      let finalWinnerName = "";

      if (winners.length === 1) {
        finalWinnerName = winners[0];
        transcript += `Winner: **${finalWinnerName}** with ${maxVotes} votes.\n`;
        context.ui.addItem({ type: MessageType.INFO, text: `Winner: ${finalWinnerName}` }, Date.now());
      } else {
        // Tie
        transcript += `Tie between: ${winners.join(', ')} with ${maxVotes} votes each.\n`;
        context.ui.addItem({ type: MessageType.WARNING, text: `Tie between: ${winners.join(', ')}. Please review the winning plans.` }, Date.now());
        finalWinnerName = "TIE: " + winners.join(" & ");
      }

      // 6. Write Output
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const transcriptFile = path.join(process.cwd(), `transcript-${timestamp}.md`);
      const winningPlanFile = path.join(process.cwd(), `winning_plan-${timestamp}.md`);

      fs.writeFileSync(transcriptFile, transcript);

      let winningContent = `# Winning Plan(s)\n\nProblem: ${query}\n\n`;
      if (winners.length === 1) {
        const plan = currentPlans.find(p => p.agentName === winners[0]);
        winningContent += `## Author: ${plan?.agentName}\n\n${plan?.content}`;
      } else {
        winningContent += `## TIE between ${winners.join(', ')}\n\n`;
        for (const winner of winners) {
            const plan = currentPlans.find(p => p.agentName === winner);
            winningContent += `### Plan by ${winner}\n\n${plan?.content}\n\n---\n\n`;
        }
      }

      fs.writeFileSync(winningPlanFile, winningContent);

      context.ui.addItem({
        type: MessageType.INFO,
        text: `Session Complete.\nTranscript saved to: ${transcriptFile}\nWinning Plan saved to: ${winningPlanFile}`,
      }, Date.now());

    } catch (e) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Planning session failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};
