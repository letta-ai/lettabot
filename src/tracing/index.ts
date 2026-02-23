/**
 * Phoenix/OpenTelemetry Tracing Integration
 *
 * Provides observability for LLM calls, tool executions, and agent turns.
 * Enabled only when PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_API_KEY is set.
 *
 * Usage:
 *   import { initTracing, traceAgentTurn } from './tracing/index.js';
 *
 *   // Call once at startup (before other imports in main.ts)
 *   await initTracing();
 *
 *   // Wrap agent message handling
 *   await traceAgentTurn({ input, sessionId, userId }, async (span) => {
 *     // ... handle message, add events to span
 *   });
 */

// OpenTelemetry Span interface (subset of @opentelemetry/api Span)
// Using a local interface to avoid requiring @opentelemetry/api as a direct dependency
interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  recordException(exception: Error): void;
  end(): void;
}

// Check if Phoenix tracing is enabled via environment variables
export const isPhoenixEnabled = Boolean(
  process.env.PHOENIX_COLLECTOR_ENDPOINT || process.env.PHOENIX_API_KEY
);

// Lazy-loaded tracer (initialized only if Phoenix is enabled)
let tracer: any = null;
let trace: any = null;
let otelContext: any = null;
let withSpanFn: any = null;
let tracerProvider: { shutdown(): Promise<void> } | null = null;

/**
 * Initialize Phoenix tracing if enabled.
 * Must be called before any traced code runs.
 * Safe to call even if Phoenix packages aren't installed.
 */
export async function initTracing(): Promise<void> {
  if (!isPhoenixEnabled) {
    console.log('[Tracing] Phoenix tracing disabled (no PHOENIX_COLLECTOR_ENDPOINT or PHOENIX_API_KEY)');
    return;
  }

  try {
    // Dynamically import Phoenix packages (they're optional dependencies)
    const [phoenixOtel, openinferenceCore] = await Promise.all([
      import('@arizeai/phoenix-otel'),
      import('@arizeai/openinference-core'),
    ]);

    // Register the tracer provider (save reference for shutdown)
    tracerProvider = phoenixOtel.register({
      projectName: process.env.PHOENIX_PROJECT_NAME || 'lettabot',
      // url and apiKey are read from env vars automatically:
      // PHOENIX_COLLECTOR_ENDPOINT, PHOENIX_API_KEY
    });

    // Store references for later use
    trace = phoenixOtel.trace;
    otelContext = phoenixOtel.context;
    tracer = trace.getTracer('lettabot');
    withSpanFn = openinferenceCore.withSpan;

    const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT || 'http://localhost:6006';
    console.log(`[Tracing] Phoenix tracing enabled, sending to ${endpoint}`);
  } catch (err) {
    console.warn('[Tracing] Failed to initialize Phoenix tracing:', err);
    console.warn('[Tracing] Install optional dependencies: npm install @arizeai/phoenix-otel @arizeai/openinference-core');
  }
}

/**
 * Context for an agent turn trace
 */
export interface AgentTurnContext {
  input: string;
  sessionId?: string;
  userId?: string;
  channel?: string;
  agentId?: string;
  metadata?: Record<string, string>;
}

/**
 * Span wrapper with helper methods for agent tracing
 */
export interface TracingSpan {
  /** Get the trace ID for linking (e.g., to hooks, database records) */
  readonly traceId?: string;

  /** Add a reasoning/thinking block event */
  addReasoning(content: string): void;

  /** Add a tool call event */
  addToolCall(toolName: string, toolInput: Record<string, unknown>, toolCallId?: string): void;

  /** Add a tool result event */
  addToolResult(toolCallId: string, content: string, isError?: boolean): void;

  /** Set the final output */
  setOutput(output: string): void;

  /** Set token counts if available */
  setTokens(prompt?: number, completion?: number, total?: number): void;

  /** Set cost if available */
  setCost(totalUsd?: number): void;

  /** Record an error */
  recordError(error: Error): void;

  /** Access underlying OTEL span if needed */
  readonly raw: OTelSpan | null;
}

/**
 * Create a TracingSpan wrapper around an OTEL span
 */
function createTracingSpan(span: OTelSpan | null): TracingSpan {
  // Capture the active OTel context now (while the agent_turn span is active).
  // Used to parent child tool spans correctly even across async continuations.
  const parentCtx = otelContext?.active?.() ?? null;

  // Track in-flight tool spans by toolCallId so we can close them on result.
  const openToolSpans = new Map<string, any>();

  function flushOpenToolSpans(): void {
    for (const [, toolSpan] of openToolSpans) {
      toolSpan.end();
    }
    openToolSpans.clear();
  }

  return {
    get traceId() {
      // Access spanContext from the real OTEL span (not in our interface)
      const ctx = (span as any)?.spanContext?.();
      return ctx?.traceId;
    },

    addReasoning(content: string) {
      span?.addEvent('reasoning', {
        'message.content': content,
      });
    },

    addToolCall(toolName: string, toolInput: Record<string, unknown>, toolCallId?: string) {
      if (tracer && parentCtx) {
        // Create a proper child span so Phoenix shows it as a node in the trace tree.
        const toolSpan = tracer.startSpan(toolName, {}, parentCtx);
        toolSpan.setAttribute('openinference.span.kind', 'TOOL');
        toolSpan.setAttribute('tool.name', toolName);
        toolSpan.setAttribute('input.value', JSON.stringify(toolInput));
        toolSpan.setAttribute('input.mime_type', 'application/json');
        if (toolCallId) {
          openToolSpans.set(toolCallId, toolSpan);
        } else {
          // No id to correlate a result — end immediately
          toolSpan.end();
        }
      } else {
        // Fallback when tracer isn't available
        span?.addEvent('tool_call', {
          'tool.name': toolName,
          'tool.parameters': JSON.stringify(toolInput),
          ...(toolCallId && { 'tool_call.id': toolCallId }),
        });
      }
    },

    addToolResult(toolCallId: string, content: string, isError = false) {
      const toolSpan = openToolSpans.get(toolCallId);
      if (toolSpan) {
        openToolSpans.delete(toolCallId);
        toolSpan.setAttribute('output.value', content.slice(0, 10000));
        toolSpan.setAttribute('output.mime_type', 'text/plain');
        if (isError) toolSpan.setAttribute('error', true);
        toolSpan.end();
      } else {
        // Fallback: event on parent span (e.g. tracer unavailable, or no matching call)
        span?.addEvent('tool_result', {
          'tool_call.id': toolCallId,
          'output.value': content.slice(0, 10000),
          'error': isError,
        });
      }
    },

    setOutput(output: string) {
      flushOpenToolSpans(); // close any tool spans that never got a result
      span?.setAttribute('output.value', output);
      span?.setAttribute('output.mime_type', 'text/plain');
    },

    setTokens(prompt?: number, completion?: number, total?: number) {
      if (prompt !== undefined) span?.setAttribute('llm.token_count.prompt', prompt);
      if (completion !== undefined) span?.setAttribute('llm.token_count.completion', completion);
      if (total !== undefined) span?.setAttribute('llm.token_count.total', total);
    },

    setCost(totalUsd?: number) {
      if (totalUsd !== undefined) span?.setAttribute('llm.cost.total', totalUsd);
    },

    recordError(error: Error) {
      flushOpenToolSpans();
      span?.recordException(error);
    },

    get raw() {
      return span;
    },
  };
}

/**
 * No-op tracing span for when Phoenix is disabled
 */
const noopSpan: TracingSpan = {
  get traceId() { return undefined; },
  addReasoning() {},
  addToolCall() {},
  addToolResult() {},
  setOutput() {},
  setTokens() {},
  setCost() {},
  recordError() {},
  raw: null,
};

/**
 * Trace an agent turn (message handling).
 *
 * Creates a span covering the full input -> thinking -> tools -> output flow.
 * If Phoenix is not enabled, runs the callback without tracing overhead.
 *
 * @param ctx - Context for the trace (input, session, user, etc.)
 * @param fn - Async function to execute within the trace span
 * @returns The result of the callback function
 */
export async function traceAgentTurn<T>(
  ctx: AgentTurnContext,
  fn: (span: TracingSpan) => Promise<T>
): Promise<T> {
  // If tracing not enabled, run without overhead
  if (!isPhoenixEnabled || !tracer) {
    return fn(noopSpan);
  }

  // Use withSpan if available — idiomatic OpenInference way to create spans,
  // handles propagation and kind conventions automatically.
  if (withSpanFn) {
    // withSpan is a decorator factory: withSpan(fn, opts) returns a wrapped function.
    // We must call the returned function to actually execute fn inside a span.
    return withSpanFn(
      async () => {
        const span = trace?.getActiveSpan?.() || null;

        // Set input attributes
        span?.setAttribute('input.value', ctx.input);
        span?.setAttribute('input.mime_type', 'text/plain');
        span?.setAttribute('openinference.span.kind', 'AGENT');

        if (ctx.sessionId) span?.setAttribute('session.id', ctx.sessionId);
        if (ctx.userId) span?.setAttribute('user.id', ctx.userId);
        if (ctx.channel) span?.setAttribute('metadata.channel', ctx.channel);
        if (ctx.agentId) span?.setAttribute('metadata.agent_id', ctx.agentId);

        if (ctx.metadata) {
          for (const [key, value] of Object.entries(ctx.metadata)) {
            span?.setAttribute(`metadata.${key}`, value);
          }
        }

        return fn(createTracingSpan(span));
      },
      { name: 'agent_turn', kind: 'AGENT' }
    )(); // ← invoke the wrapped function returned by withSpan
  }

  // Fallback: manual span creation
  return tracer.startActiveSpan('agent_turn', async (span: OTelSpan) => {
    try {
      span.setAttribute('input.value', ctx.input);
      span.setAttribute('input.mime_type', 'text/plain');
      span.setAttribute('openinference.span.kind', 'AGENT');

      if (ctx.sessionId) span.setAttribute('session.id', ctx.sessionId);
      if (ctx.userId) span.setAttribute('user.id', ctx.userId);
      if (ctx.channel) span.setAttribute('metadata.channel', ctx.channel);
      if (ctx.agentId) span.setAttribute('metadata.agent_id', ctx.agentId);

      if (ctx.metadata) {
        for (const [key, value] of Object.entries(ctx.metadata)) {
          span.setAttribute(`metadata.${key}`, value);
        }
      }

      const result = await fn(createTracingSpan(span));
      return result;
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Shutdown tracing gracefully (flushes pending spans).
 * Call this before process exit.
 */
export async function shutdownTracing(): Promise<void> {
  if (!isPhoenixEnabled || !tracerProvider) return;

  try {
    console.log('[Tracing] Flushing pending spans...');
    await tracerProvider.shutdown();
    console.log('[Tracing] Shutdown complete');
  } catch (err) {
    console.warn('[Tracing] Error during shutdown:', err);
  }
}
