import { canonicalPayloadSha256, validateBotDefinition } from '@agent-works/domain';

import type { BotDefinition, BotStep, BotTrigger, BotValidationContext } from '@agent-works/domain';

function triggerWords(trigger: BotTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Started manually by the bot owner.';
    case 'event':
      return `On authenticated ${trigger.eventType} events from ${trigger.source}.`;
    case 'schedule': {
      const timing =
        trigger.timing.kind === 'cron'
          ? `Cron ${trigger.timing.expression}`
          : `Every ${trigger.timing.everySeconds} seconds, anchored at ${trigger.timing.anchor}`;
      const missed =
        trigger.missedRun === 'skip' ? 'Skip missed runs.' : 'Run once after missed runs.';
      const window =
        trigger.allowedWindow === undefined
          ? ''
          : ` Allowed weekdays ${trigger.allowedWindow.weekdays.join(', ')}, ${trigger.allowedWindow.start} to ${trigger.allowedWindow.end}.`;
      return `${timing} in ${trigger.timezone}. ${missed}${window}`;
    }
  }
}

export async function previewBot(definition: BotDefinition, context: BotValidationContext) {
  const diagnostics = await validateBotDefinition(definition, context);
  if (diagnostics.length > 0) return { success: false as const, diagnostics };
  const steps: BotStep[] = [];
  const remaining = new Map(definition.workflow.steps.map((step) => [step.id, step]));
  while (remaining.size > 0) {
    for (const [id, step] of remaining) {
      if (step.dependsOn.some((dep) => remaining.has(dep))) continue;
      steps.push(step);
      remaining.delete(id);
    }
  }
  return {
    success: true as const,
    preview: {
      name: definition.name,
      purpose: definition.purpose,
      planning: 'Fixed workflow. Steps and dependencies are frozen at publication.',
      steps,
      skills: steps
        .filter((step) => step.kind === 'skill')
        .map((step) => ({ stepId: step.id, ...step.skill })),
      externalAgents: steps
        .filter((step) => step.kind === 'mcp_delegate')
        .map((step) => ({
          stepId: step.id,
          agentId: step.agent.agentId,
          displayName:
            context.approvedAgents.get(step.agent.agentId)?.displayName ?? step.agent.agentId,
          instruction: step.instruction,
          dataSentExternally: step.inputs.map((id) => ({
            stepId: id,
            title: steps.find((source) => source.id === id)?.title ?? id,
          })),
        })),
      triggers: definition.triggers.map((trigger) => ({
        ...trigger,
        description: triggerWords(trigger),
      })),
      approvals: {
        ...definition.approvals,
        checkpoints: steps
          .filter((step) => step.kind === 'approval')
          .map((step) => ({ stepId: step.id, prompt: step.prompt })),
      },
      limits: definition.limits,
      result: definition.result,
      capabilities: [
        ...new Set(
          steps.filter((step) => step.kind === 'connector_read').map((step) => step.capability),
        ),
      ].sort(),
      digest: canonicalPayloadSha256(definition),
    },
  };
}
