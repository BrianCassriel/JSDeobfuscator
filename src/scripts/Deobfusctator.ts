import { setOutputFile } from "../utils";
import { AgentStatusUpdater } from "./AgentStatusUpdater";
import { deobfuscate } from "js-deobfuscator";

export class Deobfuscator {
    sourceFile: string;
    outputFile: string;

    constructor(sourceFile: string, outputFile: string) {
        this.sourceFile = sourceFile;
        this.outputFile = outputFile;
        this.start();
    }

    start() {
        AgentStatusUpdater.clear();
        AgentStatusUpdater.running("Starting deobfuscation process...");
        this.tryGenericDeobfuscation();
        // Add agent deobfuscation logic
    }

    abort() {
        AgentStatusUpdater.error("Deobfuscation process aborted by user.");
        // Add aborting the deobfuscation process
    }

    finish() {
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
            console.error("Error during generic deobfuscation:", error);
            AgentStatusUpdater.error("Failed to apply generic deobfuscation techniques.");
            return;
        }
        setOutputFile(this.outputFile);
        AgentStatusUpdater.running("Applied generic deobfuscation techniques.");
    }
}