export interface DebugLogger {
	log(category: string, message: string, data?: unknown): void;
}

const MAX_DATA_LENGTH = 500;

function truncate(value: unknown): string {
	let str: string;
	if (typeof value === "string") {
		str = value;
	} else {
		try {
			str = JSON.stringify(value);
		} catch {
			str = String(value);
		}
	}
	if (str.length <= MAX_DATA_LENGTH) return str;
	return `${str.slice(0, MAX_DATA_LENGTH)}… (${str.length} chars)`;
}

const noopLogger: DebugLogger = { log() {} };

export function createDebugLogger(enabled: boolean | undefined): DebugLogger {
	if (!enabled) return noopLogger;
	return {
		log(category: string, message: string, data?: unknown) {
			const ts = new Date().toISOString();
			const prefix = `[stratus:${category}]`;
			if (data !== undefined) {
				process.stderr.write(`${prefix} ${ts} ${message} ${truncate(data)}\n`);
			} else {
				process.stderr.write(`${prefix} ${ts} ${message}\n`);
			}
		},
	};
}
