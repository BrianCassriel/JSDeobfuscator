import { setOutputFile } from "../../utils";
import { AgentStatusUpdater } from "../AgentStatusUpdater";
import { ACTIONS } from "./Actions";
import { Editor } from "./Editor";
import { Executor } from "./Executor";
import { Memory } from "./Memory";
import { Planner } from "./Planner";
import { Validator } from "./Validator";

export class DeobfuscatorAgent {
    sourceFile: string;
    outputFile: string;
    shouldStop: boolean = false;
    memory: Memory = new Memory();
    score: number = 0;
    requestsPerMinute: number = 1;

    constructor(sourceFile: string, outputFile: string) {
        this.sourceFile = sourceFile;
        this.outputFile = outputFile;
    }

    async start() {
        while (this.shouldStop === false) {
            await new Promise(resolve => setTimeout(resolve, 60*1000/this.requestsPerMinute));
            const plan = await Planner.plan(this.outputFile, this.memory);
            AgentStatusUpdater.running(`Planned action: ${plan.action} - ${plan.reason}`);
            if (plan.action === ACTIONS.STOP) {
                this.finish();
                break;
            }
            const patch = await Editor.applyPlan(this.sourceFile, this.outputFile, plan);
            Executor.execute(patch, this.outputFile);
            if (!Validator.validate(this.outputFile)) {
                AgentStatusUpdater.error("Validation failed after applying patch.");
                Executor.revert();
                this.updateScore(-1);
                continue;
            }
            this.updateScore(1);
            setOutputFile(this.outputFile);
        }
    }

    abort() {
        this.shouldStop = true;
    }

    finish() {
        this.shouldStop = true;
        AgentStatusUpdater.finished();
    }

    updateScore(delta: number) {
        this.score += delta;
    }
}