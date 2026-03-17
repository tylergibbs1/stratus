import { describe, expect, it, mock } from "bun:test";
import { TodoList, todoTool } from "../../src/core/todo";
import type { Todo } from "../../src/core/todo";

describe("TodoList", () => {
	it("starts empty", () => {
		const list = new TodoList();
		expect(list.todos).toEqual([]);
	});

	it("write() replaces the entire list", () => {
		const list = new TodoList();
		const todos: Todo[] = [
			{ id: "1", content: "First task", status: "pending" },
			{
				id: "2",
				content: "Second task",
				status: "in_progress",
				activeForm: "Working on second task",
			},
		];
		list.write(todos);
		expect(list.todos).toEqual(todos);
	});

	it("write() replaces previous state", () => {
		const list = new TodoList();
		list.write([{ id: "1", content: "Old", status: "pending" }]);
		list.write([{ id: "1", content: "Old", status: "completed" }]);
		expect(list.todos).toHaveLength(1);
		expect(list.todos[0]!.status).toBe("completed");
	});

	it("clear() empties the list", () => {
		const list = new TodoList();
		list.write([{ id: "1", content: "Task", status: "pending" }]);
		list.clear();
		expect(list.todos).toEqual([]);
	});

	it("onUpdate() fires on write()", () => {
		const list = new TodoList();
		const listener = mock(() => {});
		list.onUpdate(listener);

		const todos: Todo[] = [{ id: "1", content: "Task", status: "pending" }];
		list.write(todos);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith(todos);
	});

	it("onUpdate() fires on clear()", () => {
		const list = new TodoList();
		list.write([{ id: "1", content: "Task", status: "pending" }]);

		const listener = mock(() => {});
		list.onUpdate(listener);
		list.clear();

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith([]);
	});

	it("onUpdate() supports multiple listeners", () => {
		const list = new TodoList();
		const listener1 = mock(() => {});
		const listener2 = mock(() => {});
		list.onUpdate(listener1);
		list.onUpdate(listener2);

		list.write([{ id: "1", content: "Task", status: "pending" }]);

		expect(listener1).toHaveBeenCalledTimes(1);
		expect(listener2).toHaveBeenCalledTimes(1);
	});

	it("unsubscribe stops future notifications", () => {
		const list = new TodoList();
		const listener = mock(() => {});
		const unsub = list.onUpdate(listener);

		list.write([{ id: "1", content: "Task", status: "pending" }]);
		expect(listener).toHaveBeenCalledTimes(1);

		unsub();
		list.write([{ id: "2", content: "Another", status: "pending" }]);
		expect(listener).toHaveBeenCalledTimes(1); // not called again
	});

	it("todos is a readonly snapshot", () => {
		const list = new TodoList();
		list.write([{ id: "1", content: "Task", status: "pending" }]);
		const snapshot = list.todos;
		list.write([]);
		// snapshot still has old data
		expect(snapshot).toHaveLength(1);
		expect(list.todos).toHaveLength(0);
	});
});

describe("todoTool", () => {
	it("returns a FunctionTool with correct metadata", () => {
		const list = new TodoList();
		const t = todoTool(list);

		expect(t.type).toBe("function");
		expect(t.name).toBe("todo_write");
		expect(t.description).toContain("task list");
		expect(t.parameters).toBeDefined();
	});

	it("execute() writes todos to the list", async () => {
		const list = new TodoList();
		const t = todoTool(list);

		await t.execute(
			{},
			{
				todos: [
					{ id: "1", content: "Build feature", status: "pending" },
					{ id: "2", content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
				],
			},
		);

		expect(list.todos).toHaveLength(2);
		expect(list.todos[0]!.content).toBe("Build feature");
		expect(list.todos[1]!.status).toBe("in_progress");
	});

	it("execute() returns a summary string", async () => {
		const list = new TodoList();
		const t = todoTool(list);

		const result = await t.execute(
			{},
			{
				todos: [
					{ id: "1", content: "Done", status: "completed" },
					{ id: "2", content: "Active", status: "in_progress", activeForm: "Working" },
					{ id: "3", content: "Todo", status: "pending" },
				],
			},
		);

		expect(result).toContain("1/3 completed");
		expect(result).toContain("1 in progress");
		expect(result).toContain("1 pending");
	});

	it("fires listeners when executed", async () => {
		const list = new TodoList();
		const listener = mock(() => {});
		list.onUpdate(listener);

		const t = todoTool(list);
		await t.execute(
			{},
			{
				todos: [{ id: "1", content: "Task", status: "pending" }],
			},
		);

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("can be serialized to a tool definition", () => {
		const list = new TodoList();
		const t = todoTool(list);

		// Verify the tool works with toolToDefinition
		const { toolToDefinition } = require("../../src/core/tool");
		const def = toolToDefinition(t);

		expect(def.type).toBe("function");
		expect(def.function.name).toBe("todo_write");
		expect(def.function.parameters).toBeDefined();
		expect(def.function.parameters.properties).toHaveProperty("todos");
	});
});
