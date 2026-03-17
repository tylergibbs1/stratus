import { z } from "zod";
import type { FunctionTool } from "./tool";

const TodoItemSchema = z.object({
	id: z.string().describe("Unique identifier for the todo"),
	content: z.string().describe("Description of the task"),
	status: z.enum(["pending", "in_progress", "completed"]).describe("Current status"),
	activeForm: z
		.string()
		.optional()
		.describe("Present continuous form shown when in_progress (e.g. 'Running tests')"),
});

export type Todo = z.infer<typeof TodoItemSchema>;
export type TodoStatus = Todo["status"];

export type TodoUpdateListener = (todos: readonly Todo[]) => void;

export class TodoList {
	private items: Todo[] = [];
	private listeners: TodoUpdateListener[] = [];

	/** Get a snapshot of all current todos. */
	get todos(): readonly Todo[] {
		return this.items;
	}

	/** Register a callback invoked whenever todos change. Returns an unsubscribe function. */
	onUpdate(listener: TodoUpdateListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/** Replace the entire todo list (used internally by the tool). */
	write(todos: Todo[]): void {
		this.items = todos;
		for (const listener of this.listeners) {
			listener(this.items);
		}
	}

	/** Reset the todo list. */
	clear(): void {
		this.items = [];
		for (const listener of this.listeners) {
			listener(this.items);
		}
	}
}

const TodoWriteSchema = z.object({
	todos: z.array(TodoItemSchema).describe("The complete list of todos"),
});

/**
 * Creates a tool that lets the agent manage a todo list.
 *
 * The agent sends the full todo list state each time, making updates idempotent.
 *
 * ```ts
 * const todos = new TodoList();
 * todos.onUpdate((items) => console.log(items));
 *
 * const agent = new Agent({
 *   tools: [todoTool(todos)],
 * });
 * ```
 */
export function todoTool<TContext = unknown>(
	list: TodoList,
): FunctionTool<z.infer<typeof TodoWriteSchema>, TContext> {
	return {
		type: "function",
		name: "todo_write",
		description:
			"Create or update a structured task list to track progress on multi-step work. " +
			"Send the complete list of todos each time. Use status 'pending' for new tasks, " +
			"'in_progress' for active work (provide activeForm), and 'completed' for finished tasks.",
		parameters: TodoWriteSchema,
		execute: async (_ctx, params) => {
			list.write(params.todos);

			const pending = params.todos.filter((t) => t.status === "pending").length;
			const inProgress = params.todos.filter((t) => t.status === "in_progress").length;
			const completed = params.todos.filter((t) => t.status === "completed").length;

			return `Updated todos: ${completed}/${params.todos.length} completed, ${inProgress} in progress, ${pending} pending`;
		},
	};
}
