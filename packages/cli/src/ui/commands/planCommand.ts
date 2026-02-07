/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GeminiChat,
  type Config,
  ReadFileTool,
  LSTool,
  RipGrepTool,
  GlobTool,
  MessageBus,
  PolicyEngine,
  PolicyDecision,
  MessageBusType,
  type ToolConfirmationRequest,
} from '@google/gemini-cli-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PersonaDefinition {
  id: string;
  name: string;
  description: string;
  expertise: string[];
  focus_areas: string[];
  tone: string;
}

interface Persona {
  name: string;
  description: string;
  id?: string;
}

interface PromptTemplate {
  template: string;
  persona_specific?: Record<string, string>;
  output_format?: string;
}

interface PromptsData {
  initial_proposal: PromptTemplate;
  refinement: PromptTemplate;
  validation: PromptTemplate;
  synthesis: PromptTemplate;
  universal_rules: string;
  output_format: {
    standard: string;
    synthesis: string;
  };
}

interface PersonasData {
  personas: PersonaDefinition[];
}

// Prompt loading functions
let promptsCache: PromptsData | null = null;
let personasCache: PersonasData | null = null;

function loadPrompts(): PromptsData {
  if (promptsCache) return promptsCache;

  const promptsPath = path.join(
    __dirname,
    '..',
    '..',
    'prompts',
    'plan-prompts.json',
  );
  try {
    const data = fs.readFileSync(promptsPath, 'utf-8');
    promptsCache = JSON.parse(data) as PromptsData;
    return promptsCache;
  } catch {
    throw new Error('Could not load plan prompts configuration');
  }
}

function loadPersonas(): PersonasData {
  if (personasCache) return personasCache;

  const personasPath = path.join(
    __dirname,
    '..',
    '..',
    'prompts',
    'personas.json',
  );
  try {
    const data = fs.readFileSync(personasPath, 'utf-8');
    personasCache = JSON.parse(data) as PersonasData;
    return personasCache;
  } catch {
    throw new Error('Could not load personas configuration');
  }
}

function getPersonaByName(name: string): PersonaDefinition | undefined {
  const personas = loadPersonas();
  // Try exact match first
  let persona = personas.personas.find((p) => p.name === name);
  // Try case-insensitive match
  if (!persona) {
    persona = personas.personas.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
  }
  // Try partial match
  if (!persona) {
    persona = personas.personas.find(
      (p) =>
        name.toLowerCase().includes(p.id.toLowerCase()) ||
        p.id.toLowerCase().includes(name.toLowerCase().replace(/\s+/g, '-')),
    );
  }
  return persona;
}

function buildPrompt(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value);
  }
  // Remove any remaining template variables
  result = result.replace(/{{[^}]+}}/g, '');
  return result;
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

type LogCallback = (message: string) => void;

class PlanAgent {
  private chat: GeminiChat;
  private config: Config;
  readonly name: string;
  readonly description: string;
  private messageBus: MessageBus;
  private policyEngine: PolicyEngine;

  constructor(
    name: string,
    description: string,
    config: Config,
    log: LogCallback,
  ) {
    this.name = name;
    this.description = description;
    this.config = config;

    // Create a dedicated PolicyEngine and MessageBus for this agent
    // This ensures the agent can use read-only tools without user interruption
    this.policyEngine = new PolicyEngine({
      defaultDecision: PolicyDecision.DENY, // Deny by default for safety
    });

    // Allow read-only tools
    this.policyEngine.addRule({
      toolName: ReadFileTool.Name,
      decision: PolicyDecision.ALLOW,
      priority: 100,
    });
    this.policyEngine.addRule({
      toolName: LSTool.Name,
      decision: PolicyDecision.ALLOW,
      priority: 100,
    });
    this.policyEngine.addRule({
      toolName: RipGrepTool.Name,
      decision: PolicyDecision.ALLOW,
      priority: 100,
    });
    this.policyEngine.addRule({
      toolName: GlobTool.Name,
      decision: PolicyDecision.ALLOW,
      priority: 100,
    });

    this.messageBus = new MessageBus(this.policyEngine);

    // Log tool usage
    this.messageBus.on(
      MessageBusType.TOOL_CONFIRMATION_REQUEST,
      (msg: ToolConfirmationRequest) => {
        if (msg.type === MessageBusType.TOOL_CONFIRMATION_REQUEST) {
          log(`[${this.name}] is using tool: ${msg.toolCall.name}`);
        }
      },
    );

    // Initialize Read-Only Tools
    const tools = [
      new ReadFileTool(config, this.messageBus),
      new LSTool(config, this.messageBus),
      new RipGrepTool(config, this.messageBus),
      new GlobTool(config, this.messageBus),
    ];

    this.chat = new GeminiChat(
      config,
      `You are ${name}. ${description}\n\nYou are participating in a planning session with other agents. You have access to read-only tools to explore the codebase. Use them to understand the context before proposing a plan.`,
      [{ functionDeclarations: tools.map((t) => t.schema) }],
      [],
    );
  }

  async generate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const promptId = Math.random().toString(36).substring(7);

    const responseStream = await this.chat.sendMessageStream(
      { model: this.config.getActiveModel() }, // Use active model
      [{ text: prompt }],
      promptId,
      controller.signal,
    );

    let fullText = '';
    for await (const chunk of responseStream) {
      if (
        chunk.type === 'chunk' &&
        chunk.value.candidates?.[0]?.content?.parts?.[0]?.text
      ) {
        fullText += chunk.value.candidates[0].content.parts[0].text;
      }
    }
    return fullText;
  }
}

function safeParseJSON<T>(text: string): T | null {
  // 1. Try parsing raw text
  try {
    return JSON.parse(text);
  } catch (_e) {
    // continue
  }

  // 2. Try parsing from code blocks
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (_e) {
      // continue
    }
  }

  // 3. Try finding the outermost JSON object or array
  const firstOpen = text.search(/[{[]/);
  if (firstOpen !== -1) {
    // Find the last matching closing brace/bracket
    // We can't use simple regex for nested structures easily,
    // but finding the last occurrence of the corresponding closer is a good heuristic
    const isArray = text[firstOpen] === '[';
    const closer = isArray ? ']' : '}';
    const lastClose = text.lastIndexOf(closer);

    if (lastClose !== -1 && lastClose > firstOpen) {
      try {
        return JSON.parse(text.substring(firstOpen, lastClose + 1));
      } catch (_e) {
        // continue
      }
    }
  }

  return null;
}
async function generatePersonas(
  query: string,
  count: number,
  config: Config,
): Promise<Persona[]> {
  // Load predefined personas from JSON file
  const personasPath = path.join(
    __dirname,
    '..',
    '..',
    'prompts',
    'personas.json',
  );
  let predefinedPersonas: PersonaDefinition[] = [];

  try {
    const data = fs.readFileSync(personasPath, 'utf-8');
    const parsed = JSON.parse(data) as { personas: PersonaDefinition[] };
    predefinedPersonas = parsed.personas;
  } catch {
    // Failed to load predefined personas, will fall back to AI generation
  }

  // If we have predefined personas, use them
  if (predefinedPersonas.length > 0) {
    // Shuffle and take the requested number
    const shuffled = [...predefinedPersonas].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(count, shuffled.length));

    return selected.map((p) => ({
      name: p.name,
      description: p.description,
      id: p.id,
    }));
  }

  // Fallback to AI-generated personas
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
    { model: config.getActiveModel() },
    [{ text: prompt }],
    promptId,
    controller.signal,
  );

  let fullText = '';
  for await (const chunk of responseStream) {
    if (
      chunk.type === 'chunk' &&
      chunk.value.candidates?.[0]?.content?.parts?.[0]?.text
    ) {
      fullText += chunk.value.candidates[0].content.parts[0].text;
    }
  }

  const parsed = safeParseJSON<Persona[]>(fullText);
  if (parsed && Array.isArray(parsed)) {
    return parsed;
  }

  // Ultimate fallback - create generic personas
  return Array.from({ length: count }, (_, i) => ({
    name: `Agent_${i + 1}`,
    description: `An expert agent focused on aspect ${i + 1} of the problem.`,
  }));
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
    if (
      (query.startsWith('"') && query.endsWith('"')) ||
      (query.startsWith("'") && query.endsWith("'"))
    ) {
      query = query.slice(1, -1);
    }

    if (!query) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Please provide a problem statement. Usage: /plan "How to fix bug X" [--agents 3] [--rounds 1]',
      };
    }

    // Bounds check
    agentCount = Math.max(1, Math.min(6, agentCount));
    rounds = Math.max(0, Math.min(5, rounds));

    const sessionStartTime = Date.now();

    // Visual header
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `
╔════════════════════════════════════════════════════════════════╗
║  🤖 MULTI-AGENT PLANNING SESSION                               ║
╚════════════════════════════════════════════════════════════════╝
📋 Problem: "${query}"
👥 Agents: ${agentCount}  🔄 Review Rounds: ${rounds}
`,
      },
      Date.now(),
    );

    let transcript = `# Planning Session Transcript\n\n## Problem Statement\n${query}\n\n`;

    try {
      // Helper function for phase headers
      const showPhaseHeader = (phase: string, subtext?: string) => {
        const header = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ${phase.padEnd(58)} ┃
${subtext ? `┃  ${subtext.padEnd(58)} ┃` : ''}
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`;
        context.ui.addItem(
          { type: MessageType.INFO, text: header },
          Date.now(),
        );
      };

      // 1. Generate Personas
      showPhaseHeader(
        '🎭 PHASE 0: TEAM ASSEMBLY',
        'Selecting expert personas...',
      );
      context.ui.addItem(
        { type: MessageType.INFO, text: '⏳ Generating personas...' },
        Date.now(),
      );
      const personas = await generatePersonas(query, agentCount, config);

      // Display team with icons
      const personaIcons: Record<string, string> = {
        'product-manager': '📊',
        'tech-lead': '🔧',
        'senior-engineer': '💻',
        architect: '🏗️',
        'ux-designer': '🎨',
        'end-user': '👤',
      };

      const personaDisplay = personas
        .map((p) => {
          const personaDef = getPersonaByName(p.name);
          const icon = personaDef ? personaIcons[personaDef.id] || '🤖' : '🤖';
          return `${icon} **${p.name}**\n   ${p.description}`;
        })
        .join('\n\n');

      transcript += `## Personas\n${personas.map((p) => `- **${p.name}**: ${p.description}`).join('\n')}\n\n`;
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `✅ Team assembled:\n\n${personaDisplay}`,
        },
        Date.now(),
      );

      // 2. Instantiate Agents
      const agents = personas.map(
        (p) =>
          new PlanAgent(p.name, p.description, config, (msg: string) =>
            context.ui.addItem(
              { type: MessageType.INFO, text: msg },
              Date.now(),
            ),
          ),
      );

      // 3. Proposal Round
      showPhaseHeader(
        '📝 PHASE 1: INITIAL PROPOSALS',
        `${agents.length} agents creating plans...`,
      );
      transcript += `## Phase 1: Initial Proposals\n\n`;

      let currentPlans: Plan[] = [];

      // Load prompt templates
      const prompts = loadPrompts();

      // Run sequentially to avoid rate limits
      for (const agent of agents) {
        // Get persona-specific instructions
        const persona = getPersonaByName(agent.name);
        const personaId = persona?.id || 'generic';
        const personaSpecificInstructions =
          prompts.initial_proposal.persona_specific?.[personaId] ||
          'Create a comprehensive plan addressing all aspects of the problem from your expert perspective.';

        // Build the prompt using the template
        const prompt = buildPrompt(prompts.initial_proposal.template, {
          'persona.name': agent.name,
          'persona.description': agent.description,
          'persona.expertise':
            persona?.expertise?.join(', ') || 'general problem solving',
          'persona.focus_areas':
            persona?.focus_areas?.join(', ') || 'comprehensive solution',
          'persona.tone': persona?.tone || 'professional',
          query,
          persona_specific_instructions: personaSpecificInstructions,
          universal_rules: prompts.universal_rules,
          output_format: prompts.output_format.standard,
        });

        const planStartTime = Date.now();
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `⏳ ${agent.name} is creating a plan...`,
          },
          Date.now(),
        );

        const planContent = await agent.generate(prompt);
        const planDuration = ((Date.now() - planStartTime) / 1000).toFixed(1);
        currentPlans.push({ agentName: agent.name, content: planContent });

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `✅ ${agent.name} completed plan (${planDuration}s) - ${planContent.split(' ').length} words`,
          },
          Date.now(),
        );

        // Brief pause between agents
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Show completion of Phase 1
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `\n📊 Phase 1 Complete: ${currentPlans.length} plans created`,
        },
        Date.now(),
      );

      for (const plan of currentPlans) {
        transcript += `### ${plan.agentName}'s Proposal\n${plan.content}\n\n`;
      }

      // 4. Review Rounds
      for (let r = 1; r <= rounds; r++) {
        showPhaseHeader(
          `🔄 PHASE 2: REVIEW ROUND ${r}/${rounds}`,
          'Agents refining plans based on peer feedback...',
        );
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `Phase 2: Review Round ${r}/${rounds}`,
          },
          Date.now(),
        );
        transcript += `## Phase 2: Review Round ${r}\n\n`;

        const allPlansText = currentPlans
          .map((p) => `Plan from ${p.agentName}:\n${p.content}\n---`)
          .join('\n');

        const nextRoundPlans: Plan[] = [];

        // Run sequentially
        for (let i = 0; i < agents.length; i++) {
          const agent = agents[i];
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: `⏳ [${i + 1}/${agents.length}] ${agent.name} is refining their plan...`,
            },
            Date.now(),
          );

          // Get persona-specific instructions for refinement
          const persona = getPersonaByName(agent.name);
          const personaId = persona?.id || 'generic';
          const personaSpecificInstructions =
            prompts.refinement.persona_specific?.[personaId] ||
            'Improve your plan by incorporating the best ideas from other plans while maintaining your unique perspective.';

          // Build the refinement prompt using the template
          const prompt = buildPrompt(prompts.refinement.template, {
            'persona.name': agent.name,
            'persona.description': agent.description,
            all_plans: allPlansText,
            persona_specific_instructions: personaSpecificInstructions,
            universal_rules: prompts.universal_rules,
            output_format: prompts.output_format.standard,
          });

          const refinedContent = await agent.generate(prompt);
          nextRoundPlans.push({
            agentName: agent.name,
            content: refinedContent,
          });

          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: `✅ ${agent.name} completed refinement`,
            },
            Date.now(),
          );

          // Brief pause
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        currentPlans = nextRoundPlans;

        for (const plan of currentPlans) {
          transcript += `### ${plan.agentName}'s Refined Plan (Round ${r})\n${plan.content}\n\n`;
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `\n📊 Round ${r} Complete: ${currentPlans.length} plans refined`,
          },
          Date.now(),
        );
      }

      // 5. Quality Validation Round
      showPhaseHeader(
        '✅ PHASE 3: QUALITY VALIDATION',
        'Agents reviewing and improving their plans...',
      );
      transcript += `## Phase 3: Quality Validation\n\n`;

      const validatedPlans: Plan[] = [];

      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `⏳ [${i + 1}/${agents.length}] ${agent.name} is validating their plan...`,
          },
          Date.now(),
        );

        // Get persona-specific instructions for validation
        const persona = getPersonaByName(agent.name);
        const personaId = persona?.id || 'generic';
        const personaSpecificInstructions =
          prompts.validation.persona_specific?.[personaId] ||
          'Validate and improve your plan by checking completeness and addressing any gaps.';

        // Get the agent's own plan
        const ownPlan =
          currentPlans.find((p) => p.agentName === agent.name)?.content || '';
        const otherPlans = currentPlans
          .filter((p) => p.agentName !== agent.name)
          .map((p) => `Plan from ${p.agentName}:\n${p.content}`)
          .join('\n---\n');

        // Build the validation prompt using the template
        const validationPrompt = buildPrompt(prompts.validation.template, {
          'persona.name': agent.name,
          'persona.description': agent.description,
          query,
          own_plan: ownPlan,
          other_plans: otherPlans,
          persona_specific_instructions: personaSpecificInstructions,
          universal_rules: prompts.universal_rules,
          output_format: prompts.output_format.standard,
        });

        const validatedContent = await agent.generate(validationPrompt);
        validatedPlans.push({
          agentName: agent.name,
          content: validatedContent,
        });

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `✅ ${agent.name} completed validation`,
          },
          Date.now(),
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      currentPlans = validatedPlans;

      for (const plan of currentPlans) {
        transcript += `### ${plan.agentName}'s Validated Plan\n${plan.content}\n\n`;
      }

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `\n📊 Phase 3 Complete: ${currentPlans.length} plans validated`,
        },
        Date.now(),
      );

      // 6. Synthesis Phase - Create a unified plan from the best elements
      showPhaseHeader(
        '🔮 PHASE 4: SYNTHESIS',
        'Creating unified plan from the best elements...',
      );
      transcript += `## Phase 4: Synthesis\n\n`;

      const allValidatedPlans = currentPlans
        .map((p) => `Plan from ${p.agentName}:\n${p.content}\n---`)
        .join('\n');

      // Build the synthesis prompt using the template
      const synthesizerPrompt = buildPrompt(prompts.synthesis.template, {
        query,
        all_plans: allValidatedPlans,
        universal_rules: prompts.universal_rules,
        output_format: prompts.output_format.synthesis,
      });

      const synthesisAgent = new PlanAgent(
        'Synthesizer',
        'Master plan synthesizer who creates unified plans from multiple perspectives',
        config,
        (msg: string) =>
          context.ui.addItem({ type: MessageType.INFO, text: msg }, Date.now()),
      );

      const synthesizedPlanContent =
        await synthesisAgent.generate(synthesizerPrompt);
      const synthesizedPlan: Plan = {
        agentName: 'Synthesized Plan',
        content: synthesizedPlanContent,
      };

      transcript += `### Synthesized Plan\n${synthesizedPlan.content}\n\n`;
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: '**Synthesizer** has created a unified plan combining the best elements.',
        },
        Date.now(),
      );

      // 7. Voting (now includes synthesized plan)
      context.ui.addItem(
        { type: MessageType.INFO, text: 'Phase 5: Voting' },
        Date.now(),
      );
      transcript += `## Phase 5: Voting\n\n`;

      const finalPlansForVoting = [...currentPlans, synthesizedPlan];
      const finalPlansText = finalPlansForVoting
        .map((p) => `Plan from ${p.agentName}:\n${p.content}\n---`)
        .join('\n');

      const votes: Vote[] = [];

      // Run sequentially
      for (const agent of agents) {
        const prompt = `
          The discussion is over. Here are the final plans:
          ${finalPlansText}

          Vote for the single best plan. You may vote for your own if it is truly superior, but be objective.

          Return ONLY a raw JSON object with fields: "votedFor" (the name of the agent whose plan you choose) and "reason" (string).
          Do not include markdown formatting.
          Example: {"votedFor": "SecurityExpert", "reason": "It addresses the root cause..."}
        `;
        const voteResponse = await agent.generate(prompt);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const voteData = safeParseJSON<any>(voteResponse);

        let vote: Vote;
        if (
          voteData &&
          typeof voteData.votedFor === 'string' &&
          typeof voteData.reason === 'string'
        ) {
          vote = {
            voterName: agent.name,
            votedFor: voteData.votedFor,
            reason: voteData.reason,
          } as Vote;
        } else {
          vote = {
            voterName: agent.name,
            votedFor: 'Unknown',
            reason: 'Failed to parse vote',
          } as Vote;
        }
        votes.push(vote);

        // Brief pause
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const voteCounts: Record<string, number> = {};

      for (const vote of votes) {
        transcript += `- **${vote.voterName}** voted for **${vote.votedFor}**: "${vote.reason}"\n`;
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `**${vote.voterName}** voted for **${vote.votedFor}**.`,
          },
          Date.now(),
        );

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
      let finalWinnerName = '';

      // Visual voting results
      const totalVotes = votes.length;
      const maxBarLength = 40;
      const sortedResults = Object.entries(voteCounts).sort(
        (a, b) => b[1] - a[1],
      );

      let voteVisualization = '\n📊 VOTING RESULTS:\n';
      voteVisualization += '═'.repeat(50) + '\n';

      for (const [agentName, count] of sortedResults) {
        const percentage = ((count / totalVotes) * 100).toFixed(0);
        const barLength = Math.round((count / maxVotes) * maxBarLength);
        const bar =
          '█'.repeat(barLength) + '░'.repeat(maxBarLength - barLength);
        const isWinner = winners.includes(agentName);
        const winnerIcon = isWinner ? '👑 ' : '   ';
        voteVisualization += `${winnerIcon}${agentName.padEnd(20)} ${bar} ${count}/${totalVotes} (${percentage}%)\n`;
      }

      voteVisualization += '═'.repeat(50) + '\n';

      if (winners.length === 1) {
        finalWinnerName = winners[0];
        transcript += `Winner: **${finalWinnerName}** with ${maxVotes} votes.\n`;
        voteVisualization += `\n🎉 WINNER: ${finalWinnerName}\n`;
        voteVisualization += `   ${maxVotes}/${totalVotes} votes (${((maxVotes / totalVotes) * 100).toFixed(0)}% consensus)\n`;
        context.ui.addItem(
          { type: MessageType.INFO, text: voteVisualization },
          Date.now(),
        );
      } else {
        // Tie
        transcript += `Tie between: ${winners.join(', ')} with ${maxVotes} votes each.\n`;
        voteVisualization += `\n⚖️  TIE between: ${winners.join(' & ')}\n`;
        voteVisualization += `   ${maxVotes} votes each\n`;
        context.ui.addItem(
          {
            type: MessageType.WARNING,
            text: voteVisualization,
          },
          Date.now(),
        );
        finalWinnerName = 'TIE: ' + winners.join(' & ');
      }

      // 8. Write Output
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const transcriptFile = path.join(
        process.cwd(),
        `transcript-${timestamp}.md`,
      );
      const winningPlanFile = path.join(
        process.cwd(),
        `winning_plan-${timestamp}.md`,
      );

      fs.writeFileSync(transcriptFile, transcript);

      let winningContent = `# Winning Plan\n\n**Problem:** ${query}\n\n`;
      if (winners.length === 1) {
        const winnerName = winners[0];
        let winningPlan: Plan | undefined;

        if (winnerName === 'Synthesized Plan') {
          winningPlan = synthesizedPlan;
          winningContent += `> **Winner:** Unified Synthesized Plan (combining best elements from all agents)\n\n`;
        } else {
          winningPlan = currentPlans.find((p) => p.agentName === winnerName);
          winningContent += `> **Winner:** ${winnerName}'s Plan\n\n`;
        }

        winningContent += `**Votes:** ${maxVotes}/${votes.length}\n\n---\n\n${winningPlan?.content}`;
      } else {
        winningContent += `> **Result:** Tie between ${winners.join(', ')}\n\n**Votes:** ${maxVotes} each\n\n---\n\n`;
        for (const winner of winners) {
          let plan: Plan | undefined;
          if (winner === 'Synthesized Plan') {
            plan = synthesizedPlan;
          } else {
            plan = currentPlans.find((p) => p.agentName === winner);
          }
          winningContent += `## Plan by ${winner}\n\n${plan?.content}\n\n---\n\n`;
        }
      }

      fs.writeFileSync(winningPlanFile, winningContent);

      const sessionDuration = ((Date.now() - sessionStartTime) / 1000).toFixed(
        1,
      );

      // Visual completion summary
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `
╔════════════════════════════════════════════════════════════════╗
║  ✅ SESSION COMPLETE                                           ║
╚════════════════════════════════════════════════════════════════╝
⏱️  Duration: ${sessionDuration}s
📝 Transcript: ${transcriptFile}
🏆 Winning Plan: ${winningPlanFile}
`,
        },
        Date.now(),
      );
    } catch (e) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Planning session failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};
