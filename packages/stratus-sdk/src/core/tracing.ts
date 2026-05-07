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

export interface TraceProcessor {
	exportTrace(trace: Trace): void | Promise<void>;
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
const traceProcessors: TraceProcessor[] = [];

export function getCurrentTrace(): TraceContext | undefined {
	return traceStorage.getStore();
}

export function addTraceProcessor(processor: TraceProcessor): void {
	traceProcessors.push(processor);
}

export function setTraceProcessors(processors: TraceProcessor[]): void {
	traceProcessors.length = 0;
	traceProcessors.push(...processors);
}

export function clearTraceProcessors(): void {
	traceProcessors.length = 0;
}

async function exportTrace(trace: Trace): Promise<void> {
	await Promise.all(
		traceProcessors.map(async (processor) => {
			try {
				await processor.exportTrace(trace);
			} catch (error) {
				console.warn(
					`[stratus tracing] trace processor failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}),
	);
}

export async function withTrace<T>(
	name: string,
	fn: (trace: TraceContext) => T | Promise<T>,
): Promise<{ result: T; trace: Trace }> {
	const traceCtx = new TraceContext(name);
	try {
		const result = await traceStorage.run(traceCtx, () => fn(traceCtx));
		const trace = traceCtx.finish();
		await exportTrace(trace);
		return { result, trace };
	} catch (error) {
		const trace = traceCtx.finish();
		await exportTrace(trace);
		throw error;
	}
}

export interface AzureMonitorTraceExporterConfig {
	/** Application Insights connection string. Defaults to APPLICATIONINSIGHTS_CONNECTION_STRING. */
	connectionString?: string;
	/** Optional cloud role/service name attached to each telemetry item. */
	serviceName?: string;
	/** Custom fetch implementation for tests or non-standard runtimes. */
	fetch?: typeof fetch;
}

interface ParsedConnectionString {
	instrumentationKey: string;
	ingestionEndpoint: string;
}

function parseConnectionString(value: string | undefined): ParsedConnectionString {
	if (!value) {
		throw new Error(
			"Missing Application Insights connection string. Set APPLICATIONINSIGHTS_CONNECTION_STRING or pass connectionString.",
		);
	}
	const parts = new Map(
		value
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const idx = part.indexOf("=");
				return idx >= 0 ? [part.slice(0, idx), part.slice(idx + 1)] : [part, ""];
			}),
	);
	const instrumentationKey = parts.get("InstrumentationKey");
	if (!instrumentationKey) {
		throw new Error("Application Insights connection string is missing InstrumentationKey.");
	}
	const ingestionEndpoint = (
		parts.get("IngestionEndpoint") ?? "https://dc.services.visualstudio.com"
	).replace(/\/$/, "");
	return { instrumentationKey, ingestionEndpoint };
}

function absoluteTime(ms: number): string {
	return new Date(performance.timeOrigin + ms).toISOString();
}

function flattenSpans(spans: Span[], parentId?: string): Array<{ span: Span; parentId?: string }> {
	const flattened: Array<{ span: Span; parentId?: string }> = [];
	for (const span of spans) {
		const spanId = crypto.randomUUID();
		flattened.push({ span: { ...span, metadata: { ...span.metadata, spanId } }, parentId });
		flattened.push(...flattenSpans(span.children, spanId));
	}
	return flattened;
}

export class AzureMonitorTraceExporter implements TraceProcessor {
	private readonly connection: ParsedConnectionString;
	private readonly serviceName: string;
	private readonly fetchImpl: typeof fetch;

	constructor(config?: AzureMonitorTraceExporterConfig) {
		this.connection = parseConnectionString(
			config?.connectionString ?? process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
		);
		this.serviceName = config?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "stratus-agent";
		this.fetchImpl = config?.fetch ?? fetch;
	}

	async exportTrace(trace: Trace): Promise<void> {
		const items = [
			this.toEventEnvelope("stratus.trace", trace.startTime, {
				traceId: trace.id,
				traceName: trace.name,
				durationMs: trace.duration ?? 0,
				serviceName: this.serviceName,
			}),
			...flattenSpans(trace.spans).map(({ span, parentId }) =>
				this.toEventEnvelope("stratus.span", span.startTime, {
					traceId: trace.id,
					traceName: trace.name,
					spanId:
						typeof span.metadata?.spanId === "string" ? span.metadata.spanId : crypto.randomUUID(),
					parentSpanId: parentId,
					spanName: span.name,
					spanType: span.type,
					durationMs: span.duration,
					serviceName: this.serviceName,
					...span.metadata,
				}),
			),
		];

		const response = await this.fetchImpl(`${this.connection.ingestionEndpoint}/v2/track`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(items),
		});
		if (!response.ok) {
			throw new Error(`Azure Monitor ingestion failed (${response.status})`);
		}
	}

	private toEventEnvelope(
		name: string,
		time: number,
		properties: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			name: "Microsoft.ApplicationInsights.Event",
			time: absoluteTime(time),
			iKey: this.connection.instrumentationKey,
			tags: {
				"ai.cloud.role": this.serviceName,
				"ai.operation.id": String(properties.traceId ?? ""),
			},
			data: {
				baseType: "EventData",
				baseData: {
					ver: 2,
					name,
					properties: Object.fromEntries(
						Object.entries(properties)
							.filter(([, value]) => value !== undefined)
							.map(([key, value]) => [
								key,
								typeof value === "string" ? value : JSON.stringify(value),
							]),
					),
				},
			},
		};
	}
}

export function createAzureMonitorTraceExporter(
	config?: AzureMonitorTraceExporterConfig,
): AzureMonitorTraceExporter {
	return new AzureMonitorTraceExporter(config);
}
