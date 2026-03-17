export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				if (trimmed.startsWith("data: ")) {
					const data = trimmed.slice(6);
					if (data === "[DONE]") return;
					yield data;
				}
			}
		}

		if (buffer.trim()) {
			const trimmed = buffer.trim();
			if (trimmed.startsWith("data: ")) {
				const data = trimmed.slice(6);
				if (data !== "[DONE]") {
					yield data;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
