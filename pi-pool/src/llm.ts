// The doer's LLM seam. Provider-agnostic on purpose: the whole /build pipeline is
// validated against StubLlm (no network, no spend), and a real provider is a drop-in
// implementing the same LlmClient interface. Live wiring lands at M5 once a provider+key
// are chosen.

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  meta?: Record<string, unknown>; // ignored by real providers; StubLlm may key off it
}

export interface LlmResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** No-network stub — a pure responder function. Used to prove the /build plumbing. */
export class StubLlm implements LlmClient {
  private readonly responder: (req: LlmRequest) => string;
  constructor(responder: (req: LlmRequest) => string) {
    this.responder = responder;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    return { text: this.responder(req), usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

/**
 * Real provider via @mariozechner/pi-ai `completeSimple` (verified against
 * packages/ai/src/stream.ts:52 + models.ts:20). Lazily imported so the stub path needs
 * no install. M5 activation = (a) make `@mariozechner/pi-ai` resolvable in pi-pool
 * (`npm install`, or link the local `../../DextersLab/pi-mono/packages/ai` build), and
 * (b) set the provider's env key (e.g. ANTHROPIC_API_KEY) — pi-ai auto-resolves it via
 * getEnvApiKey. `getModel`/`completeSimple` are accessed with loose casts because their
 * generic types key off pi-ai's generated MODELS table, which we address at runtime.
 */
export class PiAiLlm implements LlmClient {
  private readonly opts: { provider: string; model: string };
  constructor(opts: { provider: string; model: string }) {
    this.opts = opts;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi = (await import("@mariozechner/pi-ai")) as any;
    const model = pi.getModel(this.opts.provider, this.opts.model);
    if (!model) throw new Error(`pi-ai: unknown model ${this.opts.provider}/${this.opts.model}`);
    const res = await pi.completeSimple(
      model,
      { systemPrompt: req.system, messages: [{ role: "user", content: req.prompt }] },
      { maxTokens: req.maxTokens ?? 2048 },
    );
    const text: string = (res.content ?? [])
      .filter((b: { type?: string }) => b?.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("");
    return {
      text,
      usage: { input_tokens: res.usage?.input ?? 0, output_tokens: res.usage?.output ?? 0 },
    };
  }
}
