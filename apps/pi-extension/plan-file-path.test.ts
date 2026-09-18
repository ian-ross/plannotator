import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import plannotator from "./index.ts";
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL, PLANNOTATOR_REQUEST_CHANNEL } from "./plannotator-events.ts";

type Entry = { type: "custom"; customType: string; data: Record<string, unknown> };
type Context = ReturnType<typeof createContext>;
type Handler = (event: any, ctx: Context) => any;
const tempDirs: string[] = [];
const originalEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PLANNOTATOR_DATA_DIR: process.env.PLANNOTATOR_DATA_DIR };

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(instructions?: string) {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-path-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi/plannotator.json"), JSON.stringify({
		executionMode: "external",
		...(instructions !== undefined ? { phases: { planning: { instructions } } } : {}),
	}));
	return cwd;
}

function createContext(cwd: string, entries: Entry[]) {
	const notifications: Array<{ message: string; level?: string }> = [];
	return {
		cwd, hasUI: false, isIdle: () => true, isProjectTrusted: () => true,
		model: undefined, modelRegistry: { find: () => undefined }, notifications,
		sessionManager: {
			getBranch: () => entries, getEntries: () => entries,
			getSessionId: () => "plan-path-test", getSessionFile: () => undefined, getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus: () => undefined, setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};
}

async function runtime(cwd: string, initialEntries: Entry[] = [], planFlag = false) {
	const entries = structuredClone(initialEntries);
	const ctx = createContext(cwd, entries);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: Context) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const listeners = new Map<string, (data: any) => unknown>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const sent: unknown[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	plannotator({
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, handler: (data: any) => unknown) => { listeners.set(name, handler); return () => listeners.delete(name); },
			emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerFlag: () => undefined, registerShortcut: () => undefined,
		getFlag: () => planFlag, getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
		getThinkingLevel: () => "medium", setThinkingLevel: () => undefined, setModel: async () => true,
		appendEntry: (customType: string, data: Record<string, unknown>) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (...args: unknown[]) => sent.push(args), sendUserMessage: (...args: unknown[]) => sent.push(args),
	} as never);
	const run = async (event: string, payload: unknown = {}, context = ctx) => {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
		return results;
	};
	await run("session_start");
	return {
		ctx, entries, emitted, sent, run,
		command: (args = "") => commands.get("plannotator-plan-mode")!.handler(args, ctx),
		prompt: async () => (await run("before_agent_start"))[0]?.message?.content as string | undefined,
		gate: async (path: string, toolName = "write") => (await run("tool_call", { toolName, input: { path } }))[0],
		submit: (filePath: string) => tools.get("plannotator_submit_plan")!.execute("submit-1", { filePath }, undefined, undefined, ctx),
		request: async (payload: unknown) => {
			let response: any;
			await listeners.get(PLANNOTATOR_REQUEST_CHANNEL)!({
				requestId: "test", action: "plan-mode", payload,
				respond: (value: unknown) => { response = value; },
			});
			return response;
		},
	};
}

test("command selects a missing file before the first prompt without creating it or starting a turn", async () => {
	const cwd = workspace("Plan file: ${planFilePath}");
	const h = await runtime(cwd);
	await h.command(" plans/new feature.md ");
	expect(existsSync(join(cwd, "plans"))).toBe(false);
	expect(h.sent).toEqual([]);
	expect(await h.prompt()).toContain("Plan file: plans/new feature.md");
	expect(await h.prompt()).toBeUndefined();
	expect(await h.gate("plans/new feature.md")).toBeUndefined();
	expect(await h.gate(resolve(cwd, "plans/new feature.md"), "edit")).toBeUndefined();
	expect((await h.gate("different.md")).block).toBe(true);
	expect((await h.gate("src/app.ts")).block).toBe(true);
});

test("the bundled prompt names the selected file even without a custom placeholder", async () => {
	const cwd = workspace();
	const h = await runtime(cwd);
	await h.command("plans/auth.md");
	expect(await h.prompt()).toContain("plans/auth.md");
});

test("no-argument toggle and --plan still let the agent choose a filename", async () => {
	const cwd = workspace("Plan file: ${planFilePath}");
	const h = await runtime(cwd);
	await h.command();
	expect(await h.prompt()).toContain("Plan file: your plan file");
	expect(await h.gate("a.md")).toBeUndefined();
	expect(await h.gate("plans/b.mdx", "edit")).toBeUndefined();
	await h.command();
	expect((await h.request({ mode: "status" })).result.phase).toBe("idle");
	const flagged = await runtime(cwd, [], true);
	expect(await flagged.prompt()).toContain("Plan file: your plan file");
	expect(await flagged.gate("agent-chosen.md")).toBeUndefined();
});

test("invalid command paths leave the phase idle", async () => {
	const cwd = workspace();
	mkdirSync(join(cwd, "directory.md"));
	writeFileSync(join(cwd, "file"), "not a directory");
	const h = await runtime(cwd);
	for (const path of ["../outside.md", resolve(cwd, "../outside.md"), "src/app.ts", "directory.md", "file/child.md", "bad\0.md", "bad\n.md"]) {
		await h.command(path);
		expect(h.ctx.notifications.at(-1)?.level).toBe("error");
		expect((await h.request({ mode: "status" })).result).toEqual({ phase: "idle" });
		expect(await h.prompt()).toBeUndefined();
	}
});

test("event enter selects and reports a path, repeated entry does not toggle or reframe", async () => {
	const cwd = workspace("Plan file: ${planFilePath}");
	const h = await runtime(cwd);
	const entered = await h.request({ mode: "enter", planFilePath: resolve(cwd, "plan.mdx") });
	expect(entered).toEqual({ status: "handled", result: { phase: "planning", planFilePath: "plan.mdx" } });
	expect(await h.prompt()).toContain("Plan file: plan.mdx");
	expect(await h.request({ mode: "status" })).toEqual(entered);
	expect(await h.request({ mode: "enter", planFilePath: "./plan.mdx" })).toEqual(entered);
	await h.command("plan.mdx");
	expect(await h.prompt()).toBeUndefined();
	expect(await h.request({ mode: "enter" })).toEqual(entered);
	expect((await h.request({ mode: "enter", planFilePath: "other.md" })).status).toBe("error");
	await h.command("other.md");
	expect(h.ctx.notifications.at(-1)?.level).toBe("error");
	expect(await h.request({ mode: "status" })).toEqual(entered);
});

test("malformed event paths and paths on non-enter actions are rejected before changing state", async () => {
	const cwd = workspace();
	const h = await runtime(cwd);
	for (const payload of [
		...[null, 12, {}, "", " ", "../outside.md", "notes.txt", "bad\0.md"].map(planFilePath => ({ mode: "enter", planFilePath })),
		...["toggle", "status", "exit", undefined].map(mode => ({ mode, planFilePath: "plan.md" })),
	]) {
		expect((await h.request(payload)).status).toBe("error");
		expect((await h.request({ mode: "status" })).result.phase).toBe("idle");
	}
	expect((await h.request({ mode: "toggle" })).result.phase).toBe("planning");
	expect((await h.request({ mode: "toggle" })).result.phase).toBe("idle");
});

test("selected paths survive resume and compaction, but not exit or unrelated branches", async () => {
	const cwd = workspace("Plan file: ${planFilePath}");
	const h = await runtime(cwd);
	await h.command("draft.md");
	const beforePrompt = structuredClone(h.entries);
	const resumed = await runtime(cwd, beforePrompt);
	expect(await resumed.prompt()).toContain("Plan file: draft.md");
	const afterPrompt = await runtime(cwd, resumed.entries);
	expect(await afterPrompt.prompt()).toBeUndefined();
	await afterPrompt.run("session_compact");
	expect(await afterPrompt.prompt()).toContain("Plan file: draft.md");
	expect((await afterPrompt.gate("other.md")).block).toBe(true);
	await afterPrompt.request({ mode: "exit" });
	await afterPrompt.command();
	expect(await afterPrompt.prompt()).toContain("Plan file: your plan file");
	expect(await afterPrompt.gate("other.md")).toBeUndefined();

	await h.run("session_tree", {}, createContext(cwd, []));
	await h.command();
	expect(await h.prompt()).toContain("Plan file: your plan file");
	await h.run("session_tree", {}, createContext(cwd, beforePrompt));
	expect(await h.prompt()).toContain("Plan file: draft.md");
	const legacy = [{ type: "custom" as const, customType: "plannotator", data: { phase: "planning" } }];
	await h.run("session_tree", {}, createContext(cwd, legacy));
	expect(await h.prompt()).toContain("Plan file: your plan file");
	expect(await h.gate("legacy.md")).toBeUndefined();
});

test("submission requires the selected file and external handoff clears the selection", async () => {
	const cwd = workspace();
	const content = "# Plan\n\n- [ ] Do the work\n";
	writeFileSync(join(cwd, "selected.md"), content);
	writeFileSync(join(cwd, "other.md"), content);
	const h = await runtime(cwd);
	await h.command("selected.md");
	expect(readFileSync(join(cwd, "selected.md"), "utf8")).toBe(content);
	const refused = await h.submit("other.md");
	expect(refused.details.approved).toBe(false);
	expect(refused.content[0].text).toContain("selected.md");
	expect(h.emitted).toEqual([]);
	expect((await h.submit("./selected.md")).details).toEqual({ approved: true, handedOff: true });
	expect(h.emitted).toContainEqual({ channel: PLANNOTATOR_PLAN_APPROVED_CHANNEL, payload: { cwd, planFilePath: "./selected.md", planContent: content } });
	expect((await h.request({ mode: "status" })).result).toEqual({ phase: "idle" });
	await h.command();
	expect(await h.gate("other.md")).toBeUndefined();
});

test("a filename cannot replace an executing plan", async () => {
	const cwd = workspace();
	writeFileSync(join(cwd, "approved.md"), "# Plan\n- [ ] Work\n");
	const h = await runtime(cwd, [{ type: "custom", customType: "plannotator", data: { phase: "executing", lastSubmittedPath: "approved.md" } }]);
	await h.command("new.md");
	expect(h.ctx.notifications.at(-1)?.level).toBe("error");
	expect((await h.request({ mode: "status" })).result).toEqual({ phase: "executing", planFilePath: "approved.md" });
});
