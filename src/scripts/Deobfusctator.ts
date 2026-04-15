import { setOutputFile } from "../utils";
import { DeobfuscatorAgent } from "./agent/DeobfuscatorAgent";
import { AgentStatusUpdater } from "./AgentStatusUpdater";
import { deobfuscate } from "js-deobfuscator";
import { DeterministicTransforms } from "./transforms/DeterministicTransforms";

export class Deobfuscator {
    sourceFile: string;
    outputFile: string;
    agent: DeobfuscatorAgent;

    constructor(sourceFile: string, outputFile: string) {
        this.sourceFile = sourceFile;
        this.outputFile = outputFile;
        this.agent = new DeobfuscatorAgent(this.sourceFile);
        this.start();
    }

    start() {
        AgentStatusUpdater.clear();

        AgentStatusUpdater.running("Layer 1: Applying generic deobfuscation.");
        this.tryGenericDeobfuscation();

        AgentStatusUpdater.running("Layer 1: Running deterministic transforms.");
        this.runDeterministicTransforms();

        AgentStatusUpdater.running("Layer 2: Starting agentic semantic analysis.");
        this.agent.start();
    }

    abort() {
        this.agent.abort();
        AgentStatusUpdater.error("Deobfuscation process aborted by user.");
    }

    finish() {
        this.agent.finish();
        AgentStatusUpdater.finished();
    }

    tryGenericDeobfuscation() {
        const config = {
            verbose: false,
            isModule: false,
            arrays: {
                unpackArrays: true,
                removeArrays: true
            },
            proxyFunctions: {
                replaceProxyFunctions: true,
                removeProxyFunctions: true
            },
            expressions: {
                simplifyExpressions: true,
                removeDeadBranches: true,
                undoStringOperations: true
            },
            miscellaneous: {
                beautify: true,
                simplifyProperties: true,
                renameHexIdentifiers: true
            }
        };
        try {
            this.outputFile = deobfuscate(this.sourceFile, config);
        } catch (error) {
            console.warn("Error during generic deobfuscation:", error);
            AgentStatusUpdater.running("Generic deobfuscation failed, continuing with deterministic transforms...");
            return;
        }
        setOutputFile(this.outputFile);
        AgentStatusUpdater.running("Applied generic deobfuscation techniques.");
    }

    runDeterministicTransforms() {
        try {
            const result = DeterministicTransforms.run(this.outputFile);
            if (result.transformsApplied.length > 0) {
                this.outputFile = result.code;
                setOutputFile(this.outputFile);
                AgentStatusUpdater.running(`Deterministic transforms: ${result.transformsApplied.join(', ')}`);
            } else {
                AgentStatusUpdater.running("No additional deterministic transforms needed.");
            }
        } catch (error) {
            console.error("Error during deterministic transforms:", error);
            AgentStatusUpdater.error(`Deterministic transforms failed: ${error instanceof Error ? error.message : error}`);
        }
    }
}