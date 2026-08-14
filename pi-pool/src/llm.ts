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
 * Real provider via the maintained @earendil-works/pi-ai compatibility surface.
 * It is lazily imported so the stub path remains offline. Live activation only requires
 * the provider's env key (e.g. ANTHROPIC_API_KEY); pi-ai resolves that key automatically.
 * `getModel`/`completeSimple` are accessed with loose casts because their generic types key
 * off pi-ai's generated model table, which we address at runtime.
 */
export class PiAiLlm implements LlmClient {
  private readonly opts: { provider: string; model: string };
  constructor(opts: { provider: string; model: string }) {
    this.opts = opts;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi = (await import("@earendil-works/pi-ai/compat")) as any;
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
