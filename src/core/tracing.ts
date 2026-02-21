import { AsyncLocalStorage } from "node:async_hooks";

export interface Span {
	name: string;
	type: "model_call" | "tool_execution" | "handoff" | "guardrail" | "subagent" | "custom";
	startTime: number;
	endTime: number;
	duration: number;
	metadata?: Record<string, unknown>;
	children: Span[];
}

export interface Trace {
	id: string;
	name: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	spans: Span[];
}

export class TraceContext {
	readonly trace: Trace;
	private spanStack: Span[];

	constructor(name: string) {
		this.trace = {
			id: crypto.randomUUID(),
			name,
			startTime: performance.now(),
			spans: [],
		};
		this.spanStack = [];
	}

	startSpan(name: string, type: Span["type"], metadata?: Record<string, unknown>): Span {
		const span: Span = {
			name,
			type,
			startTime: performance.now(),
			endTime: 0,
			duration: 0,
			metadata,
			children: [],
		};

		const parent = this.spanStack[this.spanStack.length - 1];
		if (parent) {
			parent.children.push(span);
		} else {
			this.trace.spans.push(span);
		}

		this.spanStack.push(span);
		return span;
	}

	endSpan(span: Span, metadata?: Record<string, unknown>): void {
		span.endTime = performance.now();
		span.duration = span.endTime - span.startTime;
		if (metadata) {
			span.metadata = { ...span.metadata, ...metadata };
		}
		// Pop the matching span; handle out-of-order or missing endSpan calls
		const idx = this.spanStack.lastIndexOf(span);
		if (idx >= 0) {
			this.spanStack.splice(idx, 1);
		}
	}

	finish(): Trace {
		this.trace.endTime = performance.now();
		this.trace.duration = this.trace.endTime - this.trace.startTime;
		return this.trace;
	}
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getCurrentTrace(): TraceContext | undefined {
	return traceStorage.getStore();
}

export async function withTrace<T>(
	name: string,
	fn: (trace: TraceContext) => T | Promise<T>,
): Promise<{ result: T; trace: Trace }> {
	const traceCtx = new TraceContext(name);
	const result = await traceStorage.run(traceCtx, () => fn(traceCtx));
	const trace = traceCtx.finish();
	return { result, trace };
}
