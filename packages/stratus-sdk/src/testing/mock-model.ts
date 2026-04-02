import type { Model, ModelRequest, ModelResponse, StreamEvent } from "../core/model";

export interface MockModelOptions {
	capture?: boolean;
}

export interface CapturedMockModel extends Model {
	readonly requests: ModelRequest[];
}

export function createMockModel(
	responses: ModelResponse[],
	options: { capture: true },
): CapturedMockModel;
export function createMockModel(responses: ModelResponse[], options?: MockModelOptions): Model;
export function createMockModel(
	responses: ModelResponse[],
	options?: MockModelOptions,
): Model | CapturedMockModel {
	let callIndex = 0;
	const requests: ModelRequest[] = [];
	const capture = options?.capture ?? false;

	const model: Model = {
		async getResponse(request: ModelRequest): Promise<ModelResponse> {
			if (capture) requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response)
				throw new Error(
					`No more mock responses (called ${callIndex} times, have ${responses.length})`,
				);
			return response;
		},
		async *getStreamedResponse(request: ModelRequest): AsyncGenerator<StreamEvent> {
			if (capture) requests.push(structuredClone(request));
			const response = responses[callIndex++];
			if (!response)
				throw new Error(
					`No more mock responses (called ${callIndex} times, have ${responses.length})`,
				);
			if (response.content) {
				yield { type: "content_delta", content: response.content };
			}
			for (const tc of response.toolCalls) {
				yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
				yield {
					type: "tool_call_delta",
					toolCallId: tc.id,
					arguments: tc.function.arguments,
				};
				yield { type: "tool_call_done", toolCallId: tc.id };
			}
			yield { type: "done", response };
		},
	};

	if (capture) {
		return Object.assign(model, { requests }) as CapturedMockModel;
	}
	return model;
}
