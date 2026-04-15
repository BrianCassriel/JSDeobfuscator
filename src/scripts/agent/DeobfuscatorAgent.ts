import { getOutputFile } from "../../utils";
import { AgentStatusUpdater } from "../AgentStatusUpdater";
import { ACTIONS } from "./Actions";
import { Editor } from "./Editor";
import { Executor } from "./Executor";
import { Validator } from "./Validator";

const MAX_ITERATIONS = 50;
const MAX_CONSECUTIVE_FAILURES = 3;

export class DeobfuscatorAgent {
    sourceFile: string;
    shouldStop: boolean = false;
    score: number = 0;

    constructor(sourceFile: string) {
        this.sourceFile = sourceFile;
    }

    async start() {
        let iterations = 0;
        let consecutiveFailures = 0;
        const rewrittenFunctions: string[] = [];

        while (!this.shouldStop && iterations < MAX_ITERATIONS && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
            iterations++;
            const outputFile = getOutputFile() ?? "";

            let result;
            try {
                result = await Editor.planAndEdit(outputFile, rewrittenFunctions);
            } catch (e) {
                AgentStatusUpdater.error(`LLM call failed: ${e}`);
                consecutiveFailures++;
                continue;
            }

            AgentStatusUpdater.running(`[${iterations}/${MAX_ITERATIONS}] ${result.action}\n - ${result.reason}`);

            if (result.action === ACTIONS.STOP || result.operations.length === 0) {
                this.finish();
                break;
            }

            Executor.execute(result);

            if (!Validator.validate(getOutputFile() ?? "")) {
                AgentStatusUpdater.error("Validation failed, reverting...");
                Executor.revert();
                this.changeScore(-1);
                consecutiveFailures++;
                continue;
            }

            // Track rewritten functions to avoid redundant rewrites
            for (const op of result.operations) {
                if (op.tool === 'rewrite_function' && op.functionName) {
                    if (!rewrittenFunctions.includes(op.functionName)) {
                        rewrittenFunctions.push(op.functionName);
                    }
                }
            }

            this.changeScore(1);
            consecutiveFailures = 0;
        }

        if (iterations >= MAX_ITERATIONS) {
            AgentStatusUpdater.running(`Reached max iterations (${MAX_ITERATIONS}), stopping.`);
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            AgentStatusUpdater.error(`Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`);
        }

        this.finish();
    }

    abort() {
        this.shouldStop = true;
    }

    finish() {
        this.shouldStop = true;
        AgentStatusUpdater.finished();
    }

    changeScore(delta: number) {
        this.score += delta;
    }
}