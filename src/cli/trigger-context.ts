import type { TriggerContext, TriggerType, OutputMode } from '../core/types.js';

export type TriggerContextInput = {
  channel?: string;
  chatId?: string;
  triggerType?: string;
  outputMode?: string;
  jobId?: string;
  jobName?: string;
};

export function resolveTriggerContext(options: TriggerContextInput): TriggerContext | undefined {
  const envType = process.env.LETTABOT_TRIGGER_TYPE;
  const envMode = process.env.LETTABOT_TRIGGER_OUTPUT_MODE;
  const envJobId = process.env.LETTABOT_TRIGGER_JOB_ID;
  const envJobName = process.env.LETTABOT_TRIGGER_JOB_NAME;

  const rawType = (options.triggerType ?? envType)?.trim();
  const rawMode = (options.outputMode ?? envMode)?.trim();
  const jobId = (options.jobId ?? envJobId)?.trim() || undefined;
  const jobName = (options.jobName ?? envJobName)?.trim() || undefined;

  const allowedTypes: TriggerType[] = ['user_message', 'heartbeat', 'cron', 'webhook', 'feed'];
  const allowedModes: OutputMode[] = ['responsive', 'silent'];

  const type = rawType ? rawType.toLowerCase() : '';
  const outputMode = rawMode ? rawMode.toLowerCase() : '';

  const hasExplicitType = Boolean(type);
  const resolvedType = hasExplicitType
    ? (allowedTypes.includes(type as TriggerType) ? type as TriggerType : null)
    : null;

  if (hasExplicitType && !resolvedType) {
    throw new Error(`Invalid --trigger value: ${rawType}. Expected: ${allowedTypes.join(', ')}`);
  }

  const hasExplicitMode = Boolean(outputMode);
  const resolvedMode = hasExplicitMode
    ? (allowedModes.includes(outputMode as OutputMode) ? outputMode as OutputMode : null)
    : null;

  if (hasExplicitMode && !resolvedMode) {
    throw new Error(`Invalid --output-mode value: ${rawMode}. Expected: ${allowedModes.join(', ')}`);
  }

  const channel = options.channel;
  const chatId = options.chatId;
  if (!resolvedType) {
    if (hasExplicitMode || jobId || jobName) {
      console.warn('[Hooks] Trigger type not set; defaulting to "webhook". Use --trigger or LETTABOT_TRIGGER_TYPE for accuracy.');
      return {
        type: 'webhook',
        outputMode: resolvedMode ?? 'responsive',
        ...(channel ? { sourceChannel: channel } : {}),
        ...(chatId ? { sourceChatId: chatId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(jobName ? { jobName } : {}),
        ...(channel && chatId ? { notifyTarget: { channel, chatId } } : {}),
      };
    }
    return undefined;
  }

  const triggerType = resolvedType;
  const mode = resolvedMode ?? 'responsive';

  return {
    type: triggerType,
    outputMode: mode,
    ...(channel ? { sourceChannel: channel } : {}),
    ...(chatId ? { sourceChatId: chatId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(jobName ? { jobName } : {}),
    ...(channel && chatId ? { notifyTarget: { channel, chatId } } : {}),
  };
}
