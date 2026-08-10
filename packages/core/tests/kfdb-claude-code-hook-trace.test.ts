import { describe, expect, it } from 'vitest';
import { buildClaudeCodeHookTraceOperations, buildClaudeCodeHookTraceWriteBundle } from '../src/kfdb/claude-code-hook-trace.js';

describe('buildClaudeCodeHookTraceOperations', () => {
  it('creates deterministic rich private KG operations from Claude Code hook records', () => {
    const trace = {
      walletAddress: '0x75992f829DF3B5d515D70DB0f77A98171cE261EF',
      agentId: 'erc8004-expert',
      sessionId: 'session-1',
      turnIndex: 2,
      claudeSessionId: 'claude-session-1',
      transcriptPath: '/workspace/.claude/transcripts/claude-session-1.jsonl',
      model: 'claude-sonnet-4-6',
      cwd: '/workspace',
      startedAt: 1_765_000_000_000,
      completedAt: 1_765_000_001_000,
      events: [
        {
          sequence: 0,
          hookEventName: 'SessionStart',
          claudeSessionId: 'claude-session-1',
          transcriptPath: '/workspace/.claude/transcripts/claude-session-1.jsonl',
          cwd: '/workspace',
          receivedAt: 1_765_000_000_000,
          source: 'startup',
        },
        {
          sequence: 1,
          hookEventName: 'PostToolUse',
          claudeSessionId: 'claude-session-1',
          transcriptPath: '/workspace/.claude/transcripts/claude-session-1.jsonl',
          cwd: '/workspace',
          receivedAt: 1_765_000_000_500,
          toolName: 'Edit',
          toolUseId: 'tool-1',
          toolInput: { file_path: '/workspace/src/index.ts', old_string: 'a', new_string: 'b' },
          toolResponse: { success: true, filePath: '/workspace/src/index.ts' },
        },
        {
          sequence: 2,
          hookEventName: 'Stop',
          claudeSessionId: 'claude-session-1',
          transcriptPath: '/workspace/.claude/transcripts/claude-session-1.jsonl',
          cwd: '/workspace',
          receivedAt: 1_765_000_001_000,
          lastAssistantMessage: 'The Claude implementation is ready.',
        },
      ],
    };

    const first = buildClaudeCodeHookTraceOperations(trace);
    const second = buildClaudeCodeHookTraceOperations(trace);
    const labels = first.map((op) => op.label);
    const edges = first.map((op) => op.edge_type);

    expect(first).toEqual(second);
    expect(labels).toContain('ClaudeCodeSession');
    expect(labels).toContain('ClaudeCodeTurn');
    expect(labels).toContain('ClaudeCodeHookEvent');
    expect(labels).toContain('ClaudeCodeToolUse');
    expect(labels).toContain('CodeWorkspace');
    expect(labels).toContain('CodeFile');
    expect(edges).toContain('HAS_CLAUDE_CODE_TURN');
    expect(edges).toContain('EMITTED_CLAUDE_CODE_HOOK');
    expect(edges).toContain('INVOKED_CLAUDE_CODE_TOOL');
    expect(edges).toContain('RAN_IN_WORKSPACE');
    expect(edges).toContain('TOUCHED_FILE');
    const bundle = buildClaudeCodeHookTraceWriteBundle(trace);
    expect(bundle.contentArtifacts.filter((artifact) => artifact.value.contractVersion === 'content-artifact/v1').length).toBeGreaterThanOrEqual(2);
    const persistedContent = bundle.contentArtifacts.flatMap((artifact) => artifact.value.contractVersion === 'content-artifact/v1' ? [artifact.value.content] : []);
    expect(persistedContent).toContain('The Claude implementation is ready.');
    expect(bundle.operations.map((operation) => operation.label)).toContain('SessionArtifactManifest');
    expect(bundle.operations.map((operation) => operation.edge_type)).toContain('HAS_ARTIFACT_MANIFEST');
    const manifestContent = persistedContent.find((content) => content.includes('"contractVersion":"rickydata.session_artifact_manifest.v1"'));
    const manifest = manifestContent
      ? JSON.parse(manifestContent) as { runtime?: unknown; entries?: unknown[] }
      : undefined;
    expect(manifest?.runtime).toEqual({ agentId: 'erc8004-expert', model: 'claude-sonnet-4-6', cwd: '/workspace' });
    expect(manifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool-input', toolName: 'Edit', toolUseId: 'tool-1' }),
      expect.objectContaining({ role: 'tool-response', toolName: 'Edit', toolUseId: 'tool-1' }),
    ]));
  });

  it('writes embeddable text on the turn and the tool use, not only hashes', () => {
    // schema v3 wrote {contentLength, contentHash} and nothing else, so the
    // server's auto-embed extractor (TEXT_PROPERTY_NAMES in kfdb-api
    // file_embeddings/handlers.rs) found no text and every turn was invisible
    // to semantic search. These four property names are the ones it reads.
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2,
      events: [
        { sequence: 0, hookEventName: 'UserPromptSubmit', claudeSessionId: 's', receivedAt: 1, prompt: 'why did the Levanto request 403?' },
        {
          sequence: 1, hookEventName: 'PostToolUse', claudeSessionId: 's', receivedAt: 2,
          toolName: 'Bash', toolUseId: 't1',
          toolInput: { command: 'curl https://sage.levanto.ai/decide' },
          toolResponse: 'HTTP 403 Request blocked',
        },
        { sequence: 2, hookEventName: 'Stop', claudeSessionId: 's', receivedAt: 2, lastAssistantMessage: 'The WAF rejected the angle brackets.' },
      ],
    });
    const turn = bundle.operations.find((op) => op.label === 'ClaudeCodeTurn') as Record<string, any>;
    const tool = bundle.operations.find((op) => op.label === 'ClaudeCodeToolUse') as Record<string, any>;

    expect(turn.properties.text.String).toContain('why did the Levanto request 403?');
    expect(turn.properties.text.String).toContain('The WAF rejected the angle brackets.');
    expect(tool.properties.input_text.String).toContain('sage.levanto.ai/decide');
    expect(tool.properties.output_text).toEqual({ String: 'HTTP 403 Request blocked' });
    // The hash summary stays alongside the text — v3 readers keep working.
    expect(tool.properties.tool_input.Object.contentHash.String).toMatch(/^[0-9a-f]{64}$/);
    expect(turn.properties.schema_version).toEqual({ Integer: 4 });
  });

  it('omits text rather than writing an empty string when a turn has none', () => {
    // value(undefined) is {Null: null}; the extractor skips it. A turn with no
    // prose must not embed as "" — that is a vector pointing at nothing.
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2,
      events: [{ sequence: 0, hookEventName: 'SessionStart', claudeSessionId: 's', receivedAt: 1 }],
    });
    const turn = bundle.operations.find((op) => op.label === 'ClaudeCodeTurn') as Record<string, any>;
    expect(turn.properties.text).toEqual({ Null: null });
  });

  it('caps text at the server embed window so oversized payloads cost nothing extra', () => {
    const huge = 'x'.repeat(250_000);
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2,
      events: [{ sequence: 0, hookEventName: 'PostToolUse', claudeSessionId: 's', receivedAt: 1, toolName: 'Read', toolUseId: 't1', toolResponse: huge }],
    });
    const tool = bundle.operations.find((op) => op.label === 'ClaudeCodeToolUse') as Record<string, any>;
    expect(tool.properties.output_text.String.length).toBe(30_000);
  });

  it('emits a canonical DecisionObservation for a permission ruling', () => {
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2,
      events: [{
        sequence: 0, hookEventName: 'PermissionRequest', claudeSessionId: 's', receivedAt: 2,
        toolName: 'Bash', toolUseId: 'permission-1', toolInput: { command: 'deploy' }, permissionDecision: 'allow',
        decisionKind: 'tool_permission', decisionQuestion: 'Allow Bash?', decisionOptions: ['allow', 'deny'], decisionAnswer: 'allow',
      }],
    });
    expect(bundle.operations.map((op) => op.label)).toContain('DecisionObservation');
    expect(bundle.operations.map((op) => op.edge_type)).toContain('OBSERVED_IN_SESSION');
  });

  it('binds the exact rendered SessionStart context to the receiving session', () => {
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2,
      events: [{
        sequence: 0, hookEventName: 'ContextDelivery', claudeSessionId: 's', receivedAt: 2,
        contextDelivery: {
          deliveryKey: 'session-start:s', packHash: `sha256:${'a'.repeat(64)}`,
          renderedContent: 'exact compiled context', interface: 'claude-code-session-start',
          coverageStatus: 'bounded', omissions: [{ source: 'wiki', reason: 'budget', count: 2 }],
          deliveredAt: '2026-07-15T12:00:00.000Z',
        },
      }],
    });
    expect(bundle.operations.map((op) => op.label)).toContain('ContextDeliveryReceipt');
    expect(bundle.operations.map((op) => op.edge_type)).toContain('DELIVERED_TO_SESSION');
    expect(bundle.contentArtifacts.some((artifact) => artifact.value.contractVersion === 'content-artifact/v1' && artifact.value.content === 'exact compiled context')).toBe(true);
  });
});

describe('plan-mode plans', () => {
  it('emits Plan + HAS_PLAN + PLAN_FILE ops with the rd-plugin-locked id recipe', () => {
    const planFilePath = ['', 'Users', 'riccardoesclapon', '.claude', 'plans', 'hidden-gathering-brooks.md'].join('/');
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2, events: [],
      plans: [{ planFilePath, content: '# The plan', updatedAt: 1751364180000 }],
    });
    const planOp = bundle.operations.find((op) => op.label === 'Plan') as Record<string, any>;
    // Locked against rd-plugin src/lib/plan.ts — both writers must merge into this id.
    expect(planOp.id).toBe('0f0b35df-21b7-5caf-b964-349fd3965844');
    expect(planOp.mode).toBe('merge');
    expect(planOp.properties.slug).toEqual({ String: 'hidden-gathering-brooks' });
    expect(planOp.properties.content).toEqual({ String: '# The plan' });
    expect(bundle.operations.map((op) => op.edge_type)).toEqual(expect.arrayContaining(['HAS_PLAN', 'PLAN_FILE']));
    const codeFile = bundle.operations.find((op) => op.label === 'CodeFile') as Record<string, any>;
    expect(codeFile.properties.path).toEqual({ String: planFilePath });
  });

  it('supports pathless plans keyed by content hash and omits file ops', () => {
    const bundle = buildClaudeCodeHookTraceWriteBundle({
      walletAddress: '0xabc', agentId: 'claude-code', sessionId: 's', claudeSessionId: 's', turnIndex: 1,
      startedAt: 1, completedAt: 2, events: [],
      plans: [{ content: 'inline plan' }],
    });
    expect(bundle.operations.some((op) => op.label === 'Plan')).toBe(true);
    expect(bundle.operations.some((op) => op.edge_type === 'HAS_PLAN')).toBe(true);
    expect(bundle.operations.some((op) => op.edge_type === 'PLAN_FILE')).toBe(false);
  });
});
