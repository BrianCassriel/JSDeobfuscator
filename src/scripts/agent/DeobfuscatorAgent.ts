import { getOutputFile } from "../../utils";
import { AgentStatusUpdater } from "../AgentStatusUpdater";
import { ACTIONS } from "./Actions";
import { Editor } from "./Editor";
import { Executor } from "./Executor";
import { Memory } from "./Memory";
import { Planner } from "./Planner";
import { Validator } from "./Validator";

export class DeobfuscatorAgent {
    sourceFile: string;
    shouldStop: boolean = false;
    memory: Memory = new Memory();
    score: number = 0;
    requestsPerMinute: number = 1;

    constructor(sourceFile: string) {
        this.sourceFile = sourceFile;
    }

    async start() {
        while (this.shouldStop === false) {
            await new Promise(resolve => setTimeout(resolve, 60*1000/this.requestsPerMinute));
            const outputFile = getOutputFile() ?? "";
            const plan = await Planner.plan(outputFile, this.memory);
            AgentStatusUpdater.running(`Planned action: ${plan.action}\n - ${plan.reason}`);
            if (plan.action === ACTIONS.STOP) {
                this.finish();
                break;
            }
            const patch = await Editor.applyPlan(this.sourceFile, outputFile, plan);
            AgentStatusUpdater.running(`Applying patch: ${patch.characters}\n - ${patch.reason}`);
            Executor.execute(patch);
            if (!Validator.validate(getOutputFile() ?? "")) {
                AgentStatusUpdater.error("Validation failed after applying patch.");
                Executor.revert();
                this.changeScore(-1);
                continue;
            }
            this.changeScore(1);
        }
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