import { AGENT_STATUS } from "./AgentStatus";

export class AgentStatusUpdater {
    static eventName = "deobfuscator:agent-status";

    static idle() {
        window.dispatchEvent(new CustomEvent(AgentStatusUpdater.eventName, {
            detail: {
                status: AGENT_STATUS.IDLE,
                output: "Agent is idle, waiting for tasks."
            }
        }));
    }

    static running(taskDescription: string) {
        window.dispatchEvent(new CustomEvent(AgentStatusUpdater.eventName, {
            detail: {
                status: AGENT_STATUS.RUNNING,
                output: taskDescription
            }
        }));
    }

    static warning(message: string) {
        window.dispatchEvent(new CustomEvent(AgentStatusUpdater.eventName, {
            detail: {
                status: AGENT_STATUS.WARNING,
                output: message
            }
        }));
    }

    static error(errorMessage: string) {
        window.dispatchEvent(new CustomEvent(AgentStatusUpdater.eventName, {
            detail: {
                status: AGENT_STATUS.ERROR,
                output: errorMessage
            }
        }));
    }

    static finished() {
        window.dispatchEvent(new CustomEvent(AgentStatusUpdater.eventName, {
            detail: {
                status: AGENT_STATUS.DONE,
                output: "Agent has completed all tasks."
            }
        }));
    }

    static clear() {
        window.dispatchEvent(new CustomEvent(AgentStatusUpdater.eventName, {
            detail: {
                status: AGENT_STATUS.CLEAR,
                output: ""
            }
        }));
    }
}