import { setOutputFile } from "../utils";
import { DeobfuscatorAgent } from "./agent/DeobfuscatorAgent";
import { AgentStatusUpdater } from "./AgentStatusUpdater";
import { deobfuscate } from "js-deobfuscator";

export class Deobfuscator {
    sourceFile: string;
    outputFile: string;
    agent: DeobfuscatorAgent;

    constructor(sourceFile: string, outputFile: string) {
        this.sourceFile = sourceFile;
        this.outputFile = outputFile;
        this.agent = new DeobfuscatorAgent(this.sourceFile, this.outputFile);
        this.start();
    }

    start() {
        AgentStatusUpdater.clear();
        AgentStatusUpdater.running("Starting deobfuscation process...");
        this.tryGenericDeobfuscation();
        this.agent.start();
    }

    abort() {
        this.agent.abort();
        AgentStatusUpdater.error("Deobfuscation process aborted by user.");
        // Add aborting the deobfuscation process logic here
    }

    finish() {
        this.agent.finish();
        AgentStatusUpdater.finished();
        // Add finalizing the deobfuscation process
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
            AgentStatusUpdater.error("Failed to apply generic deobfuscation techniques.");
            return;
        }
        setOutputFile(this.outputFile);
        AgentStatusUpdater.running("Applied generic deobfuscation techniques.");
    }
}