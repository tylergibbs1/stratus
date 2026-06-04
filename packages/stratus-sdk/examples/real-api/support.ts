import type { AISDKUIMessageChunk } from "../../src/ai-sdk";

export function logStep(label: string, value: unknown): void {
	console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

export function textFromChunks(chunks: AISDKUIMessageChunk[]): string {
	return chunks
		.filter((chunk): chunk is { type: "text-delta"; id: string; delta: string } => {
			return chunk.type === "text-delta";
		})
		.map((chunk) => chunk.delta)
		.join("");
}

export function chunkTypes(chunks: AISDKUIMessageChunk[]): string[] {
	return chunks.map((chunk) => chunk.type);
}

export async function readUIMessageChunks(response: Response): Promise<AISDKUIMessageChunk[]> {
	if (!response.body) throw new Error("Response did not include a body");

	const chunks: AISDKUIMessageChunk[] = [];
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;

		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
			if (!dataLine) continue;
			chunks.push(JSON.parse(dataLine.slice("data: ".length)) as AISDKUIMessageChunk);
		}
	}

	return chunks;
}

export function assertIncludes(actual: string, expected: string, label: string): void {
	if (!actual.includes(expected)) {
		throw new Error(`${label} did not include "${expected}". Actual: ${actual}`);
	}
}

export function assertHasChunk(
	chunks: AISDKUIMessageChunk[],
	type: AISDKUIMessageChunk["type"],
): void {
	if (!chunks.some((chunk) => chunk.type === type)) {
		throw new Error(`Expected a ${type} chunk. Saw: ${chunkTypes(chunks).join(", ")}`);
	}
}
